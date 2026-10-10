// Esqueleto do parser/inspetor do transcript do Cursor (P0). Derivado dos ACs CPOC-22/CPOC-23 e do "Done when" de T9:
// classificação dos 4 formatos, contagens/roles de JSONL, tabelas de um SQLite sintético, linha de fixture → Activity
// e linha desconhecida sem exceção. Fixtures sintéticas em pastas temporárias (nada de conversas reais).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { classifyTranscript, inspectTranscript, parseCursorTranscriptLine } from './transcript';

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

function sqlite(name: string, build: (db: DatabaseSync) => void): string {
  const p = join(tmp.dir, name);
  const db = new DatabaseSync(p);
  try {
    build(db);
  } finally {
    db.close();
  }
  return p;
}

const JSONL = [
  '{"role":"user","content":"oi"}',
  '{"role":"assistant","tool_calls":[{"function":{"name":"Read","arguments":"{\\"file_path\\":\\"/proj/app.ts\\"}"}}]}',
  '{"role":"assistant","content":[{"type":"tool_use","name":"Grep","input":{"pattern":"foo"}}]}',
  '{"role":"tool","content":"resultado"}',
].join('\n');

// Formato REAL observado no transcript do Cursor (P0/C1, 2026-10-10): a mensagem vem aninhada em
// `message.content` (com blocos `text` e `tool_use`) e os marcadores de turno são `{type:"turn_ended"}`.
const CURSOR_JSONL = [
  '{"role":"user","message":{"content":[{"type":"text","text":"rode npm test"}]}}',
  '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"npm test","description":"Rodar os testes"}}]}}',
  '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"StrReplace","input":{"path":"/p/a.ts","old_string":"a","new_string":"b"}}]}}',
  '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"CallDynamicTool","input":{"namespace":"cursor","toolName":"list_repositories"}}]}}',
  '{"type":"turn_ended","status":"success"}',
].join('\n');

describe('classifyTranscript', () => {
  it('classifica um objeto JSON único como json', () => {
    expect(classifyTranscript(write('a.json', JSON.stringify({ role: 'user', content: 'oi' }, null, 2)))).toBe('json');
  });

  it('classifica várias linhas JSON como jsonl', () => {
    expect(classifyTranscript(write('a.jsonl', `${JSONL}\n`))).toBe('jsonl');
  });

  it('classifica SQLite pelo magic dos primeiros bytes, sem binário externo', () => {
    expect(classifyTranscript(sqlite('a.db', (db) => db.exec('CREATE TABLE t(x)')))).toBe('sqlite');
  });

  it('classifica o desconhecido como opaco, sem lançar', () => {
    expect(classifyTranscript(write('a.bin', 'isto não é json\nnem sqlite\n'))).toBe('opaco');
  });
});

describe('inspectTranscript', () => {
  it('JSONL: nº de linhas, papéis distintos, chaves com contagem e presença de tool-call', () => {
    const r = inspectTranscript(write('a.jsonl', `${JSONL}\n`));
    expect(r.format).toBe('jsonl');
    expect(r.lines).toBe(4);
    expect(r.roles).toEqual(['user', 'assistant', 'tool']);
    expect(r.hasToolCalls).toBe(true);
    expect(r.keys).toContainEqual({ key: 'role', count: 4 });
    expect(r.keys).toContainEqual({ key: 'content', count: 3 });
    expect(r.keys).toContainEqual({ key: 'tool_calls', count: 1 });
  });

  it('JSON: chaves de topo observadas com contagem', () => {
    const r = inspectTranscript(write('a.json', JSON.stringify({ role: 'user', content: 'oi', meta: { x: 1 } })));
    expect(r.format).toBe('json');
    expect(r.keys).toEqual([
      { key: 'content', count: 1 },
      { key: 'meta', count: 1 },
      { key: 'role', count: 1 },
    ]);
    expect(r.hasToolCalls).toBe(false);
  });

  it('SQLite: lista tabelas e contagens pelo node:sqlite', () => {
    const p = sqlite('a.db', (db) => {
      db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, role TEXT, content TEXT)');
      db.exec('CREATE TABLE stats(k TEXT, v INTEGER)');
      const ins = db.prepare('INSERT INTO messages(role, content) VALUES(?, ?)');
      ins.run('user', 'oi');
      ins.run('assistant', 'olá');
      ins.run('tool', 'ok');
      db.prepare('INSERT INTO stats(k, v) VALUES(?, ?)').run('n', 1);
    });
    const r = inspectTranscript(p);
    expect(r.format).toBe('sqlite');
    expect(r.tables).toEqual([
      { name: 'messages', count: 3 },
      { name: 'stats', count: 1 },
    ]);
  });

  it('opaco: não lança e explica o formato', () => {
    const r = inspectTranscript(write('a.bin', 'lixo binário \u0000\u0001'));
    expect(r.format).toBe('opaco');
    expect(r.note).toBeTruthy();
    expect(r.tables).toEqual([]);
    expect(r.keys).toEqual([]);
  });

  it('JSONL do Cursor real (message.content): detecta tool-calls mesmo aninhados na mensagem', () => {
    const r = inspectTranscript(write('cursor.jsonl', `${CURSOR_JSONL}\n`));
    expect(r.format).toBe('jsonl');
    expect(r.lines).toBe(5);
    expect(r.roles).toEqual(['user', 'assistant']);
    expect(r.hasToolCalls).toBe(true); // antes do fix (C1) isto vinha `false`
    expect(r.keys).toContainEqual({ key: 'message', count: 4 });
    expect(r.keys).toContainEqual({ key: 'type', count: 1 });
  });
});

describe('parseCursorTranscriptLine', () => {
  it('linha de fixture com tool_use vira uma Activity com kind e label', () => {
    const r = parseCursorTranscriptLine('{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/proj/app.ts"}}]}');
    expect(r.role).toBe('assistant');
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0]).toMatchObject({ kind: 'read', label: 'Lendo app.ts', tool: 'Read' });
  });

  it('linha reconhecida de tool_calls (estilo function) também vira Activity', () => {
    const r = parseCursorTranscriptLine('{"role":"assistant","tool_calls":[{"function":{"name":"Grep","arguments":"{\\"pattern\\":\\"foo\\"}"}}]}');
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0]).toMatchObject({ kind: 'search', tool: 'Grep' });
    expect(r.activities[0].label).toContain('foo');
  });

  it('linha desconhecida (sem tool-call) devolve vazio, sem lançar', () => {
    expect(parseCursorTranscriptLine('{"role":"user","content":"texto sem ferramenta"}')).toEqual({ role: 'user', activities: [] });
  });

  it('linha que não é JSON devolve vazio, sem lançar', () => {
    expect(parseCursorTranscriptLine('não é json')).toEqual({ activities: [] });
  });

  it('linha real do Cursor (message.content): tool_use vira Activity nomeada', () => {
    const r = parseCursorTranscriptLine('{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"npm test"}}]}}');
    expect(r.role).toBe('assistant');
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0]).toMatchObject({ kind: 'test', label: 'Rodando testes', tool: 'Bash' });
  });

  it('bloco de texto dentro de message.content não vira Activity', () => {
    expect(parseCursorTranscriptLine('{"role":"user","message":{"content":[{"type":"text","text":"oi"}]}}')).toEqual({
      role: 'user',
      activities: [],
    });
  });

  it('marcador de turno do Cursor (sem role/tool) devolve vazio', () => {
    expect(parseCursorTranscriptLine('{"type":"turn_ended","status":"success"}')).toEqual({ activities: [] });
  });
});
