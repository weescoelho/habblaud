# 09 — Runbook de coleta da amostra do transcript (fechar a lacuna C1)

Este runbook coleta a evidência que falta para **fechar o C1**: o *esquema* do arquivo JSONL
apontado por `transcript_path`, em especial **como os tool-calls são codificados**. A P0
(`07-poc-priorizados.md`) provou que o arquivo é **JSONL legível** (papéis `user`/`assistant`), mas
o inspetor **não reconheceu campos de tool-call** nos exemplos observados
(`00-resumo-e-ledger.md`, C1). Sem esse mapeamento, terminal/tarefas/tokens/histórico ficam em modo
"hooks-only".

Rode isto numa máquina com o **Cursor instalado e assinatura ativa**. O resultado é um dump de
**esquema** (chaves + tipos), sem conteúdo longo — seguro de compartilhar.

Os documentos `00-…` a `07-poc-priorizados.md` vivem no **repositório-pai** (`habblaud-cursor`,
pasta `docs/analise/`), não neste fork; aqui são citados só pelo nome. O runbook das POCs P0–P3 é o
`08-runbook-poc-cursor.md`.

## Pré-requisitos

- **Cursor** instalado e logado (assinatura ativa).
- **Node.js** `>= 22.12`.
- Repositório do Habblaud na branch `cursor-poc`, com `npm install` já rodado.
- Todos os comandos abaixo partem da **raiz do repositório** (a pasta `habblaud-main`).

### Por que uma conversa nova e curta

O transcript é **por conversa** (`…/agent-transcripts/<conversation_id>/<conversation_id>.jsonl`).
Para achar as linhas de tool-call com facilidade, gere uma conversa **nova, curta, com 1 de cada
tipo de ferramenta** (ver Passo 3). Não reaproveite uma conversa antiga e longa.

---

## Passo 1 — Confirmar que os transcripts estão habilitados

O `transcript_path` vem nos eventos de hook. Se ele vier **`null`**, os transcripts estão
desabilitados no Cursor e a coleta não funciona. Para checar, instale o hook (Passo 2) e confira:

```bash
tail -n 3 ~/.habblaud/cursor-poc/transcripts.txt 2>/dev/null
```

- Se aparecerem caminhos `…/agent-transcripts/…/*.jsonl`, está **habilitado**.
- Se o arquivo não existir ou só houver linhas vazias, procure nas configurações do Cursor a opção
  de **transcripts do agente** e habilite; reabra a IDE e repita.

---

## Passo 2 — Instalar o hook de captura

```bash
npm run cursor:poc:install
```

Isso **mergeia** o hook "log tudo" no `~/.cursor/hooks.json` (com backup
`hooks.json.habblaud-backup-<data>`). Cada evento com `transcript_path` grava o caminho em
`~/.habblaud/cursor-poc/transcripts.txt` e o stdin em `~/.habblaud/cursor-poc/stdin/`.

> O hook herda o ambiente da IDE: se usar `HABBLAUD_CURSOR_POC_DIR`, exporte-o **antes** de abrir o
> Cursor.

---

## Passo 3 — Exercitar a IDE numa conversa nova (com tool-calls)

Abra o **Agent Chat** e peça, **um de cada vez**, numa única conversa curta:

1. Shell: *"Rode `echo oi-habblaud` no terminal."* → `beforeShellExecution`/`preToolUse`.
2. Leitura: *"Leia o `package.json`."* → `beforeReadFile`/`preToolUse`.
3. Escrita: *"Crie `/tmp/amostra-cursor.txt` com o texto `oi`."* → `afterFileEdit`/`preToolUse`.
4. MCP (se houver MCP configurado): peça algo que use o MCP → `before/afterMCPExecution`.
5. Subagente (se disponível): *"Use um subagente para listar os arquivos da pasta `scripts`."*
   → `subagentStart`/`subagentStop` (úteis também para a P4).

Deixe o agente terminar o turno e **feche a sessão** (`sessionEnd`). Mantenha a conversa curta: o
objetivo é ter as linhas de ferramenta, não um histórico longo.

---

## Passo 4 — Localizar o transcript dessa conversa

```bash
# a) pelo índice do hook (a última linha costuma ser a conversa mais recente)
tail -n 5 ~/.habblaud/cursor-poc/transcripts.txt

# b) ou diretamente no Cursor (mais recente primeiro)
ls -t "$HOME"/.cursor/projects/*/agent-transcripts/*/*.jsonl 2>/dev/null | head -n 5

# escolha UM arquivo (o da conversa que você acabou de fazer)
FILE="$HOME/.cursor/projects/<projeto>/agent-transcripts/<conversation_id>/<conversation_id>.jsonl"
```

O formato do caminho é `…/.cursor/projects/<slug-do-projeto>/agent-transcripts/<conversation_id>/<conversation_id>.jsonl`.

---

## Passo 5 — Caracterizar com o harness (visão de topo)

```bash
npm run cursor:poc:transcript -- --path "$FILE"
```

Saída esperada: `Formato: jsonl`, `Linhas:`, `Papéis:` e `Tool-calls:`. Aqui é onde a P0 original
viu `Tool-calls: não` — isso é a lacuna que o próximo passo resolve mostrando o **esquema**.

---

## Passo 6 — Extrair o ESQUEMA (é isto que fecha o C1)

Salve o pequeno script abaixo e rode-o sobre o mesmo arquivo. Ele imprime, por **formato de linha**
(assinatura de chaves de topo), a **árvore de chaves + tipos**, além de **valores curtos** (enums
como `type`/`role`/`status` e nomes de ferramenta). Strings longas (prompts, conteúdo de arquivo)
**não** são impressas.

```bash
cat > /tmp/transcript-shape.cjs <<'EOF'
// transcript-shape.cjs — esquema (chaves + tipos) de um transcript JSONL do Cursor.
// Uso: node /tmp/transcript-shape.cjs <arquivo.jsonl>   (EXAMPLES=1 inclui 1 exemplo truncado por formato)
const fs = require('node:fs');
const file = process.argv[2];
if (!file) { console.error('uso: node transcript-shape.cjs <arquivo.jsonl>'); process.exit(2); }
if (!fs.existsSync(file)) { console.error('arquivo nao encontrado: ' + file); process.exit(2); }
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const MAXD = 8, MAXVAL = 40, MAXDISTINCT = 12;
const newNode = () => ({ types: new Map(), kids: new Map(), vals: new Set() });
const groups = new Map();
function walk(node, v, depth) {
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  node.types.set(t, (node.types.get(t) || 0) + 1);
  if (typeof v === 'string') { if (v.length <= MAXVAL && node.vals.size <= MAXDISTINCT) node.vals.add(v); return; }
  if (depth >= MAXD) return;
  if (Array.isArray(v)) {
    let kid = node.kids.get('[]') || newNode(); node.kids.set('[]', kid);
    for (const el of v) walk(kid, el, depth + 1);
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      let kid = node.kids.get(k) || newNode(); node.kids.set(k, kid);
      walk(kid, val, depth + 1);
    }
  }
}
function render(node, prefix, out) {
  for (const [k, kid] of node.kids) {
    const types = [...kid.types.keys()].join('|');
    let extra = '';
    if (kid.types.size === 1 && kid.types.has('string') && kid.vals.size)
      extra = '   ex: ' + [...kid.vals].slice(0, 8).map((s) => JSON.stringify(s)).join(', ');
    out.push(prefix + k + ': ' + types + extra);
    render(kid, prefix + '  ', out);
  }
}
const trunc = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : v)));
let bad = 0;
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { bad++; continue; }
  if (!o || Array.isArray(o) || typeof o !== 'object') { bad++; continue; }
  const s = Object.keys(o).sort().join(',');
  let g = groups.get(s);
  if (!g) { g = { node: newNode(), count: 0, example: o }; groups.set(s, g); }
  g.count++;
  for (const [k, v] of Object.entries(o)) { let kid = g.node.kids.get(k) || newNode(); g.node.kids.set(k, kid); walk(kid, v, 1); }
}
console.log('# arquivo: ' + file);
console.log('# linhas: ' + lines.length + ' (JSON invalido: ' + bad + ')');
console.log('# formatos distintos (por chaves de topo): ' + groups.size);
let i = 0;
for (const [s, g] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
  i++;
  console.log('\n## formato ' + i + '  —  ' + g.count + ' linha(s)  —  chaves: ' + s);
  const out = []; render(g.node, '', out); console.log(out.join('\n'));
  if (process.env.EXAMPLES === '1') console.log('exemplo: ' + JSON.stringify(trunc(g.example)));
}
EOF

node /tmp/transcript-shape.cjs "$FILE"
```

### Como ler a saída

- **`formatos distintos`** = quantos "tipos de linha" o transcript tem (ex.: um formato para
  mensagens de texto e outro para tool-calls). Se existir um formato com chaves como
  `tool_name`/`tool_input` (ou `message` do tipo `object`/`array`), **é ali que estão os tool-calls**.
- **`ex:`** aparece só para campos de valor curto — é onde você verá enums como
  `type: "tool_use"` ou nomes de ferramenta.
- Se **todo** o transcript tiver só `message: string` (texto puro), o tool-call **não está no
  transcript** — e a conclusão do C1 passa a ser "atividades dependem de hooks", o que também é um
  resultado válido (negativo).

Para incluir um exemplo truncado por formato (útil para confirmar o shape):

```bash
EXAMPLES=1 node /tmp/transcript-shape.cjs "$FILE"
```

---

## Passo 7 — Empacotar o que devolver

Envie de volta:

1. A saída de `npm run cursor:poc:transcript -- --path "$FILE"` (Passo 5).
2. A saída de `node /tmp/transcript-shape.cjs "$FILE"` (Passo 6). **Este é o artefato principal.**
3. Opcional: com `EXAMPLES=1`, a saída do Passo 6.
4. Opcional: o próprio `"$FILE"` **se a conversa for a de teste** (só comandos de exemplo) — evite
   enviar transcripts de conversas reais com dados sensíveis.

```bash
# exemplo: juntar tudo num arquivo
{
  echo '### 05 — cursor:poc:transcript'; npm run -s cursor:poc:transcript -- --path "$FILE";
  echo; echo '### 06 — shape'; node /tmp/transcript-shape.cjs "$FILE";
  echo; echo '### 06 — shape (EXAMPLES)'; EXAMPLES=1 node /tmp/transcript-shape.cjs "$FILE";
} > /tmp/cursor-c1-amostra.txt 2>&1
echo "pronto: /tmp/cursor-c1-amostra.txt"
```

> **Privacidade**: os Passos 5–6 não imprimem conteúdo longo. Mesmo assim, revise o arquivo antes de
> enviar e não inclua conversas reais com dados sensíveis.

---

## Passo 8 — Limpeza (quando terminar)

```bash
npm run cursor:poc:uninstall          # remove só os hooks do harness (os alheios ficam)
rm -rf ~/.habblaud/cursor-poc/        # apaga as capturas (events.jsonl, transcripts.txt, stdin/)
rm -f /tmp/transcript-shape.cjs /tmp/cursor-c1-amostra.txt
```

---

## Resultado esperado (o que isto muda)

Com o dump do esquema em mãos, o inspetor `server/sources/cursor/transcript.ts` pode ganhar os
**alias corretos** para os tool-calls do Cursor (hoje ele cobre os estilos OpenAI e Anthropic, mas
não reconheceu o formato observado). Isso fecha o **C1** e destrava, na Fase 3/4, terminal, tarefas,
tokens, GitHub e histórico. Se o C1 fechar **negativo** (sem tool-calls no transcript), a estratégia
"hooks-first" se confirma e `00-resumo-e-ledger.md`/`05-matriz-compatibilidade-cursor.md` devem
registrar terminal/histórico como **não suportados** para o Cursor.
