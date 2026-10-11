// Regras locais do Cursor ("sempre permitir"): lê/grava o bloco `rules` de ~/.habblaud/cursor-hook.json, o MESMO
// arquivo que o hook (mod/habblaud-cursor/hook.mjs) lê para decidir sem contatar o escritório. O Cursor não tem
// `updatedPermissions`, então o servidor emula a regra: quando você escolhe "permitir sempre", ele acrescenta uma
// regra `allow` aqui e o hook passa a aprovar sozinho o mesmo comando/arquivo.
//
// Regras: nunca lança na leitura (arquivo ausente/malformado/sem permissão = sem regras); a escrita é atômica
// (temp + rename) para o hook nunca ler um arquivo pela metade; o teto evita um arquivo sem fim.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Uma regra local: `pattern` (regex) casada contra o sujeito da ferramenta (comando, caminho ou nome MCP). */
export interface CursorRule {
  tool: string;
  pattern: string;
  effect: 'allow' | 'deny';
  /** Texto curto para exibição (ex.: o comando), quando houver. */
  note?: string;
}

/** O que lemos do arquivo de política do Cursor (só o que interessa ao servidor). */
export interface CursorConfig {
  decisionEvents?: string[];
  rules: CursorRule[];
}

/** Teto de regras guardadas (as mais antigas saem quando estoura). */
export const CURSOR_RULE_MAX = 200;

type Rec = Record<string, unknown>;

const isObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Caminho da configuração/política lida pelo hook do Cursor. */
export function cursorConfigPath(home: string): string {
  return join(home, '.habblaud', 'cursor-hook.json');
}

/** Caminho do registro local de decisões por regra (observabilidade do hook). */
export function cursorDecisionsPath(home: string): string {
  return join(home, '.habblaud', 'cursor-decisions.jsonl');
}

/** Uma regra válida de um JSON cru; undefined para qualquer coisa malformada. */
function cleanRule(raw: unknown): CursorRule | undefined {
  if (!isObject(raw)) return undefined;
  const tool = str(raw.tool);
  const pattern = str(raw.pattern);
  const effect = raw.effect === 'allow' || raw.effect === 'deny' ? raw.effect : undefined;
  if (!tool || !pattern || !effect) return undefined;
  const rule: CursorRule = { tool, pattern, effect };
  const note = str(raw.note);
  if (note) rule.note = note;
  return rule;
}

/** Normaliza o JSON cru do arquivo (regras inválidas descartadas; eventos vazios/duplicados = únicos ou ausente). */
function parseCursorConfig(raw: unknown): CursorConfig {
  const r = isObject(raw) ? raw : {};
  const events = Array.isArray(r.decisionEvents) ? [...new Set(r.decisionEvents.map(str).filter((e): e is string => !!e))] : undefined;
  const rules = Array.isArray(r.rules) ? r.rules.map(cleanRule).filter((x): x is CursorRule => !!x) : [];
  return events?.length ? { decisionEvents: events, rules } : { rules };
}

/** Lê a política local do Cursor. Arquivo ausente ou ilegível = sem regras, sem lançar. */
export function readCursorConfig(home: string): CursorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cursorConfigPath(home), 'utf8'));
  } catch {
    return { rules: [] };
  }
  return parseCursorConfig(raw);
}

/** Acrescenta uma regra sem duplicar `tool+pattern+effect` (a repetida vai para o fim), respeitando o teto. */
export function addCursorRule(cfg: CursorConfig, rule: CursorRule): CursorConfig {
  const same = (r: CursorRule) => r.tool === rule.tool && r.pattern === rule.pattern && r.effect === rule.effect;
  return { ...cfg, rules: [...cfg.rules.filter((r) => !same(r)), rule].slice(-CURSOR_RULE_MAX) };
}

/**
 * Grava uma regra no arquivo de política, preservando o resto (porta, espera, eventos e chaves desconhecidas).
 * Atômico: escreve um arquivo temporário e renomeia. Devolve o erro em vez de lançar (a decisão `allow` já valeu).
 */
export function writeCursorRule(home: string, rule: CursorRule): { ok: true } | { ok: false; error: string } {
  const file = cursorConfigPath(home);
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      raw = undefined;
    }
    const base = isObject(raw) ? raw : {};
    const merged = addCursorRule(parseCursorConfig(base), rule);
    const out: Rec = { ...base, rules: merged.rules };
    if (merged.decisionEvents) out.decisionEvents = merged.decisionEvents;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Quantas decisões locais o hook já registrou (linhas de ~/.habblaud/cursor-decisions.jsonl); ausente = 0. */
export function countLocalDecisions(home: string): number {
  try {
    let n = 0;
    for (const line of readFileSync(cursorDecisionsPath(home), 'utf8').split('\n')) if (line.trim()) n++;
    return n;
  } catch {
    return 0;
  }
}
