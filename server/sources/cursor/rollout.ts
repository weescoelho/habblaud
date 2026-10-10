// Camada de mapeamento dos eventos de hook do Cursor: normaliza o stdin do hook (CursorEvent), traduz o nome da
// ferramenta para uma Activity legível e mapeia o evento para uma borda de status do Office.
//
// O schema dos hooks do Cursor ainda não está confirmado (lacuna C1), então lemos ALIASES DEFENSIVOS para cada campo
// (ex.: `command`/`cmd`, `cwd`/`workspace`, `conversation_id`/`conversationId`/`session_id`) e nunca lançamos por
// causa de um campo ausente ou com tipo inesperado.
import { describeCommand, describeTool, type ActivityDescription } from '../../../shared/activity';
import type { AgentStatus } from '../../../shared/types';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Primeiro valor que é uma string útil (aliases defensivos). */
function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return undefined;
}

/** Primeiro valor que é um objeto (aliases defensivos). */
function firstRec(...vals: unknown[]): Rec | undefined {
  for (const v of vals) {
    const r = rec(v);
    if (r) return r;
  }
  return undefined;
}

/** Evento de hook do Cursor normalizado. */
export interface CursorEvent {
  /** `hook_event_name`. */
  name: string;
  /**
   * `conversation_id` (vira o sessionId do agente). Opcional para honrar "campos ausentes viram undefined": nem todo
   * evento do Cursor traz o id da conversa.
   */
  conversationId?: string;
  /** `workspace_roots[0]` (ou `workspace_root`): a sala do agente. */
  workspaceRoot?: string;
  /** `cwd` (ou `workspace`). */
  cwd?: string;
  /** `tool_name`. */
  toolName?: string;
  /** `tool_input`. */
  toolInput?: Rec;
  /** `command` (ou `cmd`). */
  command?: string;
  /** `transcript_path` (P0). */
  transcriptPath?: string;
}

/**
 * Normaliza o stdin de um evento de hook do Cursor. Sem `hook_event_name` devolve `undefined` (evento que não é do
 * Cursor). Campos ausentes ficam `undefined`; aliases defensivos cobrem variações de nome.
 */
export function parseCursorEvent(input: Record<string, unknown>): CursorEvent | undefined {
  const name = firstStr(input.hook_event_name, input.hookEventName);
  if (!name) return undefined;
  const event: CursorEvent = { name };
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : Array.isArray(input.workspaceRoots) ? input.workspaceRoots : [];
  const workspaceRoot = firstStr(roots[0], input.workspace_root, input.workspaceRoot);
  const conversationId = firstStr(input.conversation_id, input.conversationId, input.session_id, input.sessionId);
  const cwd = firstStr(input.cwd, input.workspace);
  const toolName = firstStr(input.tool_name, input.toolName);
  const toolInput = firstRec(input.tool_input, input.toolInput);
  const command = firstStr(input.command, input.cmd);
  const transcriptPath = firstStr(input.transcript_path, input.transcriptPath);
  if (conversationId) event.conversationId = conversationId;
  if (workspaceRoot) event.workspaceRoot = workspaceRoot;
  if (cwd) event.cwd = cwd;
  if (toolName) event.toolName = toolName;
  if (toolInput) event.toolInput = toolInput;
  if (command) event.command = command;
  if (transcriptPath) event.transcriptPath = transcriptPath;
  return event;
}

/**
 * Traduz uma ferramenta do Cursor em uma Activity. `Shell` vira um comando de shell (`describeCommand`); as
 * ferramentas conhecidas passam por `describeTool`; `MCP:<tool>` vira o nome no formato `mcp__<tool>`. `tool`
 * volta normalizado para o `Activity.tool`.
 *
 * Cobre tanto os nomes do HOOK (`Shell`, `MCP:<tool>`) quanto os do TRANSCRIPT (P0/C1, 2026-10-10), que usa
 * nomes próprios: `StrReplace` (edição), `CallDynamicTool` (MCP dinâmico, com `namespace`/`toolName`) e `Glob`
 * com `glob_pattern` (o canonical do `describeTool` é `pattern`).
 */
export function describeCursorTool(rawName: string, input: Rec): { desc: ActivityDescription; tool: string } {
  if (rawName === 'Shell') {
    const command = firstStr(input.command, input.cmd) ?? '';
    return { desc: describeCommand(command, str(input.description)), tool: 'Bash' };
  }
  if (rawName.startsWith('MCP:')) {
    const tool = `mcp__${rawName.slice(4)}`;
    return { desc: describeTool(tool, input), tool };
  }
  if (rawName === 'CallDynamicTool') {
    const ns = firstStr(input.namespace);
    const tool = firstStr(input.toolName);
    const name = tool ? `mcp__${ns ? `${ns}__` : ''}${tool}` : rawName;
    return { desc: describeTool(name, firstRec(input.arguments) ?? input), tool: name };
  }
  if (rawName === 'StrReplace') {
    return { desc: describeTool('Edit', input), tool: rawName };
  }
  if (rawName === 'Glob') {
    // O transcript do Cursor manda `glob_pattern` (o canonical do `describeTool` é `pattern`).
    return { desc: describeTool('Glob', { ...input, pattern: firstStr(input.pattern, input.glob_pattern) ?? '' }), tool: rawName };
  }
  return { desc: describeTool(rawName, input), tool: rawName };
}

/**
 * Borda de status de um evento de hook do Cursor. `undefined` = evento não tratado (o chamador ignora). O `sessionEnd`
 * NÃO está aqui: ele fecha o agente (`closeMain`), tratado à parte na fonte.
 */
export function statusBorder(event: string): { status: AgentStatus; waitingFor?: string } | undefined {
  switch (event) {
    case 'sessionStart':
      return { status: 'idle' };
    case 'beforeSubmitPrompt':
    case 'preToolUse':
    case 'postToolUse':
    case 'postToolUseFailure':
    case 'beforeMCPExecution':
    case 'afterMCPExecution':
    case 'beforeReadFile':
    case 'afterFileEdit':
    case 'afterAgentResponse':
    case 'afterAgentThought':
    case 'afterShellExecution':
      return { status: 'working' };
    case 'beforeShellExecution':
      return { status: 'shell' };
    case 'stop':
      return { status: 'idle' };
    default:
      return undefined;
  }
}
