// Pedidos de aprovação do Cursor no registro de permissões: o agente pela conversa (`session_id`/`conversation_id`),
// título e resumo pela tradução das ferramentas do Cursor (`Shell`→Bash, `MCP:<tool>`→`mcp__<tool>`), sem sugestões
// nem perguntas, recusa só com motivo (interromper e "sempre permitir" = unsupported), sem a busca da resposta no
// transcript e com a mesma expiração dos outros provedores. Dados sintéticos.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { cursorToolView } from './cursor';
import { EXPIRY_GRACE_MS, PermissionRegistry, type WaitResult } from './registry';

setQuiet(true);

const CONV = 'conv-cursor-1';
const CURSOR = `cursor:${CONV}`;
const CLAUDE = 'acc:1';

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(),
    now: clock.now,
  });
  office.addMain({ id: CURSOR, provider: 'cursor', account: 'cursor', sessionId: CONV, cwd: '/p/loja', role: 'Agente principal (Cursor)', startedAt: 0, status: 'working' });
  office.addMain({ id: CLAUDE, account: 'acc', sessionId: 'sess-1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  const scans: string[] = [];
  permissions = new PermissionRegistry({
    office,
    viewers: () => 1,
    transcriptPathOf: (id) => {
      scans.push(id);
      return undefined;
    },
    now: clock.now,
  });
  return { office, registry: permissions, clock, scans };
}

function cursorInput(over: Record<string, unknown> = {}) {
  return {
    provider: 'cursor',
    session_id: CONV,
    cwd: '/p/loja',
    tool_name: 'Shell',
    tool_input: { command: 'npm test', description: 'Rodar os testes' },
    timeout_ms: 25_000,
    ...over,
  };
}

function registered(r: ReturnType<PermissionRegistry['register']>): string {
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
}

const snapAgent = (office: Office, id: string) => office.commit().snapshot.agents.find((a) => a.id === id);

describe('PermissionRegistry: pedidos do Cursor', () => {
  it('publica no agente do Cursor: provider cursor, título/resumo pela tradução do Cursor, sem sugestões', () => {
    const { office, registry } = setup();
    const id = registered(registry.register(cursorInput()));
    const a = snapAgent(office, CURSOR)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    expect(a.permission).toMatchObject({ id, provider: 'cursor', tool: 'Shell', title: 'Bash(npm test)', text: 'Rodando testes', icon: '🧪', expiresAt: 1_025_000 });
    expect(a.permission!.suggestions).toBeUndefined();
    expect(registry.detail(id)).toMatchObject({ input: 'npm test', inputKind: 'command' });
    // O agente do Claude Code não é tocado.
    expect(snapAgent(office, CLAUDE)!.permission).toBeUndefined();
  });

  it('resolve o agente pela conversa (session_id ou conversation_id); conversa desconhecida não desvia', () => {
    const { office, registry } = setup();
    registered(registry.register(cursorInput()));
    expect(snapAgent(office, CURSOR)!.permission).toBeDefined();
    // conversation_id vale como alias de session_id.
    expect(registry.register({ provider: 'cursor', conversation_id: CONV, tool_name: 'Read', tool_input: { file_path: '/p/loja/a.ts' } })).not.toHaveProperty('skip');
    expect(registry.register(cursorInput({ session_id: 'conv-outra' }))).toEqual({ skip: 'unknown-session' });
  });

  it('decisões: allow e deny com motivo valem; interromper e "sempre permitir" = unsupported; answer = invalid-answer; terminal libera', async () => {
    const { registry } = setup();
    const id = registered(registry.register(cursorInput()));
    expect(registry.decide(id, { behavior: 'deny', message: 'não', interrupt: true })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    const w = registry.wait(id, 10_000)!;
    expect(registry.decide(id, { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    expect(await w.result).toEqual({ status: 'decided', behavior: 'deny', message: 'use pnpm' } satisfies WaitResult);

    const id2 = registered(registry.register(cursorInput()));
    const w2 = registry.wait(id2, 10_000)!;
    expect(registry.decide(id2, { behavior: 'terminal' })).toBe('ok');
    expect(await w2.result).toEqual({ status: 'released', reason: 'terminal' });
  });

  it('AskUserQuestion vindo do Cursor não é pergunta: aprova-se como os outros pedidos', () => {
    const { registry } = setup();
    const id = registered(registry.register(cursorInput({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Qual?', options: [{ label: 'A' }] }] } })));
    expect(registry.detail(id)!.questions).toBeUndefined();
    expect(registry.decide(id, { behavior: 'allow' })).toBe('ok');
  });

  it('sem a busca da resposta no terminal: o transcript nunca é lido e o principal que deixa de esperar não libera o pedido', () => {
    const { office, registry, clock, scans } = setup();
    const id = registered(registry.register(cursorInput()));
    const w = registry.wait(id, 25_000)!;
    office.setStatus(CURSOR, 'waiting', 'aprovar uma permissão');
    for (let i = 0; i < 20; i++) {
      clock.advance(500);
      if (i === 5) office.setStatus(CURSOR, 'working');
      registry.tick();
    }
    expect(scans).toEqual([]);
    expect(registry.size).toBe(1);
    w.cancel();
  });

  it('tempo limite do hook: o pedido expira e libera quem espera', async () => {
    const { registry, clock } = setup();
    const id = registered(registry.register(cursorInput({ timeout_ms: 20_000 })));
    const w = registry.wait(id, 25_000)!;
    clock.advance(20_000 + EXPIRY_GRACE_MS);
    registry.tick();
    await expect(w.result).resolves.toEqual({ status: 'released', reason: 'expired' });
  });
});

describe('cursorToolView: nomes de ferramenta do Cursor', () => {
  it('Shell vira Bash (título pelo comando), MCP: vira mcp__ e Read vira o título do arquivo', () => {
    expect(cursorToolView('Shell', { command: 'npm test' }, '/p')).toMatchObject({ title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' });
    expect(cursorToolView('MCP:github__create_issue', { title: 'Bug' }).title).toBe('github - create_issue (MCP)');
    expect(cursorToolView('Read', { file_path: '/p/src/app.ts' }, '/p')).toMatchObject({ title: 'Read(src/app.ts)', text: 'Lendo app.ts' });
  });
});
