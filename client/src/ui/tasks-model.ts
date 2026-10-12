// Tarefas headless do Cursor no cliente (P5 · SC-21/SC-24): monta o formulário de criação (prompt/modo/modelo/
// isolada) e lê o estado das tarefas para o launcher mostrar. A parte pura (form → corpo da requisição e
// tarefa → linha da interface) é testada em ui/tasks-model.test.ts; as chamadas a `/api/tasks*` aceitam um
// `fetch` injetável (os testes passam um falso). O launcher existente (ui/index.ts) usa isto.
import type { CursorTaskInfo } from '../../../shared/types';

/** Modos do Cursor expostos por tarefa (o mesmo contrato do servidor). */
export type TaskMode = 'plan' | 'ask' | 'agent';

/** Modos na ordem exibida, com o rótulo em PT-BR. */
export const TASK_MODE_LABEL: Record<TaskMode, string> = { plan: 'Planejar', ask: 'Perguntar', agent: 'Executar' };
export const TASK_MODES: readonly TaskMode[] = ['plan', 'ask', 'agent'];

/** Rótulo do estado da tarefa (SC-24: a mesma leitura de uma sessão comum). */
export const TASK_STATUS_LABEL: Record<CursorTaskInfo['status'], string> = {
  starting: 'iniciando',
  running: 'rodando',
  stopped: 'parada',
  failed: 'falhou',
  done: 'concluída',
};

/** O formulário do launcher para criar uma tarefa. */
export interface TaskForm {
  prompt: string;
  /** Projeto de origem (a sala onde a tarefa aparece). */
  cwd: string;
  mode: TaskMode;
  model: string;
  /** Isolar em worktree+branch. Padrão false. */
  isolated: boolean;
}

/** Formulário vazio (modo `plan`, isolada). */
export function emptyTaskForm(cwd = ''): TaskForm {
  return { prompt: '', cwd, mode: 'plan', model: '', isolated: false };
}

/** Corpo de `POST /api/tasks` a partir do formulário; undefined quando falta o prompt ou o projeto. */
export function taskRequest(form: TaskForm): { prompt: string; cwd: string; mode: TaskMode; model?: string; isolated: boolean } | undefined {
  const prompt = form.prompt.trim();
  const cwd = form.cwd.trim();
  if (!prompt || !cwd) return undefined;
  const model = form.model.trim();
  return { prompt, cwd, mode: form.mode, ...(model ? { model } : {}), isolated: form.isolated };
}

/** Linha da interface para uma tarefa (o que o launcher mostra). */
export interface TaskRow {
  id: string;
  label: string;
  prompt: string;
  mode: TaskMode;
  model?: string;
  /** Sala (projeto de origem). */
  roomId: string;
  status: CursorTaskInfo['status'];
  /** Rótulo do status em PT-BR. */
  statusLabel: string;
  branch?: string;
  error?: string;
  createdAt: number;
}

/** Linhas das tarefas, das mais recentes para as mais antigas. */
export function taskRows(tasks: CursorTaskInfo[] | null | undefined): TaskRow[] {
  return (tasks ?? [])
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      label: t.label,
      prompt: t.prompt,
      mode: t.mode,
      ...(t.model ? { model: t.model } : {}),
      roomId: t.roomId,
      status: t.status,
      statusLabel: TASK_STATUS_LABEL[t.status],
      ...(t.branch ? { branch: t.branch } : {}),
      ...(t.error ? { error: t.error } : {}),
      createdAt: t.createdAt,
    }));
}

/** O mínimo de `Response` que o modelo usa (permite injetar um falso nos testes). */
export interface TasksResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

/** Fábrica de requisição; padrão o `fetch` do navegador. */
export type TasksFetch = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<TasksResponse>;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Mensagem de erro do servidor (ou o status), sem depender de o corpo ser JSON. */
async function errorOf(res: TasksResponse): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string') return body.error;
  } catch {
    // Resposta sem JSON (ex.: a trava do Host): usa a mensagem padrão.
  }
  return `Não foi possível concluir (erro ${res.status}).`;
}

/** As tarefas conhecidas (GET /api/tasks); sem sucesso devolve lista vazia (degrada sem quebrar a interface). */
export async function listTasks(f: TasksFetch = fetch): Promise<CursorTaskInfo[]> {
  const res = await f('/api/tasks');
  if (!res.ok) return [];
  const body = (await res.json()) as { tasks?: unknown };
  return Array.isArray(body?.tasks) ? (body.tasks as CursorTaskInfo[]) : [];
}

/** Cria uma tarefa (POST /api/tasks): a tarefa criada (201) ou o erro acionável do servidor. */
export async function createTask(form: TaskForm, f: TasksFetch = fetch): Promise<{ task: CursorTaskInfo } | { error: string }> {
  const body = taskRequest(form);
  if (!body) return { error: 'informe o prompt e o projeto de origem' };
  const res = await f('/api/tasks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (res.status === 201) {
    const data = (await res.json()) as { task: CursorTaskInfo };
    return { task: data.task };
  }
  return { error: await errorOf(res) };
}

/** Para a tarefa (POST /api/tasks/:id/stop); undefined se o servidor não a conhece. */
export async function stopTask(id: string, f: TasksFetch = fetch): Promise<CursorTaskInfo | undefined> {
  const res = await f(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  if (!res.ok) return undefined;
  return ((await res.json()) as { task?: CursorTaskInfo }).task;
}

/** Retoma a mesma sessão (POST /api/tasks/:id/resume): a tarefa ou o erro acionável. */
export async function resumeTask(id: string, f: TasksFetch = fetch): Promise<{ task: CursorTaskInfo } | { error: string }> {
  const res = await f(`/api/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  if (res.ok) {
    const data = (await res.json()) as { task: CursorTaskInfo };
    return { task: data.task };
  }
  return { error: await errorOf(res) };
}

/**
 * Exclui a tarefa (DELETE /api/tasks/:id). `removed: true` quando saiu; senão a mensagem do servidor (tarefa
 * desconhecida, worktree com alterações não commitadas — SC-23).
 */
export async function removeTask(id: string, f: TasksFetch = fetch): Promise<{ removed: true } | { removed: false; error: string }> {
  const res = await f(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', headers: JSON_HEADERS });
  if (res.ok) return { removed: true };
  return { removed: false, error: await errorOf(res) };
}
