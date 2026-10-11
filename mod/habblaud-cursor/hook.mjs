#!/usr/bin/env node
// Hook de decisão e observação do Cursor (P3 do harness): observa os eventos dos hooks da IDE no escritório
// (POST /api/cursor/events) e, nos eventos de DECISÃO (por padrão beforeShellExecution e beforeMCPExecution; a
// configuração local pode reativar outros), registra o pedido em POST /api/permissions (provider "cursor") e espera
// a decisão em GET /api/permissions/:id/wait. Imprime a decisão no formato NATIVO do Cursor: {"permission":"allow"|
// "deny"} (+ "user_message" no deny). `npm run cursor:install` acrescenta este hook em ~/.cursor/hooks.json (ou
// --project).
//
// Antes de qualquer contato, a POLÍTICA LOCAL (mod/habblaud-cursor/policy.mjs, do mesmo ~/.habblaud/cursor-hook.json)
// é avaliada: um evento de decisão que casa uma regra `allow`/`deny` é decidido na hora, sem rede, e a decisão vai
// para ~/.habblaud/cursor-decisions.jsonl (best-effort). Sem regra, o pedido vai ao escritório com `suggest_rule`
// (a regra "sempre permitir" que o servidor grava quando você escolhe essa opção).
//
// O schema dos hooks do Cursor ainda não está confirmado (lacuna C1): o hook lê ALIASES DEFENSIVOS
// (hook_event_name/hookEventName; conversation_id/conversationId/session_id/sessionId; tool_name/toolName;
// cwd/workspace; command/cmd; file_path/filePath) e deriva a ferramenta de cada evento de decisão:
// beforeShellExecution → "Shell" (com o `command`), beforeReadFile → "Read" (com o `file_path`), beforeMCPExecution e
// preToolUse → o `tool_name` que a IDE mandar. Títulos e resumos saem da tradução das ferramentas do Cursor no
// servidor (sources/cursor/rollout.ts: "Shell"→Bash, "MCP:<x>"→mcp__x).
//
// Config: ~/.habblaud/cursor-hook.json ({port, decisionTimeoutS, decisionEvents, rules}), criado à mão se quiser
// destoar do padrão — o instalador (npm run cursor:install) não escreve este arquivo, mas o servidor grava `rules`
// nele quando você escolhe "sempre permitir". HABBLAUD_PORT vale como reserva (o ambiente do hook é o do processo que
// subiu a IDE, então variáveis do seu shell nem sempre chegam aqui). Padrões: porta 4747, espera 25 s (entre 5 e 120),
// eventos de decisão beforeShellExecution/beforeMCPExecution.
//
// Regras: node puro (22+), só `node:*`, sem dependências; nunca trava nem quebra a sessão: todo erro = sair com 0 e
// sem saída; nos eventos de observação nada vai para o stdout (no beforeSubmitPrompt ele viraria contexto do modelo).
// Tempo esgotado, Habblaud fora do ar ou da porta uma resposta sem id: sai sem imprimir nada e a IDE segue o fluxo
// normal. Só fala com 127.0.0.1. HABBLAUD_HOOK_DEBUG=1 escreve o que acontece no stderr.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowOutput, decisionEventsOf, denyOutput, deriveRule, matchRule, rulesOf } from './policy.mjs';

export const DEFAULT_PORT = 4747;
/** Espera padrão por uma decisão no escritório (segundos). */
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Arquivo de configuração opcional, em ~/.habblaud (criado à mão; o instalador não grava). */
export const CONFIG_FILE = 'cursor-hook.json';
/** Registro local (best-effort) das decisões tomadas por regra local, em ~/.habblaud. */
export const DECISIONS_FILE = 'cursor-decisions.jsonl';
/** Eventos mandados ao Habblaud (POST /api/cursor/events). */
export const OBSERVED = new Set([
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
]);
/** Prazo do envio de um evento: o Habblaud responde na hora (e o hook não pode atrasar a IDE). */
const EVENT_TIMEOUT_MS = 1_500;
/** Registrar o pedido: se o Habblaud não responder nisso, ele está fora do ar (ou travado). */
const REGISTER_TIMEOUT_MS = 2_000;
/** Espera máxima de cada long-poll (o servidor responde "pending" e o hook pergunta de novo). */
const POLL_S = 25;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Textos do evento e dos argumentos mandados ao Habblaud (o servidor só mostra prévias). */
const MAX_STRING = 8_000;
/** Corpo do pedido (o servidor recusa acima de 256 KB). */
const MAX_BODY = 200_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-cursor] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Nome do evento do hook (aliases defensivos). */
export function eventNameOf(input) {
  return typeof input.hook_event_name === 'string' ? input.hook_event_name : typeof input.hookEventName === 'string' ? input.hookEventName : undefined;
}

/** Id da conversa do Cursor (vira o sessionId do pedido). */
export function conversationIdOf(input) {
  for (const k of ['conversation_id', 'conversationId', 'session_id', 'sessionId']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Ferramenta do pedido: o `tool_name` do evento; sem ele, "Shell" para um comando ou "Read" para uma leitura de
 * arquivo (o que descreve cada evento de decisão que não traz tool_name).
 */
export function toolNameOf(input) {
  for (const k of ['tool_name', 'toolName']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const k of ['command', 'cmd']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return 'Shell';
  }
  for (const k of ['file_path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return 'Read';
  }
  return undefined;
}

/** Edits do `afterFileEdit` (`[{old_string,new_string}]`), quando o evento os traz; sem mascarar (a máscara é do servidor). */
function editsOf(input) {
  const v = input.edits;
  return Array.isArray(v) && v.length ? v : undefined;
}

/** Argumentos da ferramenta: o `tool_input` do evento; senão {command} ou {file_path} (+ `edits` do afterFileEdit). */
export function toolInputOf(input) {
  for (const k of ['tool_input', 'toolInput']) {
    const v = input[k];
    if (isObject(v)) return v;
  }
  for (const k of ['command', 'cmd']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return { command: v };
  }
  const edits = editsOf(input);
  for (const k of ['file_path', 'filePath']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return edits ? { file_path: v, edits } : { file_path: v };
  }
  return {};
}

/**
 * Porta e espera: ~/.habblaud/cursor-hook.json ({port, decisionTimeoutS}); sem porta no arquivo, HABBLAUD_PORT;
 * senão os padrões. Arquivo ausente ou ilegível = padrões.
 */
export function readConfig(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const wait = Number(f.decisionTimeoutS);
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
    waitMs: (Number.isFinite(wait) && wait > 0 ? Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, wait)) : DEFAULT_WAIT_S) * 1_000,
  };
}

/**
 * Política local do mesmo arquivo de configuração: os eventos que pedem decisão (`decisionEvents` ou o padrão
 * Shell/MCP) e as regras `allow`/`deny`. Arquivo ausente ou ilegível = padrões (nenhuma regra), sem lançar.
 */
export function readPolicy(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  return { decisionEvents: decisionEventsOf(file), rules: rulesOf(file) };
}

/** Registra (best-effort) uma decisão tomada por regra local; nunca deixa o registro atrapalhar a IDE. */
export function logLocalDecision(env, entry) {
  try {
    const dir = join(env.HOME || homedir(), '.habblaud');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, DECISIONS_FILE), `${JSON.stringify(entry)}\n`);
  } catch {
    // best-effort: a decisão já foi tomada; o registro é só observabilidade.
  }
}

/** Corta textos longos (saída de comando, patch enorme...). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/** O valor com os textos cortados; se ainda ficar grande demais no corpo, corta mais curto. */
function fitted(v, size) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimInput(v, max);
    if (size(out) <= MAX_BODY) break;
  }
  return out;
}

/** Corpo de POST /api/cursor/events: o stdin do hook inteiro, com os textos cortados. */
export function eventBody(input) {
  return { event: fitted(input, (event) => JSON.stringify({ event }).length) };
}

/** Corpo de POST /api/permissions: provider cursor, sessão = conversa e a ferramenta derivada do evento. */
export function permissionBody(input, timeoutMs) {
  const body = {
    provider: 'cursor',
    session_id: conversationIdOf(input),
    tool_name: toolNameOf(input),
    tool_input: {},
    timeout_ms: timeoutMs,
  };
  for (const k of ['cwd', 'workspace']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) {
      body.cwd = v.trim();
      break;
    }
  }
  body.tool_input = fitted(toolInputOf(input), (toolInput) => JSON.stringify({ ...body, tool_input: toolInput }).length);
  // Regra "sempre permitir" derivada do pedido: o servidor a grava quando você escolhe essa opção (o Cursor não tem
  // `updatedPermissions`). Sem sujeito (ex.: Shell sem comando), não há o que sugerir.
  const suggest = deriveRule(body.tool_name, body.tool_input);
  if (suggest) body.suggest_rule = suggest;
  return body;
}

/** Saída do hook para uma decisão do Habblaud (undefined = sair sem decidir). Formato nativo do Cursor. */
export function decisionOutput(result) {
  if (!result || result.status !== 'decided') return undefined;
  if (result.behavior === 'allow') return { permission: 'allow' };
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    return { permission: 'deny', user_message: reason ? `Recusado pelo usuário no Habblaud: ${reason}` : 'Recusado pelo usuário no Habblaud.' };
  }
  return undefined;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Requisição ao Habblaud local; null = fora do ar, tempo esgotado ou resposta ilegível. */
async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Manda o evento e, nos eventos de decisão, decide o pedido (ou não). Devolve a saída a imprimir, ou undefined. Nunca lança. */
export async function run(env = process.env, stdinText) {
  const startedAt = Date.now();
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isObject(input)) return undefined;
    const event = eventNameOf(input);
    if (!event || !OBSERVED.has(event)) return undefined;

    const cfg = readConfig(env);
    const policy = readPolicy(env);
    const base = `http://127.0.0.1:${cfg.port}`;

    // Política local ANTES de qualquer contato: regra que casa decide na hora, sem rede (nem evento).
    if (policy.decisionEvents.has(event)) {
      const tool = toolNameOf(input);
      const matched = matchRule(policy.rules, tool, toolInputOf(input));
      if (matched) {
        debug(`${event}: regra local ${matched.effect} (${matched.pattern})`);
        logLocalDecision(env, { at: Date.now(), event, tool, effect: matched.effect, pattern: matched.pattern });
        return matched.effect === 'deny' ? denyOutput(matched.note) : allowOutput();
      }
    }

    const sent = await call(base, 'POST', '/api/cursor/events', eventBody(input), EVENT_TIMEOUT_MS);
    debug(`${event}: ${sent ? `${sent.status} ${JSON.stringify(sent.json ?? null)}` : 'Habblaud fora do ar'}`);
    // Só os eventos de decisão (com ferramenta e conversa) viram pedido no escritório.
    if (!policy.decisionEvents.has(event)) return undefined;
    if (!conversationIdOf(input) || !toolNameOf(input)) return undefined;
    // Sem resposta nem ao evento: o Habblaud está fora do ar (ou travado); a IDE segue o fluxo normal.
    if (!sent) return undefined;

    // A espera conta desde o início do hook (a IDE só sabe da decisão quando ele termina).
    const deadline = startedAt + cfg.waitMs;
    const reg = await call(base, 'POST', '/api/permissions', permissionBody(input, Math.max(0, deadline - Date.now())), REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`sem desvio (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud fora do ar'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('tempo esgotado: vale a IDE');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(POLL_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      if (r.json?.status === 'pending') continue;
      debug(`resposta: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json);
    }
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return undefined;
  }
}

export async function main() {
  const { waitMs } = readConfig();
  // Rede de segurança: nada mantém o processo vivo além da espera (a IDE também tem o tempo limite do hook).
  setTimeout(() => process.exit(0), waitMs + 15_000).unref();
  const out = await run();
  // Sem process.exit() logo depois do fetch: no Windows (Node 23 até 24.19) ele derruba o processo com 0xC0000409
  // enquanto o V8 ainda compila em segundo plano o parser do fetch (nodejs/node#56645). O processo sai sozinho quando
  // o loop esvazia, o que também espera a escrita da decisão no pipe; se algo ainda segurar o loop, o process.exit
  // vem 1 s depois.
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`, finish);
  else finish();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));