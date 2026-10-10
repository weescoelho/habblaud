// Parser/inspetor do transcript do Cursor (POC P0). O schema foi mapeado ao vivo (lacuna C1, 2026-10-10):
// o arquivo é JSONL com `{"role":…,"message":{"content":[{"type":"text"|"tool_use","name","input"}]}}` e
// marcadores de turno `{"type":"turn_ended","status":…}`. Ainda assim lemos ALIASES DEFENSIVOS (estilo
// Anthropic/OpenAI no topo OU aninhados em `message.content`). Tudo pelo próprio Node
// (`node:fs`/`node:sqlite`) e SEM lançar para formato desconhecido: o harness precisa reportar "opaco" sem quebrar.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ActivityKind } from '../../../shared/types';
import { describeCursorTool } from './rollout';

/** Formato caracterizado do arquivo apontado por um `transcript_path`. */
export type TranscriptFormat = 'json' | 'jsonl' | 'sqlite' | 'opaco';

/** Atividade reconhecida numa linha de transcript (rótulo já em PT-BR; sempre com `kind` e `label`). */
export interface TranscriptActivity {
  kind: ActivityKind;
  label: string;
  /** Nome bruto da ferramenta, quando houver. */
  tool?: string;
  detail?: string;
}

/** Quantas entradas trazem uma chave de topo. */
export interface KeyCount {
  key: string;
  count: number;
}

/** Quantas linhas tem uma tabela do SQLite. */
export interface TableCount {
  name: string;
  count: number;
}

/** Retrato de um arquivo de transcript: formato + o que foi observado nele. */
export interface TranscriptInspection {
  format: TranscriptFormat;
  /** Chaves de topo observadas e a contagem (json = 1 por chave; jsonl = por linha). Ordenado por chave. */
  keys: KeyCount[];
  /** Papéis distintos, na ordem em que aparecem (JSONL). */
  roles: string[];
  /** Alguma entrada traz campos de tool-call. */
  hasToolCalls: boolean;
  /** Tabelas do SQLite com a contagem de linhas (ordenadas por nome). */
  tables: TableCount[];
  /** Nº de linhas com conteúdo (JSONL). */
  lines?: number;
  /** Explicação quando o formato é opaco (ou outra observação do inspetor). */
  note?: string;
}

const SQLITE_MAGIC = 'SQLite format 3\0';

type Rec = Record<string, unknown>;

function recOf(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Lê os primeiros `n` bytes do arquivo (para o sniff do magic do SQLite), sem lançar. */
function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function looksSqlite(path: string): boolean {
  try {
    return readHead(path, SQLITE_MAGIC.length).toString('latin1') === SQLITE_MAGIC;
  } catch {
    return false;
  }
}

/** Faz `JSON.parse` de uma linha/arquivo; devolve o objeto ou `undefined` (nunca lança). */
function parseJsonObject(text: string): Rec | undefined {
  try {
    return recOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Converte argumentos de tool-call (objeto ou string JSON) num objeto; inválido vira `{}`. */
function asInput(v: unknown): Rec {
  if (typeof v === 'string') return parseJsonObject(v) ?? {};
  return recOf(v) ?? {};
}

/**
 * Caracteriza o arquivo do transcript. SQLite pelo magic dos primeiros bytes; JSON quando o arquivo
 * inteiro faz `JSON.parse`; JSONL quando toda linha não vazia faz `JSON.parse`; caso contrário, opaco.
 */
export function classifyTranscript(path: string): TranscriptFormat {
  if (looksSqlite(path)) return 'sqlite';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return 'opaco';
  }
  const trimmed = raw.trim();
  if (!trimmed) return 'opaco';
  if (parseJsonObject(trimmed)) return 'json';
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => parseJsonObject(l))) return 'jsonl';
  return 'opaco';
}

/** Bloco de tool-call cru (nome + entrada) extraído de uma linha. */
interface ToolBlock {
  name: string;
  input: Rec;
}

/**
 * Extrai os blocos de ferramenta de UM contêiner de mensagem, cobrindo os dois estilos conhecidos:
 * estilo OpenAI/Cursor (`tool_calls: [{ function: { name, arguments } }]`) e estilo Anthropic
 * (`content: [{ type: 'tool_use', name, input }]`). Campos ausentes/inesperados são ignorados.
 */
function blocksOf(rec: Rec): ToolBlock[] {
  const out: ToolBlock[] = [];
  if (Array.isArray(rec.tool_calls)) {
    for (const item of rec.tool_calls) {
      const r = recOf(item);
      if (!r) continue;
      const fn = recOf(r.function);
      const name = typeof fn?.name === 'string' ? fn.name : typeof r.name === 'string' ? r.name : undefined;
      if (!name) continue;
      out.push({ name, input: asInput(fn?.arguments ?? r.arguments ?? fn?.input ?? r.input) });
    }
  }
  if (Array.isArray(rec.content)) {
    for (const item of rec.content) {
      const r = recOf(item);
      if (!r || (r.type !== 'tool_use' && r.type !== 'tool_call')) continue;
      const name = typeof r.name === 'string' ? r.name : undefined;
      if (!name) continue;
      out.push({ name, input: asInput(r.input ?? r.arguments) });
    }
  }
  return out;
}

/**
 * Extrai os blocos de ferramenta de uma linha. O contêiner pode ser a própria linha (estilo
 * Anthropic/OpenAI de topo) ou o objeto `message` — o formato observado no transcript real do
 * Cursor (P0/C1, 2026-10-10): `{"role":…,"message":{"content":[{"type":"tool_use","name":"Shell","input":{…}}]}}`.
 */
function toolBlocks(rec: Rec): ToolBlock[] {
  const out = blocksOf(rec);
  const msg = recOf(rec.message);
  if (msg) out.push(...blocksOf(msg));
  return out;
}

/** Traduz um bloco de ferramenta numa atividade legível (reusa `describeCursorTool`). */
function toActivity(block: ToolBlock): TranscriptActivity {
  const { desc, tool } = describeCursorTool(block.name, block.input);
  return { kind: desc.kind, label: desc.text, tool, ...(desc.detail ? { detail: desc.detail } : {}) };
}

function sortedKeys(counts: Map<string, number>): KeyCount[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function inspectJsonl(raw: string): TranscriptInspection {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const counts = new Map<string, number>();
  const roles: string[] = [];
  let hasToolCalls = false;
  for (const line of lines) {
    const rec = parseJsonObject(line);
    if (!rec) continue;
    for (const key of Object.keys(rec)) counts.set(key, (counts.get(key) ?? 0) + 1);
    const role = typeof rec.role === 'string' ? rec.role : undefined;
    if (role && !roles.includes(role)) roles.push(role);
    if (toolBlocks(rec).length) hasToolCalls = true;
  }
  return { format: 'jsonl', keys: sortedKeys(counts), roles, hasToolCalls, tables: [], lines: lines.length };
}

function inspectJson(raw: string): TranscriptInspection {
  const rec = parseJsonObject(raw.trim()) ?? {};
  const counts = new Map<string, number>();
  for (const key of Object.keys(rec)) counts.set(key, 1);
  const role = typeof rec.role === 'string' ? rec.role : undefined;
  return { format: 'json', keys: sortedKeys(counts), roles: role ? [role] : [], hasToolCalls: toolBlocks(rec).length > 0, tables: [] };
}

/** `COUNT(*)` de uma tabela, com o nome devidamente citado (aspas duplicadas). */
function countRows(db: DatabaseSync, name: string): number {
  const quoted = `"${name.replace(/"/g, '""')}"`;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get() as { c?: number | bigint } | undefined;
  return Number(row?.c ?? 0);
}

function inspectSqlite(path: string): TranscriptInspection {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tables: TableCount[] = names.map(({ name }) => ({ name, count: countRows(db as DatabaseSync, name) }));
    return { format: 'sqlite', keys: [], roles: [], hasToolCalls: false, tables };
  } catch {
    return { format: 'opaco', keys: [], roles: [], hasToolCalls: false, tables: [], note: 'Não foi possível abrir o arquivo como SQLite.' };
  } finally {
    db?.close();
  }
}

function inspectOpaque(path: string): TranscriptInspection {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // arquivo ausente: o harness (scripts/cursor-poc.ts) reporta o erro antes de chegar aqui.
  }
  const note = size
    ? `Formato não reconhecido (${size} bytes): não é JSON, JSONL nem SQLite.`
    : 'Arquivo vazio ou ausente: não é JSON, JSONL nem SQLite.';
  return { format: 'opaco', keys: [], roles: [], hasToolCalls: false, tables: [], note };
}

/** Caracteriza o arquivo e lista o observado (chaves/contagens ou tabelas+contagens). Não lança em formato opaco. */
export function inspectTranscript(path: string): TranscriptInspection {
  const format = classifyTranscript(path);
  if (format === 'sqlite') return inspectSqlite(path);
  if (format === 'jsonl') return inspectJsonl(readFileSync(path, 'utf8'));
  if (format === 'json') return inspectJson(readFileSync(path, 'utf8'));
  return inspectOpaque(path);
}

/**
 * Mapeia uma linha de transcript do Cursor para atividades legíveis. Linha desconhecida (ou que não
 * é JSON) devolve atividades vazias, SEM lançar; o `role` só aparece quando a linha o traz.
 */
export function parseCursorTranscriptLine(line: string): { activities: TranscriptActivity[]; role?: string } {
  const rec = parseJsonObject(line);
  if (!rec) return { activities: [] };
  const role = typeof rec.role === 'string' ? rec.role : undefined;
  const activities = toolBlocks(rec).map(toActivity);
  return role ? { role, activities } : { activities };
}
