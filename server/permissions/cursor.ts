// Pedidos de aprovação do Cursor (hook de decisão mod/habblaud-cursor/hook.mjs): o título e o resumo saem da tradução
// das ferramentas do Cursor (`sources/cursor/rollout.ts`: `Shell`→Bash, `MCP:<tool>`→`mcp__<tool>`, o resto por
// `describeTool`); os argumentos (título/entrada) saem da mesma máquina usada pelo Codex (`codexToolView`, que trata
// Bash/apply_patch e cai no `toolView` para o resto). Só o texto e o ícone vêm da tradução do Cursor.
import { describeCursorTool } from '../sources/cursor/rollout';
import { codexToolView, type CodexToolView } from './codex';

type Rec = Record<string, unknown>;

/** Resumo de um pedido do Cursor: o que vai em PermissionRequestInfo (title, text, icon, input, inputKind). */
export function cursorToolView(tool: string, input: Rec, cwd?: string): CodexToolView {
  const { desc, tool: norm } = describeCursorTool(tool, input);
  return { ...codexToolView(norm, input, cwd), text: desc.text, icon: desc.icon };
}
