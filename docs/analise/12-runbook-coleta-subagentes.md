# 12 — Runbook: coleta do transcript de subagente em chats anteriores

O terminal de um **subagente** do Cursor abre vazio (*"transcript do agente não encontrado"*).
Queremos que o conteúdo do sub apareça no **terminal dele próprio**. Para fechar o desenho sem
instalar hook nem disparar um subagente novo, este runbook **varre os chats anteriores já gravados
pela IDE** e imprime só a **estrutura** dos transcripts (chaves, tipo/papel, status, ferramentas,
contagens) — **sem nenhum conteúdo de conversa**.

Rode numa máquina que já tenha tido subagentes rodando **com sucesso** (plano que libere subagente,
ou chat no modelo **Auto**). No **Free com modelo nomeado** o sub falha em ~1 s e o transcript fica
só com o erro — ver "O que já sabemos".

> Contexto: `09-runbook-coleta-transcript-c1.md` fez o mesmo tipo de coleta para o transcript
> **principal** (fechar o C1). Aqui o foco é o transcript **do sub**.

---

## O que já sabemos (captura de 2026-10-11, máquina **Free**)

Um turno com dois subagentes `explore` que **erraram** (Free + modelo nomeado) mostrou:

- O sub tem transcript próprio, ao lado do principal, em:
  ```
  ~/.cursor/projects/<slug>/agent-transcripts/<conversa-pai>/subagents/<child_conversation_id>.jsonl
  ```
  (o `<child_conversation_id>` é o que o `subagentStop` entrega como `child_conversation_id`).
- No caso observado o arquivo tinha **1 linha** (só o erro):
  `{"type":"turn_ended","status":"error","error":"Named models unavailable Free plans can only use Auto. …"}`.
- O transcript **principal** usa `{"role","message"}` por linha + `{"type":"turn_ended","status","error"}`.
- `subagentStart` traz `subagent_id` (= `tool_call_id`), `parent_conversation_id`, `subagent_type`,
  `task` — **sem** o id da conversa do sub. `subagentStop` traz `child_conversation_id` e o campo
  `agent_transcript_path`.

## O que esta coleta responde

| # | Pergunta | Como a coleta responde |
| - | -------- | ---------------------- |
| Q1 | Subagentes bem-sucedidos gravam conteúdo em `subagents/<child>.jsonl`? | lista os arquivos, linhas e status |
| Q5 | O transcript do sub tem o **mesmo esquema** do principal (`{role,message}` + `turn_ended`)? | "fingerprint" agregado principal × sub |
| — | Quais ferramentas o sub usa; o sub terminou com sucesso? | nomes de ferramenta + `turn_ended.status` |

As perguntas de **hook ao vivo** (`conversation_id == child`, `transcript_path` do sub no evento do
sub) **não** aparecem no disco; se precisar delas, é o roteiro de hook (fica para depois).

---

## Pré-requisitos

- **Node.js** `>= 22.12` (nenhuma dependência).
- Acesso ao diretório `~/.cursor/projects` da máquina (ou uma cópia dele).

---

## Passo 1 — Localizar os transcripts de subagente

```bash
find ~/.cursor/projects -path '*/subagents/*.jsonl' 2>/dev/null
```

Se não houver nada, aquela máquina não teve subagente (ou ele nunca gravou transcript). Rode a IDE
com um subagente que **complete** e repita.

---

## Passo 2 — Coletar a estrutura

Salve o script abaixo em `~/collect-subagents.mjs` e rode:

```bash
node ~/collect-subagents.mjs                 # varre ~/.cursor/projects
node ~/collect-subagents.mjs /caminho/copia  # ou uma cópia/pasta específica
```

Aceita: a pasta `projects`, a pasta `agent-transcripts`, uma pasta de conversa, ou um `.jsonl`.

```js
// collect-subagents.mjs — varre os transcripts do Cursor (chats anteriores) e imprime SÓ estrutura.
// Nunca mostra conteúdo de mensagem: apenas chaves, tipo/papel, status, nomes de ferramenta e contagens.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';

const root = resolve((process.argv[2] || join(homedir(), '.cursor', 'projects')).replace(/^~(?=[\\/]|$)/, homedir()));

function walk(dir, depth = 0) {
  const out = [];
  if (depth > 6 || !existsSync(dir)) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth + 1));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function shapeOf(o) {
  if (!o || typeof o !== 'object') return `(${typeof o})`;
  const keys = Object.keys(o).sort().join(',');
  const tag = [o.type, o.role, o.status].filter((v) => typeof v === 'string' && v).join('|');
  return tag ? `{${keys}} :: ${tag}` : `{${keys}}`;
}

function toolNamesOf(x, acc) {
  if (Array.isArray(x)) { for (const v of x) toolNamesOf(v, acc); return acc; }
  if (!x || typeof x !== 'object') return acc;
  if (x.type === 'tool_use' || x.type === 'tool_call') {
    const n = x.name ?? x.tool_name;
    if (typeof n === 'string' && n) acc.add(n);
  }
  if (typeof x.tool_name === 'string' && x.tool_name) acc.add(x.tool_name);
  for (const v of Object.values(x)) toolNamesOf(v, acc);
  return acc;
}

function analyze(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const raw = text.split('\n').filter((l) => l.trim());
  const shapes = new Map();
  const tools = new Set();
  let invalid = 0, turnEnded = null;
  for (const ln of raw) {
    let o;
    try { o = JSON.parse(ln); } catch { invalid++; continue; }
    const sh = shapeOf(o);
    shapes.set(sh, (shapes.get(sh) || 0) + 1);
    toolNamesOf(o, tools);
    if (o && o.type === 'turn_ended') turnEnded = { status: o.status ?? '-', hasError: typeof o.error === 'string' && o.error.length > 0 };
  }
  return { file, bytes: statSync(file).size, lines: raw.length, invalid,
    shapes: [...shapes.entries()].sort((a, b) => b[1] - a[1]), tools: [...tools].sort(), turnEnded };
}

const files = existsSync(root) && statSync(root).isFile() ? [root] : walk(root);
const subs = files.filter((f) => /[\\/]subagents[\\/]/.test(f));
const mains = files.filter((f) => !/[\\/]subagents[\\/]/.test(f));
const rel = (p) => p.replace(root + (process.platform === 'win32' ? '\\' : '/'), '');

function reportGroup(title, list) {
  console.log(`\n==== ${title} (${list.length}) ====`);
  if (!list.length) { console.log('  (nenhum)'); return; }
  const byConv = new Map();
  for (const f of list) { const c = basename(f, '.jsonl'); if (!byConv.has(c)) byConv.set(c, []); byConv.get(c).push(f); }
  for (const [conv, fs2] of byConv) {
    console.log(`\n• conversa ${conv.slice(0, 12)}  (${fs2.length} arquivo(s))`);
    for (const f of fs2) {
      const a = analyze(f);
      if (!a) { console.log(`  - ${rel(f)}  (ilegível)`); continue; }
      console.log(`  - ${rel(f)}`);
      console.log(`      linhas=${a.lines} bytes=${a.bytes} não-JSON=${a.invalid}` +
        `${a.turnEnded ? `  turn_ended: status=${a.turnEnded.status} error=${a.turnEnded.hasError}` : ''}`);
      if (a.tools.length) console.log(`      ferramentas: ${a.tools.join(', ')}`);
      for (const [sh, n] of a.shapes.slice(0, 6)) console.log(`      forma x${n}: ${sh}`);
    }
  }
}

console.log(`raiz: ${root}`);
console.log(`arquivos .jsonl: ${files.length}  (principais=${mains.length}, subagentes=${subs.length})`);
reportGroup('TRANSCRIPTS DE SUBAGENTE', subs);
reportGroup('TRANSCRIPTS PRINCIPAIS', mains);

const fingerprint = (list) => {
  const shapes = new Map();
  for (const f of list) { const a = analyze(f); if (!a) continue; for (const [sh, n] of a.shapes) shapes.set(sh, (shapes.get(sh) || 0) + n); }
  return [...shapes.entries()].sort((a, b) => b[1] - a[1]);
};
console.log('\n==== FINGERPRINT (formas agregadas) ====');
console.log('subagente:'); for (const [sh, n] of fingerprint(subs).slice(0, 8)) console.log(`  x${n}  ${sh}`);
console.log('principal:'); for (const [sh, n] of fingerprint(mains).slice(0, 8)) console.log(`  x${n}  ${sh}`);

const okSubs = subs.map(analyze).filter((a) => a && a.lines > 1 && (!a.turnEnded || a.turnEnded.status !== 'error'));
console.log(`\nsubagentes com conteúdo (>1 linha e sem erro): ${okSubs.length} de ${subs.length}`);
```

---

## Passo 3 — (Opcional) trazer a amostra de outra máquina

Se preferir rodar aqui, copie só os transcripts de sub (e o principal da mesma conversa, para
comparar o esquema):

```bash
mkdir -p /tmp/opencode/coleta
cd ~/.cursor
for f in $(find projects -path '*/subagents/*.jsonl'); do
  d=$(dirname "$f")            # .../agent-transcripts/<conv>/subagents
  p=$(dirname "$d")            # .../agent-transcripts/<conv>
  cp --parents "$p"/*.jsonl "$f" /tmp/opencode/coleta/ 2>/dev/null
done
node ~/collect-subagents.mjs /tmp/opencode/coleta
```

> Os `.jsonl` contêm o **conteúdo real** da conversa. A saída do script não contém conteúdo; **não é
> preciso enviar os `.jsonl`** — só a saída em texto.

---

## Passo 4 — Devolver

1. A **saída em texto** do `collect-subagents.mjs` (só estrutura — seguro).
2. Preencha:

   | # | Resposta |
   | - | -------- |
   | Q1 | Algum `subagents/<child>.jsonl` com conteúdo? quantas linhas? status do `turn_ended`? |
   | Q5 | Esquema do sub = igual ao principal (`{role,message}` + `turn_ended`)? (sim/não) |
   | — | Ferramentas usadas pelo sub: ______ |

---

## Critério de sucesso

- Ao menos um transcript de sub com **> 1 linha** e `turn_ended` **sem erro**.
- O esquema do sub compatível com o do principal (para reusar `createCursorTerminalParser`).

Com isso definimos o terminal do sub: ele lê
`agent-transcripts/<pai>/subagents/<child_conversation_id>.jsonl` (usando o `child_conversation_id`
do `subagentStop`) e mostra o conteúdo no terminal do próprio sub.
