// Eventos dos hooks do Cursor (a parte "ao vivo" da fonte do Cursor): o script de hook manda o stdin do evento para
// POST /api/cursor/events e a rota repassa aqui. A fonte do Cursor (sources/cursor/source.ts) implementa.

export interface CursorLive {
  /**
   * Aplica um evento de hook do Cursor (o stdin dele: `hook_event_name`, `conversation_id`, `workspace_roots`,
   * `cwd`, `tool_name`, `tool_input`, `command`, `transcript_path`...) ao escritório. O Cursor tem conta única, então
   * não há parâmetro de conta (diferente do Codex). Devolve false para evento desconhecido.
   */
  applyHookEvent(input: Record<string, unknown>): boolean;
}
