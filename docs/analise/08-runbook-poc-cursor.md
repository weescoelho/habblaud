# 08 — Runbook das POCs do Cursor (P0–P3)

Este runbook executa as quatro POCs bloqueantes descritas em `07-poc-priorizados.md` numa máquina
com o **Cursor instalado e uma assinatura ativa** e devolve o relatório de cada uma. Rode os
passos **na ordem P1 → P0 → P2 → P3**: a P1 instala o hook de captura que a P0 reaproveita.

Os documentos `00-…` a `07-poc-priorizados.md` vivem **fora deste repositório** (ficam na pasta
de análise do workspace, não no fork). Aqui eles são citados só pelo nome do arquivo.

## Pré-requisitos

- Cursor instalado e com assinatura válida (o CLI `cursor-agent status` deve mostrar "Logged in").
- Node.js `>= 22.12` (o `node:sqlite` da P0 exige Node com o módulo estável).
- Repositório do Habblaud na branch `cursor-poc`, com `npm install` já rodado.
- Todos os comandos abaixo partem da **raiz do repositório**.

### Variáveis e caminhos

- **Diretório de captura**: `~/.habblaud/cursor-poc/` (padrão). Sobrescreva com
  `HABBLAUD_CURSOR_POC_DIR=<dir>` no shell que usa a IDE (o hook herda o ambiente do processo da
  IDE, então exporte a variável antes de abrir o Cursor).
- **Porta do Habblaud**: `4747` (padrão). Mude com `HABBLAUD_PORT` se já estiver ocupada.
- Ao passar opções por `npm run`, use o separador `--` (ex.: `npm run cursor:poc:transcript -- --path …`).

### Estrutura gerada pelo hook de captura

Depois da P1, o diretório de captura conterá:

```
~/.habblaud/cursor-poc/
├── events.jsonl        # uma linha {ts, dir, event} por evento de hook recebido
├── transcripts.txt     # ts<TAB>transcript_path, um por evento que trazia transcript_path
└── stdin/              # dump do stdin inteiro de cada evento com transcript_path
```

---

## P1 — Cobertura real de eventos de hook (harness "log tudo")

**Objetivo** (`07-poc-priorizados.md`, P1): medir quais eventos de hook a IDE realmente dispara e
com quais campos, para saber se dá para alimentar `working/idle/shell/done` e `subagent*`.

### Comando exato

```bash
npm run cursor:poc:install
```

Isso **mergeia** os hooks do harness no `~/.cursor/hooks.json`, preservando os hooks existentes e
fazendo backup do arquivo anterior (`hooks.json.habblaud-backup-<data>`). Rodar duas vezes é
idempotente. Para instalar no projeto em vez do `$HOME`, use `-- --project [dir]`.

Depois, **exercite a IDE** cobrindo os eventos candidatos:

1. Abra o Agent Chat (dispara `sessionStart`/`beforeSubmitPrompt`).
2. Peça uma execução de shell (dispara `before/afterShellExecution` e `pre/postToolUse`).
3. Peça leitura e edição de arquivo (dispara `beforeReadFile`/`afterFileEdit`).
4. Peça uma chamada MCP, se houver MCP configurado (dispara `before/afterMCPExecution`).
5. Deixe o agente responder e terminar o turno (dispara `afterAgentResponse`/`afterAgentThought`/`stop`).
6. Feche a sessão (dispara `sessionEnd`).

Em seguida, gere a matriz:

```bash
npm run cursor:poc:report
```

### Evidência esperada

- `~/.habblaud/cursor-poc/events.jsonl` com uma linha por evento (campos `ts`, `dir`, `event`).
- Uma matriz Markdown com o cabeçalho
  `| Evento | Dispara? | Contagem | Campos |`, uma linha por evento candidato (os não vistos saem
  como `não`) e a lista de campos observados por evento.
- Se o diretório estiver vazio, o comando imprime uma mensagem explicativa e sai com código `0`.

### Critério de sucesso/falha

- **Sucesso**: cobertura suficiente para derivar o status ao vivo. No mínimo, os eventos de ciclo
  de vida (`sessionStart`/`sessionEnd`), de ferramenta (`preToolUse`/`postToolUse`) e de shell
  (`before/afterShellExecution`) aparecem com `sim`, e os eventos trazem um identificador de
  conversa (`conversation_id`/`session_id`) e a pasta (`workspace_roots`/`cwd`).
- **Sucesso parcial**: faltam alguns eventos → o status cai para heurística pelos hooks
  disponíveis; registre quais faltaram.
- **Falha**: nenhum evento chega (hook não instalado, IDE não recarrega o `hooks.json`, ou o
  `node` não está no `PATH` da IDE).

---

## P0 — Descoberta do transcript (`transcript_path`)

**Objetivo** (`07-poc-priorizados.md`, P0): caracterizar o arquivo apontado por `transcript_path`
(formato, campos, incrementalidade) e decidir se há paridade de atividades/terminal/histórico sem
depender só de hooks.

A captura usa o **mesmo hook da P1**: cada evento com `transcript_path` grava o caminho em
`transcripts.txt` e o dump do stdin em `stdin/`.

### Comando exato

```bash
# 1) veja os caminhos de transcript coletados durante a P1
cat ~/.habblaud/cursor-poc/transcripts.txt

# 2) caracterize o arquivo (use um caminho da lista acima)
npm run cursor:poc:transcript -- --path <arquivo>
```

O inspetor classifica o arquivo como `json`, `jsonl`, `sqlite` ou `opaco` e lista o que observa:
para JSONL, o número de linhas, os papéis distintos e a presença de campos de tool-call; para
SQLite, as tabelas e contagens (via `node:sqlite`, sem binário externo); para JSON, as chaves com
contagem. Tudo pelo próprio Node.

### Evidência esperada

- Saída começando por `Formato: <json|jsonl|sqlite|opaco>`.
- Para JSONL: linhas `Linhas:`, `Papéis:`, `Tool-calls:`.
- Para SQLite: bloco `Tabelas:` com `nome  contagem`.
- Para JSON: bloco `Chaves:` e `Tool-calls:`.
- Arquivo inexistente → mensagem clara e código de saída `≠ 0`.

### Critério de sucesso/falha

- **Sucesso**: existe arquivo legível com delimitação de turnos/tool calls, estável entre turns;
  dá para derivar `Activity` sem hooks.
- **Falha**: arquivo inexistente, `opaco` ou criptografado (ex.: um `state.vscdb` SQLite sem
  estrutura útil) → dependemos 100% de hooks para atividades.

A entrega da P0 é um dump anotado do formato observado; ele já alimenta o esqueleto
`sources/cursor/transcript.ts`.

---

## P2 — Bloqueio do hook de decisão

**Objetivo** (`07-poc-priorizados.md`, P2): medir se o hook de decisão
(`beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`/`preToolUse`) consegue bloquear
esperando o escritório e por quanto tempo, devolvendo `permission: allow|deny`.

### Comando exato

```bash
# 1) instale o hook REAL (de decisão/observação) em ~/.cursor/hooks.json (backup antes)
npm run cursor:install

# 2) meça localmente o bloqueio contra um stub (sem precisar da IDE)
npm run cursor:poc:decision -- --hold <N> [--limit <S>]
```

`--hold <N>` é quantos segundos o stub segura antes de decidir (padrão `2`); `--limit <S>` é o
limite seguro configurado (padrão `5`). O harness sobe um stub local, roda o `hook.mjs` com um
`beforeShellExecution` sintético e reporta o tempo de bloqueio e se a decisão foi aplicada.

Para encontrar o limite real, **suba o `N` progressivamente** (ex.: 5, 10, 30) até o harness
avisar. Depois, confirme na IDE: com o hook instalado e o Habblaud no ar, dispare um comando de
shell no Agent Chat e observe por quanto tempo o Cursor aceita esperar — com a página do Habblaud
**aberta** (decisão pelo escritório) e **fechada** (degradação para o terminal).

### Evidência esperada

- `Stub no ar em http://127.0.0.1:<porta>, segurando <N> s antes de decidir.`
- `Hook bloqueou por <X> s e aplicou a decisão: {"permission":"allow"}`.
- `Bloqueio medido: <X> s (pedido: <N> s).`
- `✓ Dentro do limite seguro (<S> s).`
- Se `N > S`, o harness imprime `✗ Limite seguro observado: <S> s — <N> s excede o limite seguro…`
  e **sai com código `≠ 0`**.

### Critério de sucesso/falha

- **Sucesso**: o hook bloqueia de forma confiável por pelo menos ~30 s e a decisão é aplicada,
  dentro do formato plano nativo `{"permission":"allow"|"deny"}`.
- **Falha**: o Cursor desiste cedo (timeout curto) ou a decisão não é aplicada → "responder pelo
  escritório" degrada para **observação** (a permissão fica 100% no terminal).

A entrega da P2 é o **tempo máximo seguro** medido e o formato de saída validado.

---

## P3 — Ingest mínimo + agente vivo no escritório

**Objetivo** (`07-poc-priorizados.md`, P3): provar que um agente `cursor` aparece, muda de estado e
sai no `Office` a partir de eventos de hook — sem tocar em Claude/Codex.

### Comando exato

```bash
# 1) suba o Habblaud com a fonte do Cursor ligada (ligada por padrão)
HABBLAUD_CURSOR=1 npm run dev
```

Confirme a saúde e a fonte ligada:

```bash
curl -s http://127.0.0.1:4747/api/health | python3 -m json.tool
# procure a linha  "cursorEvents": true
```

Em outro terminal, envie a sequência simulada (ajuste `workspace_roots` para uma pasta real):

```bash
# sessionStart → cria/atualiza o agente na sala derivada de workspace_roots[0]
curl -s -X POST http://127.0.0.1:4747/api/cursor/events \
  -H 'Content-Type: application/json' \
  -d '{"event":{"hook_event_name":"sessionStart","conversation_id":"poc-1","workspace_roots":["/home/me/projeto"]}}'

# preToolUse → registra atividade e põe o agente em working
curl -s -X POST http://127.0.0.1:4747/api/cursor/events \
  -H 'Content-Type: application/json' \
  -d '{"event":{"hook_event_name":"preToolUse","conversation_id":"poc-1","tool_name":"Shell","tool_input":{"command":"ls"}}}'

# stop → idle
curl -s -X POST http://127.0.0.1:4747/api/cursor/events \
  -H 'Content-Type: application/json' \
  -d '{"event":{"hook_event_name":"stop","conversation_id":"poc-1"}}'

# sessionEnd → remove o agente do Office
curl -s -X POST http://127.0.0.1:4747/api/cursor/events \
  -H 'Content-Type: application/json' \
  -d '{"event":{"hook_event_name":"sessionEnd","conversation_id":"poc-1"}}'
```

Observe o escritório pelo snapshot e pelo stream SSE (ou abra `http://localhost:4747` no navegador):

```bash
# snapshot pontual: procure um agente com provider "cursor"
curl -s http://127.0.0.1:4747/api/snapshot | python3 -m json.tool

# stream ao vivo (Ctrl+C para sair)
curl -N http://127.0.0.1:4747/api/stream
```

> A trava local vale para a rota: só o próprio computador é aceito (`http://localhost` ou
> `http://127.0.0.1`); um Host de rede ou uma conexão não-loopback (fora do Docker) recebe `403`.

### Evidência esperada

- `/api/health` com `"cursorEvents": true`.
- Cada `POST /api/cursor/events` responde `200 {"ok":true}` (evento desconhecido → `200 {"ok":false}`).
- No `/api/snapshot`/SSE, um agente com `provider: "cursor"` (`sessionId` = `conversation_id`) que:
  entra na sala de `workspace_roots[0]`, muda para `working` no `preToolUse`, volta a `idle` no
  `stop` e some no `sessionEnd`.
- Nenhum log de erro das fontes Claude/Codex.

### Critério de sucesso/falha

- **Sucesso**: o personagem aparece, "trabalha" e sai, sem regressão em Claude/Codex.
- **Falha**: o agente não aparece ou o servidor acusa acoplamento oculto com Claude/Codex →
  identificar e isolar antes de seguir.

A entrega da P3 é o roteiro de demonstração e a prova da tese "é extensão".

---

## Como rodar a sequência inteira (resumo)

```bash
# pré-requisito
npm install

# P1 — cobertura de hooks
npm run cursor:poc:install
#   … exercite a IDE …
npm run cursor:poc:report

# P0 — transcript (use um caminho de transcripts.txt)
cat ~/.habblaud/cursor-poc/transcripts.txt
npm run cursor:poc:transcript -- --path <arquivo>

# P2 — bloqueio de decisão
npm run cursor:install
npm run cursor:poc:decision -- --hold 30 --limit 5

# P3 — ingest no escritório
HABBLAUD_CURSOR=1 npm run dev
#   … curl POST /api/cursor/events, /api/health, /api/snapshot, /api/stream …
```

---

## Limpeza / desinstalação

Depois de coletar os relatórios, desfaça tudo (nenhum comando toca no Cursor além do `hooks.json`):

```bash
# remove só os hooks do harness "log tudo" (os hooks alheios ficam)
npm run cursor:poc:uninstall

# remove só o hook REAL do Habblaud (os hooks alheios ficam)
npm run cursor:uninstall
```

- Os backups anteriores ficam como `hooks.json.habblaud-backup-<data>` em `~/.cursor/`.
- Para apagar também as capturas, remova o diretório
  `~/.habblaud/cursor-poc/` (ou o valor de `HABBLAUD_CURSOR_POC_DIR`).
- O arquivo de configuração do hook (`~/.habblaud/cursor-hook.json`) é criado à mão e não é
  removido pelos instaladores; apague-o se não for mais usar.

## Coleta dos relatórios

Cada POC produz a sua entrega, que retroalimenta `07-poc-priorizados.md`:

| POC | Entrega | O que guardar |
| --- | ------- | ------------- |
| P1 | Matriz "evento → dispara? → campos" | saída de `cursor:poc:report` |
| P0 | Dump anotado do formato do transcript | saída de `cursor:poc:transcript` + amostra do arquivo |
| P2 | Tempo máximo seguro + formato de saída | saída de `cursor:poc:decision` e observação ao vivo na IDE |
| P3 | Prova do agente no escritório | `/api/health`, snapshot e captura de tela do `Office` |
