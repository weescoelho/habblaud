// Testes do WorktreeManager com um repositório git DESCARTÁVEL (em /tmp/opencode): nada toca a árvore real.
// Exercita o `git` de verdade — criação, remoção limpa, conflito (alterações não commitadas) e erro acionável.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeManager, type GitResult } from './worktree';

/** Pasta base dos testes (preferênciada pelo harness; criada se faltar). */
const TEST_TMP = '/tmp/opencode';

/** Roda `git` no repositório descartável (só para montar o cenário; o manager usa o runner padrão). */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

interface Fixture {
  root: string;
  repo: string;
  manager: WorktreeManager;
  cleanup: () => void;
}

/** Cria um repo git descartável com um commit inicial; o worktree base fica ao lado. */
function makeFixture(): Fixture {
  mkdirSync(TEST_TMP, { recursive: true });
  const root = mkdtempSync(join(TEST_TMP, 'habblaud-wt-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.email=t@e.st', '-c', 'user.name=Teste', 'commit', '-q', '--allow-empty', '-m', 'init'], repo);
  writeFileSync(join(repo, 'arquivo.txt'), 'base\n');
  git(['add', 'arquivo.txt'], repo);
  git(['-c', 'user.email=t@e.st', '-c', 'user.name=Teste', 'commit', '-q', '-m', 'arquivo'], repo);
  const manager = new WorktreeManager({ baseDir: join(root, 'worktrees') });
  return { root, repo, manager, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

let fixture: Fixture;
afterEach(() => fixture?.cleanup());

describe('WorktreeManager', () => {
  it('cria o worktree com a branch dedicada por tarefa (SC-22)', async () => {
    fixture = makeFixture();
    const info = await fixture.manager.create(fixture.repo, 'tarefa-1');

    expect(info.branch).toBe('habblaud/tarefa-1');
    expect(info.taskId).toBe('tarefa-1');
    expect(info.repo).toBe(fixture.repo);
    expect(existsSync(info.dir)).toBe(true);
    // O worktree materializa o HEAD do repo de origem.
    expect(existsSync(join(info.dir, 'arquivo.txt'))).toBe(true);
    // A branch dedicada existe no repositório de origem.
    expect(git(['branch', '--list', 'habblaud/tarefa-1'], fixture.repo)).toContain('habblaud/tarefa-1');
    // E é a branch em uso dentro do worktree.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], info.dir).trim()).toBe('habblaud/tarefa-1');
  });

  it('remove o worktree e a branch quando está limpo (SC-23)', async () => {
    fixture = makeFixture();
    const info = await fixture.manager.create(fixture.repo, 'tarefa-2');

    const r = await fixture.manager.remove(info);

    expect(r).toEqual({ removed: true });
    expect(existsSync(info.dir)).toBe(false);
    expect(git(['branch', '--list', 'habblaud/tarefa-2'], fixture.repo).trim()).toBe('');
  });

  it('preserva e sinaliza conflito com alterações não commitadas (SC-23)', async () => {
    fixture = makeFixture();
    const info = await fixture.manager.create(fixture.repo, 'tarefa-3');
    writeFileSync(join(info.dir, 'rascunho.txt'), 'não commitado\n');

    const r = await fixture.manager.remove(info);

    expect(r).toEqual({ removed: false, reason: 'dirty' });
    // O conteúdo pendente continua no lugar, e a branch também.
    expect(existsSync(join(info.dir, 'rascunho.txt'))).toBe(true);
    expect(git(['branch', '--list', 'habblaud/tarefa-3'], fixture.repo)).toContain('habblaud/tarefa-3');
  });

  it('lança erro acionável quando o git recusa a criação', async () => {
    // Runner injetado que falha: a mensagem do git sobe como erro claro.
    const failing = (): Promise<GitResult> => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository\nmais' });
    const manager = new WorktreeManager({ baseDir: join(TEST_TMP, 'não-usado'), git: failing });

    await expect(manager.create('/nao/existe', 'tarefa-4')).rejects.toThrow(/not a git repository/);
  });

  it('remove devolve falha (sem apagar) quando o git recusa a remoção', async () => {
    // `status` responde limpo (1ª chamada) para chegar na remoção, que falha (2ª chamada).
    let calls = 0;
    const gitStub = (): Promise<GitResult> => {
      calls++;
      return Promise.resolve(calls === 1 ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'fatal: erro' });
    };
    const manager = new WorktreeManager({ baseDir: TEST_TMP, git: gitStub });

    const r = await manager.remove({ repo: '/x', dir: '/x/wt', branch: 'habblaud/x', taskId: 'x' });
    expect(r).toEqual({ removed: false, reason: 'failed' });
  });
});
