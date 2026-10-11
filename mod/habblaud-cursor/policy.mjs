// Política local do hook do Cursor: decide allow/deny ANTES de falar com o escritório.
//
// Módulo puro (sem `node:fs`, sem rede, sem dependências): recebe um objeto de política já carregado
// do arquivo ~/.habblaud/cursor-hook.json e responde às perguntas do hook — quais eventos pedem decisão,
// qual regra casa um pedido (deny > allow) e qual regra oferecer como "sempre permitir".
//
// Regras: node puro (22+); nunca lança — política ausente, ilegível ou com regra inválida = o hook segue
// o fluxo anterior (registrar e esperar). O hook do Cursor é o único consumidor desta política.
//
// Formato da política:
//   { "decisionEvents": ["beforeShellExecution", …],           // ausente/vazio = padrão (Shell/MCP)
//     "rules": [ { "tool": "Shell", "pattern": "^npm test(\\s|$)", "effect": "allow", "note": "npm test" },
//                { "tool": "Shell", "pattern": "^rm -rf", "effect": "deny", "note": "comando destrutivo" } ] }
//
// `pattern` é uma expressão regular (sem flags) casada contra o sujeito do pedido: o `command` (Shell),
// o `file_path` (leitura) ou o próprio nome da ferramenta (MCP, resto). `tool` aceita "*" para valer em
// qualquer ferramenta.

/** Eventos que pedem decisão quando a política não diz outra coisa (os de maior risco). */
export const DEFAULT_DECISION_EVENTS = ['beforeShellExecution', 'beforeMCPExecution'];

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Eventos que pedem decisão: o array `decisionEvents` da política quando ele é válido (nomes vazios
 * descartados); ausente, vazio ou inválido = o padrão (Shell/MCP).
 */
export function decisionEventsOf(policy) {
  const raw = isObject(policy) ? policy.decisionEvents : undefined;
  if (!Array.isArray(raw)) return new Set(DEFAULT_DECISION_EVENTS);
  const out = new Set();
  for (const e of raw) {
    const name = str(e);
    if (name) out.add(name);
  }
  return out.size ? out : new Set(DEFAULT_DECISION_EVENTS);
}

/** Regras válidas da política (`tool`, `pattern` e `effect` allow|deny); regra malformada é descartada. */
export function rulesOf(policy) {
  const raw = isObject(policy) ? policy.rules : undefined;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const tool = str(item.tool);
    const pattern = str(item.pattern);
    const effect = item.effect === 'allow' || item.effect === 'deny' ? item.effect : undefined;
    if (!tool || !pattern || !effect) continue;
    const rule = { tool, pattern, effect };
    const note = str(item.note);
    if (note) rule.note = note;
    out.push(rule);
  }
  return out;
}

/**
 * O que uma regra casa, pela ferramenta: `Shell` → o `command`/`cmd`; `Read` → o `file_path`; `MCP…` → o
 * próprio nome da ferramenta; resto → o JSON dos argumentos. undefined quando não há sujeito (ex.: Shell
 * sem comando) — aí o hook segue o fluxo anterior.
 */
export function subjectOf(tool, input) {
  const name = str(tool);
  const r = isObject(input) ? input : {};
  if (name === 'Shell') return str(r.command) ?? str(r.cmd);
  if (name === 'Read') return str(r.file_path) ?? str(r.filePath);
  if (name && name.startsWith('MCP')) return name;
  if (!name) return undefined;
  return Object.keys(r).length ? JSON.stringify(r) : undefined;
}

/**
 * A regra que casa o pedido, na ordem `deny` > `allow`; nenhuma = undefined (vale o escritório). Casa pela
 * ferramenta (a regra ou `*`) e pelo sujeito. Um `pattern` que não compila como regex é ignorado.
 */
export function matchRule(rules, tool, input) {
  const name = str(tool);
  const subject = subjectOf(name, input);
  if (!name || subject === undefined || !Array.isArray(rules)) return undefined;
  let allow;
  for (const rule of rules) {
    if (!isObject(rule) || (rule.tool !== name && rule.tool !== '*')) continue;
    let re;
    try {
      re = new RegExp(rule.pattern);
    } catch {
      continue;
    }
    if (!re.test(subject)) continue;
    if (rule.effect === 'deny') return rule;
    allow ??= rule;
  }
  return allow;
}

/** Escapa o texto para entrar literal dentro de uma regex (o sujeito vira o padrão ancorado). */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regra `allow` para "sempre permitir", derivada do pedido: Shell vira prefixo ancorado
 * `^<comando>(\s|$)` (pega o comando e os argumentos); Read, prefixo do caminho; MCP e o resto, o sujeito
 * exato `^<sujeito>$`. undefined quando não há sujeito. O `note` carrega o sujeito legível (o que
 * `ruleText` mostra).
 */
export function deriveRule(tool, input) {
  const name = str(tool);
  const subject = subjectOf(name, input);
  if (!name || subject === undefined) return undefined;
  const base = escapeRegExp(subject);
  const pattern = name === 'Shell' ? `^${base}(\\s|$)` : name === 'Read' ? `^${base}` : `^${base}$`;
  return { tool: name, pattern, effect: 'allow', note: subject };
}

/** Texto curto de uma regra para o escritório: "Shell(npm test)". */
export function ruleText(rule) {
  if (!isObject(rule)) return '';
  const tool = str(rule.tool) ?? '';
  const what = str(rule.note) ?? str(rule.pattern) ?? '';
  if (!tool) return what;
  return what ? `${tool}(${what})` : tool;
}

/** Decisão nativa do Cursor para `allow` (o hook imprime e sai). */
export function allowOutput() {
  return { permission: 'allow' };
}

/** Decisão nativa do Cursor para `deny`, com o motivo da regra (`note`). */
export function denyOutput(reason) {
  const why = str(reason);
  return { permission: 'deny', user_message: why ? `Recusado pela regra local do Habblaud: ${why}` : 'Recusado pela regra local do Habblaud.' };
}
