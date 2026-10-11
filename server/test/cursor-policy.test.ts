// Política local do hook do Cursor (mod/habblaud-cursor/policy.mjs): módulo puro, sem rede e sem `node:fs`.
// Cobre os ACs CPERM-03/05/06/07/08: eventos padrão e override por `decisionEvents`, `deny` > `allow`,
// regex inválida descartada, regra malformada ignorada, política ausente e a derivação do "sempre permitir".
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DECISION_EVENTS as SERVER_DEFAULT } from '../permissions/cursor-rules';

const POLICY = resolve(__dirname, '../../mod/habblaud-cursor/policy.mjs');

interface Rule {
  tool: string;
  pattern: string;
  effect: 'allow' | 'deny';
  note?: string;
}
interface PolicyModule {
  DEFAULT_DECISION_EVENTS: string[];
  decisionEventsOf(policy: unknown): Set<string>;
  rulesOf(policy: unknown): Rule[];
  subjectOf(tool: string | undefined, input: unknown): string | undefined;
  matchRule(rules: Rule[], tool: string | undefined, input: unknown): Rule | undefined;
  deriveRule(tool: string | undefined, input: unknown): Rule | undefined;
  ruleText(rule: unknown): string;
  allowOutput(): { permission: 'allow' };
  denyOutput(reason?: string): { permission: 'deny'; user_message: string };
}
const policy = (await import(pathToFileURL(POLICY).href)) as PolicyModule;

const rule = (over: Partial<Rule> = {}): Rule => ({ tool: 'Shell', pattern: '^npm test(\\s|$)', effect: 'allow', ...over });

describe('policy.mjs (política local do hook)', () => {
  it('DEFAULT_DECISION_EVENTS: só shell e MCP (os de maior risco)', () => {
    expect(policy.DEFAULT_DECISION_EVENTS).toEqual(['beforeShellExecution', 'beforeMCPExecution']);
    // Contrato: o padrão do servidor (cursor-rules, usado pelo status) não pode divergir do hook (policy.mjs).
    expect(SERVER_DEFAULT).toEqual(policy.DEFAULT_DECISION_EVENTS);
  });

  it('decisionEventsOf: sem política/inválido/vazio = padrão; com array válido = override (vazios descartados)', () => {
    expect(policy.decisionEventsOf(undefined)).toEqual(new Set(['beforeShellExecution', 'beforeMCPExecution']));
    expect(policy.decisionEventsOf({})).toEqual(new Set(['beforeShellExecution', 'beforeMCPExecution']));
    expect(policy.decisionEventsOf({ decisionEvents: 'x' })).toEqual(new Set(['beforeShellExecution', 'beforeMCPExecution']));
    expect(policy.decisionEventsOf({ decisionEvents: [] })).toEqual(new Set(['beforeShellExecution', 'beforeMCPExecution']));
    expect(policy.decisionEventsOf({ decisionEvents: ['  ', 5, null] })).toEqual(new Set(['beforeShellExecution', 'beforeMCPExecution']));
    expect(policy.decisionEventsOf({ decisionEvents: ['beforeReadFile', ' beforeReadFile ', '', 'preToolUse'] })).toEqual(new Set(['beforeReadFile', 'preToolUse']));
  });

  it('rulesOf: só tool+pattern+effect válidos; malformada é descartada e o motivo opcional é preservado', () => {
    expect(policy.rulesOf(undefined)).toEqual([]);
    expect(policy.rulesOf({ rules: 'x' })).toEqual([]);
    expect(
      policy.rulesOf({
        rules: [
          { tool: 'Shell', pattern: '^git status', effect: 'allow' },
          { tool: 'Shell', pattern: '^rm -rf', effect: 'deny', note: 'destrutivo' },
          { tool: '', pattern: '^x', effect: 'allow' },
          { tool: 'Shell', pattern: '', effect: 'allow' },
          { tool: 'Shell', pattern: '^x', effect: 'talvez' },
          { tool: 'Shell', pattern: '^x' },
          'lixo',
          null,
        ],
      }),
    ).toEqual([{ tool: 'Shell', pattern: '^git status', effect: 'allow' }, { tool: 'Shell', pattern: '^rm -rf', effect: 'deny', note: 'destrutivo' }]);
  });

  it('subjectOf: command > file_path > nome da ferramenta; sem nada, undefined', () => {
    expect(policy.subjectOf('Shell', { command: 'npm test' })).toBe('npm test');
    expect(policy.subjectOf('Read', { file_path: '/p/a.ts' })).toBe('/p/a.ts');
    expect(policy.subjectOf('MCP:github__x', { title: 'Bug' })).toBe('MCP:github__x');
    expect(policy.subjectOf(undefined, {})).toBeUndefined();
  });

  it('matchRule: casa por ferramenta + sujeito e resolve deny > allow', () => {
    const allow = rule();
    const deny = rule({ pattern: '^npm test(\\s|$)', effect: 'deny' });
    expect(policy.matchRule([allow], 'Shell', { command: 'npm test' })).toBe(allow);
    expect(policy.matchRule([allow], 'Shell', { command: 'npm run build' })).toBeUndefined();
    expect(policy.matchRule([allow], 'Read', { file_path: 'npm test' })).toBeUndefined(); // outra ferramenta
    // As duas casam: o deny vence, independentemente da ordem.
    expect(policy.matchRule([allow, deny], 'Shell', { command: 'npm test' })).toBe(deny);
    expect(policy.matchRule([deny, allow], 'Shell', { command: 'npm test' })).toBe(deny);
    // "*" vale em qualquer ferramenta.
    expect(policy.matchRule([rule({ tool: '*' })], 'Read', { file_path: 'npm test' })).toMatchObject({ effect: 'allow' });
    // Sem ferramenta ou sem sujeito: nada casa (o hook segue o fluxo anterior).
    expect(policy.matchRule([allow], undefined, { command: 'npm test' })).toBeUndefined();
    expect(policy.matchRule([allow], 'Shell', {})).toBeUndefined();
    expect(policy.matchRule([allow], 'Shell', undefined)).toBeUndefined();
  });

  it('matchRule: regex inválida e regra malformada são ignoradas (a válida seguinte ainda casa)', () => {
    const broken = rule({ pattern: '(' });
    const allow = rule();
    expect(policy.matchRule([broken], 'Shell', { command: 'npm test' })).toBeUndefined();
    expect(policy.matchRule([broken, null as unknown as Rule, allow], 'Shell', { command: 'npm test' })).toBe(allow);
  });

  it('deriveRule: prefixo ancorado a partir do sujeito; undefined sem sujeito; ruleText mostra o comando', () => {
    const derived = policy.deriveRule('Shell', { command: 'npm test' })!;
    expect(derived).toEqual({ tool: 'Shell', pattern: '^npm test(\\s|$)', effect: 'allow', note: 'npm test' });
    expect(policy.ruleText(derived)).toBe('Shell(npm test)');
    // O padrão ancorado casa o comando e o que vem depois (args), mas não um prefixo mais longo.
    expect(new RegExp(derived.pattern).test('npm test -- --run')).toBe(true);
    expect(new RegExp(derived.pattern).test('npm testing')).toBe(false);
    // Read/MCP usam o sujeito próprio.
    expect(policy.deriveRule('Read', { file_path: '/p/a.ts' })!.pattern).toBe('^/p/a\\.ts');
    expect(policy.deriveRule('MCP:github__x', { title: 'Bug' })!.pattern).toBe('^MCP:github__x$');
    // Sem sujeito: nada a derivar.
    expect(policy.deriveRule('Shell', {})).toBeUndefined();
    expect(policy.deriveRule(undefined, { command: 'npm test' })).toBeUndefined();
    expect(policy.ruleText({ tool: 'Shell', pattern: '^rm -rf', effect: 'deny' })).toBe('Shell(^rm -rf)');
  });

  it('allowOutput/denyOutput: formato nativo do Cursor', () => {
    expect(policy.allowOutput()).toEqual({ permission: 'allow' });
    expect(policy.denyOutput('comando destrutivo')).toEqual({ permission: 'deny', user_message: 'Recusado pela regra local do Habblaud: comando destrutivo' });
    expect(policy.denyOutput(undefined)).toEqual({ permission: 'deny', user_message: 'Recusado pela regra local do Habblaud.' });
  });
});
