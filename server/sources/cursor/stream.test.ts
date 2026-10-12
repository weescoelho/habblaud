// Testes do normalizador do stream-json: o que sai tem de ser lido pelo MESMO parser do transcript do Cursor.
// Cobre o caminho feliz (texto, papel, ferramenta, fim de turno) e o divergente (texto puro/JSON estranho)
// degradando para uma entrada mínima, sem lançar (SC-24, risco R-2).
import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { createCursorTerminalParser } from './terminal';
import { normalizeStream, normalizeStreamLine } from './stream';

/** Alimenta o parser do Cursor com as linhas normalizadas e devolve as entradas. */
function feed(lines: string[]): TerminalEntry[] {
  const parser = createCursorTerminalParser();
  const out: TerminalEntry[] = [];
  for (const line of lines) out.push(...parser.push(line));
  return out;
}

/** Normaliza e alimenta o parser (o caminho real do TaskManager). */
function normalizeAndFeed(text: string): TerminalEntry[] {
  return feed(normalizeStream(text));
}

describe('normalizeStreamLine', () => {
  it('linha vazia/em branco não vira nada', () => {
    expect(normalizeStreamLine('')).toBeUndefined();
    expect(normalizeStreamLine('   \n')).toBeUndefined();
  });

  it('um resultado vira o fim de turno do transcript (SC-24)', () => {
    const line = normalizeStreamLine('{"type":"result","subtype":"success","duration_ms":12}');
    expect(JSON.parse(line as string)).toMatchObject({ type: 'turn_ended', status: 'success' });
    const [entry] = feed([line as string]);
    expect(entry).toMatchObject({ kind: 'system', level: 'info' });
  });

  it('resultado com erro marca o turno como erro (SC-24)', () => {
    const line = normalizeStreamLine('{"type":"result","is_error":true}') as string;
    const [entry] = feed([line]);
    expect(JSON.parse(line)).toMatchObject({ type: 'turn_ended', status: 'error' });
    expect(entry).toMatchObject({ kind: 'system', level: 'error' });
  });

  it('mensagem de assistente já no formato do transcript passa pelo parser (SC-24)', () => {
    const line = normalizeStreamLine('{"role":"assistant","message":{"content":[{"type":"text","text":"vou começar"}]}}');
    expect(JSON.parse(line as string)).toMatchObject({ role: 'assistant', message: { content: [{ type: 'text', text: 'vou começar' }] } });
    const [entry] = feed([line as string]);
    expect(entry).toMatchObject({ kind: 'assistant' });
    expect((entry as { text: string }).text).toContain('vou começar');
  });

  it('prompt do usuário vira entrada user do transcript (SC-24)', () => {
    const entry = normalizeAndFeed('{"type":"user","content":"ajuste o README"}')[0];
    expect(entry).toMatchObject({ kind: 'user' });
    expect((entry as { text: string }).text).toContain('ajuste o README');
  });

  it('tool_call singular vira tool_use e o parser reconhece a ferramenta (SC-24)', () => {
    const [entry] = normalizeAndFeed('{"type":"tool_call","tool_name":"Shell","arguments":"{\\"command\\":\\"ls -la\\"}"}');
    expect(entry).toMatchObject({ kind: 'tool', tool: 'Bash' });
  });

  it('tool_calls (estilo OpenAI) viram tool_use (SC-24)', () => {
    const [entry] = normalizeAndFeed('{"type":"assistant","tool_calls":[{"function":{"name":"Read","arguments":"{\\"path\\":\\"/x\\"}"}}]}');
    expect(entry).toMatchObject({ kind: 'tool', tool: 'Read' });
  });

  it('delta parcial preserva o texto (SC-24)', () => {
    const [entry] = normalizeAndFeed('{"type":"assistant_delta","delta":{"text":"parcial"}}');
    expect(entry).toMatchObject({ kind: 'assistant' });
    expect((entry as { text: string }).text).toContain('parcial');
  });

  it('preserva o timestamp quando o evento traz', () => {
    const line = normalizeStreamLine('{"type":"assistant","text":"oi","timestamp":"2026-10-11T12:00:00.000Z"}') as string;
    expect(JSON.parse(line)).toMatchObject({ timestamp: '2026-10-11T12:00:00.000Z' });
  });

  it('texto puro (não-JSON) degrada sem lançar (SC-24)', () => {
    const line = normalizeStreamLine('isso não é JSON');
    expect(line).toBeDefined();
    const [entry] = feed([line as string]);
    expect(entry).toMatchObject({ kind: 'assistant' });
    expect((entry as { text: string }).text).toContain('isso não é JSON');
  });

  it('JSON desconhecido degrada para entrada mínima sem lançar (SC-24)', () => {
    const line = normalizeStreamLine('{"foo":1,"bar":[2,3]}');
    expect(line).toBeDefined();
    const [entry] = feed([line as string]);
    expect(entry).toMatchObject({ kind: 'assistant' });
  });
});

describe('normalizeStream', () => {
  it('normaliza um trecho inteiro na ordem e alimenta o terminal (SC-24)', () => {
    const stream = [
      '{"type":"user","content":"crie o arquivo"}',
      '{"type":"tool_call","tool_name":"Write","arguments":"{\\"path\\":\\"/x/a.txt\\",\\"contents\\":\\"oi\\"}"}',
      '{"role":"assistant","message":{"content":[{"type":"text","text":"pronto"}]}}',
      '{"type":"result","subtype":"success"}',
      '',
    ].join('\n');
    const entries = normalizeAndFeed(stream);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'tool', 'assistant', 'system']);
    expect(entries.every((e) => typeof e.id === 'string' && e.id.length > 0)).toBe(true);
  });
});
