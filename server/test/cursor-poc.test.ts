// Testes do harness local das POCs do Cursor (scripts/cursor-poc.ts). Cada caso RODA o script como
// processo (tsx) sobre fixtures SINTÉTICAS e confere a saída e o código, como o harness será usado:
// classificação + chaves/contagens (json/jsonl), tabelas+contagens (SQLite), o caminho inexistente e o
// `decision` (bloqueio do hook de decisão contra um stub local que segura N s).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HAS_POSIX_MODES, tempDir } from './fixtures';

const SCRIPT = resolve(__dirname, '../../scripts/cursor-poc.ts');
const HOOK = resolve(__dirname, '../../mod/habblaud-cursor/poc-hook.mjs');
const ROOT = resolve(__dirname, '../..');

/** Roda o harness como o usuário rodaria: `node --import tsx scripts/cursor-poc.ts <args>`. */
function cli(args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: ROOT,
    env: { ...process.env, ...env },
    ...(input !== undefined ? { input } : {}),
  });
}

const JSONL = [
  '{"role":"user","content":"oi"}',
  '{"role":"assistant","tool_calls":[{"function":{"name":"Read","arguments":"{\\"file_path\\":\\"/proj/app.ts\\"}"}}]}',
  '{"role":"assistant","content":[{"type":"tool_use","name":"Grep","input":{"pattern":"foo"}}]}',
  '{"role":"tool","content":"resultado"}',
].join('\n');

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

function write(name: string, content: string): string {
  const p = join(tmp.dir, name);
  writeFileSync(p, content);
  return p;
}

/** Cria um SQLite sintético (duas tabelas, contagens conhecidas) no caminho dado (sem binário externo). */
function makeSqlite(p: string): string {
  const db = new DatabaseSync(p);
  try {
    db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, role TEXT, content TEXT)');
    db.exec('CREATE TABLE stats(k TEXT, v INTEGER)');
    const ins = db.prepare('INSERT INTO messages(role, content) VALUES(?, ?)');
    ins.run('user', 'oi');
    ins.run('assistant', 'olá');
    ins.run('tool', 'ok');
    db.prepare('INSERT INTO stats(k, v) VALUES(?, ?)').run('n', 1);
  } finally {
    db.close();
  }
  return p;
}

/** SQLite sintético dentro do diretório temporário do teste. */
function sqlite(name: string): string {
  return makeSqlite(join(tmp.dir, name));
}

describe('cursor-poc.ts transcript', () => {
  it('JSONL: classifica e reporta linhas, papéis, tool-calls e chaves com contagem', () => {
    const r = cli(['transcript', '--path', write('a.jsonl', `${JSONL}\n`)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Formato: jsonl');
    expect(r.stdout).toContain('Linhas: 4');
    expect(r.stdout).toMatch(/Papéis:.*user.*assistant.*tool/);
    expect(r.stdout).toContain('Tool-calls: sim');
    expect(r.stdout).toMatch(/role\s+4/);
    expect(r.stdout).toMatch(/content\s+3/);
    expect(r.stdout).toMatch(/tool_calls\s+1/);
  });

  it('JSON: classifica e lista as chaves de topo com contagem', () => {
    const r = cli(['transcript', '--path', write('a.json', JSON.stringify({ role: 'user', content: 'oi', meta: { x: 1 } }))]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Formato: json');
    expect(r.stdout).toMatch(/content\s+1/);
    expect(r.stdout).toMatch(/meta\s+1/);
    expect(r.stdout).toMatch(/role\s+1/);
  });

  it('SQLite: lista tabelas e contagens pelo próprio Node, sem binário externo', () => {
    const r = cli(['transcript', '--path', sqlite('a.db')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Formato: sqlite');
    expect(r.stdout).toContain('Tabelas:');
    expect(r.stdout).toMatch(/messages\s+3/);
    expect(r.stdout).toMatch(/stats\s+1/);
  });

  it('formato opaco: classifica sem lançar (saída 0)', () => {
    const r = cli(['transcript', '--path', write('a.bin', 'nada de json\nnem de sqlite\n')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Formato: opaco');
  });

  it('--path inexistente: mensagem clara e código de saída diferente de 0', () => {
    const missing = join(tmp.dir, 'nao-existe.jsonl');
    const r = cli(['transcript', '--path', missing]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(missing);
    expect(`${r.stdout}${r.stderr}`).toMatch(/não encontrado/i);
  });

  it('--help e sem subcomando: mostram o uso e saem com 0', () => {
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('transcript');
    expect(help.stdout).toContain('--path');
    const none = cli([]);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('Uso:');
  });

  it('subcomando desconhecido: erro e código diferente de 0', () => {
    const r = cli(['transcrever']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/desconhecido/i);
  });
});

/** Roda o hook de captura como a IDE rodaria: `node mod/habblaud-cursor/poc-hook.mjs` com o evento no stdin. */
function hook(input: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH, ...env },
  });
}

describe('cursor-poc poc-hook.mjs (captura)', () => {
  it('anexa {ts, dir, event} no diretório de captura (HOME falso, padrão ~/.habblaud/cursor-poc)', () => {
    const home = join(tmp.dir, 'home');
    const event = { hook_event_name: 'preToolUse', conversation_id: 'c1', cwd: '/proj', tool_name: 'Read' };
    const r = hook(JSON.stringify(event), { HOME: home });
    expect(r.status).toBe(0);
    const log = readFileSync(join(home, '.habblaud', 'cursor-poc', 'events.jsonl'), 'utf8').trim();
    expect(log.split('\n')).toHaveLength(1);
    const line = JSON.parse(log) as { ts: string; dir: string; event: typeof event };
    expect(typeof line.ts).toBe('string');
    expect(line.dir).toBe('/proj');
    expect(line.event.hook_event_name).toBe('preToolUse');
    expect(line.event.conversation_id).toBe('c1');
  });

  it('evento com transcript_path: grava o caminho e o dump do stdin', () => {
    const home = join(tmp.dir, 'home');
    const raw = JSON.stringify({ hook_event_name: 'sessionStart', cwd: '/proj', transcript_path: '/proj/.cursor/transcript.jsonl' });
    const r = hook(raw, { HOME: home });
    expect(r.status).toBe(0);
    const dir = join(home, '.habblaud', 'cursor-poc');
    expect(readFileSync(join(dir, 'transcripts.txt'), 'utf8')).toContain('/proj/.cursor/transcript.jsonl');
    const dumps = readdirSync(join(dir, 'stdin'));
    expect(dumps).toHaveLength(1);
    expect(readFileSync(join(dir, 'stdin', dumps[0]), 'utf8')).toBe(raw);
  });

  it('stdin inválido/não-JSON: sai 0 e não escreve nada', () => {
    const home = join(tmp.dir, 'home');
    const r = hook('isto não é json', { HOME: home });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, '.habblaud', 'cursor-poc', 'events.jsonl'))).toBe(false);
  });

  it('HABBLAUD_CURSOR_POC_DIR troca o diretório de captura', () => {
    const home = join(tmp.dir, 'home');
    const dir = join(tmp.dir, 'capturas');
    const r = hook(JSON.stringify({ hook_event_name: 'stop', cwd: '/p' }), { HOME: home, HABBLAUD_CURSOR_POC_DIR: dir });
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(home, '.habblaud', 'cursor-poc', 'events.jsonl'))).toBe(false);
  });
});

const isHarnessCommand = (e: { command?: unknown }) => typeof e.command === 'string' && /poc-hook\.mjs/.test(e.command);
const ourEntries = (file: { hooks?: Record<string, Array<{ command?: unknown }>> }) =>
  Object.values(file.hooks ?? {}).flat().filter(isHarnessCommand);

describe('cursor-poc install/uninstall/report', () => {
  it('install: hooks.json ausente → cria com version 1 e os hooks do harness em cada evento', () => {
    const home = join(tmp.dir, 'home');
    const r = cli(['install'], { HOME: home });
    expect(r.status).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8')) as { version?: unknown; hooks?: Record<string, Array<{ command?: unknown }>> };
    expect(saved.version).toBe(1);
    const names = Object.keys(saved.hooks ?? {});
    expect(names).toContain('preToolUse');
    expect(names).toContain('sessionStart');
    expect(names.every((n) => saved.hooks![n].every((e) => typeof e.command === 'string'))).toBe(true);
    expect(ourEntries(saved).length).toBe(names.length); // um hook do harness por evento
  });

  it('install: mergeia preservando hooks alheios, faz backup do original e é idempotente', () => {
    const home = join(tmp.dir, 'home');
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const other = { version: 1, hooks: { preToolUse: [{ command: 'outro-hook' }] } };
    writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify(other, null, 2)}\n`);

    const r1 = cli(['install'], { HOME: home });
    expect(r1.status).toBe(0);
    const file = join(dir, 'hooks.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    expect(saved.hooks.preToolUse[0]).toEqual({ command: 'outro-hook' }); // o hook alheio fica
    expect(saved.hooks.preToolUse.some(isHarnessCommand)).toBe(true); // e o nosso entra
    expect(saved.hooks.sessionStart.some(isHarnessCommand)).toBe(true);

    const backups = readdirSync(dir).filter((f) => f.includes('backup'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, backups[0]), 'utf8'))).toEqual(other);

    const before = readFileSync(file, 'utf8');
    const r2 = cli(['install'], { HOME: home });
    expect(r2.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before); // nada muda
    expect(readdirSync(dir).filter((f) => f.includes('backup'))).toHaveLength(1); // nem backup novo
  });

  it('install --project <dir>: grava em <dir>/.cursor/hooks.json', () => {
    const proj = join(tmp.dir, 'projeto');
    mkdirSync(proj, { recursive: true });
    const r = cli(['install', '--project', proj]);
    expect(r.status).toBe(0);
    const saved = JSON.parse(readFileSync(join(proj, '.cursor', 'hooks.json'), 'utf8')) as { hooks?: Record<string, unknown[]> };
    expect(Object.keys(saved.hooks ?? {}).length).toBeGreaterThan(0);
  });

  it('uninstall: remove só os hooks do harness, preservando os demais', () => {
    const home = join(tmp.dir, 'home');
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const other = { version: 1, hooks: { preToolUse: [{ command: 'outro-hook' }], stop: [{ command: 'outro-stop' }] } };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(other));
    expect(cli(['install'], { HOME: home }).status).toBe(0);

    const r = cli(['uninstall'], { HOME: home });
    expect(r.status).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    expect(saved.hooks.preToolUse).toEqual([{ command: 'outro-hook' }]);
    expect(saved.hooks.stop).toEqual([{ command: 'outro-stop' }]);
    expect(ourEntries(saved)).toEqual([]);
  });

  it('report: lê o diretório de captura e imprime a matriz evento → dispara?/contagem/campos', () => {
    const home = join(tmp.dir, 'home');
    const dir = join(home, '.habblaud', 'cursor-poc');
    mkdirSync(dir, { recursive: true });
    const lines = [
      { ts: 't1', dir: '/p', event: { hook_event_name: 'preToolUse', cwd: '/p', tool_name: 'Read' } },
      { ts: 't2', dir: '/p', event: { hook_event_name: 'preToolUse', cwd: '/p', tool_name: 'Grep', conversation_id: 'c1' } },
      { ts: 't3', dir: '/p', event: { hook_event_name: 'stop', cwd: '/p' } },
    ].map((l) => JSON.stringify(l));
    writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);

    const r = cli(['report'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('| Evento | Dispara? | Contagem | Campos |');
    expect(r.stdout).toMatch(/\| preToolUse \| sim \| 2 \|/);
    expect(r.stdout).toMatch(/conversation_id/);
    expect(r.stdout).toMatch(/\| stop \| sim \| 1 \|/);
    expect(r.stdout).toMatch(/\| sessionStart \| não \| 0 \|/);
  });

  it('report: diretório de captura vazio → mensagem explicativa e código 0', () => {
    const home = join(tmp.dir, 'home');
    const r = cli(['report'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/nenhum evento/i);
  });
});

/** Medição impressa pelo `decision`: "Bloqueio medido: 1.02 s (pedido: 1 s)." */
function measuredSeconds(stdout: string): number {
  const m = /Bloqueio medido:\s*([0-9]+(?:\.[0-9]+)?)\s*s/.exec(stdout);
  if (!m) throw new Error(`sem medição de bloqueio em:\n${stdout}`);
  return Number(m[1]);
}

describe('cursor-poc.ts decision (bloqueio do hook de decisão)', () => {
  it('--hold 1: mede ~1 s de bloqueio, aplica {"permission":"allow"} e sai 0 (dentro do limite)', () => {
    const r = cli(['decision', '--hold', '1', '--limit', '5']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Stub no ar');
    expect(r.stdout).toContain('aplicou a decisão: {"permission":"allow"}');
    expect(r.stdout).toMatch(/Dentro do limite seguro/);
    const sec = measuredSeconds(r.stdout);
    expect(sec).toBeGreaterThanOrEqual(0.9);
    expect(sec).toBeLessThan(4);
  }, 30_000);

  it('--hold igual ao limite: não é excesso (sai 0)', () => {
    const r = cli(['decision', '--hold', '1', '--limit', '1']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Dentro do limite seguro/);
  }, 30_000);

  it('--hold acima do limite: reporta o limite seguro observado e sai ≠ 0', () => {
    const r = cli(['decision', '--hold', '2', '--limit', '1']);
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/Limite seguro observado: 1 s/);
    expect(out).toMatch(/excede o limite seguro/);
    expect(r.stdout).toContain('aplicou a decisão: {"permission":"allow"}'); // o bloqueio foi medido
    const sec = measuredSeconds(r.stdout);
    expect(sec).toBeGreaterThanOrEqual(1.5);
    expect(sec).toBeLessThan(6);
  }, 30_000);

  it('--hold/--limit inválidos e opção desconhecida: erro e saída ≠ 0', () => {
    for (const args of [['decision', '--hold', 'abc'], ['decision', '--hold', '0'], ['decision', '--limit', '-1'], ['decision', '--nada']]) {
      const r = cli(args);
      expect(r.status, args.join(' ')).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`, args.join(' ')).toMatch(/--hold|--limit|desconhecida/);
    }
  });

  it('--help lista o subcomando decision e as opções --hold/--limit', () => {
    const r = cli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('decision');
    expect(r.stdout).toContain('--hold');
    expect(r.stdout).toContain('--limit');
  });
});

describe('cursor-poc.ts usage (P8)', () => {
  it('--path <dir>: lista os candidatos (usage.json e state.vscdb) com tamanho e mtime', () => {
    const root = join(tmp.dir, 'uso');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'usage.json'), JSON.stringify({ plan: 'pro' }));
    makeSqlite(join(root, 'state.vscdb'));
    const r = cli(['usage', '--path', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage.json');
    expect(r.stdout).toContain('state.vscdb');
    expect(r.stdout).toContain('[json]');
    expect(r.stdout).toContain('[sqlite]');
    expect(r.stdout).toMatch(/\d+ B {2}\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/); // tamanho + mtime ISO
  });

  it('JSON: reporta só as chaves de topo e nunca os valores', () => {
    const root = join(tmp.dir, 'cfg');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'usage.json'), JSON.stringify({ plan: 'segredo-xyz', limits: { usados: 1 }, credit: 42 }));
    const r = cli(['usage', '--path', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Chaves JSON:');
    expect(r.stdout).toMatch(/plan\s+1/);
    expect(r.stdout).toMatch(/limits\s+1/);
    expect(r.stdout).toMatch(/credit\s+1/);
    expect(r.stdout).not.toContain('segredo-xyz');
  });

  it('SQLite: reporta as tabelas e as contagens', () => {
    const root = join(tmp.dir, 'db');
    mkdirSync(root, { recursive: true });
    makeSqlite(join(root, 'state.vscdb'));
    const r = cli(['usage', '--path', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Tabelas:');
    expect(r.stdout).toMatch(/messages\s+3/);
    expect(r.stdout).toMatch(/stats\s+1/);
  });

  it('sem --path: varre as raízes do HOME falso (~/.cursor)', () => {
    const home = join(tmp.dir, 'home');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'agent-cli-state.json'), JSON.stringify({ ativo: true }));
    const r = cli(['usage'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('agent-cli-state.json');
  });

  it('ignora projects/ (um usage.json lá dentro não é listado)', () => {
    const root = join(tmp.dir, 'ign');
    mkdirSync(join(root, 'projects', 'p1'), { recursive: true });
    writeFileSync(join(root, 'projects', 'p1', 'usage.json'), JSON.stringify({ escondido: 1 }));
    writeFileSync(join(root, 'usage.json'), JSON.stringify({ visivel: 1 }));
    const r = cli(['usage', '--path', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(join('ign', 'usage.json'));
    expect(r.stdout).not.toContain('projects');
  });

  it('diretório inexistente: mensagem explicativa e código 0', () => {
    const r = cli(['usage', '--path', join(tmp.dir, 'nao-existe')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/nenhum arquivo candidato/i);
  });

  it.skipIf(!HAS_POSIX_MODES)('arquivo sem permissão de leitura não lança (sai 0)', () => {
    const root = join(tmp.dir, 'opaco');
    mkdirSync(root, { recursive: true });
    const file = join(root, 'usage.json');
    writeFileSync(file, JSON.stringify({ plan: 'x' }));
    chmodSync(file, 0o000);
    try {
      const r = cli(['usage', '--path', root]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('usage.json');
    } finally {
      chmodSync(file, 0o644);
    }
  });
});

/** Escreve um `events.jsonl` de captura sintético no HOME dado (formato do poc-hook: {ts, dir, event}). */
function capture(home: string, events: Array<Record<string, unknown>>): void {
  const dir = join(home, '.habblaud', 'cursor-poc');
  mkdirSync(dir, { recursive: true });
  const lines = events.map((event) => JSON.stringify({ ts: 't', dir: '/p', event }));
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
}

describe('cursor-poc.ts subagents (P4)', () => {
  it('install: passa a instalar subagentStart/subagentStop no hooks.json (17 eventos)', () => {
    const home = join(tmp.dir, 'home');
    const r = cli(['install'], { HOME: home });
    expect(r.status).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8')) as { hooks?: Record<string, unknown[]> };
    const names = Object.keys(saved.hooks ?? {});
    expect(names).toContain('subagentStart');
    expect(names).toContain('subagentStop');
    expect(names).toHaveLength(17);
  });

  it('par casado por id: reporta o par como casado e mostra o pai', () => {
    const home = join(tmp.dir, 'home');
    capture(home, [
      { hook_event_name: 'subagentStart', subagent_id: 's1', parent_conversation_id: 'pai-1' },
      { hook_event_name: 'subagentStop', subagent_id: 's1', parent_conversation_id: 'pai-1' },
    ]);
    const r = cli(['subagents'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/par s1\s+casado/);
    expect(r.stdout).toContain('pai: pai-1');
  });

  it('órfão: um stop sem start é reportado como órfão', () => {
    const home = join(tmp.dir, 'home');
    capture(home, [{ hook_event_name: 'subagentStop', subagent_id: 's2' }]);
    const r = cli(['subagents'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/órfão s2/);
  });

  it('evento de subagente sem id: reporta sem-correlação (sem falhar)', () => {
    const home = join(tmp.dir, 'home');
    capture(home, [{ hook_event_name: 'subagentStart', cwd: '/p' }]);
    const r = cli(['subagents'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/sem-correlação/);
  });

  it('sem eventos de subagente: imprime "não observado" e sai 0', () => {
    const home = join(tmp.dir, 'home');
    capture(home, [{ hook_event_name: 'preToolUse', conversation_id: 'c1' }]);
    const r = cli(['subagents'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/não observado/i);
  });

  it('events.jsonl com linha corrompida: ignora e segue (sai 0)', () => {
    const home = join(tmp.dir, 'home');
    const dir = join(home, '.habblaud', 'cursor-poc');
    mkdirSync(dir, { recursive: true });
    const good = JSON.stringify({ ts: 't', dir: '/p', event: { hook_event_name: 'subagentStart', subagent_id: 's3' } });
    writeFileSync(join(dir, 'events.jsonl'), `{ linha quebrada\n${good}\n`);
    const r = cli(['subagents'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/par s3/);
  });
});

/** NDJSON sintético no formato do `cursor-agent -p --output-format stream-json`. */
const CLI_STREAM = [
  JSON.stringify({ type: 'system', session_id: 'sess-1', model: 'x' }),
  JSON.stringify({ type: 'assistant', message: { content: 'oi' } }),
  JSON.stringify({ type: 'tool_call', tool_name: 'Read' }),
  JSON.stringify({ type: 'tool_call', name: 'Grep' }),
  JSON.stringify({ type: 'result', subtype: 'success' }),
  '{ linha corrompida',
].join('\n') + '\n';

describe('cursor-poc.ts cli (P5)', () => {
  it('--path <arquivo>: conta tipos, extrai session_id, diversidade e ilegíveis', () => {
    const r = cli(['cli', '--path', write('stream.ndjson', CLI_STREAM)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sess-1');
    expect(r.stdout).toMatch(/system\s+1/);
    expect(r.stdout).toMatch(/assistant\s+1/);
    expect(r.stdout).toMatch(/tool_call\s+2/);
    expect(r.stdout).toMatch(/result\s+1/);
    expect(r.stdout).toMatch(/Ferramentas: 2 distintas, 2 chamadas/);
    expect(r.stdout).toMatch(/Read\s+1/);
    expect(r.stdout).toMatch(/Grep\s+1/);
    expect(r.stdout).toMatch(/ileg[íi]veis:\s*1/);
  });

  it('sem --path: lê o stream do stdin', () => {
    const r = cli(['cli'], {}, CLI_STREAM);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sess-1');
    expect(r.stdout).toMatch(/tool_call\s+2/);
  });

  it('stream vazio: contagens zeradas e saída 0', () => {
    const r = cli(['cli']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Eventos: 0/);
    expect(r.stdout).toMatch(/ileg[íi]veis:\s*0/);
  });

  it('--path inexistente: erro e código ≠ 0', () => {
    const r = cli(['cli', '--path', join(tmp.dir, 'nao-existe.ndjson')]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/não encontrado/i);
  });
});
