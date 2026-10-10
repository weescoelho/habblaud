# POCs Cursor (P0–P3) Specification

## Problem Statement

O Habblaud observa Claude Code e Codex, mas ainda não o Cursor. Antes de investir na Fase 1
(`06-arquitetura-proposta.md`), a análise exige validar quatro POCs **bloqueantes** —
P0 (transcript), P1 (cobertura de hooks), P2 (bloqueio do hook de decisão) e P3 (ingest +
agente no escritório) — em `docs/analise/07-poc-priorizados.md`. Este trabalho entrega o
**harness portável** para essas validações e o **esqueleto de extensão `cursor`** (P3), com
validação local determinística de tudo que não depende do runtime do Cursor; as partes que
dependem de uma assinatura viva do Cursor rodam numa máquina do usuário, seguindo um runbook.

## Goals

- [ ] Provar a tese "é extensão": um agente `cursor` aparece, muda de estado e sai no `Office`
      a partir de eventos de hook simulados, sem regressão em Claude/Codex.
- [ ] Entregar um harness portável (instalador + hooks + analisadores) que, numa máquina com
      Cursor, coleta as evidências de P0/P1/P2 e as transforma nos relatórios das entregas.
- [ ] Manter a validação local determinística (vitest) para tudo que não depende do Cursor.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature                                                             | Reason                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P4–P8 (subagentes avançados, CLI `cursor-agent`, mensagens, histórico, uso do plano) | Fase seguinte (`07-poc-priorizados.md`); só após P0–P3 confirmadas        |
| Paridade visual completa e cartão de uso no cliente                 | Depende de dados que só o P0/P8 podem confirmar; cliente fica intacto     |
| Publicar/push no fork ou abrir PR upstream                          | Ação remota: exige go-ahead explícito (blast radius)                      |
| Transcript parser "completo" do Cursor                              | O schema real é desconhecido (lacuna C1); aqui só o esqueleto + heurística |
| Alterar a UI (`client/`) além do que já é dirigido por `provider`   | Reuso máximo; sem decisão de produto nova                                 |
| "Sempre permitir"/perguntas (`AskUserQuestion`) no Cursor           | Sem superfície documentada; P2 só cobre allow/deny + motivo               |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Onde a validação ao vivo acontece | Em outra máquina com assinatura Cursor, via runbook | Este ambiente não tem IDE controlável, CLI logado nem transcripts locais (evidência: `cursor-agent status` = "Not logged in"; sem `hooks.json`; `~/.cursor/projects/*` só com `canvases/mcps/terminals`) | y |
| Forma de trabalho no código | Fork do upstream: repo local com remote `upstream`, trabalho na branch `cursor-poc` | Pedido do usuário ("via fork do repo"); `projects/habblaud-main` já convertido em repo git em `d5f3718` | y |
| Local do `.specs/` | Dentro do fork (`projects/habblaud-main/.specs/`) | Permite incluir `tasks.md`/`spec.md` no mesmo commit atômico da tarefa (regra do skill); o `.specs/` da raiz é de outro projeto | y |
| Idioma de código e artefatos | PT-BR (comentários, mensagens, runbook) | Convenção do repositório (README, comentários, UI) | y |
| Padrão de implementação do provedor | Espelhar o Codex (`server/sources/codex/*`, `server/codex/http.ts`, `mod/habblaud-codex/hook.mjs`, `scripts/codex-install.ts`) | É o precedente direto de segundo provedor (`01-arquitetura-habblaud.md` §4.4) | y |
| Flag de recurso | `HABBLAUD_CURSOR` ligada por padrão; inerte sem eventos | Padrão do `HABBLAUD_CODEX`; sem pastas locais do Cursor, a fonte só reage a hooks | y |
| Dependências de runtime | Zero (só `node:*` no servidor; `tsx`/`vitest` já existentes como dev) | Requisito do projeto ("servidor sem dependências de runtime") | y |
| Detecção de presença sem arquivos | Via hooks (`sessionStart`/`sessionEnd`) | Lacuna C2: não há registro local de sessões do Cursor conhecido | n |
| Semântica de remoção no `sessionEnd` | Marcar `offline`/remover do `Office` como as outras fontes fazem | Reuso do modelo do `Office` | n |
| Diretório de captura das POCs | `~/.habblaud/cursor-poc/` (sobrescrevível por `HABBLAUD_CURSOR_POC_DIR`) | Fica junto ao estado do Habblaud; fácil de zipar e portar | n |
| Formato do relatório de cobertura (P1) | Markdown "evento → dispara? (contagem) → campos" | Casamento com `05-matriz-compatibilidade.md` §5.1 | n |

**Open questions:** none - all resolved or logged above (required before the spec is confirmed).

---

## User Stories

### P1: Ingest mínimo e agente Cursor no escritório (POC P3) ⭐ MVP

**User Story**: Como responsável pelo Habblaud, quero registrar eventos de hook do Cursor numa
rota de ingest e vê-los refletidos no `Office`, para provar que suportar o Cursor é uma
extensão (sem reescrever o produto).

**Why P1**: É a tese central (`06` §6.2). É totalmente testável localmente com eventos
simulados e destrava a Fase 1 inteira.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN `POST /api/cursor/events` recebe `{event:{hook_event_name:"sessionStart", workspace_roots:[<p>], conversation_id:<id>}}` THEN o sistema SHALL criar ou atualizar um agente `provider:"cursor"` na sala derivada de `workspace_roots[0]` e responder `200 {ok:true}`.  <!-- event-driven -->
2. WHEN chega um evento `preToolUse` com `tool_name` THEN o sistema SHALL registrar uma `Activity` traduzida e colocar o agente em `working`.  <!-- event-driven -->
3. WHEN chega um evento `stop` THEN o sistema SHALL colocar o agente em `idle`.  <!-- event-driven -->
4. WHEN chega um evento `sessionEnd` THEN o sistema SHALL remover o agente do `Office` (ou marcá-lo `offline`).  <!-- event-driven -->
5. IF o corpo não contém `event` como objeto com `hook_event_name` string THEN o sistema SHALL responder com status `400`.  <!-- unwanted-behavior -->
6. WHERE o provedor Cursor está desligado (`HABBLAUD_CURSOR=0`) THEN o sistema SHALL responder `200 {ok:false}` sem alterar o `Office`.  <!-- optional-feature -->
7. The system SHALL manter o comportamento das fontes Claude e Codex inalterado quando eventos Cursor chegam.  <!-- ubiquitous -->
8. WHEN o evento tem `hook_event_name` desconhecido THEN o sistema SHALL responder `200 {ok:false}` sem lançar erro.  <!-- event-driven -->
9. The system SHALL aceitar eventos Cursor apenas de conexão local (mesma trava Host/loopback do Codex).  <!-- ubiquitous -->
10. WHEN chega um evento `beforeShellExecution`/`afterShellExecution` THEN o sistema SHALL colocar o agente em `shell`/`working` respectivamente.  <!-- event-driven -->

**Independent Test**: Subir o servidor com `HABBLAUD_CURSOR=1`, enviar a sequência
`sessionStart → preToolUse → stop → sessionEnd` por `curl` no `POST /api/cursor/events` e
verificar no `/api/health`/snapshot SSE que um agente `cursor` aparece, muda de status e some,
sem nenhum log de erro das fontes Claude/Codex.

---

### P2: Harness de cobertura de eventos de hook na IDE (POC P1)

**User Story**: Como investigador, quero instalar um hook "log tudo" e gerar uma matriz
"evento → dispara? → campos" a partir dos eventos observados, para medir a cobertura real de
hooks na IDE do Cursor.

**Why P2**: P1 é bloqueante (`07`) e determina a estratégia ao vivo (arquivos vs hooks).

**Acceptance Criteria**:

1. WHEN `npm run cursor:poc:install` roda THEN o sistema SHALL gravar/mergear hooks em `~/.cursor/hooks.json` (ou no projeto, com `--project`) preservando os hooks existentes e fazendo backup do arquivo anterior.  <!-- event-driven -->
2. WHEN um hook do harness recebe um evento no `stdin` THEN o sistema SHALL anexar uma linha JSON `{ts, dir, event}` ao diretório de captura.  <!-- event-driven -->
3. WHEN `npm run cursor:poc:report` roda sobre um diretório de captura THEN o sistema SHALL emitir uma matriz "evento → dispara? (contagem) → campos observados" em Markdown.  <!-- event-driven -->
4. IF `hooks.json` não existe no destino THEN o instalador SHALL criá-lo com `{"version":1,"hooks":{}}` sem falhar.  <!-- unwanted-behavior -->
5. IF o diretório de captura está vazio THEN o relatório SHALL imprimir uma mensagem explicativa e sair com código 0.  <!-- unwanted-behavior -->
6. WHEN `npm run cursor:poc:uninstall` roda THEN o sistema SHALL remover apenas os hooks do harness, preservando os demais.  <!-- event-driven -->

**Independent Test**: Rodar `install` num `HOME` temporário e conferir o merge/backup; invocar
o hook com um JSON de stdin e conferir a linha capturada; rodar `report` e conferir a matriz.

---

### P2: Harness de descoberta do transcript (POC P0)

**User Story**: Como investigador, quero capturar o `transcript_path` dos hooks e caracterizar
o arquivo resultante (formato, campos, incrementalidade), para decidir se há paridade de
atividades/terminal/histórico sem depender só de hooks.

**Why P2**: P0 é bloqueante e define a estratégia geral (arquivos vs hooks).

**Acceptance Criteria**:

1. WHEN um hook de captura recebe um evento com `transcript_path` THEN o sistema SHALL copiar o valor e um dump do `stdin` para o diretório de captura.  <!-- event-driven -->
2. WHEN `npm run cursor:poc:transcript --path <arquivo>` roda THEN o sistema SHALL classificar o arquivo como `json`, `jsonl`, `sqlite` ou `opaco` e listar as chaves/campos observados com contagens.  <!-- event-driven -->
3. IF o arquivo é JSONL THEN o inspetor SHALL reportar o número de linhas, os papéis distintos e a presença de campos de tool-call.  <!-- unwanted-behavior -->
4. IF o arquivo é SQLite THEN o inspetor SHALL listar tabelas e contagens sem depender de binário externo.  <!-- unwanted-behavior -->
5. IF o arquivo apontado não existe THEN o inspetor SHALL falhar com mensagem clara e código de saída diferente de 0.  <!-- unwanted-behavior -->
6. The parser esqueleto SHALL mapear linhas reconhecidas do transcript do Cursor para `Activity` sem lançar para formatos desconhecidos.  <!-- ubiquitous -->
7. WHEN o parser esqueleto recebe uma linha de fixture conhecida THEN o sistema SHALL emitir uma `Activity` com `kind` e `label` definidos.  <!-- event-driven -->

**Independent Test**: Rodar o inspetor sobre fixtures `jsonl`, `json` e um SQLite sintético e
conferir a classificação/contagens; alimentar o parser esqueleto com uma linha de fixture e
conferir a `Activity`; rodar com `--path` inexistente e conferir o erro.

---

### P3: Hook de decisão e harness de bloqueio (POC P2)

**User Story**: Como investigador, quero um hook de decisão que bloqueie esperando o escritório
e um harness local que meça o bloqueio, para saber se "responder pelo escritório" é viável no
Cursor e com qual tempo máximo.

**Why P3**: P2 é bloqueante para a permissão pelo escritório, mas puede degradar para
observação; por isso fica atrás de P3/P0/P1.

**Acceptance Criteria**:

1. WHEN o hook de decisão recebe `beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`/`preToolUse` no `stdin` THEN o sistema SHALL registrar o pedido em `POST /api/permissions` com `provider:"cursor"` e aguardar em `GET /api/permissions/:id/wait`.  <!-- event-driven -->
2. WHEN uma decisão `allow`/`deny` chega THEN o hook SHALL imprimir `{"permission":"allow"|"deny"}` no `stdout` e sair com código 0.  <!-- event-driven -->
3. WHEN o tempo esgota ou o Habblaud está fora do ar THEN o hook SHALL sair com código 0 sem imprimir decisão.  <!-- event-driven -->
4. The hook de decisão SHALL nunca lançar exceção não tratada nem derrubar a sessão do Cursor.  <!-- ubiquitous -->
5. WHEN o harness local roda com um stub que segura `N` segundos THEN o sistema SHALL medir e reportar que o hook bloqueou ~`N` s e aplicou a decisão.  <!-- event-driven -->
6. IF `N` excede o limite seguro configurado THEN o harness SHALL reportar o limite seguro observado.  <!-- unwanted-behavior -->

**Independent Test**: Subir um stub de `POST /api/permissions` + `GET /api/permissions/:id/wait`
que demora `N` s, invocar o hook com um JSON de `beforeShellExecution` e conferir o tempo de
bloqueio medido e a saída `{permission}`; derrubar o stub e conferir saída vazia com código 0.

---

## Edge Cases

- IF o corpo de `POST /api/cursor/events` excede o limite de tamanho THEN o sistema SHALL responder `413` sem aplicar o evento.
- IF `workspace_roots` vem ausente ou vazio no `sessionStart` THEN o sistema SHALL usar o `cwd` do evento ou uma sala padrão, sem falhar.
- WHEN dois eventos do mesmo `conversation_id` chegam fora de ordem THEN o sistema SHALL aplicar a borda mais recente (informação mais nova vence), sem estado inconsistente.
- IF o `stdin` do hook é JSON inválido THEN o hook SHALL sair com código 0 sem escrever nada em `stdout`.
- WHEN o instalador roda duas vezes THEN o sistema SHALL ser idempotente (não duplicar hooks nem perder o backup original).

---

## Requirement Traceability

Each requirement gets a unique ID for tracking across design, tasks, and validation.

| Requirement ID | Story       | Phase  | Status  |
| -------------- | ----------- | ------ | ------- |
| CPOC-01        | P1: Ingest  | Design | Implementing |
| CPOC-02        | P1: Ingest  | Design | Implementing |
| CPOC-03        | P1: Ingest  | Design | Implementing |
| CPOC-04        | P1: Ingest  | Design | Implementing |
| CPOC-05        | P1: Ingest  | Design | Implementing |
| CPOC-06        | P1: Ingest  | Design | Implementing |
| CPOC-07        | P1: Ingest  | Design | Implementing |
| CPOC-08        | P1: Ingest  | Design | Implementing |
| CPOC-09        | P1: Ingest  | Design | Implementing |
| CPOC-10        | P1: Ingest  | Design | Implementing |
| CPOC-11        | P2: Hooks   | Design | Pending |
| CPOC-12        | P2: Hooks   | Design | Implementing |
| CPOC-13        | P2: Hooks   | Design | Pending |
| CPOC-14        | P2: Hooks   | Design | Pending |
| CPOC-15        | P2: Hooks   | Design | Pending |
| CPOC-16        | P2: Hooks   | Design | Pending |
| CPOC-17        | P2: Transcript | Design | Implementing |
| CPOC-18        | P2: Transcript | Design | Implementing |
| CPOC-19        | P2: Transcript | Design | Implementing |
| CPOC-20        | P2: Transcript | Design | Implementing |
| CPOC-21        | P2: Transcript | Design | Implementing |
| CPOC-22        | P2: Transcript | Design | Implementing |
| CPOC-23        | P2: Transcript | Design | Implementing |
| CPOC-24        | P3: Decision | Design | Pending |
| CPOC-25        | P3: Decision | Design | Pending |
| CPOC-26        | P3: Decision | Design | Pending |
| CPOC-27        | P3: Decision | Design | Pending |
| CPOC-28        | P3: Decision | Design | Pending |
| CPOC-29        | P3: Decision | Design | Pending |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`, `NOTIF-02`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 29 total, 0 mapped to tasks, 29 unmapped ⚠️

---

## Success Criteria

How we know the feature is successful:

- [ ] Um agente `cursor` aparece/muda de estado/sai no `Office` a partir de eventos simulados,
      com o gate de testes verde e sem regressão das suítes existentes.
- [ ] Os três harnesses (hooks, transcript, decisão) rodam localmente com `HOME`/diretório
      temporários e produzem seus relatórios sem depender do Cursor.
- [ ] Existe um runbook único que executa P0–P3 numa máquina com Cursor e devolve os
      relatórios/entregas de cada POC.
