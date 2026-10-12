// Terminal da conversa do Cursor: converte as linhas JSONL do transcript (o `transcript_path` que os hooks
// trazem) em TerminalEntry — prompts, respostas, ferramentas e fim de turno — reusando as regras do terminal
// do Claude/Codex (sources/terminal.ts): títulos no estilo `toolView`, segredos mascarados e textos truncados.
//
// O que o transcript do Cursor traz (mapeado ao vivo, lacuna C1) e que molda as regras abaixo:
// - uma linha por mensagem: `{"role":"user"|"assistant","message":{"content":[…]}}`, onde cada bloco é `text`
//   ou `tool_use` (`{"type":"tool_use","name":…,"input":…}`); o prompt do usuário vem envolvido em
//   `<timestamp>`/`<user_query>` — o terminal mostra só o que foi digitado;
// - `{"type":"turn_ended","status":…}` fecha o turno (sucesso/erro);
// - NÃO há `tool_result` nem timestamp: por isso o parser não emite entradas `result` e usa `timestamp`/`ts`
//   quando houver (senão o último conhecido, com `Date.now()` só de reserva). Os ids são por posição da linha
//   + índice do bloco (o FileTail não relê, então os ids ficam estáveis por leitura).
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { marked, prepare, TEXT_MAX, toolView, type TerminalParser } from '../terminal';

type Rec = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error';
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;

/** Ids já emitidos que são lembrados (duplicatas são locais: a mesma linha ou mensagem repetida). */
const SEEN_MAX = 20_000;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Prompt que o Cursor grava no transcript: o texto digitado vem em `<user_query>`; o envelope
 * (`<timestamp>`, `<user_info>`…) some. Sem a tag, o texto cru permanece.
 */
export function unwrapCursorUserText(raw: string): string {
  const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw);
  const inner = m?.[1]?.trim();
  return inner || raw;
}

/** Horário do envelope (`<timestamp>Monday, Oct 12, 2026, 12:03 PM (UTC-3)</timestamp>`). */
export function cursorUserEnvelopeAt(raw: string): number | undefined {
  const m = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(raw);
  const label = m?.[1]?.trim();
  if (!label) return undefined;
  return toMs(label.replace(/\s*\([^)]*\)\s*$/, '').trim());
}

interface ToolRender {
  tool: string;
  title: string;
  input?: string;
  inputKind?: TerminalInputKind;
}

/**
 * Título e argumentos de uma ferramenta do Cursor, no estilo do `toolView`. Mapeia os nomes/argumentos
 * próprios do transcript para o canonical do `toolView` (`Shell`→`Bash`, `StrReplace`→`Edit`,
 * `List`→`LS`, `Write.contents`→`content`, `Glob.glob_pattern`→`pattern`, `CallDynamicTool`→`mcp__…`).
 * Sem tradução dedicada, cai no genérico do `toolView` com o nome cru.
 */
function cursorToolView(rawName: string, input: Rec): ToolRender {
  const path = str(input.path) ?? str(input.file_path);
  switch (rawName) {
    case 'Shell':
      return { tool: 'Bash', ...toolView('Bash', input) };
    case 'Write':
      return { tool: 'Write', ...toolView('Write', { file_path: path, content: str(input.contents) ?? str(input.content) }) };
    case 'StrReplace':
      return { tool: 'Edit', ...toolView('Edit', { file_path: path, old_string: input.old_string, new_string: input.new_string }) };
    case 'MultiEdit':
      // `edits` no canonical do Claude (`{old_string,new_string}`): reusa o MultiEdit do `toolView`, que junta as
      // edições num diff com `@@`. Sem `edits` (ou sem `old_string`/`new_string`), não há entrada de diff.
      return { tool: 'MultiEdit', ...toolView('MultiEdit', { ...input, file_path: path }) };
    case 'Glob':
      return { tool: 'Glob', ...toolView('Glob', { ...input, pattern: str(input.pattern) ?? str(input.glob_pattern) ?? '' }) };
    case 'Grep':
      return { tool: 'Grep', ...toolView('Grep', { ...input, pattern: str(input.pattern) ?? str(input.query) ?? str(input.glob_pattern) ?? '' }) };
    case 'List':
      return { tool: 'LS', ...toolView('LS', { file_path: path }) };
    case 'CallDynamicTool': {
      const ns = str(input.namespace);
      const tool = str(input.toolName);
      const args = rec(input.arguments) ?? {};
      // O Cursor dispara o delegate por aqui (`CallDynamicTool{toolName:'Task'}`): vira o Task do Claude.
      if (tool === 'Task') return { tool: 'Task', ...toolView('Task', args) };
      const name = tool ? `mcp__${ns ? `${ns}__` : ''}${tool}` : 'CallDynamicTool';
      return { tool: name, ...toolView(name, args) };
    }
    default:
      return { tool: rawName, ...toolView(rawName, input) };
  }
}

class CursorTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private seq = 0;
  private lastAt?: number;

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Linha estranha demais: fica o que já tiver saído dela; a leitura segue.
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private line(raw: string): void {
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const j = rec(parsed);
    if (!j) return;
    const ts = toMs(j.timestamp) ?? toMs(j.ts);
    if (ts !== undefined) this.lastAt = ts;
    const at = ts ?? this.lastAt ?? Date.now();
    const key = `l${++this.seq}`;

    if (j.type === 'turn_ended') return this.turnEnded(key, at, j);

    const role = str(j.role);
    if (!role) return;
    const content = rec(j.message)?.content;
    if (!Array.isArray(content)) return;
    content.forEach((rawBlock, i) => {
      const b = rec(rawBlock);
      if (!b) return;
      const id = `${key}:${i}`;
      switch (b.type) {
        case 'text':
          if (role === 'user') this.user(id, at, str(b.text) ?? '', ts);
          else if (role === 'assistant') this.assistant(id, at, str(b.text) ?? '');
          return;
        case 'tool_use':
          this.tool(id, at, str(b.name) ?? 'ferramenta', rec(b.input) ?? {});
          return;
        default:
          return;
      }
    });
  }

  // ---------------------------------------------------------------- entradas

  private user(id: string, at: number, raw: string, jsonTs?: number): void {
    const envelopeAt = jsonTs === undefined ? cursorUserEnvelopeAt(raw) : undefined;
    if (envelopeAt !== undefined) this.lastAt = envelopeAt;
    const text = marked(prepare(unwrapCursorUserText(raw), TEXT_MAX));
    if (text) this.emit({ kind: 'user', id: `${id}:u`, at: envelopeAt ?? at, text });
  }

  private assistant(id: string, at: number, raw: string): void {
    const text = marked(prepare(raw, TEXT_MAX));
    if (text) this.emit({ kind: 'assistant', id, at, text });
  }

  private sys(id: string, at: number, text: string, level: Level): void {
    this.emit({ kind: 'system', id, at, text: maskSecrets(text), level });
  }

  private tool(id: string, at: number, name: string, input: Rec): void {
    const view = cursorToolView(name, input);
    const e: ToolEntry = { kind: 'tool', id, at, tool: view.tool, title: maskSecrets(view.title) };
    if (view.input) {
      e.input = view.input;
      e.inputKind = view.inputKind;
    }
    this.emit(e);
  }

  private turnEnded(key: string, at: number, j: Rec): void {
    const status = str(j.status)?.toLowerCase();
    const ok = status === 'success' || status === 'ok' || status === 'completed';
    if (ok) return this.sys(`${key}:s`, at, 'Turno concluído', 'info');
    const error = status === 'error' || status === 'failed' || status === 'failure';
    this.sys(`${key}:s`, at, status ? `Turno encerrado: ${status}` : 'Turno encerrado', error ? 'error' : 'warn');
  }
}

/** Parser com estado: uma instância por leitura de arquivo, alimentada linha a linha, na ordem do arquivo. */
export function createCursorTerminalParser(): TerminalParser {
  return new CursorTerminalParser();
}
