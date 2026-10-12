import { describe, expect, it } from 'vitest';
import type { CursorTaskInfo } from '../../../shared/types';
import {
  createTask,
  emptyTaskForm,
  listTasks,
  removeTask,
  resumeTask,
  stopTask,
  TASK_MODE_LABEL,
  TASK_STATUS_LABEL,
  taskRequest,
  taskRows,
  type TasksFetch,
  type TasksResponse,
} from './tasks-model';

function task(over: Partial<CursorTaskInfo> = {}): CursorTaskInfo {
  return { id: 't1', prompt: 'arruma a loja', mode: 'plan', agentId: 'cursor:task:t1', roomId: 'loja', label: 'arruma a loja', status: 'running', createdAt: 1, ...over };
}

function resp(status: number, body: unknown): TasksResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** `fetch` falso que grava as chamadas e responde o que o caso mandar. */
function recorder(reply: TasksResponse | ((path: string) => TasksResponse)): { f: TasksFetch; calls: Array<{ path: string; init?: Parameters<TasksFetch>[1] }> } {
  const calls: Array<{ path: string; init?: Parameters<TasksFetch>[1] }> = [];
  const f: TasksFetch = async (path, init) => {
    calls.push({ path, init });
    return typeof reply === 'function' ? reply(path) : reply;
  };
  return { f, calls };
}

describe('formulário da tarefa (montagem)', () => {
  it('nasce vazio: modo plan e isolada (SC-21)', () => {
    expect(emptyTaskForm()).toEqual({ prompt: '', cwd: '', mode: 'plan', model: '', isolated: false });
    expect(emptyTaskForm('/p/loja')).toMatchObject({ cwd: '/p/loja', mode: 'plan', isolated: false });
    expect(TASK_MODE_LABEL).toEqual({ plan: 'Planejar', ask: 'Perguntar', agent: 'Executar' });
  });

  it('monta o corpo com trim, omite o modelo vazio e mantém a isolada (SC-21)', () => {
    expect(taskRequest({ prompt: '  arruma a loja  ', cwd: ' /p/loja ', mode: 'agent', model: '  ', isolated: false })).toEqual({
      prompt: 'arruma a loja',
      cwd: '/p/loja',
      mode: 'agent',
      isolated: false,
    });
    expect(taskRequest({ prompt: 'x', cwd: '/p', mode: 'ask', model: ' gpt ', isolated: true })).toEqual({ prompt: 'x', cwd: '/p', mode: 'ask', model: 'gpt', isolated: true });
    expect(taskRequest({ prompt: '   ', cwd: '/p', mode: 'plan', model: '', isolated: true })).toBeUndefined();
    expect(taskRequest({ prompt: 'x', cwd: '  ', mode: 'plan', model: '', isolated: true })).toBeUndefined();
  });
});

describe('estado da tarefa (leitura)', () => {
  it('vira linha com o rótulo do status, das mais recentes para as mais antigas (SC-24)', () => {
    const rows = taskRows([
      task({ id: 'velha', createdAt: 10, status: 'done', branch: 'cursor/tarefa-velha', mode: 'plan' }),
      task({ id: 'nova', createdAt: 30, status: 'failed', error: 'não encontrei o cursor-agent', mode: 'agent', model: 'gpt' }),
      task({ id: 'meio', createdAt: 20, status: 'running', mode: 'ask' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['nova', 'meio', 'velha']);
    expect(rows[0]).toMatchObject({ label: 'arruma a loja', statusLabel: TASK_STATUS_LABEL.failed, error: 'não encontrei o cursor-agent', model: 'gpt' });
    expect(rows[1].statusLabel).toBe('rodando');
    expect(rows[2]).toMatchObject({ statusLabel: 'concluída', branch: 'cursor/tarefa-velha' });
    expect(rows[0].model).toBe('gpt');
    expect(rows[2].error).toBeUndefined();
  });

  it('sem tarefas devolve lista vazia (SC-24)', () => {
    expect(taskRows(null)).toEqual([]);
    expect(taskRows(undefined)).toEqual([]);
    expect(taskRows([])).toEqual([]);
  });
});

describe('chamadas a /api/tasks*', () => {
  it('listTasks lê GET /api/tasks e degrada para vazio sem sucesso (SC-21)', async () => {
    const ok = recorder(resp(200, { tasks: [task()] }));
    expect(await listTasks(ok.f)).toEqual([task()]);
    expect(ok.calls).toEqual([{ path: '/api/tasks', init: undefined }]);

    const bad = recorder(resp(403, { error: 'desligadas' }));
    expect(await listTasks(bad.f)).toEqual([]);
    const weird = recorder(resp(200, { nope: 1 }));
    expect(await listTasks(weird.f)).toEqual([]);
  });

  it('createTask envia o corpo montado e devolve a tarefa (201) ou o erro acionável (SC-21, SC-26)', async () => {
    const { f, calls } = recorder(resp(201, { task: task({ status: 'running' }) }));
    expect(await createTask({ prompt: ' arruma ', cwd: '/p/loja', mode: 'agent', model: '', isolated: true }, f)).toEqual({ task: task() });
    expect(calls).toEqual([
      { path: '/api/tasks', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'arruma', cwd: '/p/loja', mode: 'agent', isolated: true }) } },
    ]);

    const failed = recorder(resp(409, { error: 'não encontrei o cursor-agent' }));
    expect(await createTask(emptyTaskForm('/p'), failed.f)).toEqual({ error: 'informe o prompt e o projeto de origem' });
    expect(failed.calls).toHaveLength(0);
    const conflict = recorder(resp(409, { error: 'não encontrei o cursor-agent' }));
    expect(await createTask({ prompt: 'x', cwd: '/p', mode: 'plan', model: '', isolated: true }, conflict.f)).toEqual({ error: 'não encontrei o cursor-agent' });
  });

  it('stopTask e resumeTask refletem a tarefa; desconhecida vira undefined/erro (SC-25)', async () => {
    const stopped = recorder(resp(200, { task: task({ status: 'stopped' }) }));
    expect(await stopTask('t1', stopped.f)).toEqual(task({ status: 'stopped' }));
    expect(stopped.calls[0].path).toBe('/api/tasks/t1/stop');

    const missing = recorder(resp(404, { error: 'tarefa não encontrada' }));
    expect(await stopTask('t1', missing.f)).toBeUndefined();

    const resumed = recorder(resp(200, { task: task({ status: 'running' }) }));
    expect(await resumeTask('t1', resumed.f)).toEqual({ task: task() });
    expect(resumed.calls[0]).toMatchObject({ path: '/api/tasks/t1/resume', init: { method: 'POST' } });

    const failed = recorder(resp(409, { error: 'não encontrei o cursor-agent' }));
    expect(await resumeTask('t1', failed.f)).toEqual({ error: 'não encontrei o cursor-agent' });
  });

  it('removeTask devolve removed ou o erro do servidor (SC-23)', async () => {
    const ok = recorder(resp(200, { removed: true }));
    expect(await removeTask('t1', ok.f)).toEqual({ removed: true });
    expect(ok.calls[0]).toMatchObject({ path: '/api/tasks/t1', init: { method: 'DELETE' } });

    const missing = recorder(resp(404, { error: 'tarefa não encontrada' }));
    expect(await removeTask('t1', missing.f)).toEqual({ removed: false, error: 'tarefa não encontrada' });

    const dirty = recorder(resp(409, { error: 'há alterações não commitadas: a tarefa foi preservada' }));
    expect(await removeTask('t1', dirty.f)).toEqual({ removed: false, error: 'há alterações não commitadas: a tarefa foi preservada' });
  });
});
