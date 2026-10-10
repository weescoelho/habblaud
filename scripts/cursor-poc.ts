// Harness local das POCs do Cursor (P0–P3). Roda no HOST, com tsx:
//
//   npm run cursor:poc:transcript -- --path <arquivo>   # caracteriza o transcript (json/jsonl/sqlite/opaco)
//   npm run cursor:poc:install    [-- --project [dir]]  # instala o hook "log tudo" em ~/.cursor/hooks.json
//   npm run cursor:poc:uninstall  [-- --project [dir]]  # remove só os hooks do harness
//   npm run cursor:poc:report                           # matriz "evento → dispara? (contagem) → campos"
//   npm run cursor:poc:decision   [-- --hold N]         # mede o bloqueio do hook de decisão contra um stub local
//
// O transcript do Cursor ainda não tem schema confirmado (lacuna C1): este harness só OBSERVA. Tudo é
// feito pelo próprio Node (`node:fs`/`node:sqlite`), sem binário externo, e nunca lança para formato
// desconhecido — um arquivo "opaco" é reportado como tal.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectTranscript, type TranscriptInspection } from '../server/sources/cursor/transcript';
import { quotePath, readSettings, tildify, writeSettings, type Settings } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** O hook "log tudo" do harness (instalado por `install`). */
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-cursor', 'poc-hook.mjs');
/** O hook REAL de decisão/observação do Cursor (T14) — o alvo medido pelo subcomando `decision`. */
export const DECISION_HOOK = join(ROOT, 'mod', 'habblaud-cursor', 'hook.mjs');
/** Segundos que o stub segura antes de decidir (padrão do subcomando `decision`). */
export const DEFAULT_HOLD_S = 2;
/** Limite seguro (segundos) de bloqueio do hook de decisão; acima disso, o harness avisa e sai ≠ 0. */
export const DEFAULT_SAFE_LIMIT_S = 5;
/** Reconhece o hook do harness pelo caminho do script no comando (independe do resto do comando). */
const SCRIPT_MARK = /habblaud-cursor[\\/]+poc-hook\.mjs/;
/** Eventos de hook candidatos do Cursor que o harness instala (para medir a cobertura real). */
export const HARNESS_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'afterAgentResponse',
  'afterAgentThought',
  'stop',
] as const;

const USAGE = `Uso: npm run cursor:poc:<subcomando> -- [opções]

  transcript --path <arquivo>   caracteriza o transcript (json/jsonl/sqlite/opaco) e lista
                                as chaves/tabelas observadas com contagens
  install [--project [dir]]     instala o hook "log tudo" em ~/.cursor/hooks.json
                                (com --project, em <dir>/.cursor/hooks.json; dir padrão = atual)
  uninstall [--project [dir]]   remove só os hooks do harness, preservando os demais
  report                        lê o diretório de captura e imprime a matriz
                                "evento → dispara? (contagem) → campos"
  decision [--hold <N>] [--limit <S>]
                                sobe um stub local, roda o hook de decisão com um
                                beforeShellExecution sintético e mede o bloqueio;
                                se N exceder o limite seguro S, avisa e sai ≠ 0

Opções:
  --hold <N>                    segundos que o stub segura antes de decidir (padrão: 2)
  --limit <S>                   limite seguro de bloqueio em segundos (padrão: 5)
  -h, --help                    mostra esta ajuda

Diretório de captura: HABBLAUD_CURSOR_POC_DIR ou ~/.habblaud/cursor-poc/.
O transcript do Cursor ainda não tem schema confirmado (lacuna C1): o inspetor reporta o que
observa e nunca lança para formato desconhecido.`;

/** Subcomandos do harness (cada um com as suas opções). */
export type RunOptions =
  | { command: 'transcript'; path: string }
  | { command: 'install'; project: string | boolean }
  | { command: 'uninstall'; project: string | boolean }
  | { command: 'report' }
  | { command: 'decision'; holdS: number; limitS: number };

class FatalError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Segundos positivos de uma opção (`--hold`/`--limit`), ou erro claro. */
function positiveSeconds(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new FatalError(`${flag} precisa de um número de segundos > 0.`);
  return n;
}

/** Lê os argumentos do harness. Sem subcomando (ou `--help`) devolve `'help'` (uso, saída 0). */
export function parseArgs(argv: string[]): RunOptions | 'help' {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) return 'help';
  const [command, ...rest] = argv;
  if (command === 'transcript') {
    let path: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--path') {
        path = rest[++i];
        if (!path) throw new FatalError('--path precisa de um arquivo.');
      } else {
        throw new FatalError(`opção desconhecida: ${a}`);
      }
    }
    if (!path) throw new FatalError('transcript precisa de --path <arquivo>.');
    return { command: 'transcript', path };
  }
  if (command === 'install' || command === 'uninstall') {
    let project: string | boolean = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a !== '--project') throw new FatalError(`opção desconhecida: ${a}`);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        project = resolve(next);
        i++;
      } else {
        project = true;
      }
    }
    return { command, project };
  }
  if (command === 'report') {
    if (rest.length) throw new FatalError(`opção desconhecida: ${rest[0]}`);
    return { command: 'report' };
  }
  if (command === 'decision') {
    let holdS = DEFAULT_HOLD_S;
    let limitS = DEFAULT_SAFE_LIMIT_S;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--hold') holdS = positiveSeconds(rest[++i], '--hold');
      else if (a === '--limit') limitS = positiveSeconds(rest[++i], '--limit');
      else throw new FatalError(`opção desconhecida: ${a}`);
    }
    return { command: 'decision', holdS, limitS };
  }
  throw new FatalError(`subcomando desconhecido: ${command}\n\n${USAGE}`);
}

// ---------------------------------------------------------------- transcript (P0)

/** Linhas do relatório de um transcript (classificação + chaves/tabelas observadas). */
export function formatInspection(info: TranscriptInspection): string[] {
  const lines = [`Formato: ${info.format}`];
  if (info.format === 'opaco') {
    if (info.note) lines.push(`Nota: ${info.note}`);
    return lines;
  }
  if (info.format === 'jsonl') {
    lines.push(`Linhas: ${info.lines ?? 0}`);
    lines.push(`Papéis: ${info.roles.length ? info.roles.join(', ') : '(nenhum)'}`);
    lines.push(`Tool-calls: ${info.hasToolCalls ? 'sim' : 'não'}`);
  } else if (info.format === 'json') {
    lines.push(`Tool-calls: ${info.hasToolCalls ? 'sim' : 'não'}`);
  }
  if (info.tables.length) {
    lines.push('Tabelas:');
    for (const t of info.tables) lines.push(`  ${t.name}  ${t.count}`);
  }
  if (info.keys.length) {
    lines.push('Chaves:');
    for (const k of info.keys) lines.push(`  ${k.key}  ${k.count}`);
  }
  return lines;
}

// ---------------------------------------------------------------- install/uninstall (P1)

/** Comando que roda o hook do harness (node + caminho do script). */
export function hookCommand(hookPath: string): string {
  return `node ${quotePath(hookPath)}`;
}

/** Uma entrada de hook é do harness? (o comando aponta para o `poc-hook.mjs`). */
function isOurEntry(entry: unknown): boolean {
  return isObject(entry) && typeof entry.command === 'string' && SCRIPT_MARK.test(entry.command);
}

export type PlanAction =
  | { action: 'install'; settings: Settings; message: string }
  | { action: 'uninstall'; settings: Settings; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

/**
 * Plano de instalação no formato PLANO do Cursor (`{"version":1,"hooks":{<evento>:[entradas]}}`):
 * acrescenta uma entrada do harness no FIM de cada evento, sem tocar nas entradas existentes.
 * Idempotente: com uma entrada nossa no fim, não há mudança.
 */
export function planInstall(settings: Settings, command: string, events: readonly string[]): PlanAction {
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return { action: 'skip', message: 'hooks em formato desconhecido; nada foi alterado' };
  const hooks: Record<string, unknown[]> = isObject(settings.hooks) ? { ...(settings.hooks as Record<string, unknown[]>) } : {};
  let changed = false;
  for (const event of events) {
    const cur = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = cur.filter((e) => !isOurEntry(e));
    const next = [...kept, { command }];
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      hooks[event] = next;
      changed = true;
    }
  }
  if (!changed) return { action: 'none', message: 'já instalado' };
  const out: Settings = { ...settings, hooks };
  if (out.version === undefined) out.version = 1;
  return { action: 'install', settings: out, message: `hooks do harness instalados (${events.length} eventos)` };
}

/** Plano de remoção: tira SÓ as entradas do harness (e os eventos que ficarem sem entradas). */
export function planUninstall(settings: Settings): PlanAction {
  if (!isObject(settings.hooks)) return { action: 'none', message: 'não estava instalado' };
  const hooks: Record<string, unknown[]> = {};
  let removed = 0;
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) {
      hooks[event] = list as unknown[];
      continue;
    }
    const kept = list.filter((e) => !isOurEntry(e));
    removed += list.length - kept.length;
    if (kept.length) hooks[event] = kept;
  }
  if (!removed) return { action: 'none', message: 'não estava instalado' };
  return { action: 'uninstall', settings: { ...settings, hooks }, message: `hooks do harness removidos (${removed})` };
}

// ---------------------------------------------------------------- report (P1)

/** Diretório de captura: HABBLAUD_CURSOR_POC_DIR (com `~` expandido) ou ~/.habblaud/cursor-poc/. */
export function captureDirOf(env: NodeJS.ProcessEnv, home: string): string {
  const custom = typeof env.HABBLAUD_CURSOR_POC_DIR === 'string' ? env.HABBLAUD_CURSOR_POC_DIR.trim() : '';
  if (custom) return resolve(custom.replace(/^~(?=[\\/]|$)/, home));
  return join(home, '.habblaud', 'cursor-poc');
}

interface CapturedEvent {
  name: string;
  fields: string[];
}

/** Lê o `events.jsonl` da captura (linhas inválidas são ignoradas; nunca lança). */
export function readCapturedEvents(file: string): CapturedEvent[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: CapturedEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as { event?: unknown };
      if (!isObject(rec.event)) continue;
      const event = rec.event;
      const name = typeof event.hook_event_name === 'string' ? event.hook_event_name : typeof event.event === 'string' ? event.event : '(sem nome)';
      out.push({ name, fields: Object.keys(event).sort() });
    } catch {
      // linha corrompida: ignora
    }
  }
  return out;
}

/** Matriz Markdown "evento → dispara? (contagem) → campos" (eventos do harness não vistos saem como "não"). */
export function reportMatrix(events: readonly CapturedEvent[]): string[] {
  const counts = new Map<string, number>();
  const fields = new Map<string, Set<string>>();
  for (const e of events) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    let set = fields.get(e.name);
    if (!set) fields.set(e.name, (set = new Set()));
    for (const f of e.fields) set.add(f);
  }
  const names = [...new Set<string>([...HARNESS_EVENTS, ...counts.keys()])].sort((a, b) => {
    const ca = counts.get(a) ?? 0;
    const cb = counts.get(b) ?? 0;
    return ca !== cb ? cb - ca : a < b ? -1 : a > b ? 1 : 0;
  });
  const lines = ['| Evento | Dispara? | Contagem | Campos |', '| --- | --- | --- | --- |'];
  for (const name of names) {
    const count = counts.get(name) ?? 0;
    const used = [...(fields.get(name) ?? [])].sort().join(', ');
    lines.push(`| ${name} | ${count ? 'sim' : 'não'} | ${count} | ${used} |`);
  }
  return lines;
}

// ---------------------------------------------------------------- decision (P2)

interface DecisionStub {
  base: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Stub local do "escritório" para medir o bloqueio: aceita `POST /api/cursor/events` (200) e
 * `POST /api/permissions` (201 com id) e, em `GET /api/permissions/:id/wait`, segura `holdMs` e então
 * decide `allow` — é o atraso que o hook de decisão sente na pele.
 */
function startDecisionStub(holdMs: number): Promise<DecisionStub> {
  const server = createServer((req, res) => {
    req.resume();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/cursor/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/permissions') {
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'poc-decision' }));
      return;
    }
    if (req.method === 'GET' && /^\/api\/permissions\/[^/]+\/wait$/.test(url.pathname)) {
      const timer = setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'decided', behavior: 'allow' }));
      }, holdMs);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      ok({
        base: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

interface HookRunResult {
  code: number | null;
  stdout: string;
  ms: number;
}

/** Roda o hook de decisão com um evento sintético contra o stub (HOME falso, porta pelo HABBLAUD_PORT). */
function runDecisionHook(hookPath: string, event: unknown, port: number, home: string): Promise<HookRunResult> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [hookPath], {
      env: { PATH: process.env.PATH, HOME: home, HABBLAUD_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.resume();
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, ms: Date.now() - t0 });
    });
    child.stdin.end(JSON.stringify(event));
  });
}

/** Mede o bloqueio do hook de decisão contra o stub e avisa se `hold` excede o limite seguro. */
async function runDecision(opts: { holdS: number; limitS: number }, ctx: RunContext): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), 'habblaud-cursor-decision-'));
  const stub = await startDecisionStub(opts.holdS * 1_000);
  try {
    ctx.out(`Stub no ar em ${stub.base}, segurando ${opts.holdS} s antes de decidir.`);
    const event = { hook_event_name: 'beforeShellExecution', conversation_id: 'poc-decision', cwd: ctx.cwd, command: 'echo poc' };
    const r = await runDecisionHook(DECISION_HOOK, event, stub.port, home);
    const sec = r.ms / 1_000;
    const text = r.stdout.trim();
    let decision: { permission?: unknown } | undefined;
    try {
      decision = text ? (JSON.parse(text) as { permission?: unknown }) : undefined;
    } catch {
      decision = undefined;
    }
    const applied = decision?.permission === 'allow';
    ctx.out(`Hook bloqueou por ${sec.toFixed(2)} s e ${applied ? `aplicou a decisão: ${text}` : `não aplicou decisão (${text || 'saída vazia'})`}.`);
    ctx.out(`Bloqueio medido: ${sec.toFixed(2)} s (pedido: ${opts.holdS} s).`);
    if (opts.holdS > opts.limitS) {
      ctx.err(`✗ Limite seguro observado: ${opts.limitS} s — ${opts.holdS} s excede o limite seguro; reduza a espera do hook (decisionTimeoutS).`);
      return 1;
    }
    if (r.code !== 0) {
      ctx.err(`✗ o hook saiu com código ${r.code}.`);
      return 1;
    }
    if (!applied) {
      ctx.err('✗ o hook não aplicou a decisão esperada; confira a saída do hook.');
      return 1;
    }
    ctx.out(`✓ Dentro do limite seguro (${opts.limitS} s).`);
    return 0;
  } finally {
    await stub.close();
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- execução

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  now: Date;
  out: (line: string) => void;
  err: (line: string) => void;
}

function hooksFileOf(ctx: RunContext, project: string | boolean): string {
  if (project === false) return join(ctx.home, '.cursor', 'hooks.json');
  const dir = typeof project === 'string' ? project : ctx.cwd;
  return join(dir, '.cursor', 'hooks.json');
}

/** Executa o subcomando. Devolve o código de saída (0 = sucesso). Nunca lança para dados estranhos. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  switch (opts.command) {
    case 'transcript':
      return runTranscript(opts, ctx);
    case 'install':
      return runInstall(ctx, opts.project);
    case 'uninstall':
      return runUninstall(ctx, opts.project);
    case 'report':
      return runReport(ctx);
    case 'decision':
      return runDecision(opts, ctx);
  }
}

function runTranscript(opts: { path: string }, ctx: RunContext): number {
  if (!existsSync(opts.path)) {
    ctx.err(`Arquivo não encontrado: ${opts.path}`);
    return 1;
  }
  // `inspectTranscript` nunca lança para formato desconhecido; erros de leitura (permissão, corrida)
  // ainda podem subir — o chamador os transforma em saída ≠ 0.
  const info = inspectTranscript(opts.path);
  for (const line of formatInspection(info)) ctx.out(line);
  return 0;
}

/** Lê o hooks.json do destino, aplica o plano e grava com backup. 0 = ok, 1 = erro. */
function applyPlan(ctx: RunContext, file: string, plan: PlanAction): number {
  const label = tildify(file, ctx.home);
  if (plan.action === 'none') {
    ctx.out(`= ${label}: ${plan.message}`);
    return 0;
  }
  if (plan.action === 'skip') {
    ctx.err(`✗ ${label}: ${plan.message}`);
    return 1;
  }
  const read = readSettings(file);
  if ('error' in read) {
    ctx.err(`✗ ${label}: ${read.error}`);
    return 1;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const backup = writeSettings(file, plan.settings, read.raw, ctx.now);
    ctx.out(`✓ ${label}: ${plan.message}${backup ? ` · backup em ${tildify(backup, ctx.home)}` : ''}`);
    return 0;
  } catch (err) {
    ctx.err(`✗ ${label}: não consegui gravar (${(err as Error).message})`);
    return 1;
  }
}

function runInstall(ctx: RunContext, project: string | boolean): number {
  const file = hooksFileOf(ctx, project);
  const read = readSettings(file);
  if ('error' in read) {
    ctx.err(`✗ ${tildify(file, ctx.home)}: ${read.error}`);
    return 1;
  }
  return applyPlan(ctx, file, planInstall(read.settings, hookCommand(HOOK_SCRIPT), HARNESS_EVENTS));
}

function runUninstall(ctx: RunContext, project: string | boolean): number {
  const file = hooksFileOf(ctx, project);
  const read = readSettings(file);
  if ('error' in read) {
    ctx.err(`✗ ${tildify(file, ctx.home)}: ${read.error}`);
    return 1;
  }
  return applyPlan(ctx, file, planUninstall(read.settings));
}

function runReport(ctx: RunContext): number {
  const dir = captureDirOf(ctx.env, ctx.home);
  const events = readCapturedEvents(join(dir, 'events.jsonl'));
  if (!events.length) {
    ctx.out(`Nenhum evento capturado em ${tildify(dir, ctx.home)}.`);
    ctx.out('Instale o hook (npm run cursor:poc:install) e use o Cursor; depois rode o report de novo.');
    return 0;
  }
  for (const line of reportMatrix(events)) ctx.out(line);
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  process.exitCode = await run(parsed, {
    env: process.env,
    home: process.env.HOME || homedir(),
    cwd: process.cwd(),
    now: new Date(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[cursor-poc] Erro: ${err.message}` : `[cursor-poc] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
