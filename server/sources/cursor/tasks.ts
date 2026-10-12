// Tarefas headless gerenciadas (P5 · SC-21/SC-24/SC-25/SC-26): o escritório abre um `cursor-agent` em modo
// headless (`-p <prompt> --output-format stream-json --stream-partial-output`), isolado (por padrão) num
// worktree+branch por tarefa, e acompanha a saída normalizada (`stream.ts`) como uma sessão comum do Office.
//
// Contrato do lote:
// - `create()` LANÇA o processo (não confunde com "throw"): monta a linha de comando, faz `spawn`, grava o
//   stdout normalizado num JSONL (o terminal lê dali) e alimenta o Office (addMain/addActivity) — a tarefa
//   aparece na sala do PROJETO DE ORIGEM, com o rótulo da tarefa (SC-40 fica a cargo do chamador via `cwd`).
// - `stop()` encerra o processo e marca a tarefa `stopped`; `resume()` retoma a MESMA sessão (`--resume`).
// - `reconcile()` (no boot) marca como `stopped` a tarefa órfã (o processo não existe mais).
// - Binário ausente / falha de worktree → tarefa `failed` com erro acionável (SC-26).
//
// O `spawn` e o `WorktreeManager` são INJETÁVEIS: os testes de unidade nunca lançam um processo de verdade.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { normalizeCwd } from '../../model/rooms';
import type { AgentStats, CursorTaskInfo } from '../../../shared/types';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { cursorToolUses } from './transcript';
import { describeCursorTool } from './rollout';
import { normalizeStreamLine } from './stream';
import type { WorktreeInfo, WorktreeManager } from './worktree';

/** Prefixo do agente de Office que representa a tarefa (`cursor:task:<id>`). */
export const TASK_AGENT_PREFIX = 'cursor:task:';
/** Papel exibido no Office para uma tarefa headless. */
const TASK_ROLE = 'Tarefa headless (Cursor)';
/** Aviso acionável quando o CLI do Cursor não está disponível (SC-26). */
export const MISSING_BIN = 'não encontrei o cursor-agent: instale o CLI do Cursor ou defina HABBLAUD_CURSOR_AGENT_BIN';

/** Modos do Cursor expostos por tarefa (padrão `plan`). */
export type TaskMode = 'plan' | 'ask' | 'agent';

/** O que o usuário informa para criar uma tarefa. */
export interface TaskInput {
  prompt: string;
  /** Rótulo (nome da tarefa/branch); padrão: as primeiras palavras do prompt. */
  label?: string;
  /** Padrão `plan`. */
  mode?: TaskMode;
  model?: string;
  /** Projeto de origem (a sala onde a tarefa aparece). */
  cwd: string;
  /** Isolar em worktree+branch; padrão `true`. */
  isolated?: boolean;
  /** Executar forçado (`--trust --force`): opt-in explícito por tarefa; padrão `false`. */
  force?: boolean;
}

/** Um processo de tarefa (o mínimo que o `spawn` do Node satisfaz). */
export interface TaskProcess {
  pid?: number;
  stdout: Readable | null;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Fábrica do processo; injetável (os testes passam uma que nunca lança nada de verdade). */
export type TaskSpawner = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => TaskProcess;

/** Resultado da remoção: `dirty` = alterações não commitadas (worktree preservado). */
export type TaskRemoveResult = { removed: true } | { removed: false; reason: 'dirty' | 'failed' | 'missing' };

export interface TaskManagerOptions {
  office: Office;
  /** Gerencia o isolamento; ausente = um novo WorktreeManager com o padrão. */
  worktrees?: WorktreeManager;
  /** Fábrica de processo; padrão o `spawn` do Node. */
  spawn?: TaskSpawner;
  /** Diretório dos JSONL normalizados das tarefas. */
  dir?: string;
  /** Arquivo de persistência das tarefas (reconcile no boot); `null`/ausente = só memória. */
  file?: string | null;
  /** Binário do cursor-agent; explícito pula a busca. Padrão: HABBLAUD_CURSOR_AGENT_BIN ou o do PATH. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Nome do binário headless no PATH (o execFile sem shell não roda `.cmd`/scripts). */
export const CURSOR_AGENT_BIN = process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent';

/** Um binário que o execFile (sem shell) consegue rodar. */
function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Binário do cursor-agent: explícito, HABBLAUD_CURSOR_AGENT_BIN ou o do PATH. `undefined` = não achou. */
export function findCursorAgentBin(env: NodeJS.ProcessEnv, explicit?: string): string | undefined {
  const given = explicit?.trim();
  if (given) return given;
  const override = env.HABBLAUD_CURSOR_AGENT_BIN?.trim();
  if (override) return canExecute(override) ? override : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, CURSOR_AGENT_BIN);
    if (canExecute(p)) return p;
  }
  return undefined;
}

/**
 * Argumentos do `cursor-agent` headless. O prompt vai no `-p` (o CLI o lê como valor); o formato e o
 * `--stream-partial-output` espelham o canal validado no POC. `--trust --force` só com opt-in; `--resume`
 * retoma a sessão. Sem `--workspace`: o diretório de trabalho do processo É o workspace (o worktree, quando
 * isolado) — evita passar um flag não confirmado no canal (context.md).
 */
export function taskArgs(input: {
  prompt: string;
  mode?: TaskMode;
  model?: string;
  resume?: string;
  force?: boolean;
}): string[] {
  const args = ['-p', input.prompt, '--output-format', 'stream-json', '--stream-partial-output'];
  if (input.mode) args.push('--mode', input.mode);
  if (input.model?.trim()) args.push('--model', input.model.trim());
  if (input.resume) args.push('--resume', input.resume);
  if (input.force) args.push('--trust', '--force');
  return args;
}

/** Rótulo padrão de uma tarefa sem nome: as primeiras palavras do prompt, cortadas. */
function firstWords(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ');
  return words.length > 46 ? `${words.slice(0, 45)}…` : words;
}

function zeroStats(): AgentStats {
  return { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };
}

/** O que a sessão de stream traz de novo (para `--resume`). */
function sessionIdOf(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  for (const v of [rec.session_id, rec.sessionId]) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

/** Estado interno de uma tarefa (o `info` é o que o snapshot/rotas expõem). */
interface TaskRecord {
  info: CursorTaskInfo;
  prompt: string;
  mode: TaskMode;
  model?: string;
  force: boolean;
  /** Projeto de origem (a sala). */
  cwd: string;
  isolated: boolean;
  worktree?: WorktreeInfo;
  transcriptPath: string;
  child?: TaskProcess;
  /** Sobra da última leitura do stdout (linha ainda incompleta). */
  buffer: string;
  /** Contador para ids de atividade. */
  seq: number;
}

/** Tarefa serializada (persistência). */
interface StoredTask {
  info: CursorTaskInfo;
  prompt: string;
  mode: TaskMode;
  model?: string;
  force: boolean;
  cwd: string;
  isolated: boolean;
  worktree?: WorktreeInfo;
  transcriptPath: string;
}

export class TaskManager {
  private readonly records = new Map<string, TaskRecord>();
  private readonly spawner: TaskSpawner;
  private readonly worktrees: WorktreeManager;
  private readonly dir: string;
  private readonly file: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bin?: string;
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly opts: TaskManagerOptions) {
    this.spawner = opts.spawn ?? ((bin, args, o) => spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) as ChildProcess as TaskProcess);
    this.dir = opts.dir ?? join(tmpdir(), 'habblaud-tasks');
    this.file = opts.file ?? null;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.bin = findCursorAgentBin(this.env, opts.bin);
    // O WorktreeManager padrão usa o binário do git do PATH; injetável nos testes.
    this.worktrees = opts.worktrees ?? (undefined as unknown as WorktreeManager);
    this.load();
  }

  /** As tarefas conhecidas (cópias), da mais antiga para a mais recente. */
  list(): CursorTaskInfo[] {
    return [...this.records.values()].map((r) => ({ ...r.info })).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** Arquivo do transcript normalizado de um agente de tarefa (para o terminal da fonte). */
  transcriptPathOf(agentId: string): string | undefined {
    for (const r of this.records.values()) if (r.info.agentId === agentId) return r.transcriptPath;
    return undefined;
  }

  /** O agente de Office pertence a uma tarefa gerenciada? */
  owns(agentId: string): boolean {
    return agentId.startsWith(TASK_AGENT_PREFIX);
  }

  /**
   * Abre a tarefa: isola (por padrão) num worktree, monta o comando, faz `spawn` e passa a observar. Falhas de
   * isolamento ou de lançamento resultam numa tarefa `failed` com erro acionável — nunca lançam (SC-26).
   */
  async create(input: TaskInput): Promise<CursorTaskInfo> {
    const prompt = (input.prompt ?? '').trim();
    if (!prompt) throw new Error('a tarefa precisa de um prompt');
    const now = this.now();
    const id = `task-${now.toString(36)}-${(++this.seq).toString(36)}`;
    const cwd = input.cwd;
    const info: CursorTaskInfo = {
      id,
      prompt,
      mode: input.mode ?? 'plan',
      model: input.model,
      agentId: `${TASK_AGENT_PREFIX}${id}`,
      roomId: normalizeCwd(cwd),
      label: (input.label ?? '').trim() || firstWords(prompt) || id,
      status: 'starting',
      createdAt: now,
    };
    const record: TaskRecord = {
      info,
      prompt,
      mode: info.mode,
      model: input.model,
      force: !!input.force,
      cwd,
      isolated: input.isolated !== false,
      transcriptPath: join(this.dir, `${id}.jsonl`),
      buffer: '',
      seq: 0,
    };
    this.records.set(id, record);
    // O transcript nasce com o prompt do usuário (o terminal mostra a instrução desde o começo).
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(record.transcriptPath, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: prompt }] } })}\n`);
    } catch (err) {
      return this.markFailed(record, `não consegui preparar o transcript da tarefa (${errMsg(err)})`);
    }

    if (record.isolated) {
      try {
        const wt = await this.worktrees.create(cwd, id);
        record.worktree = wt;
        record.info.worktree = wt.dir;
        record.info.branch = wt.branch;
      } catch (err) {
        return this.markFailed(record, `não consegui isolar a tarefa (${errMsg(err)})`);
      }
    }

    if (!this.bin) return this.markFailed(record, MISSING_BIN);
    const processDir = record.worktree ? record.worktree.dir : cwd;
    try {
      const proc = this.spawner(this.bin, taskArgs({ prompt, mode: record.mode, model: record.model, force: record.force }), { cwd: processDir, env: this.env });
      this.wire(record, proc, 'working');
    } catch (err) {
      return this.markFailed(record, `não consegui lançar o cursor-agent (${errMsg(err)})`);
    }
    this.save();
    return { ...record.info };
  }

  /** Encerra o processo e marca a tarefa `stopped` (a sessão segue retomável). */
  stop(id: string): CursorTaskInfo | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    this.kill(record);
    record.info.status = 'stopped';
    record.info.pid = undefined;
    this.setOfficeStatus(record, 'idle');
    this.save();
    return { ...record.info };
  }

  /** Retoma a MESMA sessão (`--resume <sessionId>`), com o prompt e o modo originais. */
  async resume(id: string): Promise<CursorTaskInfo | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.info.status === 'running' || record.info.status === 'starting') return { ...record.info };
    if (!this.bin) return this.markFailed(record, MISSING_BIN);
    record.info.status = 'starting';
    record.info.error = undefined;
    const processDir = record.worktree ? record.worktree.dir : record.cwd;
    try {
      const proc = this.spawner(
        this.bin,
        taskArgs({ prompt: record.prompt, mode: record.mode, model: record.model, force: record.force, resume: record.info.sessionId }),
        { cwd: processDir, env: this.env },
      );
      this.wire(record, proc, 'working');
    } catch (err) {
      return this.markFailed(record, `não consegui retomar a tarefa (${errMsg(err)})`);
    }
    this.save();
    return { ...record.info };
  }

  /**
   * Exclui a tarefa: encerra o processo e remove o worktree+branch. Com alterações não commitadas, NÃO remove
   * (devolve `dirty`) e a tarefa/worktree ficam de pé (SC-23).
   */
  async remove(id: string): Promise<TaskRemoveResult> {
    const record = this.records.get(id);
    if (!record) return { removed: false, reason: 'missing' };
    this.kill(record);
    if (record.worktree) {
      const r = await this.worktrees.remove(record.worktree);
      if (!r.removed) {
        record.info.status = 'stopped';
        record.info.error = r.reason === 'dirty' ? 'há alterações não commitadas: o worktree foi preservado' : 'não consegui remover o worktree da tarefa';
        this.setOfficeStatus(record, 'idle');
        this.save();
        return { removed: false, reason: r.reason === 'dirty' ? 'dirty' : 'failed' };
      }
    }
    this.records.delete(id);
    if (this.opts.office.has(record.info.agentId)) this.opts.office.closeMain(record.info.agentId);
    this.save();
    return { removed: true };
  }

  /** No boot: tarefa que não tem (mais) processo vivo vira `stopped` (SC-25). */
  reconcile(): void {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.child) continue;
      if (record.info.status !== 'starting' && record.info.status !== 'running') continue;
      record.info.status = 'stopped';
      record.info.pid = undefined;
      changed = true;
    }
    if (changed) this.save();
  }

  // ---------------------------------------------------------------- internos

  /** Amarra o processo à tarefa: entra no Office, observa o stdout e as bordas de saída/erro. */
  private wire(record: TaskRecord, proc: TaskProcess, status: 'working' | 'idle'): void {
    record.child = proc;
    record.info.pid = proc.pid;
    record.info.status = 'running';
    record.info.error = undefined;
    this.enterOffice(record, status);
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: unknown) => this.onChunk(record, String(chunk)));
    proc.once('exit', (code) => this.onExit(record, code));
    proc.on('error', (err) => this.onError(record, err));
  }

  private onChunk(record: TaskRecord, chunk: string): void {
    record.buffer += chunk;
    const lines = record.buffer.split(/\r?\n/);
    record.buffer = lines.pop() ?? '';
    for (const line of lines) this.ingest(record, line);
  }

  /** Normaliza uma linha do stdout, grava no JSONL e reflete ferramentas/sessão no Office. */
  private ingest(record: TaskRecord, raw: string): void {
    const session = sessionIdOf(raw);
    if (session) record.info.sessionId = session;
    const normalized = normalizeStreamLine(raw);
    if (!normalized) return;
    try {
      appendFileSync(record.transcriptPath, `${normalized}\n`);
    } catch (err) {
      log.warnOnce(`task-transcript:${record.info.id}`, `Tarefa ${record.info.id}: não consegui gravar o transcript (${errMsg(err)}).`);
    }
    for (const use of cursorToolUses(normalized)) {
      const { desc, tool } = describeCursorTool(use.name, use.input);
      this.opts.office.addActivity(record.info.agentId, { id: `${record.info.agentId}#${++record.seq}`, at: this.now(), ...desc, tool }, true);
    }
  }

  private onExit(record: TaskRecord, code: number | null): void {
    record.child = undefined;
    if (record.buffer.trim()) {
      this.ingest(record, record.buffer);
      record.buffer = '';
    }
    if (record.info.status === 'stopped') return;
    record.info.pid = undefined;
    if (code === 0) {
      record.info.status = 'done';
      this.setOfficeStatus(record, 'done');
    } else {
      record.info.status = 'failed';
      record.info.error = `o cursor-agent saiu com código ${code ?? '?'}`;
      this.setOfficeStatus(record, 'idle');
    }
    this.save();
  }

  private onError(record: TaskRecord, err: Error): void {
    record.child = undefined;
    if (record.info.status === 'stopped') return;
    this.markFailed(record, `não consegui lançar o cursor-agent (${errMsg(err)})`);
  }

  private kill(record: TaskRecord): void {
    const child = record.child;
    record.child = undefined;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Processo já terminou: nada a fazer.
    }
  }

  /** Traz a tarefa para o Office na sala do projeto de origem, com o rótulo da tarefa. */
  private enterOffice(record: TaskRecord, status: 'working' | 'idle'): void {
    const office = this.opts.office;
    office.addMain({
      id: record.info.agentId,
      provider: 'cursor',
      account: 'cursor',
      sessionId: record.info.id,
      cwd: record.cwd,
      role: TASK_ROLE,
      startedAt: record.info.createdAt,
      status,
    });
    office.applyTranscript(record.info.agentId, {
      title: record.info.label,
      tasks: [],
      stats: zeroStats(),
      ...(record.info.model ? { model: record.info.model } : {}),
    });
  }

  private setOfficeStatus(record: TaskRecord, status: 'idle' | 'done'): void {
    if (this.opts.office.has(record.info.agentId)) this.opts.office.setStatus(record.info.agentId, status);
  }

  private markFailed(record: TaskRecord, message: string): CursorTaskInfo {
    record.info.status = 'failed';
    record.info.error = message;
    record.info.pid = undefined;
    this.enterOffice(record, 'idle');
    this.save();
    return { ...record.info };
  }

  // ---------------------------------------------------------------- persistência

  private load(): void {
    if (!this.file) return;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`Não consegui ler ${this.file} (${errMsg(err)}).`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const tasks = (parsed as { tasks?: unknown })?.tasks;
    if (!Array.isArray(tasks)) return;
    for (const item of tasks) {
      const stored = item as StoredTask;
      if (!stored?.info || typeof stored.info.id !== 'string' || typeof stored.info.agentId !== 'string' || typeof stored.cwd !== 'string') continue;
      const info: CursorTaskInfo = { ...stored.info, status: stored.info.status === 'running' || stored.info.status === 'starting' ? 'running' : stored.info.status };
      delete info.pid;
      const worktree = stored.worktree && typeof stored.worktree.dir === 'string' ? stored.worktree : undefined;
      this.records.set(info.id, {
        info,
        prompt: typeof stored.prompt === 'string' ? stored.prompt : info.prompt,
        mode: stored.mode ?? info.mode,
        model: stored.model,
        force: !!stored.force,
        cwd: stored.cwd,
        isolated: stored.isolated !== false,
        worktree,
        transcriptPath: typeof stored.transcriptPath === 'string' ? stored.transcriptPath : join(this.dir, `${info.id}.jsonl`),
        buffer: '',
        seq: 0,
      });
    }
  }

  private save(): void {
    if (!this.file) return;
    const tasks: StoredTask[] = [...this.records.values()].map((r) => ({
      info: r.info,
      prompt: r.prompt,
      mode: r.mode,
      model: r.model,
      force: r.force,
      cwd: r.cwd,
      isolated: r.isolated,
      worktree: r.worktree,
      transcriptPath: r.transcriptPath,
    }));
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, tasks }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(`Não consegui gravar ${this.file} (${errMsg(err)}).`);
    }
  }
}
