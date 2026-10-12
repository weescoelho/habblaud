// Detecção do GitHub do Cursor: `Shell`→`Bash` (via `githubCallOf`) e o fallback só-comando (o transcript do
// Cursor não grava `tool_result`). Derivado dos ACs CSH-09/CSH-10/CSH-12 — inclui as travas de
// `--dry-run`/`--delete`/`--auto` e a delegação a `detectGitHubResult` quando há resultado.
import { describe, expect, it } from 'vitest';
import { cursorGitHubCall, cursorGitHubEvent } from './github';

describe('cursorGitHubCall', () => {
  it('Shell → Bash via githubCallOf (git push / gh pr)', () => {
    expect(cursorGitHubCall('Shell', { command: 'git push origin main' })).toMatchObject({ tool: 'Bash', ops: ['push'] });
    expect(cursorGitHubCall('Shell', { command: 'gh pr create --title x' })).toMatchObject({ tool: 'Bash', ops: ['pr_create'] });
  });

  it('comando sem git/gh (ou ferramenta não-Bash) → undefined', () => {
    expect(cursorGitHubCall('Shell', { command: 'ls -la' })).toBeUndefined();
    expect(cursorGitHubCall('Read', { file_path: '/a.ts' })).toBeUndefined();
  });

  it('CallDynamicTool de um MCP do GitHub vira a chamada mcp__…', () => {
    const call = cursorGitHubCall('CallDynamicTool', {
      namespace: 'github',
      toolName: 'create_pull_request',
      arguments: { owner: 'o', repo: 'r', title: 't' },
    });
    expect(call).toMatchObject({ tool: 'mcp__github__create_pull_request', ops: ['pr_create'] });
    expect(cursorGitHubCall('CallDynamicTool', { namespace: 'github' })).toBeUndefined();
  });

  it('um nome já no formato mcp__ do GitHub passa direto pelo githubCallOf', () => {
    expect(cursorGitHubCall('mcp__github__merge_pull_request', { pullNumber: 12 })).toMatchObject({
      tool: 'mcp__github__merge_pull_request',
      ops: ['pr_merge'],
    });
  });
});

describe('cursorGitHubEvent (sem resultado: fallback só-comando)', () => {
  it('push → push; --dry-run/--delete → undefined (nada foi publicado)', () => {
    expect(cursorGitHubEvent(cursorGitHubCall('Shell', { command: 'git push origin main' })!)).toEqual({ kind: 'push' });
    const dry = cursorGitHubCall('Shell', { command: 'git push --dry-run origin main' })!;
    expect(dry.noPush).toBe(true);
    expect(cursorGitHubEvent(dry)).toBeUndefined();
    expect(cursorGitHubEvent(cursorGitHubCall('Shell', { command: 'git push --delete origin x' })!)).toBeUndefined();
  });

  it('pr create → pr_opened; pr merge → pr_merged com o número; --auto → undefined', () => {
    expect(cursorGitHubEvent(cursorGitHubCall('Shell', { command: 'gh pr create --title x --repo o/r' })!)).toMatchObject({
      kind: 'pr_opened',
      repo: 'o/r',
    });
    expect(cursorGitHubEvent(cursorGitHubCall('Shell', { command: 'gh pr merge 12' })!)).toMatchObject({ kind: 'pr_merged', number: 12 });
    const auto = cursorGitHubCall('Shell', { command: 'gh pr merge 12 --auto' })!;
    expect(auto.auto).toBe(true);
    expect(cursorGitHubEvent(auto)).toBeUndefined();
  });

  it('CI e release do Cursor → undefined (o desfecho é indispensável)', () => {
    expect(cursorGitHubEvent(cursorGitHubCall('Shell', { command: 'gh run watch' })!)).toBeUndefined();
    expect(cursorGitHubEvent(cursorGitHubCall('Shell', { command: 'gh pr checks 12' })!)).toBeUndefined();
    expect(cursorGitHubEvent(cursorGitHubCall('Shell', { command: 'gh release create v1' })!)).toBeUndefined();
  });
});

describe('cursorGitHubEvent (com resultado delega ao detectGitHubResult)', () => {
  it('push com saída de sucesso → push com a branch; push que falhou → undefined', () => {
    const call = cursorGitHubCall('Shell', { command: 'git push origin main' })!;
    expect(cursorGitHubEvent(call, { content: 'To github.com:o/r.git\n   7917867..32a2814  main -> main', tur: {}, isError: false })).toEqual({
      kind: 'push',
      branch: 'main',
    });
    expect(cursorGitHubEvent(call, { content: '! [rejected]', tur: {}, isError: true })).toBeUndefined();
  });

  it('gh pr create com a URL na saída → pr_opened com número/repo', () => {
    const call = cursorGitHubCall('Shell', { command: 'gh pr create --title x' })!;
    expect(cursorGitHubEvent(call, { content: 'https://github.com/o/r/pull/7', tur: {}, isError: false })).toMatchObject({
      kind: 'pr_opened',
      number: 7,
      repo: 'o/r',
    });
  });
});
