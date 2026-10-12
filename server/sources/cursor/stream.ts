// Normalizador do stream-json headless (P5 · SC-24): o `cursor-agent -p --output-format stream-json` fala NDJSON
// próprio; aqui ele vira o MESMO JSONL do transcript do Cursor (o que o `createCursorTerminalParser` já lê) —
// linhas `{"role":…,"message":{"content":[…]}}` e marcadores `{"type":"turn_ended","status":…}`. Assim a tarefa
// headless ganha a observabilidade da IDE sem um caminho novo de parser.
//
// É DEFENSIVO: o formato do stream-json ainda não está confirmado (risco R-2 do design). Qualquer linha
// desconhecida — JSON estranho ou texto puro — degrada para uma entrada mínima de assistente, SEM lançar; linha
// vazia devolve `undefined` (nada a escrever).
import { maskSecrets } from '../../../shared/activity';

type Rec = Record<string, unknown>;

function recOf(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Primeira string útil (não vazia) entre os candidatos. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

/** Argumentos de ferramenta (objeto, ou string JSON): inválido vira `{}`. */
function asInput(v: unknown): Rec {
  if (typeof v === 'string') {
    try {
      return recOf(JSON.parse(v)) ?? {};
    } catch {
      return {};
    }
  }
  return recOf(v) ?? {};
}

/** Tipo declarado do evento (`type`/`kind`/`event`), em minúsculas. */
function kindOf(rec: Rec): string {
  return (firstString(rec.type, rec.kind, rec.event) ?? '').toLowerCase();
}

/** Status do fim de turno (resultado): `status`/`subtype` e, na falta, `is_error`. */
function statusOf(rec: Rec): string {
  const s = firstString(rec.status, rec.subtype);
  if (s) return s.toLowerCase();
  return rec.is_error === true ? 'error' : 'success';
}

/** Texto direto de um evento (mensagem, delta parcial ou `content` textual). */
function textOf(rec: Rec): string | undefined {
  const msg = recOf(rec.message);
  const delta = recOf(rec.delta);
  return firstString(
    rec.text,
    delta?.text,
    typeof rec.content === 'string' ? rec.content : undefined,
    msg?.text,
    typeof msg?.content === 'string' ? msg.content : undefined,
  );
}

/** Bloco de ferramenta normalizado a partir de um item de tool_call/tool_use. */
function toolUseOf(item: Rec): Rec {
  const fn = recOf(item.function);
  const name = firstString(item.tool_name, item.toolName, item.name, fn?.name) ?? 'ferramenta';
  return { type: 'tool_use', name, input: asInput(item.input ?? item.arguments ?? fn?.arguments ?? fn?.input) };
}

/** Bloco de conteúdo normalizado (`text` ou `tool_use`); `undefined` quando o bloco não é reconhecido. */
function normalizeBlock(b: Rec): Rec | undefined {
  if (b.type === 'tool_use' || b.type === 'tool_call') return toolUseOf(b);
  if (b.type === 'text' || typeof b.text === 'string') {
    const text = typeof b.text === 'string' ? b.text : '';
    return { type: 'text', text };
  }
  return undefined;
}

/** Os blocos de conteúdo de um evento (mensagem, tool_call(s) ou texto direto); `undefined` se nada reconhecido. */
function contentOf(rec: Rec, kind: string): Rec[] | undefined {
  const out: Rec[] = [];
  const msg = recOf(rec.message);
  const arr = Array.isArray(msg?.content) ? msg.content : Array.isArray(rec.content) ? rec.content : undefined;
  if (arr) {
    for (const raw of arr) {
      const b = recOf(raw);
      if (!b) continue;
      const nb = normalizeBlock(b);
      if (nb) out.push(nb);
    }
  }
  const single = recOf(rec.tool_call);
  if (single) out.push(toolUseOf(single));
  if (Array.isArray(rec.tool_calls)) {
    for (const item of rec.tool_calls) {
      const r = recOf(item);
      if (r) out.push(toolUseOf(r));
    }
  }
  if (!single && !Array.isArray(rec.tool_calls) && (kind === 'tool_call' || kind === 'tool_use' || kind === 'tool')) {
    const name = firstString(rec.tool_name, rec.toolName, rec.name);
    if (name) out.push({ type: 'tool_use', name, input: asInput(rec.input ?? rec.arguments) });
  }
  if (!out.length) {
    const text = textOf(rec);
    if (text) out.push({ type: 'text', text });
  }
  return out.length ? out : undefined;
}

/** Copia o timestamp (`timestamp`/`ts`/`created_at`) para a linha normalizada, quando houver. */
function withMeta(line: Rec, rec: Rec): Rec {
  const ts = rec.timestamp ?? rec.ts ?? rec.created_at;
  if (typeof ts === 'string' || typeof ts === 'number') line.timestamp = ts;
  return line;
}

/** Entrada mínima de assistente (degradação graciosa): nunca lança, nunca perde a linha. */
function minimal(text: string): string {
  return JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
}

/**
 * Converte UMA linha do stream-json do CLI na linha equivalente do transcript do Cursor (JSON serializado).
 * Linha vazia → `undefined`; formato desconhecido → entrada mínima de assistente (sem lançar).
 */
export function normalizeStreamLine(line: string): string | undefined {
  const raw = line.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return minimal(maskSecrets(raw));
  }
  const rec = recOf(parsed);
  if (!rec) return minimal(maskSecrets(raw));

  const kind = kindOf(rec);
  if (kind === 'result' || kind === 'turn_ended' || kind === 'done' || kind === 'completion') {
    return JSON.stringify(withMeta({ type: 'turn_ended', status: statusOf(rec) }, rec));
  }

  const content = contentOf(rec, kind);
  if (!content) {
    return minimal(maskSecrets(textOf(rec) ?? raw));
  }
  const role = firstString(rec.role)?.toLowerCase() ?? (kind === 'user' || kind === 'user_message' || kind === 'prompt' ? 'user' : 'assistant');
  const out: Rec = { role: role === 'user' ? 'user' : 'assistant', message: { content } };
  return JSON.stringify(withMeta(out, rec));
}

/**
 * Normaliza um trecho inteiro do stream (várias linhas) para uma lista de linhas do transcript, prontas para
 * gravar num JSONL e alimentar o `createCursorTerminalParser`. Linhas vazias são puladas.
 */
export function normalizeStream(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const n = normalizeStreamLine(line);
    if (n) out.push(n);
  }
  return out;
}
