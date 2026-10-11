// Hook de decisão e observação do Cursor (mod/habblaud-cursor/hook.mjs) rodado como processo de verdade contra o
// servidor de teste (rotas de verdade e uma fonte do Cursor falsa): eventos de observação (sem saída) — por padrão
// beforeReadFile/preToolUse também são observação —, a configuração em ~/.habblaud/cursor-hook.json (porta, espera,
// decisionEvents e rules), a decisão local por regra (sem rede), os eventos de decisão (beforeShellExecution e
// beforeMCPExecution) — aprovar, recusar, tempo esgotado, Habblaud fora do ar e stdin inválido — e o contrato do
// suggest_rule. O schema dos hooks do Cursor ainda não está confirmado (lacuna C1): o stdin é sintético, e o hook lê
// com aliases defensivos.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';
import { CURSOR_MAIN, CURSOR_CONV, servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const HOOK = resolve(__dirname, '../../mod/habblaud-cursor/hook.mjs');

/** Funções exportadas pelo hook (JavaScript puro, sem tipos). */
interface HookModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number; waitMs: number };
  permissionBody(input: Record<string, unknown>, timeoutMs: number): Record<string, unknown>;
  decisionOutput(result: unknown): unknown;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

/** Fonte do Cursor falsa: guarda os eventos recebidos. */
class FakeLive {
  calls: Array<{ input: Record<string, unknown> }> = [];
  applyHookEvent(input: Record<string, unknown>): boolean {
    this.calls.push({ input });
    return true;
  }
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

let tmp: ReturnType<typeof tempDir>;
let home: string;
let srv: PermissionServer | undefined;
let live: FakeLive;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  live = new FakeLive();
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  tmp.cleanup();
});

/** ~/.habblaud/cursor-hook.json no HOME falso. */
function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'cursor-hook.json'), JSON.stringify(cfg));
}

function runHook(stdin: string, env: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/** JSON (sintético) de um evento de hook do Cursor. */
function cursorEvent(event: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: CURSOR_CONV,
    workspace_roots: ['/p/loja'],
    cwd: '/p/loja',
    hook_event_name: event,
    ...over,
  };
}

/** Um comando prestes a rodar (beforeShellExecution, com o `command` que a IDE manda). */
const beforeShell = (over: Record<string, unknown> = {}) => cursorEvent('beforeShellExecution', { command: 'npm test', description: 'Rodar os testes', ...over });

/** Uma ferramenta MCP prestes a rodar. */
const beforeMcp = (over: Record<string, unknown> = {}) => cursorEvent('beforeMCPExecution', { tool_name: 'MCP:github__create_issue', tool_input: { title: 'Bug' }, ...over });

/** Uma leitura de arquivo prestes a acontecer (beforeReadFile, com o file_path). */
const beforeRead = (over: Record<string, unknown> = {}) => cursorEvent('beforeReadFile', { file_path: '/p/loja/src/app.ts', ...over });

/** Um uso de ferramenta prestes a acontecer (preToolUse, com tool_name/tool_input). */
const preTool = (over: Record<string, unknown> = {}) => cursorEvent('preToolUse', { tool_name: 'Read', tool_input: { file_path: '/p/loja/README.md' }, ...over });

async function pendingId(s: PermissionServer): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = s.registry!.snapshot().get(CURSOR_MAIN)?.id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('o hook não registrou o pedido');
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

describe('hook.mjs do Cursor (processo)', () => {
  it('evento de observação: vai para /api/cursor/events; nada no stdout, sai 0 e não registra pedido', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port });
    const input = cursorEvent('afterShellExecution', { command: 'ls', exit_code: 0 });
    const r = await runHook(JSON.stringify(input));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(live.calls).toEqual([{ input }]);
    expect(srv.registry!.size).toBe(0);
  });

  it('beforeShellExecution aprovado no Habblaud: manda o evento, registra provider cursor e imprime {"permission":"allow"}', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port, decisionTimeoutS: 30 });
    const run = runHook(JSON.stringify(beforeShell()));
    const id = await pendingId(srv);
    expect(live.calls.map((c) => c.input.hook_event_name)).toEqual(['beforeShellExecution']);
    const info = srv.registry!.detail(id)!;
    expect(info).toMatchObject({ provider: 'cursor', tool: 'Shell', title: 'Bash(npm test)' });
    // A espera do arquivo (30 s) vira o prazo do pedido no escritório.
    expect(info.expiresAt - info.createdAt).toBeGreaterThan(25_000);
    expect(info.expiresAt - info.createdAt).toBeLessThanOrEqual(30_000);
    expect(srv.registry!.decide(id, { behavior: 'allow' })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"permission":"allow"}\n');
  });

  it('beforeMCPExecution recusado com motivo: {"permission":"deny","user_message":...}; terminais são liberados', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port });
    let run = runHook(JSON.stringify(beforeMcp()));
    expect(srv.registry!.decide(await pendingId(srv), { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    let r = await run;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ permission: 'deny', user_message: 'Recusado pelo usuário no Habblaud: use pnpm' });
    // "responder no terminal" libera sem decisão (nada no stdout).
    run = runHook(JSON.stringify(beforeShell()));
    srv.registry!.decide(await pendingId(srv), { behavior: 'terminal' });
    r = await run;
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('beforeReadFile e preToolUse são observação por padrão: vão ao escritório sem registrar pedido nem bloquear', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port });
    let r = await runHook(JSON.stringify(beforeRead()));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    r = await runHook(JSON.stringify(preTool()));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(live.calls.map((c) => c.input.hook_event_name)).toEqual(['beforeReadFile', 'preToolUse']);
    expect(srv.registry!.size).toBe(0);
  });

  it('decisionEvents reativa beforeReadFile: o pedido volta a ser registrado (degradação graciosa)', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port, decisionEvents: ['beforeReadFile'] });
    const run = runHook(JSON.stringify(beforeRead()));
    const id = await pendingId(srv);
    expect(srv.registry!.detail(id)).toMatchObject({ provider: 'cursor', tool: 'Read', title: 'Read(src/app.ts)' });
    srv.registry!.decide(id, { behavior: 'allow' });
    expect((await run).stdout).toBe('{"permission":"allow"}\n');
  });

  it('regra allow da política local: decide na hora, sem nenhuma requisição, e registra a decisão', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port, rules: [{ tool: 'Shell', pattern: '^npm test(\\s|$)', effect: 'allow', note: 'npm test' }] });
    const r = await runHook(JSON.stringify(beforeShell()));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"permission":"allow"}\n');
    expect(r.ms).toBeLessThan(2_000);
    expect(live.calls).toHaveLength(0);
    expect(srv.registry!.size).toBe(0);
    const lines = readFileSync(join(home, '.habblaud', 'cursor-decisions.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'beforeShellExecution', tool: 'Shell', effect: 'allow', pattern: '^npm test(\\s|$)' });
  });

  it('regra deny da política local: recusa com o motivo, sem contatar o escritório', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port, rules: [{ tool: 'Shell', pattern: '^rm -rf', effect: 'deny', note: 'comando destrutivo' }] });
    const r = await runHook(JSON.stringify(beforeShell({ command: 'rm -rf /' })));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ permission: 'deny', user_message: 'Recusado pela regra local do Habblaud: comando destrutivo' });
    expect(live.calls).toHaveLength(0);
  });

  it('regra inválida na política (regex que não compila) é ignorada: volta ao fluxo anterior (registrar e esperar)', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port, rules: [{ tool: 'Shell', pattern: '(', effect: 'allow' }] });
    const run = runHook(JSON.stringify(beforeShell()));
    const id = await pendingId(srv);
    srv.registry!.decide(id, { behavior: 'allow' });
    expect((await run).stdout).toBe('{"permission":"allow"}\n');
  });

  it('HABBLAUD_PORT vale como reserva quando o arquivo não tem a porta', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    const run = runHook(JSON.stringify(beforeShell()), { HABBLAUD_PORT: String(srv.port) });
    srv.registry!.decide(await pendingId(srv), { behavior: 'allow' });
    expect((await run).stdout).toBe('{"permission":"allow"}\n');
  });

  it('Habblaud fora do ar, sem página aberta ou conversa desconhecida: sai rápido, sem decisão', async () => {
    writeConfig({ port: await deadPort() });
    let r = await runHook(JSON.stringify(beforeShell()));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    srv = await servePermissions({ cursor: true, cursorLive: live, viewers: 0 });
    writeConfig({ port: srv.port });
    r = await runHook(JSON.stringify(beforeShell()));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    r = await runHook(JSON.stringify(beforeShell({ conversation_id: 'conversa-desconhecida' })));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(srv.registry!.size).toBe(0);
  });

  it('espera esgotada (decisionTimeoutS: 5): desiste e sai sem decisão (a IDE segue o fluxo normal)', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live, registry: { orphanMs: 300 } });
    writeConfig({ port: srv.port, decisionTimeoutS: 5 });
    const r = await runHook(JSON.stringify(beforeShell()));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(4_500);
    expect(r.ms).toBeLessThan(10_000);
  }, 20_000);

  it('stdin inválido ou evento que o Habblaud não usa: sai 0 e nada é mandado', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port });
    for (const stdin of ['', 'não é json', '[]', JSON.stringify({ hook_event_name: 5 }), JSON.stringify(cursorEvent('eventoEstranho'))]) {
      const r = await runHook(stdin);
      expect(r, stdin).toMatchObject({ code: 0, stdout: '' });
    }
    expect(live.calls).toHaveLength(0);
  });

  it('evento de decisão sem conversa ou ferramenta: observa, mas não registra pedido', async () => {
    srv = await servePermissions({ cursor: true, cursorLive: live });
    writeConfig({ port: srv.port });
    let r = await runHook(JSON.stringify(cursorEvent('beforeShellExecution', { conversation_id: undefined })));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    r = await runHook(JSON.stringify(cursorEvent('beforeReadFile')));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(srv.registry!.size).toBe(0);
  });
});

describe('hook.mjs do Cursor (funções)', () => {
  it('readConfig: arquivo, reserva HABBLAUD_PORT, padrões e limites da espera', () => {
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4851, waitMs: 25_000 });
    writeConfig({ port: 4900, decisionTimeoutS: 60 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4900, waitMs: 60_000 });
    writeConfig({ port: 'x', decisionTimeoutS: 1 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 5_000 });
    writeConfig({ decisionTimeoutS: 999 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 120_000 });
    writeFileSync(join(home, '.habblaud', 'cursor-hook.json'), '{ quebrado');
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
  });

  it('permissionBody: provider cursor, sessão pela conversa, a ferramenta derivada e o suggest_rule do "sempre permitir"', () => {
    const body = hook.permissionBody(beforeShell({ command: 'y'.repeat(20_000) }), 25_000);
    expect(Object.keys(body).sort()).toEqual(['cwd', 'provider', 'session_id', 'suggest_rule', 'timeout_ms', 'tool_input', 'tool_name']);
    expect(body).toMatchObject({ provider: 'cursor', session_id: CURSOR_CONV, tool_name: 'Shell', timeout_ms: 25_000, cwd: '/p/loja' });
    expect((body.tool_input as { command: string }).command.length).toBe(8_000);
    expect(body.suggest_rule).toEqual({ tool: 'Shell', pattern: `^${'y'.repeat(8_000)}(\\s|$)`, effect: 'allow', note: 'y'.repeat(8_000) });

    const mcp = hook.permissionBody(beforeMcp(), 25_000);
    expect(mcp).toMatchObject({ provider: 'cursor', session_id: CURSOR_CONV, tool_name: 'MCP:github__create_issue', tool_input: { title: 'Bug' } });
    expect(mcp.suggest_rule).toEqual({ tool: 'MCP:github__create_issue', pattern: '^MCP:github__create_issue$', effect: 'allow', note: 'MCP:github__create_issue' });

    const read = hook.permissionBody(beforeRead(), 25_000);
    expect(read).toMatchObject({ tool_name: 'Read', tool_input: { file_path: '/p/loja/src/app.ts' } });
    expect(read.suggest_rule).toEqual({ tool: 'Read', pattern: '^/p/loja/src/app\\.ts', effect: 'allow', note: '/p/loja/src/app.ts' });

    // Shell sem comando: não há sujeito para derivar a regra (sem botão "sempre permitir").
    const noSubject = hook.permissionBody({ hook_event_name: 'beforeShellExecution', conversation_id: CURSOR_CONV }, 25_000);
    expect(noSubject.suggest_rule).toBeUndefined();
  });

  it('decisionOutput: só allow e deny (+user_message); nunca outra coisa', () => {
    expect(hook.decisionOutput({ status: 'decided', behavior: 'allow', suggestion: 0 })).toEqual({ permission: 'allow' });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'deny', message: 'use pnpm' })).toEqual({ permission: 'deny', user_message: 'Recusado pelo usuário no Habblaud: use pnpm' });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'deny' })).toEqual({ permission: 'deny', user_message: 'Recusado pelo usuário no Habblaud.' });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'answer', answers: [] })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'released', reason: 'terminal' })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'pending' })).toBeUndefined();
    expect(hook.decisionOutput(undefined)).toBeUndefined();
  });
});