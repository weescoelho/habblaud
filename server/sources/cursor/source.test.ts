// Integração da fonte do Cursor: sem arquivos locais (lacuna C2), a presença vem só dos eventos de hook. O teste usa
// o AccountsService e o Office de verdade e empurra eventos de hook sintéticos, cobrindo 1:1 os ACs de T5
// (CPOC-01, CPOC-03, CPOC-04, CPOC-08, CPOC-10) e os edge cases da spec (sala padrão, fora de ordem, expiração).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { TranscriptHub } from '../transcript-hub';
import { CursorSource } from './source';
import type { TaskManagerOptions, TaskSpawner } from './tasks';
import { WorktreeManager, type GitRunner } from './worktree';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(opts: { hub?: TranscriptHub; tasks?: (ctx: { dir: string; home: string }) => Omit<TaskManagerOptions, 'office'> } = {}) {
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
  const source = new CursorSource({ accounts, office, home: home.dir, dir, now, pollMs: 1_000, hub: opts.hub, tasks: opts.tasks?.({ dir, home: home.dir }) });
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

/**
 * Opções de tarefa com `spawn`/`git` FAKES: nenhum processo nem repositório de verdade é tocado. O transcript
 * normalizado fica em `<cursorDir>/tasks` (apagado com a pasta temporária do teste).
 */
function fakeTasks(dir: string, opts: { file?: string } = {}): Omit<TaskManagerOptions, 'office'> {
  const spawn: TaskSpawner = () => ({ pid: 7, stdout: null, kill: () => true, once: () => {}, on: () => {} });
  const git: GitRunner = async () => ({ code: 0, stdout: '', stderr: '' });
  const worktrees = new WorktreeManager({ baseDir: join(dir, 'worktrees'), git });
  return { spawn, worktrees, dir: join(dir, 'tasks'), bin: '/opt/bin/cursor-agent', env: { PATH: '/usr/bin' }, file: opts.file ?? null };
}

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

describe('fonte do Cursor: subagentes por hook', () => {
  const sub = (extra: Record<string, unknown>) => ({ hook_event_name: 'subagentStart', conversation_id: 'c1', ...extra });

  it('subagentStart cria o sub no escritório (parentId, role, title, working); subagentStop entrega', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart', { conversation_id: 'c1' }));
    expect(
      ctx.hook(
        sub({
          parent_conversation_id: 'c1',
          subagent_id: 'sa-1',
          subagent_type: 'explore',
          task: 'Mapear o repositório',
        }),
      ),
    ).toBe(true);
    expect(ctx.agent('cursor:s:sa-1')).toMatchObject({
      kind: 'sub',
      parentId: 'cursor:c1',
      account: 'cursor',
      role: 'Explore',
      title: 'Mapear o repositório',
      status: 'working',
    });
    // O principal segue intacto (o evento de subagente não mexe no status dele).
    expect(ctx.agent('cursor:c1')).toMatchObject({ kind: 'main', status: 'idle' });

    expect(ctx.hook({ hook_event_name: 'subagentStop', conversation_id: 'c9', subagent_id: 'sa-1' })).toBe(true);
    expect(ctx.agent('cursor:s:sa-1')?.status).toBe('done');
    expect(ctx.agent('cursor:c1')?.status).toBe('idle');
  });

  it('sem subagent_type usa o papel padrão; sem parent_conversation_id usa o conversation_id do evento', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart', { conversation_id: 'c1' }));
    ctx.hook(sub({ subagent_id: 'sa-2' }));
    expect(ctx.agent('cursor:s:sa-2')).toMatchObject({ parentId: 'cursor:c1', role: 'Subagente (Cursor)' });
    expect(ctx.agent('cursor:s:sa-2')?.title).toBeUndefined();
  });

  it('subagentStop órfão é no-op: nada é criado, sem lançar, principal intacto', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.hook({ hook_event_name: 'subagentStop', conversation_id: 'c1', subagent_id: 'ninguem' })).toBe(true);
    expect(ctx.agent('cursor:s:ninguem')).toBeUndefined();
    expect(ctx.agent('cursor:c1')?.status).toBe('idle');
  });

  it('subagentStart sem id, sem pai ou com pai desconhecido degrada (nenhum sub quebrado)', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    expect(ctx.hook({ hook_event_name: 'subagentStart', conversation_id: 'c1' })).toBe(false); // sem id
    expect(ctx.hook({ hook_event_name: 'subagentStart', subagent_id: 'sa-4' })).toBe(false); // sem pai
    expect(ctx.hook({ hook_event_name: 'subagentStart', subagent_id: 'sa-5', parent_conversation_id: 'nao-existe' })).toBe(false); // pai desconhecido
    expect(ctx.agent('cursor:s:sa-4')).toBeUndefined();
    expect(ctx.agent('cursor:s:sa-5')).toBeUndefined();
    expect(ctx.agent('cursor:c1')?.status).toBe('idle');
  });

  it('subagentStart sem subagentStop é completado no poll quando a presença expira', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    ctx.hook(sub({ subagent_id: 'sa-6' }));
    // O principal segue recebendo eventos (fica fresco); o sub, não.
    ctx.advance(4 * 60_000);
    ctx.hook(ev('preToolUse', { tool_name: 'Read', tool_input: { file_path: '/a.ts' } }));
    ctx.advance(2 * 60_000);
    ctx.poll();
    expect(ctx.agent('cursor:s:sa-6')?.status).toBe('done');
    expect(ctx.agent('cursor:c1')?.status).toBe('working'); // o principal não foi fechado
  });

  it('sessionEnd do principal encerra os subs filhos', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    ctx.hook(sub({ subagent_id: 'sa-7' }));
    expect(ctx.hook(ev('sessionEnd'))).toBe(true);
    expect(ctx.agent('cursor:c1')?.status).toBe('offline');
    expect(ctx.agent('cursor:s:sa-7')?.status).toBe('done');
  });

  it('um novo subagentStart do mesmo id reativa um sub já entregue', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    ctx.hook(sub({ subagent_id: 'sa-8', task: 'Tarefa A' }));
    ctx.hook({ hook_event_name: 'subagentStop', conversation_id: 'c1', subagent_id: 'sa-8' });
    expect(ctx.agent('cursor:s:sa-8')?.status).toBe('done');
    ctx.hook(sub({ subagent_id: 'sa-8', task: 'Tarefa A de novo' }));
    expect(ctx.agent('cursor:s:sa-8')?.status).toBe('working');
  });

  it('subagentStop resolve o transcript do sub ao lado do pai (child_conversation_id) e mantém o terminal', () => {
    const ctx = setup();
    const parentFile = join(ctx.dir, 'projects', 'slug', 'agent-transcripts', 'c1', 'c1.jsonl');
    mkdirSync(dirname(parentFile), { recursive: true });
    writeFileSync(parentFile, '{}\n');
    ctx.hook(ev('sessionStart', { transcript_path: parentFile }));
    const subFile = join(dirname(parentFile), 'subagents', 'child-1.jsonl');
    mkdirSync(dirname(subFile), { recursive: true });
    writeFileSync(subFile, `${JSON.stringify({ role: 'assistant', message: { content: 'ok' } })}\n`);
    ctx.hook(sub({ parent_conversation_id: 'c1', subagent_id: 'sa-9' }));
    ctx.hook({
      hook_event_name: 'subagentStop',
      conversation_id: 'c1',
      subagent_id: 'sa-9',
      child_conversation_id: 'child-1',
    });
    expect(ctx.source.transcriptPathOf('cursor:s:sa-9')).toBe(subFile);
    expect(ctx.source.terminalParser('cursor:s:sa-9')).toBeDefined(); // o terminal do sub resolve
    expect(ctx.agent('cursor:s:sa-9')?.status).toBe('done');
    // O principal não foi afetado.
    expect(ctx.agent('cursor:c1')?.status).toBe('idle');
  });

  it('subagentStop acha o transcript do sub por varredura quando o pai ainda não tem caminho', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    const subFile = join(
      ctx.dir,
      'projects',
      'outro-slug',
      'agent-transcripts',
      'conv-7',
      'subagents',
      'child-2.jsonl',
    );
    mkdirSync(dirname(subFile), { recursive: true });
    writeFileSync(subFile, `${JSON.stringify({ role: 'assistant', message: { content: 'ok' } })}\n`);
    ctx.hook(sub({ subagent_id: 'sa-10' }));
    ctx.hook({
      hook_event_name: 'subagentStop',
      conversation_id: 'c1',
      subagent_id: 'sa-10',
      child_conversation_id: 'child-2',
    });
    expect(ctx.source.transcriptPathOf('cursor:s:sa-10')).toBe(subFile);
  });

  it('subagentStop prefere `agent_transcript_path` e degrada sem caminho conhecido', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    const hinted = join(ctx.home.dir, 'sub-hint.jsonl');
    writeFileSync(hinted, '');
    ctx.hook(sub({ subagent_id: 'sa-11' }));
    ctx.hook({
      hook_event_name: 'subagentStop',
      conversation_id: 'c1',
      subagent_id: 'sa-11',
      child_conversation_id: 'child-3',
      agent_transcript_path: hinted,
    });
    expect(ctx.source.transcriptPathOf('cursor:s:sa-11')).toBe(hinted);

    // Sem child id nem hint, o terminal degrada (undefined), sem lançar.
    ctx.hook(sub({ subagent_id: 'sa-12' }));
    expect(ctx.hook({ hook_event_name: 'subagentStop', conversation_id: 'c1', subagent_id: 'sa-12' })).toBe(true);
    expect(ctx.source.transcriptPathOf('cursor:s:sa-12')).toBeUndefined();
  });
});

describe('fonte do Cursor: pump do transcript (GitHub)', () => {
  // Linha sintética no formato real do transcript do Cursor (message.content + tool_use Shell).
  const shellLine = (command: string) =>
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command } }] } });

  it('seekEnd ignora o conteúdo antigo; a linha nova (git push) vira atividade do GitHub', () => {
    const ctx = setup();
    const file = join(ctx.home.dir, 'transcript.jsonl');
    writeFileSync(file, `${shellLine('git push origin main')}\n`); // já existia no attach
    ctx.hook(ev('sessionStart', { transcript_path: file }));
    ctx.poll();
    expect(ctx.agent()?.activity?.tool).not.toBe('GitHub'); // nada do conteúdo antigo (seekEnd)

    appendFileSync(file, `${shellLine('gh pr create --title x')}\n`);
    ctx.poll();
    // `gh pr create` vira o evento `pr_opened` (texto "Abriu … PR"), não um `push` genérico (CSH-09).
    expect(ctx.agent()?.activity).toMatchObject({ tool: 'GitHub', kind: 'git', text: 'Abriu um PR' });
  });

  it('só emite git/gh: um comando comum no transcript não vira evento do GitHub', () => {
    const ctx = setup();
    const file = join(ctx.home.dir, 't2.jsonl');
    ctx.hook(ev('sessionStart', { transcript_path: file }));
    writeFileSync(file, `${shellLine('npm test')}\n`);
    ctx.poll();
    expect(ctx.agent()?.activity?.tool).not.toBe('GitHub');
  });

  it('sem transcript_path: o poll não lança e a presença/atividade por hook segue intacta', () => {
    const ctx = setup();
    ctx.hook(ev('sessionStart'));
    ctx.hook(ev('preToolUse', { tool_name: 'Shell', tool_input: { command: 'ls -la' } }));
    expect(() => ctx.poll()).not.toThrow();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent()?.activity?.tool).toBe('Bash');
    expect(ctx.source.transcriptPathOf('cursor:c1')).toBeUndefined();
  });

  it('transcript ausente degrada sem lançar; quando o arquivo aparece, o pump passa a ler', () => {
    const ctx = setup();
    const file = join(ctx.home.dir, 'late.jsonl');
    ctx.hook(ev('sessionStart', { transcript_path: file }));
    expect(() => ctx.poll()).not.toThrow(); // ausente: degrada
    expect(ctx.agent()?.activity?.tool).not.toBe('GitHub');
    writeFileSync(file, `${shellLine('git push origin main')}\n`);
    ctx.poll();
    expect(ctx.agent()?.activity?.tool).toBe('GitHub');
  });

  it('transcript truncado/rotacionado recomeça do fim, sem reemitir o antigo', () => {
    const ctx = setup();
    const file = join(ctx.home.dir, 'rot.jsonl');
    writeFileSync(file, `${shellLine('npm test')}\n${shellLine('ls')}\n`);
    ctx.hook(ev('sessionStart', { transcript_path: file }));
    ctx.poll(); // 1º attach: seekEnd (nada do antigo)
    // Rotaciona: o arquivo encolhe e traz um git push no começo.
    writeFileSync(file, `${shellLine('git push origin main')}\n`);
    ctx.poll();
    expect(ctx.agent()?.activity?.tool).not.toBe('GitHub'); // recomeçou do fim, sem festa falsa
  });

  it('assina o hub: a linha nova entregue pelo hub vira atividade do GitHub sem depender do poll (SC-02/SC-05)', () => {
    const hub = new TranscriptHub({ auto: false });
    cleanups.push(() => hub.close());
    const ctx = setup({ hub });
    expect(hub.size).toBe(0); // ninguém assinou ainda
    const file = join(ctx.home.dir, 'live.jsonl');
    writeFileSync(file, `${shellLine('git commit -m antigo')}\n`); // já existia no attach (seekEnd ignora)
    ctx.hook(ev('sessionStart', { transcript_path: file }));
    expect(hub.size).toBe(1); // a fonte assina o hub (deixa de abrir FileTail próprio)

    appendFileSync(file, `${shellLine('git push origin main')}\n`);
    hub.tick(); // o hub entrega; a fonte reage ao vivo, sem passar pelo poll()
    expect(ctx.agent()?.activity).toMatchObject({ tool: 'GitHub', kind: 'git' });
  });
});

describe('fonte do Cursor: tarefas headless (P5)', () => {
  it('hospeda o ciclo e roteia o terminal da tarefa para o transcript normalizado (SC-21/SC-24)', async () => {
    const ctx = setup({ tasks: ({ dir }) => fakeTasks(dir) });
    const info = await ctx.source.createTask({ prompt: 'Crie a tela de login', cwd: '/projetos/alfa' });

    expect(ctx.source.tasks().map((t) => t.id)).toEqual([info.id]);
    // O terminal da tarefa lê o JSONL normalizado, com um parser NOVO por leitura (SC-24).
    expect(ctx.source.transcriptPathOf(info.agentId)).toBe(join(ctx.dir, 'tasks', `${info.id}.jsonl`));
    const p1 = ctx.source.terminalParser(info.agentId);
    const p2 = ctx.source.terminalParser(info.agentId);
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1).not.toBe(p2);
    // A tarefa entra na sala do projeto de origem como um agente Cursor comum.
    expect(ctx.agent(info.agentId)).toMatchObject({ provider: 'cursor', roomId: '/projetos/alfa', status: 'working' });
  });

  it('para, retoma e exclui a tarefa pelo host (SC-21/SC-25/SC-23)', async () => {
    const ctx = setup({ tasks: ({ dir }) => fakeTasks(dir) });
    const info = await ctx.source.createTask({ prompt: 'x', cwd: '/projetos/alfa' });

    expect(ctx.source.stopTask(info.id)?.status).toBe('stopped');
    expect((await ctx.source.resumeTask(info.id))?.status).toBe('running');
    await expect(ctx.source.removeTask(info.id)).resolves.toEqual({ removed: true });
    expect(ctx.source.tasks()).toEqual([]);
    expect(ctx.source.transcriptPathOf(info.agentId)).toBeUndefined();
  });

  it('não roteia terminal de um id de tarefa desconhecido', () => {
    const ctx = setup({ tasks: ({ dir }) => fakeTasks(dir) });
    expect(ctx.source.transcriptPathOf('cursor:task:inexistente')).toBeUndefined();
    expect(ctx.source.terminalParser('cursor:task:inexistente')).toBeUndefined();
  });

  it('reconcilia a tarefa órfã persistida ao iniciar (SC-25)', () => {
    let file = '';
    const ctx = setup({
      tasks: ({ dir }) => {
        file = join(dir, 'tasks.json');
        mkdirSync(dir, { recursive: true });
        const info = {
          id: 'task-x',
          prompt: 'x',
          mode: 'plan',
          agentId: 'cursor:task:task-x',
          roomId: '/projetos/alfa',
          label: 'x',
          status: 'running',
          createdAt: 1,
        };
        writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ info, prompt: 'x', mode: 'plan', force: false, cwd: '/projetos/alfa', isolated: false, transcriptPath: join(dir, 'tasks', 'task-x.jsonl') }] }));
        return fakeTasks(dir, { file });
      },
    });

    expect(ctx.source.tasks()[0].status).toBe('running');
    ctx.source.start(); // boot: sem processo vivo, a órfã vira stopped
    expect(ctx.source.tasks()[0].status).toBe('stopped');
  });
});
