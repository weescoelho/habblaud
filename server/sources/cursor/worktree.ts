// Worktree por tarefa headless (P5 · SC-22/SC-23): cada tarefa isolada roda num `git worktree` com branch
// dedicada (`habblaud/<taskId>`), criada e limpa pelo escritório. A limpeza NUNCA apaga conteúdo não commitado:
// com alterações pendentes o worktree e a branch ficam de pé e o conflito é sinalizado (edge case da spec).
//
// O `git` é chamado por `execFile` (sem shell; mesmo padrão de `server/messages/codex.ts`), com o runner
// injetável para os testes de quem não quer um repositório real. O `WorktreeManager` em si não decide o
// caminho da linha de comando do agente: só prepara e limpa o isolamento.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Saída crua de um comando `git` (código negativo = o binário nem rodou). */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Um comando `git` (args + cwd). Injetável para os testes; o padrão usa o `git` do PATH. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/** O isolamento criado para uma tarefa: repositório de origem, pasta, branch e id. */
export interface WorktreeInfo {
  /** Raiz do repositório de origem (onde a sala do projeto vive). */
  repo: string;
  /** Pasta do worktree. */
  dir: string;
  /** Branch dedicada (`habblaud/<taskId>`). */
  branch: string;
  taskId: string;
}

/** Resultado da limpeza: removido, ou preservado com o motivo (`dirty` = alterações não commitadas). */
export type WorktreeRemoveResult = { removed: true } | { removed: false; reason: 'dirty' | 'failed' };

export interface WorktreeManagerOptions {
  /** Pasta base dos worktrees; padrão `<tmp>/habblaud-worktrees`. */
  baseDir?: string;
  git?: GitRunner;
}

const ERROR_MAX = 300;

/** Primeira linha não vazia da saída de erro, cortada (o `git` fala alto e cedo). */
function firstLine(s: string | undefined): string | undefined {
  const line = (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** Erro acionável de um comando git que falhou. */
function gitError(what: string, r: GitResult): Error {
  const detail = firstLine(r.stderr) ?? firstLine(r.stdout) ?? `código ${r.code}`;
  return new Error(`${what}: ${detail}`);
}

/** Runner padrão: `git` no PATH, sem shell e com prazo. Nunca rejeita — falha vira um `GitResult` com code ≠ 0. */
export function execFileGitRunner(git = 'git'): GitRunner {
  return (args, cwd) =>
    new Promise((done) => {
      execFile(git, args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' || e.code === 'EACCES') return done({ code: -1, stdout: '', stderr: `não consegui rodar o git (${git})` });
        done({ code: typeof e.code === 'number' ? e.code : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
}

/**
 * Prepara e limpa o isolamento de uma tarefa headless: `create(repo, taskId)` cria
 * `git worktree add -b habblaud/<taskId> <dir> HEAD`; `remove(info)` apaga o worktree e a branch — mas só
 * quando não há alterações pendentes (SC-23). O `--force` fica fora de propósito: preservar é o contrato.
 */
export class WorktreeManager {
  private readonly baseDir: string;
  private readonly git: GitRunner;

  constructor(opts: WorktreeManagerOptions = {}) {
    this.baseDir = opts.baseDir ?? join(tmpdir(), 'habblaud-worktrees');
    this.git = opts.git ?? execFileGitRunner();
  }

  /** Branch dedicada da tarefa (`habblaud/<taskId>`). */
  branchOf(taskId: string): string {
    return `habblaud/${taskId}`;
  }

  /** Pasta do worktree da tarefa (`<baseDir>/<taskId>`). */
  dirOf(taskId: string): string {
    return join(this.baseDir, taskId);
  }

  /** Cria o worktree e a branch. Lança com erro acionável se o git recusar (repo inválido, branch existente...). */
  async create(repo: string, taskId: string): Promise<WorktreeInfo> {
    const dir = this.dirOf(taskId);
    const branch = this.branchOf(taskId);
    mkdirSync(this.baseDir, { recursive: true });
    const r = await this.git(['worktree', 'add', '-b', branch, dir, 'HEAD'], repo);
    if (r.code !== 0) throw gitError(`não consegui criar o worktree da tarefa (${branch})`, r);
    return { repo, dir, branch, taskId };
  }

  /**
   * Apaga o worktree e a branch criados por `create`. Com alterações não commitadas (ou arquivos não
   * rastreados), NÃO apaga: devolve `{removed:false, reason:'dirty'}` e o diretório fica no lugar.
   */
  async remove(info: WorktreeInfo): Promise<WorktreeRemoveResult> {
    const dirty = await this.isDirty(info.dir);
    if (dirty === true) return { removed: false, reason: 'dirty' };
    const r = await this.git(['worktree', 'remove', info.dir], info.repo);
    if (r.code !== 0) return { removed: false, reason: 'failed' };
    await this.git(['branch', '-D', info.branch], info.repo);
    return { removed: true };
  }

  /** O worktree tem alterações pendentes? `undefined` quando a pasta não é um worktree legível. */
  private async isDirty(dir: string): Promise<boolean | undefined> {
    const r = await this.git(['status', '--porcelain'], dir);
    if (r.code !== 0) return undefined;
    return r.stdout.trim().length > 0;
  }
}
