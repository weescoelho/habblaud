// Terminal da conversa do Cursor: reconstrói user/assistant/tool/system das linhas JSONL do transcript,
// cobrindo 1:1 os ACs de T1 (CTRANS-04, CTRANS-05, CTRANS-06, CTRANS-07, CTRANS-08) e os edge cases da spec
// (linha inválida/em branco = [], vários tool_use na mesma linha, argumento ausente, máscara/truncamento).
// As fixtures são SINTÉTICAS: nenhuma conversa real é versionada.
import { describe, expect, it } from 'vitest';
import { TEXT_MAX } from '../terminal';
import { createCursorTerminalParser } from './terminal';

const line = (o: unknown) => JSON.stringify(o);
const msg = (role: 'user' | 'assistant', content: unknown[]) => line({ role, message: { content } });
const text = (t: string) => ({ type: 'text', text: t });
const tool = (name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', name, input });

/** Alimenta o parser com linhas e devolve todas as entradas (a ordem importa). */
function read(...lines: string[]) {
  const parser = createCursorTerminalParser();
  return lines.flatMap((l) => parser.push(l));
}

describe('terminal do Cursor: prompt e resposta', () => {
  it('role user com bloco text vira uma entrada user', () => {
    const out = read(msg('user', [text('Escreva os testes')]));
    expect(out).toEqual([{ kind: 'user', id: 'l1:0:u', at: expect.any(Number), text: 'Escreva os testes' }]);
  });

  it('role assistant com bloco text vira uma entrada assistant', () => {
    const out = read(msg('assistant', [text('Feito!')]));
    expect(out).toEqual([{ kind: 'assistant', id: 'l1:0', at: expect.any(Number), text: 'Feito!' }]);
  });

  it('usa timestamp/ts da linha como at, senão o último conhecido (CTRANS-08)', () => {
    const iso = '2026-10-10T14:03:00.000Z';
    const out = read(
      line({ role: 'user', timestamp: iso, message: { content: [text('oi')] } }),
      line({ type: 'turn_ended', ts: 1710000000000, status: 'success' }),
    );
    expect(out.map((e) => e.at)).toEqual([Date.parse(iso), 1710000000000]);
  });

  it('a mesma linha com vários blocos tool_use gera uma entrada por bloco (CTRANS-05, edge case)', () => {
    const out = read(msg('assistant', [text('Vou ler e rodar'), tool('Read', { path: 'a.ts' }), tool('Shell', { command: 'ls' })]));
    expect(out.map((e) => e.kind)).toEqual(['assistant', 'tool', 'tool']);
    expect(out.map((e) => (e.kind === 'tool' ? e.tool : e.kind))).toEqual(['assistant', 'Read', 'Bash']);
  });
});

describe('terminal do Cursor: tradução das ferramentas (CTRANS-05)', () => {
  it('Shell → Bash(cmd) com o input do comando', () => {
    const [e] = read(msg('assistant', [tool('Shell', { command: 'ls -la' })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Bash', title: 'Bash(ls -la)', inputKind: 'command' });
    if (e.kind === 'tool') expect(e.input).toContain('ls -la');
  });

  it('Read usa o argumento path do Cursor', () => {
    const [e] = read(msg('assistant', [tool('Read', { path: 'a.ts' })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Read', title: 'Read(a.ts)' });
  });

  it('Write usa contents (o canonical do toolView é content)', () => {
    const [e] = read(msg('assistant', [tool('Write', { path: 'a.ts', contents: 'linha' })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Write', title: 'Write(a.ts)', inputKind: 'diff' });
    if (e.kind === 'tool') expect(e.input).toContain('+ linha');
  });

  it('StrReplace vira Edit com diff', () => {
    const [e] = read(msg('assistant', [tool('StrReplace', { path: 'a.ts', old_string: 'a', new_string: 'b' })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Edit', title: 'Edit(a.ts)', inputKind: 'diff' });
    if (e.kind === 'tool') expect(e.input).toBe('- a\n+ b');
  });

  it('Glob usa glob_pattern no título', () => {
    const [e] = read(msg('assistant', [tool('Glob', { glob_pattern: '**/*.ts' })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Glob', title: 'Glob(**/*.ts)' });
  });

  it('Grep cita o padrão', () => {
    const [e] = read(msg('assistant', [tool('Grep', { pattern: 'foo' })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Grep', title: 'Grep(foo)' });
  });

  it('List vira LS com o caminho', () => {
    const [e] = read(msg('assistant', [tool('List', { path: 'src' })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'LS', title: 'LS(src)' });
  });

  it('CallDynamicTool vira mcp__<ns>__<tool>', () => {
    const [e] = read(msg('assistant', [tool('CallDynamicTool', { namespace: 'cursor', toolName: 'list_repos', arguments: { limit: 10 } })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'mcp__cursor__list_repos', title: 'cursor - list_repos (MCP)' });
  });

  it('CallDynamicTool com toolName Task vira delegate (Task)', () => {
    const [e] = read(msg('assistant', [tool('CallDynamicTool', { namespace: 'cursor', toolName: 'Task', arguments: { description: 'Fazer X', prompt: 'p' } })]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Task', title: 'Task(Fazer X)' });
  });

  it('GetDynamicTools/AskQuestion/UpdateCurrentStep geram entradas legíveis', () => {
    const out = read(
      msg('assistant', [tool('GetDynamicTools')]),
      msg('assistant', [tool('AskQuestion', { title: 'Qual caminho?' })]),
      msg('assistant', [tool('UpdateCurrentStep', { current_step: 'Rodando testes' })]),
    );
    expect(out).toMatchObject([
      { kind: 'tool', tool: 'GetDynamicTools', title: 'GetDynamicTools' },
      { kind: 'tool', tool: 'AskQuestion', title: 'AskQuestion(Qual caminho?)' },
      { kind: 'tool', tool: 'UpdateCurrentStep', title: 'UpdateCurrentStep(Rodando testes)' },
    ]);
  });

  it('tool_use sem o argumento esperado ainda emite a entrada, sem lançar (edge case)', () => {
    const [e] = read(msg('assistant', [tool('Shell', {})]));
    expect(e).toMatchObject({ kind: 'tool', tool: 'Bash', title: 'Bash' });
  });
});

describe('terminal do Cursor: fim de turno e linhas inválidas (CTRANS-04, CTRANS-06)', () => {
  it('turn_ended de sucesso vira system info', () => {
    const [e] = read(line({ type: 'turn_ended', status: 'success' }));
    expect(e).toMatchObject({ kind: 'system', level: 'info' });
  });

  it('turn_ended de erro vira system error', () => {
    const [e] = read(line({ type: 'turn_ended', status: 'error' }));
    expect(e).toMatchObject({ kind: 'system', level: 'error' });
  });

  it('turn_ended com status não-sucedido e desconhecido vira system warn', () => {
    const [e] = read(line({ type: 'turn_ended', status: 'interrupted' }));
    expect(e).toMatchObject({ kind: 'system', level: 'warn' });
  });

  it('linha inválida, desconhecida, vazia ou em branco devolve []', () => {
    const parser = createCursorTerminalParser();
    expect(parser.push('{ isso não é json')).toEqual([]);
    expect(parser.push(line({ type: 'algo_desconhecido' }))).toEqual([]);
    expect(parser.push(line({ role: 'user', message: { content: 'sem array' } }))).toEqual([]);
    expect(parser.push('')).toEqual([]);
    expect(parser.push('   ')).toEqual([]);
    expect(parser.push('x')).toEqual([]);
  });
});

describe('terminal do Cursor: máscara e truncamento (CTRANS-07)', () => {
  it('segredos saem mascarados', () => {
    const secret = 'ghp_abcdefghijklmnopqrst';
    const [e] = read(msg('assistant', [text(`token ${secret}`)]));
    expect(e.kind).toBe('assistant');
    if (e.kind === 'assistant') {
      expect(e.text).not.toContain(secret);
      expect(e.text).toContain('gh*_***');
    }
  });

  it('texto longo é truncado com o marcador do terminal', () => {
    const [e] = read(msg('user', [text('a'.repeat(TEXT_MAX + 500))]));
    expect(e.kind).toBe('user');
    if (e.kind === 'user') {
      expect(e.text.endsWith('…')).toBe(true);
      expect(e.text.length).toBeLessThanOrEqual(TEXT_MAX + 2);
    }
  });
});
