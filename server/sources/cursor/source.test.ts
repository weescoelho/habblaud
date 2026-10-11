// Integração da fonte do Cursor: sem arquivos locais (lacuna C2), a presença vem só dos eventos de hook. O teste usa
// o AccountsService e o Office de verdade e empurra eventos de hook sintéticos, cobrindo 1:1 os ACs de T5
// (CPOC-01, CPOC-03, CPOC-04, CPOC-08, CPOC-10) e os edge cases da spec (sala padrão, fora de ordem, expiração).
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { CursorSource } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup() {
  const home = tempDir('habblaud-cursor-');
  cleanups.push(home.cleanup);
  const dir = resolve(join(home.dir, '.cursor'));
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: home.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new CursorSource({ accounts, office, home: home.dir, dir, now, pollMs: 1_000 });
  cleanups.unshift(() => source.stop());
  const notices: string[] = [];
  return {
    home,
    dir,
    accounts,
    office,
    source,
    notices,
    advance(ms: number) {
      clock += ms;
    },
    now,
    poll() {
      source.poll();
      office.tick();
      notices.push(...office.commit().notices.map((n) => n.text));
    },
    agent(id = 'cursor:c1'): AgentInfo | undefined {
      const snap = office.commit();
      notices.push(...snap.notices.map((n) => n.text));
      return snap.snapshot.agents.find((a) => a.id === id);
    },
    hook(input: Record<string, unknown>): boolean {
      return source.applyHookEvent(input);
    },
  };
}

const ev = (name: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: name,
  conversation_id: 'c1',
  workspace_roots: ['/projetos/demo'],
  ...extra,
});

describe('fonte do Cursor: presença por hooks', () => {
  it('sessionStart cria o agente na sala de workspace_roots[0]; preToolUse trabalha; stop para; sessionEnd fecha', () => {
    const ctx = setup();
    expect(ctx.hook(ev('sessionStart', { workspace_roots: ['/projetos/demo'] }))).toBe(true);
    expect(ctx.agent()).toMatchObject({
      kind: 'main',
      provider: 'cursor',
      account: 'cursor',
      sessionId: 'c1',
      roomId: '/projetos/demo',
      role: 'Agente principal (Cursor)',
      status: 'idle',
    });
    expect(ctx.office.commit().snapshot.rooms.map((r) => r.id)).toEqual(['/projetos/demo']);

    expect(ctx.hook(ev('preToolUse', { tool_name: 'Shell', tool_input: { command: 'ls -la' } }))).toBe(true);
    const a = ctx.agent()!;
    expect(a.status).toBe('working');
    expect(a.activity).toMatchObject({ tool: 'Bash' });
    expect(a.activity?.text).toBeTruthy();

    expect(ctx.hook(ev('stop'))).toBe(true);
    expect(ctx.agent()?.status).toBe('idle');

    expect(ctx.hook(ev('sessionEnd'))).toBe(true);
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.notices.some((n) => n.includes('encerrou'))).toBe(true);
  });

  it('sem workspace_roots: usa o cwd do evento', () => {
    const ctx = setup();
    expect(ctx.hook({ hook_event_name: 'sessionStart', conversation_id: 'c2', cwd: '/projetos/api' })).toBe(true);
    expect(ctx.agent('cursor:c2')).toMatchObject({ roomId: '/projetos/api', status: 'idle' });
  });

  it('sem workspace_roots nem cwd: entra na sala padrão sem falhar', () => {
    const ctx = setup();
    expect(ctx.hook({ hook_event_name: 'sessionStart', conversation_id: 'c3' })).toBe(true);
    expect(ctx.agent('cursor:c3')).toMatchObject({ roomId: 'cursor', status: 'idle' });
  });

  it('preToolUse sem sessionStart cria o agente e o traz para o escritório', () => {
    const ctx = setup();
    expect(ctx.hook(ev('preToolUse', { conversation_id: 'c4', tool_name: 'Read', tool_input: { file_path: '/a/b.ts' } }))).toBe(true);
    expect(ctx.agent('cursor:c4')).toMatchObject({ provider: 'cursor', status: 'working', roomId: '/projetos/demo' });
    expect(ctx.agent('cursor:c4')?.activity).toMatchObject({ tool: 'Read', kind: 'read' });
  });

  it('beforeShellExecution → shell; afterShellExecution → working (CPOC-10)', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.hook(ev('beforeShellExecution', { command: 'npm test', tool_input: { command: 'npm test' } }))).toBe(true);
    expect(ctx.agent()?.status).toBe('shell');
    expect(ctx.hook(ev('afterShellExecution', { command: 'npm test' }))).toBe(true);
    expect(ctx.agent()?.status).toBe('working');
  });

  it('evento fora de HOOK_EVENTS (ou sem hook_event_name) → false, sem lançar', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.hook({ hook_event_name: 'desconhecido', conversation_id: 'c1' })).toBe(false);
    expect(ctx.hook({})).toBe(false);
    expect(ctx.hook({ conversation_id: 'c1' })).toBe(false);
    // Nada mudou no escritório.
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('sessionEnd de conversa desconhecida → false', () => {
    const ctx = setup();
    expect(ctx.hook(ev('sessionEnd', { conversation_id: 'ninguem' }))).toBe(false);
  });

  it('borda fora de ordem não regride o estado (a informação mais nova vence, por statusAt)', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    const t0 = ctx.now();
    ctx.advance(1_000);
    expect(ctx.hook(ev('preToolUse', { tool_name: 'Read', tool_input: { file_path: '/a.ts' } }))).toBe(true);
    expect(ctx.agent()?.status).toBe('working');
    // Evento mais antigo que o último (relógio recuado) chega depois: ignorado.
    ctx.advance(-500);
    expect(ctx.now()).toBeLessThan(t0 + 1_000);
    expect(ctx.hook(ev('stop'))).toBe(true);
    expect(ctx.agent()?.status).toBe('working');
    // Um evento de verdade mais novo volta a valer.
    ctx.advance(2_000);
    expect(ctx.hook(ev('stop'))).toBe(true);
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('relógio de presença: sem evento novo por mais de STALE_PRESENCE_MS o agente sai; um hook novo o traz de volta', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(5 * 60_000 + 1);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.notices.some((n) => n.includes('encerrou'))).toBe(true);
    // Um evento novo reabre a sessão.
    ctx.advance(1_000);
    expect(ctx.hook(ev('preToolUse', { tool_name: 'Read', tool_input: { file_path: '/a.ts' } }))).toBe(true);
    expect(ctx.agent()?.status).toBe('working');
  });

  it('sem transcript_path: transcriptPathOf fica undefined, mas o parser existe por agente conhecido', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.source.transcriptPathOf('cursor:c1')).toBeUndefined();
    expect(ctx.source.terminalParser('cursor:c1')).toBeDefined();
    // Um evento com transcript_path nulo (ex.: beforeReadFile) não inventa caminho.
    expect(ctx.hook(ev('beforeReadFile', { transcript_path: null }))).toBe(true);
    expect(ctx.source.transcriptPathOf('cursor:c1')).toBeUndefined();
  });

  it('com transcript_path: expõe o caminho e um parser novo por chamada; evento sem caminho não limpa', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart', { transcript_path: '/tmp/cursor.jsonl' }));
    expect(ctx.source.transcriptPathOf('cursor:c1')).toBe('/tmp/cursor.jsonl');
    const p1 = ctx.source.terminalParser('cursor:c1');
    const p2 = ctx.source.terminalParser('cursor:c1');
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1).not.toBe(p2); // parser NOVO por leitura (guarda estado)
    // Evento posterior sem transcript_path (ou nulo) NÃO limpa o caminho já guardado.
    ctx.hook(ev('stop'));
    ctx.hook(ev('beforeReadFile', { transcript_path: null }));
    expect(ctx.source.transcriptPathOf('cursor:c1')).toBe('/tmp/cursor.jsonl');
  });

  it('agente desconhecido: transcriptPathOf e terminalParser devolvem undefined', () => {
    const ctx = setup();
    expect(ctx.source.transcriptPathOf('cursor:ninguem')).toBeUndefined();
    expect(ctx.source.terminalParser('cursor:ninguem')).toBeUndefined();
  });

  it('tokens dos hooks viram stats do agente no Office (soma, sem regredir; tasks sempre vazio)', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    ctx.hook(ev('stop', { input_tokens: 100, output_tokens: 40, cache_read_tokens: 20, cache_write_tokens: 5 }));
    expect(ctx.agent()?.stats).toMatchObject({ tokensIn: 125, tokensOut: 40 });
    // afterAgentResponse só com output soma ao acumulado.
    ctx.hook(ev('afterAgentResponse', { output_tokens: 10 }));
    expect(ctx.agent()?.stats).toMatchObject({ tokensIn: 125, tokensOut: 50 });
    // Evento sem tokens (ou com campo não numérico) não muda os números.
    ctx.hook(ev('afterAgentResponse'));
    ctx.hook(ev('afterAgentResponse', { output_tokens: 'x' }));
    expect(ctx.agent()?.stats).toMatchObject({ tokensIn: 125, tokensOut: 50 });
    // Sem checklist no transcript: nenhuma tarefa é derivada.
    expect(ctx.agent()?.tasks).toEqual([]);
  });

  it('preToolUse de ferramenta própria do Cursor gera Activity traduzida (não o genérico), com tasks vazio', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    ctx.hook(ev('preToolUse', { tool_name: 'GetDynamicTools' }));
    expect(ctx.agent()?.activity).toMatchObject({ kind: 'other', tool: 'GetDynamicTools' });
    expect(ctx.agent()?.activity?.text).not.toMatch(/^Usando /);
    ctx.advance(10);
    ctx.hook(ev('preToolUse', { tool_name: 'AskQuestion', tool_input: { title: 'Qual caminho?' } }));
    expect(ctx.agent()?.activity).toMatchObject({ kind: 'ask', tool: 'AskQuestion' });
    ctx.advance(10);
    ctx.hook(ev('preToolUse', { tool_name: 'UpdateCurrentStep', tool_input: { current_step: 'Rodando os testes' } }));
    expect(ctx.agent()?.activity).toMatchObject({ kind: 'plan', tool: 'UpdateCurrentStep' });
    expect(ctx.agent()?.activity?.text).toBe('Etapa: Rodando os testes');
    expect(ctx.agent()?.tasks).toEqual([]);
  });

  it('conta única registrada: id cursor, nome Cursor, short/color sem colidir; sources() reflete as sessões', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.source.accountEntries().map((e) => e.id)).toEqual(['cursor']);
    const list = ctx.accounts.list(new Map([['cursor', 1]]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'cursor', provider: 'cursor', name: 'Cursor', sessions: 1 });
    expect(list[0].short).toBeTruthy();
    expect(list[0].color).toBeTruthy();
    expect(ctx.source.sources()).toEqual([{ label: 'cursor', provider: 'cursor', path: ctx.dir, sessions: 1, ok: true }]);
  });

  it('o estado das fontes Claude/Codex não muda (nenhuma conta externa além do Cursor)', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.accounts.entries()).toEqual([]);
    expect(ctx.accounts.entriesOf('cursor').map((e) => e.id)).toEqual(['cursor']);
  });
});
