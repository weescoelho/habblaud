// Testes do harness local das POCs do Cursor (scripts/cursor-poc.ts). Cada caso RODA o script como
// processo (tsx) sobre fixtures SINTÉTICAS e confere a saída e o código, como o harness será usado:
// classificação + chaves/contagens (json/jsonl), tabelas+contagens (SQLite) e o caminho inexistente.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './fixtures';

const SCRIPT = resolve(__dirname, '../../scripts/cursor-poc.ts');
const HOOK = resolve(__dirname, '../../mod/habblaud-cursor/poc-hook.mjs');
const ROOT = resolve(__dirname, '../..');

/** Roda o harness como o usuário rodaria: `node --import tsx scripts/cursor-poc.ts <args>`. */
function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: ROOT,
    env: process.env,
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

/** SQLite sintético com duas tabelas e contagens conhecidas (sem binário externo). */
function sqlite(name: string): string {
  const p = join(tmp.dir, name);
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
