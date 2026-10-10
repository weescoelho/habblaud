// Testes do harness local das POCs do Cursor (scripts/cursor-poc.ts). Cada caso RODA o script como
// processo (tsx) sobre fixtures SINTÉTICAS e confere a saída e o código, como o harness será usado:
// classificação + chaves/contagens (json/jsonl), tabelas+contagens (SQLite) e o caminho inexistente.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './fixtures';

const SCRIPT = resolve(__dirname, '../../scripts/cursor-poc.ts');
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
