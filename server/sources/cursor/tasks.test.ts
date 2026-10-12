// Testes do TaskManager (P5 · SC-21/SC-24/SC-25/SC-26): abre, para, retoma, reconcilia e exclui tarefas
// headless SEM lançar nenhum processo de verdade (o `spawn` e o `git` são injetados). O Office é real, então
// a observabilidade (sala/rótulo/atividade/terminal) é exercitada pelo mesmo caminho da IDE (SC-24).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import type { CursorTaskInfo } from '../../../shared/types';
import { MISSING_BIN, TASK_AGENT_PREFIX, TaskManager, findCursorAgentBin, taskArgs, type TaskProcess, type TaskSpawner } from './tasks';
import { WorktreeManager, type GitRunner } from './worktree';
import { normalizeStreamLine } from './stream';

setQuiet(true);

/** Pasta base dos testes (preferida pelo harness; criada se faltar). */
const TEST_TMP = '/tmp/opencode';

/** Espera um macrotask para o PassThrough entregar os `data` escritos (o manager lê em modo flowing). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Processo falso: o teste controla a saída e as bordas de exit/erro; nada é lançado de verdade. */
class FakeProcess implements TaskProcess {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed?: NodeJS.Signals;
  private exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }

  once(_event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitCbs.push(cb);
  }

  on(_event: 'error', cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }

  /** Escreve no stdout (o manager normaliza e grava no JSONL). */
  push(text: string): void {
    this.stdout.write(text);
  }

  exit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code, null);
  }

  fail(err: Error): void {
    for (const cb of this.errorCbs) cb(err);
  }
}

/** Runner de git falso: monta um WorktreeManager real sem tocar repositório nenhum. */
function stubWorktrees(root: string, opts: { createFail?: string; dirty?: boolean; removeFail?: boolean } = {}): WorktreeManager {
  const git: GitRunner = async (args) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      return opts.createFail ? { code: 128, stdout: '', stderr: opts.createFail } : { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'status') return { code: 0, stdout: opts.dirty ? ' M arquivo.ts\n' : '', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'remove') {
      return opts.removeFail ? { code: 1, stdout: '', stderr: 'fatal: não removi' } : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return new WorktreeManager({ baseDir: join(root, 'worktrees'), git });
}

interface SpawnCall {
  bin: string;
  args: string[];
  cwd: string;
}

interface Harness {
  root: string;
  dir: string;
  office: Office;
  manager: TaskManager;
  worktrees: WorktreeManager;
  spawns: SpawnCall[];
  procs: FakeProcess[];
  advance(ms: number): void;
  /** Um segundo manager sobre o mesmo arquivo (exercita load/reconcile). */
  reload(file: string): TaskManager;
  cleanup(): void;
}

function makeHarness(opts: { createFail?: string; dirty?: boolean; removeFail?: boolean; spawnThrows?: boolean; env?: NodeJS.ProcessEnv } = {}): Harness {
  mkdirSync(TEST_TMP, { recursive: true });
  const root = mkdtempSync(join(TEST_TMP, 'habblaud-tasks-'));
  const dir = join(root, 'transcripts');
  const spawns: SpawnCall[] = [];
  const procs: FakeProcess[] = [];
  let clock = 1_000_000;
  const now = () => clock;
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    now,
  });
  const worktrees = stubWorktrees(root, opts);
  const env = opts.env ?? { PATH: '/usr/bin' };
  const spawn: TaskSpawner = (bin, args, o) => {
    spawns.push({ bin, args, cwd: o.cwd });
    if (opts.spawnThrows) throw new Error('o spawn explodiu');
    const p = new FakeProcess();
    procs.push(p);
    return p;
  };
  const manager = new TaskManager({ office, worktrees, spawn, dir, bin: '/opt/bin/cursor-agent', env, now });
  return {
    root,
    dir,
    office,
    manager,
    worktrees,
    spawns,
    procs,
    advance: (ms) => {
      clock += ms;
    },
    reload: (file) => new TaskManager({ office, worktrees, spawn, dir, file, bin: '/opt/bin/cursor-agent', env, now }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

let current: Harness | undefined;
afterEach(() => {
  current?.cleanup();
  current = undefined;
});

/** Histórico de atividades do agente de Office que representa a tarefa. */
function history(h: Harness, agentId: string) {
  return h.office.detail(agentId)?.history ?? [];
}

describe('taskArgs', () => {
  it('monta o comando headless com o prompt no -p e o stream-json (SC-21)', () => {
    expect(taskArgs({ prompt: 'ajuste o README', mode: 'plan' })).toEqual([
      '-p',
      'ajuste o README',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--mode',
      'plan',
    ]);
  });

  it('não força por padrão; --trust --force só com opt-in (SC-26)', () => {
    expect(taskArgs({ prompt: 'x' })).not.toContain('--force');
    expect(taskArgs({ prompt: 'x' })).not.toContain('--trust');
    expect(taskArgs({ prompt: 'x', force: true })).toEqual(expect.arrayContaining(['--trust', '--force']));
  });

  it('inclui --model quando informado e --resume ao retomar (SC-25)', () => {
    const args = taskArgs({ prompt: 'x', model: 'gpt-5', resume: 'sess-1' });
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5', '--resume', 'sess-1']));
    // Sem modelo, o flag some (não vira string vazia).
    expect(taskArgs({ prompt: 'x' })).not.toContain('--model');
  });
});

describe('findCursorAgentBin', () => {
  it('respeita o binário explícito e o override executável por env', () => {
    expect(findCursorAgentBin({}, '/meu/agent')).toBe('/meu/agent');

    mkdirSync(TEST_TMP, { recursive: true });
    const root = mkdtempSync(join(TEST_TMP, 'habblaud-bin-'));
    try {
      const exe = join(root, 'cursor-agent');
      writeFileSync(exe, '#!/bin/sh\nexit 0\n');
      chmodSync(exe, 0o755);
      expect(findCursorAgentBin({ HABBLAUD_CURSOR_AGENT_BIN: exe }, undefined)).toBe(exe);
      // Override que não é um arquivo executável é ignorado.
      expect(findCursorAgentBin({ HABBLAUD_CURSOR_AGENT_BIN: join(root, 'sumiu') }, undefined)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sem PATH nem override, não acha o binário', () => {
    expect(findCursorAgentBin({ PATH: '' }, undefined)).toBeUndefined();
  });
});

describe('TaskManager.create', () => {
  it('lança a sessão, entra na sala do projeto de origem e grava o prompt no transcript (SC-21/SC-24/SC-40)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'Crie a tela de login', label: 'login', mode: 'agent', model: 'gpt-5', cwd: '/projetos/alfa', isolated: false });

    expect(info.status).toBe('running');
    expect(info.agentId).toBe(`${TASK_AGENT_PREFIX}${info.id}`);
    expect(info.label).toBe('login');
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].bin).toBe('/opt/bin/cursor-agent');
    expect(h.spawns[0].cwd).toBe('/projetos/alfa');
    expect(h.spawns[0].args).toEqual(expect.arrayContaining(['-p', 'Crie a tela de login', '--mode', 'agent', '--model', 'gpt-5']));

    const agent = h.office.get(info.agentId);
    expect(agent?.provider).toBe('cursor');
    expect(agent?.status).toBe('working');
    expect(agent?.title).toBe('login');
    expect(agent?.roomId).toBe('/projetos/alfa');

    // O transcript nasce com o prompt do usuário (o terminal mostra a instrução desde o começo).
    const seeded = readFileSync(join(h.dir, `${info.id}.jsonl`), 'utf8');
    expect(seeded).toContain('Crie a tela de login');
    expect(h.manager.transcriptPathOf(info.agentId)).toBe(join(h.dir, `${info.id}.jsonl`));
    expect(h.manager.owns(info.agentId)).toBe(true);
    expect(h.manager.owns('cursor:c1')).toBe(false);
  });

  it('sem rótulo, usa as primeiras palavras do prompt', async () => {
    current = makeHarness();
    const info = await current.manager.create({ prompt: 'Ajuste o README e os testes do projeto agora', cwd: '/projetos/alfa' });
    expect(info.label).toBe('Ajuste o README e os testes');
  });

  it('isola num worktree+branch e roda o processo lá dentro (SC-22)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa', isolated: true });

    const expectedDir = join(h.root, 'worktrees', info.id);
    expect(info.worktree).toBe(expectedDir);
    expect(info.branch).toBe(`habblaud/${info.id}`);
    expect(h.spawns[0].cwd).toBe(expectedDir);
  });

  it('sem isolar, roda no próprio projeto (SC-21)', async () => {
    current = makeHarness();
    const info = await current.manager.create({ prompt: 'x', cwd: '/projetos/alfa', isolated: false });

    expect(info.worktree).toBeUndefined();
    expect(current.spawns[0].cwd).toBe('/projetos/alfa');
  });

  it('recusa prompt vazio sem lançar processo', async () => {
    current = makeHarness();
    await expect(current.manager.create({ prompt: '   ', cwd: '/projetos/alfa' })).rejects.toThrow(/prompt/);
    expect(current.spawns).toHaveLength(0);
  });

  it('binário ausente marca failed com erro acionável (SC-26)', async () => {
    current = makeHarness({ env: { PATH: '' } });
    const h = current;
    const manager = new TaskManager({ office: h.office, worktrees: h.worktrees, spawn: () => new FakeProcess(), dir: h.dir, env: { PATH: '' }, now: () => 1 });
    const info = await manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    expect(info.status).toBe('failed');
    expect(info.error).toBe(MISSING_BIN);
    expect(h.office.get(info.agentId)?.status).toBe('idle');
  });

  it('falha de worktree marca failed com o erro do git (SC-26)', async () => {
    current = makeHarness({ createFail: 'fatal: not a git repository' });
    const info = await current.manager.create({ prompt: 'x', cwd: '/projetos/alfa', isolated: true });

    expect(info.status).toBe('failed');
    expect(info.error).toContain('not a git repository');
    expect(current.spawns).toHaveLength(0);
  });

  it('spawn que lança marca failed sem derrubar o escritório (SC-26)', async () => {
    current = makeHarness({ spawnThrows: true });
    const info = await current.manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    expect(info.status).toBe('failed');
    expect(info.error).toContain('o spawn explodiu');
    expect(current.office.get(info.agentId)?.status).toBe('idle');
  });
});

describe('TaskManager observabilidade', () => {
  it('normaliza o stdout, grava no JSONL e reflete a ferramenta como atividade (SC-24)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa', isolated: false });
    const before = history(h, info.agentId).length;

    h.procs[0].push(`${normalizeStreamLine('{"type":"tool_call","tool_name":"Read","arguments":"{\\"path\\":\\"/x\\"}"}')}\n`);
    await tick();

    const lines = readFileSync(join(h.dir, `${info.id}.jsonl`), 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(1); // prompt + a linha normalizada
    expect(history(h, info.agentId).length).toBeGreaterThan(before);
    expect(history(h, info.agentId).some((a) => a.tool === 'Read')).toBe(true);
  });

  it('guarda o sessionId do stream para o --resume (SC-25)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    h.procs[0].push('{"type":"result","session_id":"sess-42","subtype":"success"}\n');
    await tick();

    h.manager.stop(info.id);
    await h.manager.resume(info.id);
    expect(h.spawns[1].args).toEqual(expect.arrayContaining(['--resume', 'sess-42']));
  });
});

describe('TaskManager stop/resume', () => {
  it('stop encerra o processo e mantém a sessão retomável (SC-25)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    const stopped = h.manager.stop(info.id);
    expect(stopped?.status).toBe('stopped');
    expect(stopped?.pid).toBeUndefined();
    expect(h.procs[0].killed).toBe('SIGTERM');
    expect(h.office.get(info.agentId)?.status).toBe('idle');
  });

  it('resume continua a MESMA sessão com prompt e modo originais (SC-25)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', mode: 'ask', cwd: '/projetos/alfa' });
    h.manager.stop(info.id);

    const resumed = await h.manager.resume(info.id);
    expect(resumed?.status).toBe('running');
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1].args).toEqual(expect.arrayContaining(['-p', 'x', '--mode', 'ask']));
  });

  it('resume de tarefa viva não lança outro processo', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    const same = await h.manager.resume(info.id);
    expect(same?.status).toBe('running');
    expect(h.spawns).toHaveLength(1);
  });

  it('retomar sem binário marca failed (SC-26)', async () => {
    current = makeHarness({ env: { PATH: '' } });
    const h = current;
    const manager = new TaskManager({ office: h.office, worktrees: h.worktrees, spawn: () => new FakeProcess(), dir: h.dir, env: { PATH: '' }, now: () => 1 });
    const info = await manager.create({ prompt: 'x', cwd: '/projetos/alfa' });
    const resumed = await manager.resume(info.id);
    expect(resumed?.status).toBe('failed');
    expect(resumed?.error).toBe(MISSING_BIN);
  });
});

describe('TaskManager.exit', () => {
  it('saída com código 0 marca done (SC-24)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    h.procs[0].exit(0);
    expect(h.manager.list()[0].status).toBe('done');
    expect(h.office.get(info.agentId)?.status).toBe('done');
  });

  it('saída com código ≠ 0 marca failed com o código (SC-24/SC-26)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    h.procs[0].exit(3);
    expect(h.manager.list()[0].status).toBe('failed');
    expect(h.manager.list()[0].error).toContain('3');
  });
});

describe('TaskManager.remove', () => {
  it('remove limpo apaga worktree/branch e tira o agente do escritório (SC-23)', async () => {
    current = makeHarness();
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa', isolated: true });

    const r = await h.manager.remove(info.id);
    expect(r).toEqual({ removed: true });
    expect(h.manager.list()).toHaveLength(0);
    expect(h.office.get(info.agentId)?.status).toBe('offline');
  });

  it('com alterações não commitadas, preserva e sinaliza conflito (SC-23)', async () => {
    current = makeHarness({ dirty: true });
    const h = current;
    const info = await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa', isolated: true });

    const r = await h.manager.remove(info.id);
    expect(r).toEqual({ removed: false, reason: 'dirty' });
    expect(h.manager.list()).toHaveLength(1);
    expect(h.manager.list()[0].status).toBe('stopped');
    expect(h.office.get(info.agentId)?.status).toBe('idle');
  });

  it('id desconhecido devolve missing', async () => {
    current = makeHarness();
    await expect(current.manager.remove('não-existe')).resolves.toEqual({ removed: false, reason: 'missing' });
  });
});

describe('TaskManager.reconcile', () => {
  it('marca stopped a tarefa órfã persistida (SC-25)', async () => {
    current = makeHarness();
    const h = current;
    const file = join(h.root, 'tasks.json');
    const manager = h.reload(file);
    const info = await manager.create({ prompt: 'x', cwd: '/projetos/alfa' });
    expect(info.status).toBe('running');
    expect(existsSync(file)).toBe(true);

    // Novo manager sobre o MESMO arquivo: sem processo vivo, a tarefa fica órfã.
    const booted = h.reload(file);
    expect(booted.list()[0].status).toBe('running');
    booted.reconcile();
    expect(booted.list()[0].status).toBe('stopped');
    expect(booted.list()[0].pid).toBeUndefined();
  });

  it('não mexe numa tarefa com processo vivo', async () => {
    current = makeHarness();
    const h = current;
    await h.manager.create({ prompt: 'x', cwd: '/projetos/alfa' });

    h.manager.reconcile();
    expect(h.manager.list()[0].status).toBe('running');
  });
});

/** Uma tarefa com o formato mínimo que a persistência espera. */
function storedTask(over: Partial<CursorTaskInfo> = {}): CursorTaskInfo {
  return {
    id: 'task-antiga',
    prompt: 'x',
    mode: 'plan',
    agentId: `${TASK_AGENT_PREFIX}task-antiga`,
    roomId: '/projetos/alfa',
    label: 'antiga',
    status: 'running',
    createdAt: 1,
    ...over,
  };
}

describe('TaskManager persistência', () => {
  it('lê um arquivo válido e ignora entradas fora do formato', () => {
    current = makeHarness();
    const h = current;
    const file = join(h.root, 'tasks.json');
    mkdirSync(h.root, { recursive: true });
    const write = (tasks: unknown[]) => writeFileSync(file, JSON.stringify({ version: 1, tasks }));
    write([
      { info: storedTask(), prompt: 'x', mode: 'plan', force: false, cwd: '/projetos/alfa', isolated: true, transcriptPath: join(h.dir, 'a.jsonl') },
      { info: { id: 2 } }, // inválida: ignorada
      'lixo',
    ]);

    const manager = h.reload(file);
    expect(manager.list().map((t) => t.id)).toEqual(['task-antiga']);
  });
});
