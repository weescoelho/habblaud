// Regras locais do Cursor (server/permissions/cursor-rules.ts): leitura/escrita do bloco `rules` de
// ~/.habblaud/cursor-hook.json. Tudo com HOME/diretório temporário (nunca toca no ~ real): round-trip,
// dedupe, JSON malformado tolerado, teto de regras e escrita atômica.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addCursorRule, countLocalDecisions, cursorConfigPath, cursorDecisionsPath, CURSOR_RULE_MAX, readCursorConfig, writeCursorRule, type CursorRule } from './cursor-rules';
import { tempDir } from '../test/fixtures';

const rule = (over: Partial<CursorRule> = {}): CursorRule => ({ tool: 'Shell', pattern: '^npm test(\\s|$)', effect: 'allow', ...over });

describe('cursor-rules.ts (regras locais do Cursor)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
  });
  afterEach(() => tmp.cleanup());

  const writeRaw = (text: string): void => {
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(cursorConfigPath(home), text);
  };

  it('readCursorConfig: ausente, diretório inexistente ou JSON malformado = sem regras, sem lançar', () => {
    expect(readCursorConfig(home)).toEqual({ rules: [] });
    writeRaw('{ quebrado');
    expect(readCursorConfig(home)).toEqual({ rules: [] });
    writeRaw('[]');
    expect(readCursorConfig(home)).toEqual({ rules: [] });
  });

  it('readCursorConfig: normaliza decisionEvents e regras (malformada descartada, note opcional)', () => {
    writeRaw(
      JSON.stringify({
        port: 4900,
        decisionEvents: ['beforeShellExecution', ' beforeShellExecution ', '', 5],
        rules: [
          { tool: 'Shell', pattern: '^git status', effect: 'allow' },
          { tool: 'Shell', pattern: '^rm -rf', effect: 'deny', note: 'destrutivo' },
          { tool: '', pattern: '^x', effect: 'allow' },
          { tool: 'Shell', pattern: '^x', effect: 'talvez' },
          'lixo',
        ],
      }),
    );
    expect(readCursorConfig(home)).toEqual({
      decisionEvents: ['beforeShellExecution'],
      rules: [
        { tool: 'Shell', pattern: '^git status', effect: 'allow' },
        { tool: 'Shell', pattern: '^rm -rf', effect: 'deny', note: 'destrutivo' },
      ],
    });
  });

  it('addCursorRule: não duplica tool+pattern+effect (a repetida vai para o fim) e respeita o teto', () => {
    const a = rule({ pattern: '^a' });
    const b = rule({ pattern: '^b' });
    let cfg = addCursorRule({ rules: [] }, a);
    cfg = addCursorRule(cfg, b);
    expect(cfg.rules).toEqual([a, b]);
    // Repetida: sai da posição antiga e entra no fim (sem duplicar).
    cfg = addCursorRule(cfg, rule({ pattern: '^a' }));
    expect(cfg.rules).toEqual([b, rule({ pattern: '^a' })]);
    // Mesmo padrão, efeito diferente: é outra regra.
    cfg = addCursorRule(cfg, rule({ pattern: '^a', effect: 'deny' }));
    expect(cfg.rules).toHaveLength(3);
    // Teto: só as últimas CURSOR_RULE_MAX ficam.
    let big: { rules: CursorRule[] } = { rules: [] };
    for (let i = 0; i < CURSOR_RULE_MAX + 5; i++) big = addCursorRule(big, rule({ pattern: `^cmd${i}` }));
    expect(big.rules).toHaveLength(CURSOR_RULE_MAX);
    expect(big.rules[big.rules.length - 1]!.pattern).toBe(`^cmd${CURSOR_RULE_MAX + 4}`);
  });

  it('writeCursorRule: grava a regra, faz round-trip e preserva port/decisionTimeoutS e regras anteriores', () => {
    writeRaw(JSON.stringify({ port: 4900, decisionTimeoutS: 60, decisionEvents: ['beforeReadFile'] }));
    expect(writeCursorRule(home, rule({ note: 'npm test' }))).toEqual({ ok: true });
    expect(writeCursorRule(home, rule({ pattern: '^rm -rf', effect: 'deny', note: 'destrutivo' }))).toEqual({ ok: true });
    const saved = JSON.parse(readFileSync(cursorConfigPath(home), 'utf8'));
    expect(saved).toMatchObject({ port: 4900, decisionTimeoutS: 60, decisionEvents: ['beforeReadFile'] });
    expect(saved.rules).toEqual([rule({ note: 'npm test' }), rule({ pattern: '^rm -rf', effect: 'deny', note: 'destrutivo' })]);
    expect(readCursorConfig(home).rules).toHaveLength(2);
  });

  it('writeCursorRule: arquivo malformado é substituído (sem lançar) e a escrita é atômica (temp some, arquivo íntegro)', () => {
    writeRaw('{ quebrado');
    expect(writeCursorRule(home, rule())).toEqual({ ok: true });
    expect(readCursorConfig(home).rules).toEqual([rule()]);
    // O temp do temp+rename não fica para trás.
    const leftovers = readdirSync(join(home, '.habblaud')).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('writeCursorRule: destino impossível devolve erro em vez de lançar', () => {
    // `home` aponta para um arquivo (não diretório): mkdir falha.
    writeRaw('');
    const file = join(tmp.dir, 'nao-e-dir');
    writeFileSync(file, 'x');
    const r = writeCursorRule(join(file, 'sub'), rule());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });

  it('countLocalDecisions: conta as linhas não vazias do registro (ausente = 0)', () => {
    expect(countLocalDecisions(home)).toBe(0);
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(cursorDecisionsPath(home), '{"a":1}\n\n{"b":2}\n');
    expect(countLocalDecisions(home)).toBe(2);
    expect(existsSync(cursorDecisionsPath(home))).toBe(true);
  });
});
