// Detecção do GitHub a partir dos `tool_use` do transcript do Cursor. O Cursor registra o comando em `Shell`
// (comando de shell), mas NÃO grava o `tool_result` (Fase 3): então, além do caminho comum do Claude/Codex
// (`githubCallOf`/`detectGitHubResult`), há um fallback só-comando. Sem o desfecho não dá para confirmar sucesso
// (limitação documentada, v1): emitimos pelo comando, respeitando as travas de `--dry-run`/`--delete`/`--auto`.
// CI e release ficam de fora (o desfecho é indispensável para saber o que aconteceu). Puro: a fonte lê a linha e
// chama isto; nada de rede nem token.
import type { GitHubEvent } from '../../../shared/github';
import { detectGitHubResult, githubCallOf, type GitHubCall } from '../github';

/**
 * Guarda a chamada do Cursor se ela pode gerar um evento do GitHub. O `Shell` do Cursor é o `Bash` das outras
 * ferramentas (delega ao `githubCallOf`); o `CallDynamicTool` (MCP dinâmico do transcript) vira o nome `mcp__…`;
 * um nome já no formato `mcp__` passa direto. `undefined` = não interessa.
 */
export function cursorGitHubCall(name: string, input: Record<string, unknown>): GitHubCall | undefined {
  if (name === 'Shell') return githubCallOf('Bash', input);
  if (name === 'CallDynamicTool') {
    const ns = typeof input.namespace === 'string' ? input.namespace : '';
    const tool = typeof input.toolName === 'string' ? input.toolName : '';
    if (!tool) return undefined;
    const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments) ? (input.arguments as Record<string, unknown>) : input;
    return githubCallOf(`mcp__${ns ? `${ns}__` : ''}${tool}`, args);
  }
  return githubCallOf(name, input);
}

/**
 * Evento do GitHub de uma chamada guardada do Cursor. Com um `result` presente, usa as regras comuns
 * (`detectGitHubResult`, como Claude/Codex). Sem resultado (o Cursor não grava `tool_result`), cai no fallback
 * só-comando: `pr_create`→`pr_opened`, `pr_merge`→`pr_merged` (sem `--auto`) e `push` (sem `--dry-run`/`--delete`).
 * CI/release devolvem `undefined` (o desfecho é indispensável). Limitação v1: o comando não confirma sucesso — pode
 * haver falso positivo.
 */
export function cursorGitHubEvent(
  call: GitHubCall,
  result?: { content: unknown; tur: Record<string, unknown>; isError: boolean; branch?: string },
): GitHubEvent | undefined {
  if (result) return detectGitHubResult(call, result);
  return commandOnlyEvent(call);
}

/** Fallback só-comando (sem `tool_result`): o que o próprio comando diz que foi feito. */
function commandOnlyEvent(call: GitHubCall): GitHubEvent | undefined {
  const ops = call.ops;
  if (ops.includes('pr_merge') && !call.auto) {
    const ev: GitHubEvent = { kind: 'pr_merged' };
    if (call.number !== undefined) ev.number = call.number;
    if (call.repo) ev.repo = call.repo;
    return ev;
  }
  if (ops.includes('pr_create')) {
    const ev: GitHubEvent = { kind: 'pr_opened' };
    if (call.number !== undefined) ev.number = call.number;
    if (call.repo) ev.repo = call.repo;
    return ev;
  }
  if (ops.includes('push') && !call.noPush) {
    const ev: GitHubEvent = { kind: 'push' };
    if (call.branch) ev.branch = call.branch;
    return ev;
  }
  return undefined;
}
