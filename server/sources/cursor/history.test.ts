// Histórico do terminal do Cursor: listagem dos transcripts recentes (projects/<slug>/agent-transcripts/<id>/<id>.jsonl),
// o título do primeiro prompt, o `cwd` defensivo, o resolve seguro e a degradação. Fixtures SINTÉTICAS (nada de
// conversas reais), no formato observado ao vivo (message.content + turn_ended).
import { mkdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { truncate } from '../../../shared/activity';
import { setQuiet } from '../../log';
import { appendLines, symlinkOrSkip, tempDir, writeLines } from '../../test/fixtures';
import { HistorySet, type HistoryProvider } from '../source';
import { CursorHistory, isCursorSessionId } from './history';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

// Linhas sintéticas no formato real do transcript do Cursor.
const user = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
const assistant = (text: string) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
const shell = (command: string) => JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command } }] } });
const turnEnded = (status = 'success') => JSON.stringify({ type: 'turn_ended', status });
/** Uma linha com `cwd` (defensiva): o parser do histórico a usa para o `project`, quando existe. */
const withCwd = (cwd: string, text: string) => JSON.stringify({ cwd, role: 'user', message: { content: [{ type: 'text', text }] } });

/** Um HOME temporário com a árvore do Cursor (`<dir>/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`). */
function cursorHome(name = '.cursor') {
  const tmp = tempDir('habblaud-cursor-hist-');
  const dir = join(tmp.dir, name);
  mkdirSync(dir, { recursive: true });
  return {
    home: tmp.dir,
    dir,
    cleanup: tmp.cleanup,
    transcript(project: string, id: string, lines: string[], o: { mtime?: number } = {}): string {
      const path = join(dir, 'projects', project, 'agent-transcripts', id, `${id}.jsonl`);
      writeLines(path, lines);
      if (o.mtime !== undefined) utimesSync(path, o.mtime / 1000, o.mtime / 1000);
      return path;
    },
    append(path: string, lines: string[]): void {
      appendLines(path, lines);
    },
  };
}

function setup() {
  const home = cursorHome();
  cleanups.push(home.cleanup);
  const now = Date.now();
  const open = new Set<string>();
  const history = new CursorHistory({
    accounts: () => [{ id: 'cursor', dir: home.dir }],
    openAgentOf: (acc, sid) => (open.has(sid) ? `${acc}:${sid}` : undefined),
    now: () => now,
  });
  return { home, history, now, open };
}

describe('histórico do Cursor', () => {
  it('lista as sessões dos últimos 7 dias, da mais recente para a mais antiga', async () => {
    const { home, history, now, open } = setup();
    const a = home.transcript('proj-a', 'sess-a', [user('Arrume o checkout'), shell('npm test'), turnEnded()], { mtime: now - 3_600_000 });
    home.transcript('proj-b', 'sess-b', [user('pergunta antiga'), assistant('resposta')], { mtime: now - 2 * 86_400_000 });
    home.transcript('proj-old', 'sess-old', [user('muito antiga')], { mtime: now - 10 * 86_400_000 });
    open.add('sess-a');

    const list = await history.list();
    expect(list.map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b']);
    expect(list[0]).toMatchObject({
      account: 'cursor',
      provider: 'cursor',
      sessionId: 'sess-a',
      projectDir: 'proj-a',
      title: 'Arrume o checkout',
      lastAt: statSync(a).mtimeMs,
      firstAt: statSync(a).mtimeMs,
      open: true,
      agentId: 'cursor:sess-a',
    });
    expect(list[0].size).toBeGreaterThan(0);
    expect(list[1]).toMatchObject({ account: 'cursor', provider: 'cursor', sessionId: 'sess-b', projectDir: 'proj-b', title: 'pergunta antiga', open: false });
    expect(list[1].agentId).toBeUndefined();
    expect(history.hasAccount('cursor')).toBe(true);
    expect(history.hasAccount('.outra')).toBe(false);
  });

  it('o título sai do primeiro prompt (cortado); um transcript sem prompt não inventa título', async () => {
    const { home, history, now } = setup();
    const long = 'x'.repeat(200);
    home.transcript('proj-a', 'sess-a', [user(long), user('segundo'), turnEnded()], { mtime: now - 1_000 });
    home.transcript('proj-b', 'sess-b', [shell('ls'), turnEnded()], { mtime: now - 2_000 });

    const list = await history.list();
    const a = list.find((s) => s.sessionId === 'sess-a')!;
    const b = list.find((s) => s.sessionId === 'sess-b')!;
    expect(a.title).toBe(truncate(long, 90));
    expect(b.title).toBeUndefined();
  });

  it('usa o `cwd` de uma linha do transcript como `project`, sem inventar caminho a partir do slug', async () => {
    const { home, history, now } = setup();
    home.transcript('home-ana-loja', 'sess-a', [withCwd('/home/ana/loja', 'oi')], { mtime: now - 1_000 });
    home.transcript('sem-cwd', 'sess-b', [user('sem diretório')], { mtime: now - 2_000 });

    const list = await history.list();
    expect(list.find((s) => s.sessionId === 'sess-a')).toMatchObject({ project: '/home/ana/loja', projectDir: 'home-ana-loja' });
    expect(list.find((s) => s.sessionId === 'sess-b')?.project).toBeUndefined();
    expect(list.find((s) => s.sessionId === 'sess-b')?.projectDir).toBe('sem-cwd');
  });

  it('resolve: devolve o arquivo e um parser novo por chamada; id inválido 400; conta/sessão 404', ({ skip }) => {
    const { home, history, now } = setup();
    const path = home.transcript('proj-a', 'sess-a', [user('oi')], { mtime: now - 1_000 });
    const r = history.resolve('cursor', 'sess-a');
    expect('path' in r && r.path).toBe(path);
    if ('path' in r) {
      expect(r.createParser()).not.toBe(r.createParser());
      expect(r.createParser().push(user('olá'))[0]).toMatchObject({ kind: 'user', text: 'olá' });
    }
    expect(history.resolve('cursor', '../../etc/passwd')).toEqual({ status: 400, error: 'id de sessão inválido' });
    expect(history.resolve('.outra', 'sess-a')).toEqual({ status: 404, error: 'conta desconhecida' });
    expect(history.resolve('cursor', 'inexistente')).toMatchObject({ status: 404 });

    // Link para fora da pasta da conta: não serve.
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    const link = join(home.dir, 'projects', 'proj-a', 'agent-transcripts', 'sess-link', 'sess-link.jsonl');
    mkdirSync(join(link, '..'), { recursive: true });
    writeLines(join(outside.dir, 'x.jsonl'), [user('de fora')]);
    symlinkOrSkip(skip, join(outside.dir, 'x.jsonl'), link);
    expect(history.resolve('cursor', 'sess-link')).toMatchObject({ status: 404 });
  });

  it('um candidato ilegível é ignorado sem derrubar a listagem', async ({ skip }) => {
    const { home, history, now } = setup();
    home.transcript('proj-a', 'sess-a', [user('boa')], { mtime: now - 1_000 });
    const broken = join(home.dir, 'projects', 'proj-a', 'agent-transcripts', 'sess-broken', 'sess-broken.jsonl');
    mkdirSync(join(broken, '..'), { recursive: true });
    // Link quebrado: o `stat` do candidato falha e ele é ignorado (degrada).
    symlinkOrSkip(skip, join(home.dir, 'nao-existe.jsonl'), broken);

    const list = await history.list();
    expect(list.map((s) => s.sessionId)).toEqual(['sess-a']);
  });

  it('cache: o transcript só é relido quando o mtime/tamanho muda', async () => {
    const { home, history, now } = setup();
    const path = home.transcript('proj-a', 'sess-a', [user('primeiro')], { mtime: now - 1_000 });
    expect((await history.list())[0].title).toBe('primeiro');
    expect(history.reads).toBe(1);
    await history.list();
    expect(history.reads).toBe(1);
    home.append(path, [assistant('resposta')]);
    await history.list();
    expect(history.reads).toBe(2);
  });

  it('sem a pasta projects/ não lista nada (degrada, sem lançar)', async () => {
    const home = cursorHome();
    cleanups.push(home.cleanup);
    const history = new CursorHistory({ accounts: () => [{ id: 'cursor', dir: home.dir }], openAgentOf: () => undefined });
    await expect(history.list()).resolves.toEqual([]);
    expect(history.resolve('cursor', 'sess-a')).toMatchObject({ status: 404 });
  });

  it('um transcript vazio entra na listagem, sem título', async () => {
    const { home, history, now } = setup();
    home.transcript('proj-a', 'sess-vazia', [], { mtime: now - 1_000 });
    const list = await history.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 'sess-vazia', projectDir: 'proj-a', open: false });
    expect(list[0].title).toBeUndefined();
    expect(list[0].size).toBe(0);
  });

  it('o HistorySet despacha a conta `cursor` para o CursorHistory (e não para o Claude)', () => {
    const { home, history, now } = setup();
    const path = home.transcript('proj-a', 'sess-a', [user('oi')], { mtime: now - 1_000 });
    const claude: HistoryProvider = {
      provider: 'claude',
      hasAccount: (a) => a !== 'cursor',
      list: async () => [],
      resolve: () => ({ status: 404, error: 'sessão não encontrada' }),
    };
    const set = new HistorySet([claude, history]);
    const r = set.resolve('cursor', 'sess-a');
    expect('path' in r && r.path).toBe(path);
    expect(set.resolve('outra-conta', 'sess-a')).toMatchObject({ status: 404 });
  });

  it('o id de sessão aceita só caracteres de pasta (sem separadores de caminho)', () => {
    expect(isCursorSessionId('6087c51e-41bd-4801-89c9-84ce7775c102')).toBe(true);
    expect(isCursorSessionId('sess_ABC-123')).toBe(true);
    expect(isCursorSessionId('../etc')).toBe(false);
    expect(isCursorSessionId('a/b')).toBe(false);
    expect(isCursorSessionId('')).toBe(false);
  });
});
