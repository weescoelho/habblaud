// Camada de mapeamento dos eventos de hook do Cursor: normaliza o stdin do hook (CursorEvent), traduz o nome da
// ferramenta para uma Activity legível e mapeia o evento para uma borda de status do Office.
//
// O schema dos hooks do Cursor ainda não está confirmado (lacuna C1), então lemos ALIASES DEFENSIVOS para cada campo
// (ex.: `command`/`cmd`, `cwd`/`workspace`, `conversation_id`/`conversationId`/`session_id`) e nunca lançamos por
// causa de um campo ausente ou com tipo inesperado.
import { describeCommand, describeTool, maskSecrets, truncate, type ActivityDescription } from '../../../shared/activity';
import type { ActivityKind, AgentStatus, EditDiff } from '../../../shared/types';

type Rec = Record<string, unknown>;

/** Limites do `make` de shared/activity.ts (texto do balão e detalhe). */
const ACT_TEXT_MAX = 46;
const ACT_DETAIL_MAX = 300;

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

/** Número finito (os campos de token do hook); qualquer outra coisa é ignorada. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Máximo de caracteres guardados de cada trecho do diff do evento (o conteúdo cru é mascarado/cortado aqui). */
const DIFF_TEXT_MAX = 4_000;
/** Máximo de edições guardadas do diff do evento (o resto não entra no resumo). */
const DIFF_EDITS_MAX = 50;
/** Ferramentas de edição cujo input rende um resumo de diff na Activity. */
const EDIT_TOOLS = new Set(['StrReplace', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Texto exato de um campo (sem `trim`, preserva quebras): só strings valem; o resto fica `undefined`. */
function text(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Corta preservando quebras de linha (o `truncate` do balão colapsa espaços e destruiria o diff). */
function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Trecho de uma edição (`old`/`new`) do diff do evento. */
export interface CursorEdit {
  old: string;
  new: string;
}

/** Diff de uma edição do hook (`afterFileEdit`), já mascarado/cortado no servidor. */
export interface CursorDiff {
  /** Caminho do arquivo editado ('' quando o evento não traz). */
  file: string;
  edits: CursorEdit[];
}

/** Normaliza os `edits` de um input (`old_string`/`new_string` ou `old`/`new`), sem mascarar. */
function editsFrom(raw: unknown): CursorEdit[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  const out: CursorEdit[] = [];
  for (const e of raw.slice(0, DIFF_EDITS_MAX)) {
    const r = rec(e);
    if (!r) continue;
    out.push({ old: text(r.old_string) ?? text(r.old) ?? '', new: text(r.new_string) ?? text(r.new) ?? '' });
  }
  return out;
}

/** Diff do evento já mascarado/cortado (o hook NÃO mascara: a máscara/truncamento é sempre do servidor). */
function cursorDiff(raw: unknown, file: string | undefined): CursorDiff | undefined {
  const edits = editsFrom(raw).map((e) => ({ old: clipText(maskSecrets(e.old), DIFF_TEXT_MAX), new: clipText(maskSecrets(e.new), DIFF_TEXT_MAX) }));
  return edits.length ? { file: file ?? '', edits } : undefined;
}

/** Linhas de um texto (sem o vazio final de uma quebra no fim). */
function linesOf(s: string): string[] {
  const parts = s.replace(/\r\n/g, '\n').split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Linhas adicionadas/removidas de uma edição (ignora o trecho comum no começo e no fim). */
function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
  const o = linesOf(oldText);
  const n = linesOf(newText);
  let head = 0;
  while (head < o.length && head < n.length && o[head] === n[head]) head++;
  let tail = 0;
  while (tail < o.length - head && tail < n.length - head && o[o.length - 1 - tail] === n[n.length - 1 - tail]) tail++;
  return { added: n.length - head - tail, removed: o.length - head - tail };
}

/** Tokens de um evento de hook (só quando algum dos quatro campos é número finito). */
export interface CursorTokens {
  /** `input_tokens`. */
  input: number;
  /** `output_tokens`. */
  output: number;
  /** `cache_read_tokens`. */
  cacheRead: number;
  /** `cache_write_tokens`. */
  cacheWrite: number;
}

/** Activity com texto/detalhe mascarados e cortados (mesmas regras do `make` de shared/activity.ts). */
function activity(kind: ActivityKind, icon: string, text: string, detail?: string): ActivityDescription {
  return { kind, icon, text: truncate(maskSecrets(text), ACT_TEXT_MAX), ...(detail ? { detail: truncate(maskSecrets(detail), ACT_DETAIL_MAX) } : {}) };
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
  /** Tokens do turno (`stop`/`afterAgentResponse`); ausente quando o evento não traz nenhum campo. */
  tokens?: CursorTokens;
  /** `subagent_id` (`subagentStart`/`subagentStop`): o id estável do par Start↔Stop. */
  subagentId?: string;
  /** `subagent_type`: o papel do subagente. */
  subagentType?: string;
  /** `task`: o título/objetivo do subagente. */
  subagentTask?: string;
  /** `parent_conversation_id`: a conversa pai (senão vale o `conversation_id`). */
  parentConversationId?: string;
  /** `child_conversation_id` (`subagentStop`): a conversa **própria** do subagente (nomeia o transcript dele). */
  childConversationId?: string;
  /** `agent_transcript_path` (`subagentStop`): o transcript do subagente, quando a IDE manda. */
  agentTranscriptPath?: string;
  /** Diff de uma edição (`afterFileEdit`: `edits`), já mascarado/cortado no servidor (SC-06, SC-09). */
  diff?: CursorDiff;
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
  let toolName = firstStr(input.tool_name, input.toolName);
  let toolInput = firstRec(input.tool_input, input.toolInput);
  const command = firstStr(input.command, input.cmd);
  const transcriptPath = firstStr(input.transcript_path, input.transcriptPath);
  // Campos de subagente (`subagentStart`/`subagentStop`): o id do par, o papel, a tarefa e a conversa pai
  // (aliases defensivos). Ausentes ficam `undefined` (não inventamos parentesco).
  const subagentId = firstStr(input.subagent_id, input.subagentId);
  const subagentType = firstStr(input.subagent_type, input.subagentType);
  const subagentTask = firstStr(input.task);
  const parentConversationId = firstStr(input.parent_conversation_id, input.parentConversationId);
  // `subagentStop`: a conversa própria do subagente e o caminho do transcript dele. Ausentes ficam `undefined`
  // (o `subagentStart` não traz o id da conversa do sub; só o Stop fecha a correlação).
  const childConversationId = firstStr(input.child_conversation_id, input.childConversationId);
  const agentTranscriptPath = firstStr(input.agent_transcript_path, input.agentTranscriptPath);
  // Diff do `afterFileEdit` (T5): os `edits` chegam no topo do stdin (ou dentro do `tool_input`) e são mascarados/
  // cortados AQUI (o hook só transporta). Sem `edits`, `diff` fica `undefined` (retrocompatível).
  const rawEdits = Array.isArray(input.edits) ? input.edits : Array.isArray(toolInput?.edits) ? toolInput.edits : undefined;
  const filePath = firstStr(input.file_path, input.filePath, input.path, toolInput?.file_path, toolInput?.path);
  const diff = cursorDiff(rawEdits, filePath);
  // O `afterFileEdit` traz `file_path`/`edits` no topo do stdin, fora do `tool_input`. Monta o input da edição e usa
  // um nome de edição quando a IDE não manda `tool_name`, para a Activity sair com o resumo do diff (kind edit/write).
  if (diff && name === 'afterFileEdit') {
    if (!toolInput) toolInput = { file_path: diff.file, edits: rawEdits };
    if (!toolName) toolName = 'StrReplace';
  }
  // Campos de token (`stop`/`afterAgentResponse`): cada ausente/não numérico vale 0; sem nenhum campo útil,
  // `tokens` fica `undefined` (o acumulado não é tocado). Aliases camelCase cobrem variações do hook.
  const inputTok = num(input.input_tokens) ?? num(input.inputTokens);
  const outputTok = num(input.output_tokens) ?? num(input.outputTokens);
  const cacheRead = num(input.cache_read_tokens) ?? num(input.cacheReadTokens);
  const cacheWrite = num(input.cache_write_tokens) ?? num(input.cacheWriteTokens);
  if (conversationId) event.conversationId = conversationId;
  if (workspaceRoot) event.workspaceRoot = workspaceRoot;
  if (cwd) event.cwd = cwd;
  if (toolName) event.toolName = toolName;
  if (toolInput) event.toolInput = toolInput;
  if (command) event.command = command;
  if (transcriptPath) event.transcriptPath = transcriptPath;
  if (subagentId) event.subagentId = subagentId;
  if (subagentType) event.subagentType = subagentType;
  if (subagentTask) event.subagentTask = subagentTask;
  if (parentConversationId) event.parentConversationId = parentConversationId;
  if (childConversationId) event.childConversationId = childConversationId;
  if (agentTranscriptPath) event.agentTranscriptPath = agentTranscriptPath;
  if (diff) event.diff = diff;
  if (inputTok !== undefined || outputTok !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    event.tokens = { input: inputTok ?? 0, output: outputTok ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
  }
  return event;
}

/**
 * Traduz uma ferramenta do Cursor em uma Activity. `Shell` vira um comando de shell (`describeCommand`); as
 * ferramentas conhecidas passam por `describeTool`; `MCP:<tool>` vira o nome no formato `mcp__<tool>`. `tool`
 * volta normalizado para o `Activity.tool`.
 *
 * Cobre tanto os nomes do HOOK (`Shell`, `MCP:<tool>`) quanto os do TRANSCRIPT (P0/C1, 2026-10-10), que usa
 * nomes próprios: `StrReplace` (edição), `CallDynamicTool` (MCP dinâmico, com `namespace`/`toolName`, e o
 * delegate `Task`) e `Glob` com `glob_pattern` (o canonical do `describeTool` é `pattern`). As ferramentas
 * próprias do Cursor (`GetDynamicTools`, `AskQuestion`, `UpdateCurrentStep`) ganham tradução dedicada.
 */
function describeCursorToolBase(rawName: string, input: Rec): { desc: ActivityDescription; tool: string } {
  if (rawName === 'Shell') {
    const command = firstStr(input.command, input.cmd) ?? '';
    return { desc: describeCommand(command, str(input.description)), tool: 'Bash' };
  }
  if (rawName.startsWith('MCP:')) {
    const tool = `mcp__${rawName.slice(4)}`;
    return { desc: describeTool(tool, input), tool };
  }
  if (rawName === 'GetDynamicTools') {
    return { desc: activity('other', '🧰', 'Carregando as ferramentas do Cursor'), tool: rawName };
  }
  if (rawName === 'AskQuestion') {
    // O Cursor usa `prompt`/`options.label`; o canonical do `describeTool` (AskUserQuestion) é
    // `question`/`options.label` — a pergunta vira o `question` para o balão e as opções seguem.
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const mapped = questions.map((q) => {
      const r = rec(q);
      return r ? { ...r, question: firstStr(r.prompt, r.question) ?? '' } : q;
    });
    return { desc: describeTool('AskUserQuestion', { ...input, questions: mapped }), tool: rawName };
  }
  if (rawName === 'UpdateCurrentStep') {
    const step = firstStr(input.current_step, input.currentStep);
    return { desc: activity('plan', '🧭', step ? `Etapa: ${step}` : 'Atualizando a etapa', step), tool: rawName };
  }
  if (rawName === 'CallDynamicTool') {
    const ns = firstStr(input.namespace);
    const tool = firstStr(input.toolName);
    const args = firstRec(input.arguments) ?? input;
    // O Cursor dispara o delegate por aqui (`CallDynamicTool{toolName:'Task'}`): vira o Task do Claude.
    if (tool === 'Task') return { desc: describeTool('Task', args), tool: 'Task' };
    const name = tool ? `mcp__${ns ? `${ns}__` : ''}${tool}` : rawName;
    return { desc: describeTool(name, args), tool: name };
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

/** Descrição de ferramenta do Cursor: a Activity (com o resumo do diff quando a edição o traz). */
export type CursorToolDescription = ActivityDescription & { diff?: EditDiff };

/**
 * Resumo do diff (contagens `added`/`removed`) do input de uma ferramenta de edição, quando ele traz `edits`
 * (hook/`MultiEdit`), `old_string`/`new_string` (`Edit`/`StrReplace`) ou o conteúdo escrito (`Write`).
 */
function diffSummary(rawName: string, input: Rec): EditDiff | undefined {
  if (!EDIT_TOOLS.has(rawName)) return undefined;
  let edits = editsFrom(input.edits);
  if (!edits.length) {
    const oldText = text(input.old_string);
    const newText = text(input.new_string) ?? text(input.content) ?? text(input.contents) ?? text(input.new_source);
    if (oldText !== undefined || newText !== undefined) edits = [{ old: oldText ?? '', new: newText ?? '' }];
  }
  if (!edits.length) return undefined;
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const d = lineDelta(e.old, e.new);
    added += d.added;
    removed += d.removed;
  }
  return { file: firstStr(input.file_path, input.filePath, input.path, input.notebook_path) ?? '', added, removed };
}

/**
 * Traduz uma ferramenta do Cursor em uma Activity, anexando o resumo do diff (`EditDiff`) quando a ferramenta é
 * uma edição e o input o traz. O resumo é aditivo: sem `edits`/`old_string`/`new_string`, o resultado é o de
 * {@link describeCursorToolBase} (retrocompatível).
 */
export function describeCursorTool(rawName: string, input: Rec): { desc: CursorToolDescription; tool: string } {
  const base = describeCursorToolBase(rawName, input);
  const diff = diffSummary(rawName, input);
  return { desc: diff ? { ...base.desc, diff } : base.desc, tool: base.tool };
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
    case 'subagentStop':
      return { status: 'idle' };
    case 'subagentStart':
      return { status: 'working' };
    default:
      return undefined;
  }
}
