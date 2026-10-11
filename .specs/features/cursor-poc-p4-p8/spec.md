# POCs Cursor (P4–P8) Specification

## Problem Statement

A rodada P0–P3 fechou as lacunas bloqueantes do Cursor (transcript JSONL — C1 ✅; cobertura de
hooks; bloqueio de decisão; ingestão no escritório) e deu **GO** à Fase 1 (`docs/analise/07-poc-priorizados.md`).
Restam cinco POCs **não bloqueantes** que destravam decisões de escopo e de UI: **P4** (subagentes
e ciclo de turno), **P5** (CLI headless `cursor-agent` como fonte alternativa), **P6** (injeção de
mensagem na sessão), **P7** (histórico e efeitos `gh`/`git`) e **P8** (uso/limites do plano).

Este trabalho entrega o **harness local** que responde a essas cinco perguntas com validação
determinística de tudo que não depende do runtime do Cursor, mais um **runbook** para as partes que
exigem uma máquina com Cursor (e CLI logada). Como manda a regra das POCs, o harness é
**descartável**: o objetivo é responder perguntas, não construir o produto.

## Goals

- [ ] Responder, com evidência reproduzível, às cinco perguntas de P4–P8 (disparam? correlacionam?
      degradam? dá para listar? dá para injetar? há dado de uso?).
- [ ] Estender o harness existente (`scripts/cursor-poc.ts` + `mod/habblaud-cursor/`) com cinco
      analisadores e um probe, **sem** tocar no caminho de produção (Claude/Codex/Cursor vivos).
- [ ] Entregar um runbook único (P4–P8) e manter a validação local determinística (vitest) de tudo
      que não depende do Cursor.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature                                                                 | Reason                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `CursorHistory`/`SessionHistory` de **produção** (Fase 4)               | A POC P7 só prova que o histórico é reconstruível; ligar ao produto é Fase 4 |
| `addSub`/`completeSub` no `CursorSource` vivo (Fase 4)                  | A POC P4 mede os eventos/ids; a fiação no `Office` é Fase 4               |
| Cartão de uso na UI (`client/`)                                         | Depende do veredicto da P8 (provável "ocultar"); cliente intacto           |
| Suporte de produção ao CLI `cursor-agent`                               | A POC P5 só caracteriza o `stream-json`; suportar o CLI é decisão à parte  |
| Injeção de mensagem pela UI ("Mandar mensagens", Fase 5)                | A POC P6 só testa o `stop.followup_message`; a UI é Fase 5                 |
| Publicar/push no fork ou abrir PR upstream                             | Ação remota: exige go-ahead explícito (blast radius)                       |
| Alterar `shared/activity.ts` (`06` §6.2)                                | Tradução fica local à fonte (`sources/cursor/rollout.ts`); risco de regressão |
| Interpretar/decodificar valores de uso/plano da P8                      | Privacidade: a P8 só lista arquivos candidatos e as **chaves** de JSON     |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Forma de entrega | Harness **descartável** (5 analisadores + 1 probe + runbook), espelhando P0–P3 | Regra de `07`: "os PoCs são descartáveis; responder perguntas, não construir o produto" | y |
| Onde a validação ao vivo acontece | Em outra máquina com Cursor (e CLI logada), via runbook `10` | Este ambiente não tem `agent-transcripts` nem CLI logada; o `~/.cursor` local só tem config/estado (evidência: `~/.cursor/{cli-config,ide_state,mcp}.json`, `projects/*` sem `agent-transcripts`) | y |
| Analisadores são 100% locais | Todos os 5 subcomandos rodam com `HOME`/diretórios falsos e fixtures sintéticas | Mantém o gate determinístico (vitest) sem depender do Cursor | y |
| Reuso do diretório de captura | P4 lê o mesmo `HABBLAUD_CURSOR_POC_DIR`/`~/.habblaud/cursor-poc/` de `report` | O hook "log tudo" (P1) já anota `events.jsonl`; P4 só interpreta | y |
| Convenção do transcript (P7) | `~/.cursor/projects/<slug>/agent-transcripts/<conversation_id>/<conversation_id>.jsonl` | Caminho observado ao vivo no runbook `09` (amostra do C1) | y |
| Schema do `stream-json` do CLI (P5) | NDJSON com `{"type": "system"\|"user"\|"assistant"\|"tool_call"\|"result", …}` | Documentado por `07` P5; lido com aliases defensivos (o CLI pode variar) | n |
| Formato do `stop.followup_message` (P6) | `{"followup_message": "<texto>"}` no `stdout` do hook `stop` | Único caminho citado em `07` P6; validado ao vivo pelo runbook | n |
| Locais candidatos de uso/plano (P8) | `~/.cursor`, `~/.cursor-server`, `~/.config/Cursor` (sobrescrevível por `--path`) | `07` P8 manda procurar em `~/.cursor/`; ampliamos para os equivalentes do servidor/app | n |
| Prefixo dos scripts npm | `cursor:poc:<subcomando>` (usage/subagents/cli/followup/history) | Convenção já existente (`cursor:poc:transcript\|report\|decision`) | y |
| Idioma de código e artefatos | PT-BR (comentários, mensagens, runbook) | Convenção do repositório | y |
| Dependências de runtime | Zero novas (só `node:*`); `tsx`/`vitest` já existentes | Requisito do projeto | y |
| Gate do repositório | `npm run typecheck && npm test && npm run build` (quick: `npx vitest run <arquivo>`) | `server/README.md` / tarefas da rodada anterior | y |

**Open questions:** none - all resolved or logged above (required before the spec is confirmed).

---

## User Stories

### S1: Ver o uso/limites do plano no Cursor (POC P8)

**User Story**: Como responsável pelo Habblaud, quero saber se existe alguma fonte local com limites
de uso do Cursor, para decidir se mostro um cartão de uso ou o escondo.

**Why S1**: P8 é o único de P4–P8 totalmente local e destrava uma decisão de UI.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN `npm run cursor:poc:usage` roda THEN o sistema SHALL varrer os locais candidatos do Cursor (`~/.cursor`, `~/.cursor-server`, `~/.config/Cursor`; ou `--path`), ignorando `projects/`/`skills*/`/`plugins/`/`extensions/`, e listar os arquivos candidatos a uso/plano (`usage|plan|limit|quota|billing|credit|ai-tracking|statsig|agent-cli-state|state.vscdb`) com caminho, tamanho e mtime, sem enviar nada para a rede.  <!-- event-driven -->
2. IF um arquivo listado é JSON THEN o sistema SHALL reportar somente as chaves de topo dele; IF é SQLite THEN o sistema SHALL reportar os nomes de tabela e as contagens; em nenhum caso SHALL imprimir valores de campos.  <!-- unwanted-behavior -->
3. IF nenhum local candidato existe THEN o sistema SHALL imprimir uma mensagem explicativa e sair com código `0`.  <!-- unwanted-behavior -->
4. The system SHALL nunca lançar para arquivo ilegível/opaco (reporta e segue).  <!-- ubiquitous -->

**Independent Test**: Rodar `usage` sobre um `HOME`/`--path` temporário com um `usage.json` e um
subdiretório, conferir a listagem e as chaves; rodar sobre um caminho inexistente e conferir a
mensagem e o código `0`.

---

### S2: Medir subagentes e o ciclo de turno (POC P4)

**User Story**: Como investigador, quero correlacionar os eventos `subagentStart`/`subagentStop`
capturados, para saber se o Cursor expõe subagentes (e ids correlacionáveis) como o Claude Code.

**Why S2**: P4 destrava a Fase 4; a rodada P1 **não** observou esses eventos — a primeira pergunta
é se disparam.

**Acceptance Criteria**:

1. WHEN `npm run cursor:poc:install` roda THEN o sistema SHALL instalar hooks para `subagentStart`/`subagentStop` (além dos 15 eventos já instalados), para que a captura possa observá-los.  <!-- event-driven -->
2. WHEN `npm run cursor:poc:subagents` roda sobre o diretório de captura THEN o sistema SHALL listar os eventos `subagentStart`/`subagentStop` capturados e correlacioná-los por `subagent_id`/`conversation_id`.  <!-- event-driven -->
3. WHEN um `subagentStop` casa um `subagentStart` (mesmo id) THEN o sistema SHALL reportar o par como correlacionado, com o pai (`parent_conversation_id`) quando houver.  <!-- event-driven -->
4. IF um `subagentStop` não tem `subagentStart` correspondente THEN o sistema SHALL reportá-lo como órfão.  <!-- unwanted-behavior -->
5. IF não há eventos de subagente na captura THEN o sistema SHALL imprimir "não observado" e sair com código `0`.  <!-- unwanted-behavior -->

**Independent Test**: Alimentar `subagents` com um `events.jsonl` sintético contendo um par
casado, um órfão e nenhum evento; conferir os três relatórios e os códigos de saída.

---

### S3: Caracterizar o CLI headless (`stream-json`) (POC P5)

**User Story**: Como investigador, quero caracterizar o NDJSON do `cursor-agent -p --output-format
stream-json`, para decidir se dá para observar o CLI mesmo sem hooks.

**Why S3**: P5 define o escopo "CLI suportado?" (`07` §P5); o próprio `07` cita risco de hooks
parciais no CLI.

**Acceptance Criteria**:

1. WHEN `npm run cursor:poc:cli --path <arquivo>` recebe um NDJSON THEN o sistema SHALL contar os tipos de evento (`system`/`user`/`assistant`/`tool_call`/`result`…) e reportar o `session_id` observado.  <!-- event-driven -->
2. WHEN o stream traz `tool_call` THEN o sistema SHALL reportar a contagem e a diversidade de ferramentas.  <!-- event-driven -->
3. IF uma linha não é JSON válido THEN o sistema SHALL contá-la como ilegível e seguir com as linhas válidas.  <!-- unwanted-behavior -->
4. WHEN nenhum `--path` é informado THEN o sistema SHALL ler o stream do `stdin`.  <!-- event-driven -->

**Independent Test**: Alimentar `cli` com um NDJSON sintético (`system`, `assistant`, dois
`tool_call` com nomes distintos, `result`) e com uma linha corrompida; conferir contagens,
`session_id`, diversidade e o conta de ilegíveis.

---

### S4: Provar a injeção de mensagem (`stop.followup_message`) (POC P6)

**User Story**: Como investigador, quero um probe que devolva `followup_message` num `stop`, para
saber se "Mandar mensagens" é viável ao fim do turno.

**Why S4**: P6 destrava a Fase 5 (`07` §P6); é o único caminho de injeção citado.

**Acceptance Criteria**:

1. WHEN o probe de followup recebe um evento `stop` no `stdin` THEN o sistema SHALL imprimir `{"followup_message": <texto>}` no `stdout` e sair com código `0`.  <!-- event-driven -->
2. WHEN `npm run cursor:poc:followup [--message <texto>]` roda THEN o sistema SHALL executar o probe com um `stop` sintético e validar que a saída é um JSON com `followup_message` string.  <!-- event-driven -->
3. IF a saída do probe não for JSON válido THEN o harness SHALL falhar com código de saída diferente de `0`.  <!-- unwanted-behavior -->
4. The probe SHALL nunca lançar (stdin inválido → saída silenciosa com código `0`).  <!-- ubiquitous -->

**Independent Test**: Rodar `followup` e conferir a forma da saída e o código `0`; alimentar o probe
com um stdin inválido e conferir a saída vazia com código `0`; forçar saída inválida e conferir a
falha do harness.

---

### S5: Reconstruir histórico e efeitos (`gh`/`git`) (POC P7)

**User Story**: Como investigador, quero enumerar as sessões do Cursor a partir dos transcripts e
detectar `git push`/`gh pr create`, para provar o histórico e os efeitos de sala (Fase 4).

**Why S5**: P7 depende do transcript (P0 ✅) e destrava a Fase 4; a rodada P0 já confirmou o formato.

**Acceptance Criteria**:

1. WHEN `npm run cursor:poc:history` roda sobre o diretório de projetos do Cursor (padrão `~/.cursor/projects`, ou `--projects`) THEN o sistema SHALL enumerar as sessões (`agent-transcripts/<id>/<id>.jsonl`) com id, mtime, nº de turnos (`role`) e ferramentas usadas.  <!-- event-driven -->
2. WHEN um transcript contém um comando `git push` ou `gh pr create`/`gh pr merge` THEN o sistema SHALL reportar o efeito detectado.  <!-- event-driven -->
3. IF o diretório de projetos não existe THEN o sistema SHALL imprimir uma mensagem explicativa e sair com código `0`.  <!-- unwanted-behavior -->
4. The system SHALL reusar o parser do transcript (`parseCursorTranscriptLine`/`describeCursorTool`) e nunca lançar para linha desconhecida.  <!-- ubiquitous -->

**Independent Test**: Montar um `--projects` sintético com duas sessões (uma com `git push`/`gh pr
create`) e uma linha corrompida; conferir as sessões, as ferramentas, os efeitos e o código `0`;
rodar sobre um caminho inexistente e conferir a mensagem e o código `0`.

---

### S6: Executar P4–P8 numa máquina com Cursor (runbook)

**User Story**: Como responsável pelo Habblaud, quero um runbook único que execute P4–P8 e devolva
as evidências, para validar as cinco POCs sem improvisar passos.

**Why S6**: Fecha a entrega "harness + runbook" no padrão da rodada P0–P3 (`08-runbook-poc-cursor.md`).

**Acceptance Criteria**:

1. The system SHALL entregar um runbook (`docs/analise/10-runbook-poc-cursor-p4-p8.md`) com um passo por POC (P4–P8) que diga o comando, o que observar e o critério de sucesso/falha.  <!-- ubiquitous -->
2. WHEN o runbook é seguido THEN o sistema SHALL produzir a evidência de cada POC (relatório/matriz/arquivo) no diretório de captura.  <!-- event-driven -->

**Independent Test**: Revisão do runbook contra a `07` (cada POC tem hipótese, comando e critério);
importa que os comandos existam e casem com os subcomandos entregues.

---

## Edge Cases

- IF o `events.jsonl` tem linhas corrompidas THEN `subagents` SHALL ignorá-las e seguir (nunca lançar).
- IF um evento de subagente não traz id THEN `subagents` SHALL reportá-lo como sem-correlação, sem falhar.
- IF uma sessão do transcript tem `0` turnos THEN `history` SHALL listá-la com contagem `0`, sem falhar.
- IF um arquivo de `usage` é ilegível (permissão) THEN `usage` SHALL reportá-lo e seguir.
- IF o probe de followup recebe um evento que não é `stop` THEN o probe SHALL sair com código `0` sem imprimir nada.
- IF o `stdin` do `cli` não fecha (sem entrada) THEN o harness SHALL tratar como stream vazio e sair `0`.

---

## Requirement Traceability

Each requirement gets a unique ID for tracking across design, tasks, and validation.

| Requirement ID | Story       | Phase  | Status  |
| -------------- | ----------- | ------ | ------- |
| CP48-01        | S1: Uso     | Design | Pending |
| CP48-02        | S1: Uso     | Design | Pending |
| CP48-03        | S1: Uso     | Design | Pending |
| CP48-04        | S1: Uso     | Design | Pending |
| CP48-05        | S2: Subagentes | Design | Pending |
| CP48-06        | S2: Subagentes | Design | Pending |
| CP48-07        | S2: Subagentes | Design | Pending |
| CP48-08        | S2: Subagentes | Design | Pending |
| CP48-09        | S2: Subagentes | Design | Pending |
| CP48-10        | S3: CLI     | Design | Pending |
| CP48-11        | S3: CLI     | Design | Pending |
| CP48-12        | S3: CLI     | Design | Pending |
| CP48-13        | S3: CLI     | Design | Pending |
| CP48-14        | S4: Followup | Design | Pending |
| CP48-15        | S4: Followup | Design | Pending |
| CP48-16        | S4: Followup | Design | Pending |
| CP48-17        | S4: Followup | Design | Pending |
| CP48-18        | S5: Histórico | Design | Pending |
| CP48-19        | S5: Histórico | Design | Pending |
| CP48-20        | S5: Histórico | Design | Pending |
| CP48-21        | S5: Histórico | Design | Pending |
| CP48-22        | S6: Runbook | Design | Pending |
| CP48-23        | S6: Runbook | Design | Pending |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`, `NOTIF-02`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 23 total, 23 mapped to tasks, 0 unmapped (verificado em `validation.md`)

---

## Success Criteria

How we know the feature is successful:

- [ ] Os cinco subcomandos (`usage`, `subagents`, `cli`, `followup`, `history`) e o probe de
      followup rodam localmente com `HOME`/diretórios temporários e produzem seus relatórios sem
      depender do Cursor.
- [ ] O runbook `10` executa P4–P8 numa máquina com Cursor (e CLI logada) e devolve a evidência de
      cada POC.
- [ ] Gate de testes verde (`typecheck` + `vitest` + `build`), sem regressão das suítes existentes.
