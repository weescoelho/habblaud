// Harness local das POCs do Cursor (P0–P3). Roda no HOST, com tsx:
//
//   npm run cursor:poc:transcript -- --path <arquivo>   # caracteriza o transcript (json/jsonl/sqlite/opaco)
//   npm run cursor:poc:install    [-- --project [dir]]  # instala o hook "log tudo" em ~/.cursor/hooks.json
//   npm run cursor:poc:uninstall  [-- --project [dir]]  # remove só os hooks do harness
//   npm run cursor:poc:report                           # matriz "evento → dispara? (contagem) → campos"
//   npm run cursor:poc:subagents                        # correlaciona subagentStart/subagentStop (P4)
//   npm run cursor:poc:cli        [-- --path <arquivo>] # caracteriza o NDJSON do cursor-agent (P5)
//   npm run cursor:poc:followup   [-- --message <texto>] # roda o probe do `stop` e valida a forma (P6)
//   npm run cursor:poc:usage      [-- --path <dir>]     # lista os candidatos de uso/plano do Cursor (P8)
//   npm run cursor:poc:decision   [-- --hold N]         # mede o bloqueio do hook de decisão contra um stub local
//
// O transcript do Cursor ainda não tem schema confirmado (lacuna C1): este harness só OBSERVA. Tudo é
// feito pelo próprio Node (`node:fs`/`node:sqlite`), sem binário externo, e nunca lança para formato
// desconhecido — um arquivo "opaco" é reportado como tal.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyTranscript, inspectTranscript, type TranscriptInspection } from '../server/sources/cursor/transcript';
import { quotePath, readSettings, tildify, writeSettings, type Settings } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** O hook "log tudo" do harness (instalado por `install`). */
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-cursor', 'poc-hook.mjs');
/** O hook REAL de decisão/observação do Cursor (T14) — o alvo medido pelo subcomando `decision`. */
export const DECISION_HOOK = join(ROOT, 'mod', 'habblaud-cursor', 'hook.mjs');
/** O probe de followup do harness (P6) — o alvo validado pelo subcomando `followup`. */
export const FOLLOWUP_HOOK = join(ROOT, 'mod', 'habblaud-cursor', 'followup-hook.mjs');
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
  'subagentStart',
  'subagentStop',
] as const;

const USAGE = `Uso: npm run cursor:poc:<subcomando> -- [opções]

  transcript --path <arquivo>   caracteriza o transcript (json/jsonl/sqlite/opaco) e lista
                                as chaves/tabelas observadas com contagens
  install [--project [dir]]     instala o hook "log tudo" em ~/.cursor/hooks.json
                                (com --project, em <dir>/.cursor/hooks.json; dir padrão = atual)
  uninstall [--project [dir]]   remove só os hooks do harness, preservando os demais
  report                        lê o diretório de captura e imprime a matriz
                                "evento → dispara? (contagem) → campos"
  subagents                     lê o diretório de captura e correlaciona
                                subagentStart/subagentStop por id (pares, órfãos, sem id)
  cli [--path <arquivo>]        lê o NDJSON do CLI (cursor-agent -p --output-format
                                stream-json) do arquivo ou do stdin e conta tipos/ferramentas
  usage [--path <dir>]          varre os locais de uso/plano do Cursor (~/.cursor,
                                ~/.cursor-server, ~/.config/Cursor; ou --path) e lista os
                                candidatos (JSON: chaves de topo; SQLite: tabelas+contagens),
                                sem rede e sem imprimir valores
  followup [--message <texto>]  roda o probe de followup com um stop sintético e valida
                                a forma {"followup_message": <texto>} (P6)
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
  | { command: 'subagents' }
  | { command: 'cli'; path?: string }
  | { command: 'usage'; path?: string }
  | { command: 'followup'; message?: string }
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
  if (command === 'subagents') {
    if (rest.length) throw new FatalError(`opção desconhecida: ${rest[0]}`);
    return { command: 'subagents' };
  }
  if (command === 'cli') {
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
    return { command: 'cli', path };
  }
  if (command === 'usage') {
    let path: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--path') {
        path = rest[++i];
        if (!path) throw new FatalError('--path precisa de um diretório.');
      } else {
        throw new FatalError(`opção desconhecida: ${a}`);
      }
    }
    return { command: 'usage', path };
  }
  if (command === 'followup') {
    let message: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--message') {
        message = rest[++i];
        if (message === undefined) throw new FatalError('--message precisa de um texto.');
      } else {
        throw new FatalError(`opção desconhecida: ${a}`);
      }
    }
    return { command: 'followup', message };
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

export interface CapturedEvent {
  name: string;
  fields: string[];
  /** O evento cru (para correlações que precisam de valores, como os ids de subagente). */
  event: Record<string, unknown>;
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
      out.push({ name, fields: Object.keys(event).sort(), event });
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

// ---------------------------------------------------------------- subagents (P4)

/** Um par de eventos de subagente correlacionados pelo id (Start e, quando houver, Stop). */
export interface SubagentPair {
  id?: string;
  parent?: string;
  start?: CapturedEvent;
  stop?: CapturedEvent;
  complete: boolean;
}

/** Resultado da correlação: pares, órfãos (Stop sem Start) e eventos de subagente sem id. */
export interface SubagentCorrelation {
  pairs: SubagentPair[];
  orphans: CapturedEvent[];
  uncorrelated: CapturedEvent[];
  total: number;
}

const SUBAGENT_EVENTS = new Set(['subagentStart', 'subagentStop']);

/** Id de correlação de um evento de subagente (aceita os aliases conhecidos; `undefined` se não houver). */
function subagentIdOf(ev: CapturedEvent): string | undefined {
  for (const key of ['subagent_id', 'subagentId', 'id', 'conversation_id', 'conversationId']) {
    const v = ev.event[key];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Pai do subagente, quando algum dos eventos traz `parent_conversation_id`. */
function subagentParentOf(...evs: Array<CapturedEvent | undefined>): string | undefined {
  for (const ev of evs) {
    if (!ev) continue;
    const v = ev.event.parent_conversation_id ?? ev.event.parentConversationId;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Correlaciona os `subagentStart`/`subagentStop` capturados pelo id: Stop que casa um Start vira
 * par (`complete`); Stop sem Start vira órfão; evento de subagente sem id vira `uncorrelated`.
 * Eventos de outros tipos são ignorados. Nunca lança.
 */
export function correlateSubagents(events: readonly CapturedEvent[]): SubagentCorrelation {
  const byId = new Map<string, SubagentPair>();
  const uncorrelated: CapturedEvent[] = [];
  let total = 0;
  for (const ev of events) {
    if (!SUBAGENT_EVENTS.has(ev.name)) continue;
    total++;
    const id = subagentIdOf(ev);
    if (!id) {
      uncorrelated.push(ev);
      continue;
    }
    let pair = byId.get(id);
    if (!pair) byId.set(id, (pair = { id, complete: false }));
    if (ev.name === 'subagentStart') {
      if (!pair.start) pair.start = ev;
    } else if (!pair.stop) {
      pair.stop = ev;
    }
  }
  const pairs: SubagentPair[] = [];
  const orphans: CapturedEvent[] = [];
  for (const pair of byId.values()) {
    pair.parent = subagentParentOf(pair.start, pair.stop);
    pair.complete = !!pair.start && !!pair.stop;
    if (pair.start) pairs.push(pair);
    else if (pair.stop) orphans.push(pair.stop);
  }
  return { pairs, orphans, uncorrelated, total };
}

// ---------------------------------------------------------------- cli (P5)

/** Resumo do NDJSON do CLI: contagem por tipo, ferramentas, `session_id` e linhas ilegíveis. */
export interface CliSummary {
  kinds: Map<string, number>;
  tools: Map<string, number>;
  sessionId?: string;
  malformed: number;
}

/** Primeira string útil (aliases defensivos); `undefined` se nenhuma. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

/** Nomes de ferramenta citados por um evento do stream, cobrindo os dois estilos conhecidos. */
function toolNamesOf(kind: string, rec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    const s = firstString(v);
    if (s) out.push(s);
  };
  const single = isObject(rec.tool_call) ? rec.tool_call : undefined;
  if (single) add(firstString(single.tool_name, single.toolName, single.name));
  if (Array.isArray(rec.tool_calls)) {
    for (const item of rec.tool_calls) {
      if (!isObject(item)) continue;
      const fn = isObject(item.function) ? item.function : undefined;
      add(firstString(fn?.name, item.name, item.tool_name));
    }
  }
  if (kind === 'tool_call' || kind === 'tool_use' || kind === 'tool') {
    add(firstString(rec.tool_name, rec.toolName, rec.name));
  }
  return out;
}

/**
 * Caracteriza um NDJSON do CLI: conta os tipos (`type`/`kind`/`event`), extrai o `session_id` e os
 * nomes de ferramenta, e conta as linhas não-JSON como ilegíveis (linhas vazias são puladas).
 * Nunca lança.
 */
export function parseCliStream(text: string): CliSummary {
  const kinds = new Map<string, number>();
  const tools = new Map<string, number>();
  let sessionId: string | undefined;
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      rec = isObject(parsed) ? parsed : undefined;
    } catch {
      rec = undefined;
    }
    if (!rec) {
      malformed++;
      continue;
    }
    const kind = firstString(rec.type, rec.kind, rec.event) ?? '(sem tipo)';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (!sessionId) sessionId = firstString(rec.session_id, rec.sessionId);
    for (const name of toolNamesOf(kind, rec)) tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return { kinds, tools, sessionId, malformed };
}

/** Relatório legível do resumo do CLI (session_id, tipos e ferramentas). */
export function formatCliSummary(s: CliSummary): string[] {
  const total = [...s.kinds.values()].reduce((a, b) => a + b, 0);
  const calls = [...s.tools.values()].reduce((a, b) => a + b, 0);
  const byName = (a: [string, number], b: [string, number]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return [
    `Session-id: ${s.sessionId ?? '(nenhum)'}`,
    `Eventos: ${total} · ilegíveis: ${s.malformed}`,
    'Tipos:',
    ...[...s.kinds.entries()].sort(byName).map(([k, n]) => `  ${k}  ${n}`),
    `Ferramentas: ${s.tools.size} distintas, ${calls} chamadas`,
    ...[...s.tools.entries()].sort(byName).map(([k, n]) => `  ${k}  ${n}`),
  ];
}

// ---------------------------------------------------------------- usage (P8)

/** Um candidato a arquivo de uso/plano encontrado na varredura (só metadados; nunca o conteúdo). */
export interface UsageHit {
  path: string;
  kind: 'json' | 'sqlite' | 'other';
  size: number;
  mtimeMs: number;
}

/** Pastas que a varredura de uso IGNORA (não são estado de uso/plano, e `projects/` é o grosso). */
const IGNORED_USAGE_DIRS = new Set(['projects', 'plugins', 'extensions', 'node_modules']);

/** Nome de pasta ignorada: a lista fixa mais os diretórios de skills (`skills*`). */
function ignoredUsageDir(name: string): boolean {
  const n = name.toLowerCase();
  return IGNORED_USAGE_DIRS.has(n) || n.startsWith('skills');
}

/** Tokens que nomeiam um candidato a uso/plano (casa no NOME do arquivo, sem sensibilidade a caixa). */
const USAGE_NAME_RE = /usage|plan|limit|quota|billing|credit|ai-tracking|statsig|agent-cli-state|state\.vscdb/i;

/** Raízes candidatas de uso/plano para um `HOME` (o `--path` substitui esta lista). */
export function usageRoots(home: string): string[] {
  return [join(home, '.cursor'), join(home, '.cursor-server'), join(home, '.config', 'Cursor')];
}

/** Classifica um candidato por formato: SQLite pelo magic, JSON/JSONL pelo conteúdo, senão `other`. */
function usageKindOf(path: string): UsageHit['kind'] {
  const format = classifyTranscript(path);
  if (format === 'sqlite') return 'sqlite';
  if (format === 'json' || format === 'jsonl') return 'json';
  return 'other';
}

/** Acrescenta um candidato com metadados, se o `stat` funcionar (nunca lança). */
function pushUsageHit(out: UsageHit[], path: string): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  out.push({ path, kind: usageKindOf(path), size: st.size, mtimeMs: st.mtimeMs });
}

/**
 * Varre `root` (diretório, ou o próprio arquivo) e devolve os candidatos a uso/plano, pulando as
 * pastas de `IGNORED_USAGE_DIRS`/skills. Nunca lança: pasta ilegível é ignorada e arquivo ilegível
 * ainda entra (metadados). Ordenado por caminho para saída estável.
 */
export function scanUsage(root: string): UsageHit[] {
  const out: UsageHit[] = [];
  let st;
  try {
    st = statSync(root);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (USAGE_NAME_RE.test(basename(root))) pushUsageHit(out, root);
    return out;
  }
  const walk = (dir: string): void => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredUsageDir(entry.name)) walk(full);
        } else if (entry.isFile()) {
          if (USAGE_NAME_RE.test(entry.name)) pushUsageHit(out, full);
        }
      }
    } catch {
      // pasta ilegível: ignora
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Descreve o conteúdo de um candidato sem imprimir valores: JSON/JSONL → chaves de topo (e a
 * contagem); SQLite → nomes de tabela (e a contagem); senão → só uma nota de formato. Nunca lança.
 */
export function describeUsageFile(path: string): string[] {
  const info = inspectTranscript(path);
  if (info.format === 'json' || info.format === 'jsonl') {
    if (!info.keys.length) return ['JSON sem chaves de topo.'];
    return ['Chaves JSON:', ...info.keys.map((k) => `  ${k.key}  ${k.count}`)];
  }
  if (info.format === 'sqlite') {
    if (!info.tables.length) return ['SQLite sem tabelas.'];
    return ['Tabelas:', ...info.tables.map((t) => `  ${t.name}  ${t.count}`)];
  }
  return ['Formato não reconhecido (só metadados).'];
}

/** Linha de metadados de um candidato: caminho (com `~`), tamanho, mtime ISO e tipo. */
function formatUsageHit(hit: UsageHit, home: string): string {
  return `${tildify(hit.path, home)}  ${hit.size} B  ${new Date(hit.mtimeMs).toISOString()}  [${hit.kind}]`;
}

// ---------------------------------------------------------------- followup (P6)

/** Caminho do probe de followup: HABBLAUD_CURSOR_POC_FOLLOWUP_HOOK (testes) ou o probe do harness. */
export function followupHookPath(env: NodeJS.ProcessEnv): string {
  const custom = typeof env.HABBLAUD_CURSOR_POC_FOLLOWUP_HOOK === 'string' ? env.HABBLAUD_CURSOR_POC_FOLLOWUP_HOOK.trim() : '';
  return custom || FOLLOWUP_HOOK;
}

interface ProbeRunResult {
  code: number | null;
  stdout: string;
}

/** Spawna um hook com um evento no `stdin` e captura a saída (molde do `runDecisionHook`). */
function runProbe(hookPath: string, event: unknown, env: NodeJS.ProcessEnv): Promise<ProbeRunResult> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.resume();
    const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout });
    });
    child.stdin.end(JSON.stringify(event));
  });
}

/**
 * Roda o probe de followup com um `stop` sintético e valida que a saída é um JSON com
 * `followup_message` string. Saída inválida, código ≠ 0 ou erro do spawn → mensagem e código ≠ 0.
 */
async function runFollowup(opts: { message?: string }, ctx: RunContext): Promise<number> {
  const hook = followupHookPath(ctx.env);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: ctx.home };
  if (opts.message !== undefined) env.HABBLAUD_CURSOR_POC_FOLLOWUP = opts.message;
  let r: ProbeRunResult;
  try {
    r = await runProbe(hook, { hook_event_name: 'stop' }, env);
  } catch (err) {
    ctx.err(`✗ não consegui rodar o probe ${tildify(hook, ctx.home)} (${(err as Error).message}).`);
    return 1;
  }
  const text = r.stdout.trim();
  if (r.code !== 0) {
    ctx.err(`✗ o probe saiu com código ${r.code} (${text || 'sem saída'}).`);
    return 1;
  }
  let parsed: { followup_message?: unknown } | undefined;
  try {
    parsed = text ? (JSON.parse(text) as { followup_message?: unknown }) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed.followup_message !== 'string') {
    ctx.err(`✗ o probe não devolveu {"followup_message": <string>}: ${text || 'saída vazia'}.`);
    return 1;
  }
  ctx.out(`✓ followup_message: ${parsed.followup_message}`);
  return 0;
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
    case 'subagents':
      return runSubagents(ctx);
    case 'cli':
      return runCli(opts, ctx);
    case 'usage':
      return runUsage(opts, ctx);
    case 'followup':
      return runFollowup(opts, ctx);
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

/** Lê todo o `stdin` como texto; sem entrada (TTY) devolve string vazia (stream vazio). */
function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Caracteriza o NDJSON do CLI (`--path` ou `stdin`). Arquivo ausente/ilegível → erro e código ≠ 0. */
async function runCli(opts: { path?: string }, ctx: RunContext): Promise<number> {
  let text: string;
  if (opts.path) {
    if (!existsSync(opts.path)) {
      ctx.err(`✗ Arquivo não encontrado: ${opts.path}`);
      return 1;
    }
    try {
      text = readFileSync(opts.path, 'utf8');
    } catch {
      ctx.err(`✗ não consegui ler ${opts.path}.`);
      return 1;
    }
  } else {
    text = await readStdin();
  }
  for (const line of formatCliSummary(parseCliStream(text))) ctx.out(line);
  return 0;
}

/** Correlaciona os subagentes capturados e imprime pares/órfãos. Sem eventos → "não observado" e 0. */
function runSubagents(ctx: RunContext): number {
  const dir = captureDirOf(ctx.env, ctx.home);
  const report = correlateSubagents(readCapturedEvents(join(dir, 'events.jsonl')));
  if (!report.total) {
    ctx.out(`Subagentes: não observado em ${tildify(dir, ctx.home)}.`);
    ctx.out('Nenhum subagentStart/subagentStop na captura (os hooks podem não disparar no Cursor).');
    return 0;
  }
  ctx.out(`Eventos de subagente: ${report.total} · pares: ${report.pairs.length} · órfãos: ${report.orphans.length} · sem id: ${report.uncorrelated.length}`);
  for (const p of report.pairs) {
    const pai = p.parent ? ` · pai: ${p.parent}` : '';
    ctx.out(`  par ${p.id}  ${p.complete ? 'casado' : 'aguardando stop'}${pai}`);
  }
  for (const o of report.orphans) ctx.out(`  órfão ${subagentIdOf(o)}  (stop sem start)`);
  for (const u of report.uncorrelated) ctx.out(`  sem-correlação  ${u.name}  (sem id)`);
  return 0;
}

/** Varre as raízes (ou `--path`) e imprime os candidatos de uso/plano. Sem candidatos → mensagem e 0. */
function runUsage(opts: { path?: string }, ctx: RunContext): number {
  const roots = opts.path ? [resolve(opts.path)] : usageRoots(ctx.home);
  const hits = roots.flatMap((root) => scanUsage(root));
  if (!hits.length) {
    const where = roots.map((r) => tildify(r, ctx.home)).join(', ');
    ctx.out(`Nenhum arquivo candidato de uso/plano em ${where}.`);
    ctx.out('O Cursor provavelmente não grava limites localmente (o cartão de uso ficaria vazio).');
    return 0;
  }
  for (const hit of hits) {
    ctx.out(formatUsageHit(hit, ctx.home));
    for (const line of describeUsageFile(hit.path)) ctx.out(`  ${line}`);
  }
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
