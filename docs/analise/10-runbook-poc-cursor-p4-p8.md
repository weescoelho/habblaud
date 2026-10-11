# 10 — Runbook das POCs do Cursor (P4–P8)

Este runbook executa as cinco POCs restantes descritas em `07-poc-priorizados.md` numa máquina
com o **Cursor instalado e uma assinatura ativa** (e, para a P5, o **CLI `cursor-agent`**). Ele
fecha a rodada iniciada pelo `08-runbook-poc-cursor.md` (P0–P3) e devolve a evidência de cada POC.

Os documentos `00-…` a `07-poc-priorizados.md` vivem **fora deste repositório** (ficam na pasta de
análise do workspace, não no fork). Aqui eles são citados só pelo nome do arquivo.

Rode os passos **na ordem P4 → P5 → P6 → P7 → P8**. A P4 reaproveita o hook de captura da P1,
agora com os eventos de subagente; as demais são independentes.

> **Atalho offline (sem a máquina do usuário)**: os analisadores aceitam caminhos por `--path`/
> `--projects`; dá para validá-los contra dados já exportados (ex.: `docs/cursor-export/`) sem o
> Cursor. As respostas definitivas das P4/P5/P6, porém, exigem a máquina real (hooks e CLI vivos).

## Pré-requisitos

- Cursor instalado e com assinatura válida.
- Node.js `>= 22.12` (o `node:sqlite` da P8 exige Node com o módulo estável).
- Repositório do Habblaud na branch `cursor-poc`, com `npm install` já rodado.
- Para a P5: o CLI `cursor-agent` instalado (normalmente em
  `~/.config/Cursor/User/globalStorage/anysphere.cursor-agent-worker/agent-cli/…`; se não estiver no
  `PATH`, use o caminho absoluto do binário).
- Todos os comandos abaixo partem da **raiz do repositório**.

### Variáveis e caminhos

- **Diretório de captura**: `~/.habblaud/cursor-poc/` (padrão). Sobrescreva com
  `HABBLAUD_CURSOR_POC_DIR=<dir>` no shell que usa a IDE (o hook herda o ambiente do processo da
  IDE, então exporte a variável antes de abrir o Cursor).
- **Transcripts**: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` (padrão da P7;
  sobrescreva com `--projects <dir>`).
- Ao passar opções por `npm run`, use o separador `--` (ex.: `npm run cursor:poc:cli -- --path …`).

---

## P4 — Subagentes e ciclo de turno

**Objetivo** (`07-poc-priorizados.md`, P4): descobrir se a IDE emite `subagentStart`/`subagentStop`
(com `subagent_id`/`parent_conversation_id`), para mapear `addSub`/`completeSub`.

**Correção de método**: a rodada P0–P3 não instalou os hooks de subagente (`HARNESS_EVENTS` não os
incluía), então o "não observado" da P1 era **artefato do método**. O `install` agora instala
**17 eventos**, incluindo `subagentStart`/`subagentStop` — é preciso **reinstalar** e re-testar.

### Comando exato

```bash
# 1) reinstale o hook "log tudo" (agora com os eventos de subagente) — idempotente
npm run cursor:poc:install

# 2) exercite a IDE disparando subagentes (Task: explore/generalPurpose)
#    abra o Agent Chat e peça uma tarefa que use subagente; deixe o turno terminar

# 3) correlacione os eventos capturados
npm run cursor:poc:subagents
```

Se o hook ainda mostrar "não observado", use o **fallback pelo transcript** (a IDE usa `Task`):
procure `tool_name":"Task"` no `events.jsonl` ou um bloco `tool_use` de `Task` no transcript.

### Evidência esperada

- `Eventos de subagente: <n> · pares: <p> · órfãos: <o> · sem id: <u>`.
- Uma linha `  par <id>  casado · pai: <parent_conversation_id>` por subagente correlacionado.
- Sem eventos de subagente → `Subagentes: não observado em …` (código `0`).

### Critério de sucesso/falha

- **Sucesso**: `subagentStart`/`subagentStop` disparam com `subagent_id` (e `parent_conversation_id`)
  → dá para alimentar `addSub`/`completeSub`.
- **Sucesso parcial (fallback)**: só o `Task` do transcript aparece → o sub entra sem correlação de
  id/par (degradação aceitável).
- **Falha**: nem hook nem `Task` → o modelo de subagente do Habblaud não tem lastro no Cursor.

---

## P5 — CLI headless (`cursor-agent`) como fonte alternativa

**Objetivo** (`07-poc-priorizados.md`, P5): caracterizar o NDJSON de
`cursor-agent -p --output-format stream-json` e decidir se o CLI é observável sem hooks.

### Comando exato

```bash
# 0) confirme o CLI (se não estiver no PATH, use o caminho absoluto do binário)
cursor-agent --version

# 1) rode um prompt e guarde o stream (NDJSON) — ou canalize direto para o harness
cursor-agent -p "responda apenas OK" --output-format stream-json > /tmp/cursor-stream.ndjson

# 2) caracterize o stream salvo…
npm run cursor:poc:cli -- --path /tmp/cursor-stream.ndjson

# …ou leia direto do stdin (sem arquivo intermediário)
cursor-agent -p "responda apenas OK" --output-format stream-json | npm run cursor:poc:cli
```

O analisador conta os `type` observados, extrai o `session_id`, soma as chamadas de ferramenta e
conta as linhas ilegíveis (linha corrompida não quebra: só conta).

### Evidência esperada

- `Session-id: <id>` (ou `(nenhum)` se o CLI não mandar).
- `Eventos: <n> · ilegíveis: <k>`.
- Bloco `Tipos:` com `system`/`user`/`assistant`/`tool_call`/`result` (conforme a versão).
- `Ferramentas: <d> distintas, <c> chamadas` com o nome de cada ferramenta.

### Critério de sucesso/falha

- **Sucesso**: o stream traz `session_id` e `tool_call` com nome de ferramenta → o CLI é observável
  (mesmo onde os hooks falham, ex.: Linux).
- **Sucesso parcial**: só `system`/`result` → observação pobre (sem atividades).
- **Falha**: stream vazio/opaco ou sem `session_id` → só a IDE é viável.

---

## P6 — Injeção de mensagem na sessão (`stop.followup_message`)

**Objetivo** (`07-poc-priorizados.md`, P6): provar a forma
`hook stop → {"followup_message": <texto>}` e se a mensagem "entra como usuário" ao fim do turno.

O probe `mod/habblaud-cursor/followup-hook.mjs` produz a forma; o harness valida-a localmente **sem**
a IDE. A **injeção real** só se confirma instalando o probe no evento `stop` do `hooks.json` —
por isso o harness **não** o instala por padrão (é um experimento destrutivo: injeta texto).

### Comando exato

```bash
# 1) valide a forma localmente (não precisa da IDE nem de assinatura)
npm run cursor:poc:followup -- --message "continue de onde parou"

# 2) instale o probe no evento `stop` do ~/.cursor/hooks.json (instalação à mão; backup antes)
#    acrescente, no array de hook_event_name:"stop":
#      {"command": "node /caminho/para/mod/habblaud-cursor/followup-hook.mjs"}
#    e exporte o texto a injetar:
export HABBLAUD_CURSOR_POC_FOLLOWUP="continue de onde parou"

# 3) exercite a IDE: dispare um turno e deixe o agente terminar (dispara `stop`)
#    observe se o texto aparece como uma nova mensagem/continuação do agente

# 4) desfaça (remova a entrada do `stop` do hooks.json)
```

### Evidência esperada

- Passo 1: `✓ followup_message: continue de onde parou` e código `0`; saída inválida do probe →
  código `≠ 0` (falha barulhenta).
- Passos 2–3: a mensagem injetada aparece na conversa após o `stop` (evidência: captura de tela do
  Agent Chat).

### Critério de sucesso/falha

- **Sucesso**: o `stop` com `{"followup_message": …}` faz o agente continuar com o texto → viável o
  "Mandar mensagens" (Fase 5) ao fim do turno.
- **Falha**: o texto é ignorado → v1 sem injeção por hook; investigar SDK/ACP como alternativa.

> O harness sempre pode ser apontado para um probe forjado via
> `HABBLAUD_CURSOR_POC_FOLLOWUP_HOOK=<script>` (usado nos testes; útil para diagnosticar).

---

## P7 — Histórico e GitHub (dependem de P0)

**Objetivo** (`07-poc-priorizados.md`, P7): reconstruir as sessões a partir dos transcripts e
detectar efeitos de sala (`git push`, `gh pr create`/`gh pr merge`).

### Comando exato

```bash
# varre o diretório padrão de transcripts da IDE
npm run cursor:poc:history

# ou um diretório específico (ex.: um export já coletado)
npm run cursor:poc:history -- --projects <dir>
```

O analisador reusa o parser do transcript (`parseCursorTranscriptLine`) — linha desconhecida não
lança; a sessão aparece mesmo parcial.

### Evidência esperada

- `Sessões: <n> · com efeitos: <m>`.
- Uma linha por sessão: `  <id>  <mtime-ISO>  turnos: <t> (<papel contagem>)`, seguida de
  `    ferramentas: <Nome> <n>, …` e, quando houver, `    efeitos: git push, gh pr create`.
- Diretório inexistente → mensagem explicativa e código `0`.

### Critério de sucesso/falha

- **Sucesso**: sessões listadas com turnos/ferramentas e os efeitos `git push`/`gh pr create`/`gh pr
  merge` detectados → histórico e efeitos de sala viáveis (Fase 4).
- **Sucesso parcial**: sessões aparecem, mas sem `session_id`/título → histórico limitado.
- **Falha**: diretório sem `agent-transcripts/<id>/<id>.jsonl` ou parser não reconhece o schema (C1
  regrediu).

---

## P8 — Uso/limites do plano

**Objetivo** (`07-poc-priorizados.md`, P8): achar alguma fonte **local** (ou API) com limites de uso,
para decidir se o cartão de uso faz sentido para o Cursor.

O analisador **nunca** imprime valores: para JSON mostra só as chaves de topo; para SQLite, só as
tabelas e as contagens; para o resto, só tamanho/mtime. Diretórios de projeto são ignorados.

### Comando exato

```bash
# varre ~/.cursor, ~/.cursor-server e ~/.config/Cursor (ou um --path específico)
npm run cursor:poc:usage

# exemplo: um único diretório
npm run cursor:poc:usage -- --path ~/.cursor
```

### Evidência esperada

- Uma lista de candidatos: `  <caminho>  <tamanho> B  <mtime-ISO>  [json|sqlite|other]`, cada um com
  `Chaves JSON:` / `Tabelas:` abaixo.
- Nenhum candidato → `Nenhum arquivo candidato de uso/plano em …` e código `0` (é o resultado
  esperado se o Cursor não grava limites localmente).

### Critério de sucesso/falha

- **Sucesso**: existe uma fonte de primeira parte com limites reais (não só `plans/` do **plan
  mode** nem `statsig`/telemetria) → dá para exibir algo.
- **Sucesso parcial**: só fontes de terceiros/telemetria (ex.: extensão token-monitor) → cartão
  depende de heurística frágil.
- **Falha (provável)**: nenhuma fonte local → **ocultar o cartão** para o Cursor.

---

## Como rodar a sequência inteira (resumo)

```bash
# pré-requisito
npm install

# P4 — subagentes (reinstale para pegar subagentStart/subagentStop)
npm run cursor:poc:install
#   … dispare Task na IDE …
npm run cursor:poc:subagents

# P5 — CLI headless
cursor-agent -p "responda apenas OK" --output-format stream-json > /tmp/cursor-stream.ndjson
npm run cursor:poc:cli -- --path /tmp/cursor-stream.ndjson

# P6 — injeção no stop
npm run cursor:poc:followup -- --message "continue de onde parou"
#   … instale o probe no `stop` do hooks.json e observe a IDE …

# P7 — histórico e efeitos
npm run cursor:poc:history

# P8 — uso/limites do plano
npm run cursor:poc:usage
```

---

## Limpeza / desinstalação

- Para remover o hook "log tudo" (inclui os eventos de subagente): `npm run cursor:poc:uninstall`.
- O probe de followup é instalado **à mão** em `~/.cursor/hooks.json`; remova a entrada do `stop`
  manualmente (ou restaure o backup `hooks.json.habblaud-backup-<data>`).
- Para apagar as capturas, remova `~/.habblaud/cursor-poc/` (ou o valor de `HABBLAUD_CURSOR_POC_DIR`).

## Coleta das evidências

Cada POC produz a sua entrega, que retroalimenta `07-poc-priorizados.md`:

| POC | Entrega | O que guardar |
| --- | ------- | ------------- |
| P4 | Correlação de subagentes (hook) + fallback por `Task` | saída de `cursor:poc:subagents` |
| P5 | Retrato do stream-json do CLI | saída de `cursor:poc:cli` (+ amostra do NDJSON) |
| P6 | Forma validada + efeito real do `stop` | saída de `cursor:poc:followup` e captura do Agent Chat |
| P7 | Sessões, ferramentas e efeitos `git`/`gh` | saída de `cursor:poc:history` |
| P8 | Candidatos de uso/plano (só nomes/chaves/tabelas) | saída de `cursor:poc:usage` |
