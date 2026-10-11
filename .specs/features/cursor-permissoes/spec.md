# Fluxo de permissões do Cursor sem travar (Specification)

## Problem Statement

O Cursor não tem os hooks `PermissionRequest`/`Notification`: a decisão vem nos hooks
`beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`/`preToolUse`. O hook do Habblaud
(`mod/habblaud-cursor/hook.mjs`) foi construído para **registrar um pedido no escritório e esperar**
em cada um desses eventos, bloqueando até `decisionTimeoutS` (padrão 25 s). Como o `preToolUse`
dispara para **toda** ferramenta (ex.: 465 eventos na captura real) e o `beforeReadFile` também pede
decisão (180 eventos na mesma captura), o agente **para o tempo todo** — mesmo para uma leitura de
arquivo — e o escritório vira uma fila de aprovações triviais. O Cursor também não expõe
`updatedPermissions`, então hoje não há "sempre permitir" (`server/permissions/registry.ts:177-180`
recusa `suggestion` para `cursor`/`codex`). Este trabalho adapta o fluxo para que o Cursor **pare só
quando realmente precisa de você**.

## Goals

- [x] Reduzir os eventos que **pedem decisão** por padrão (só Shell/MCP), mantendo o restante como
      observação — o agente deixa de travar em `preToolUse`/`beforeReadFile`.
- [x] Oferecer regras locais "sempre permitir" (política consultada pelo hook) que respondem
      `allow`/`deny` na hora, **sem** contatar o escritório nem bloquear.
- [x] Persistir a regra quando o usuário escolhe "permitir sempre" no escritório (emula o
      `updatedPermissions` que o Cursor não tem).
- [x] Documentar e verificar a camada base: auto-run/allowlist nativo do Cursor + status dos eventos
      de decisão e regras locais.
- [x] Fechar tudo com validação determinística (vitest) do que não exige a IDE do Cursor.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature                                                                 | Reason                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Terminal/atividades ricas do transcript (Fase 3)                        | Independente deste fluxo; `CursorSource.transcriptPathOf`/`terminalParser` seguem sob Fase 3 |
| Histórico de sessões / efeitos `git`/`gh` de produção (Fase 4)          | Depende do transcript (P7 só provou o harness)                                              |
| Injeção de mensagem na sessão ("Mandar mensagens", Fase 5)              | Depende de C7 (aberta); fora deste fluxo                                                    |
| UI de gestão de regras (listar/editar/apagar regras pela página)        | v1 disciplina regras pelo arquivo local + "permitir sempre" no diálogo existente             |
| "Sempre permitir" para o Codex                                          | O Codex segue `unsupported` (decisão explícita de escopo)                                    |
| Suporte de produção ao CLI `cursor-agent`                               | Escopo do CLI é decisão à parte (P5)                                                        |
| `updatedPermissions` nativo do Cursor                                   | Não existe na doc de hooks do Cursor — a regra é emulada localmente                          |
| Publicar/push no fork ou abrir PR upstream                              | Ação remota: exige go-ahead explícito (blast radius)                                        |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Eventos que pedem decisão por padrão | `beforeShellExecution` + `beforeMCPExecution` | São os de maior risco; o `preToolUse` cobria toda ferramenta (465 eventos) e o `beforeReadFile` (180) viravam aprovação trivial | y |
| Reativar `beforeReadFile`/`preToolUse` | Config `decisionEvents` sobrescreve o conjunto padrão | Degradação graciosa: quem quiser o rigor antigo religa sem recompilar | y |
| Onde vive a regra local | `~/.habblaud/cursor-hook.json` (arquivo já existente; ganha `rules`) | O hook já lê esse arquivo; evita dependência/serviço novo | y |
| Quem escreve a regra do "permitir sempre" | O **servidor** (ao decidir), no mesmo arquivo lido pelo hook | O hook do Cursor não expressa "sempre"; a regra é do Habblaud | y |
| Ordem de avaliação das regras | `deny` > `allow` > escritório | Determinismo e segurança: negar sempre vence | y |
| Camada base | Auto-run/allowlist **nativo do Cursor** documentado e recomendado | Já existe e reduz o volume antes do hook; o Habblaud só cobre o que pede | y |
| Fail-fast sem viewer (só bloquear quando o escritório está aberto) | **Não** entra nesta feature (o hook mantém a espera até o timeout quando não há decisão) | Oferecido no alinhamento e não priorizado; S1/S2/S3 já cortam o travamento. Reavaliar se ainda travar | y |
| Comandos destrutivos | Podem ser cobertos por regra `deny` explícita; não há heurística automática | Heurística de "perigo" seria escopo novo e frágil | y |
| Idioma de código e artefatos | PT-BR (comentários, mensagens, runbook) | Convenção do repositório | y |
| Dependências de runtime | Zero novas (só `node:*`) | Requisito do projeto | y |
| Gate do repositório | `npm run typecheck && npm test && npm run build` (quick: `npx vitest run <arquivo>`) | `server/README.md` / rodadas anteriores | y |

**Open questions:** none - all resolved or logged above (required before the spec is confirmed).

---

## User Stories

### P1: Decidir só o que importa — cortar o volume de prompts ⭐ MVP

**User Story**: Como usuário do Habblaud com o Cursor, quero que só comandos de shell e MCP peçam
decisão, para que ler/editar um arquivo não trave o agente o tempo todo.

**Why P1**: É a causa direta do "parando o tempo todo" (todo `preToolUse`/`beforeReadFile` virava
pedido no escritório).

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN `npm run cursor:install` instala/mergeia os hooks THEN o sistema SHALL marcar como eventos de **decisão** apenas `beforeShellExecution` e `beforeMCPExecution` por padrão, mantendo `preToolUse`/`beforeReadFile`/`afterFileEdit`/`postToolUse`/… como eventos de **observação**.  <!-- event-driven -->
2. WHEN o hook recebe um evento de observação (ex.: `preToolUse`, `beforeReadFile`) THEN o hook SHALL enviar o evento para `POST /api/cursor/events` e sair com código `0`, sem registrar pedido de permissão e sem bloquear.  <!-- event-driven -->
3. WHERE a configuração local define `decisionEvents` THEN o hook SHALL usar exatamente esse conjunto de eventos como os que pedem decisão.  <!-- optional-feature -->
4. IF um evento de decisão não traz `conversation_id` ou ferramenta derivável THEN o hook SHALL sair com código `0` sem decidir.  <!-- unwanted-behavior -->

**Independent Test**: alimentar o hook com um `preToolUse` e um `beforeReadFile` contra um servidor
falso; conferir que houve **só** `POST /api/cursor/events` (nenhum `POST /api/permissions`), que o
stdout ficou vazio e o exit foi `0`. Depois, com `decisionEvents` reativando `beforeReadFile`, conferir
que o pedido volta a ser registrado.

---

### P1: Regras locais "sempre permitir" (allowlist do hook) ⭐ MVP

**User Story**: Como usuário do Habblaud, quero regras locais (`allow`/`deny`) que o hook aplica na
hora, para que comandos já confiáveis sigam sem passar pelo escritório.

**Why P1**: É o mecanismo que impede a espera repetida sem depender do que o Cursor não oferece.

**Acceptance Criteria**:

1. WHEN o hook recebe um evento de decisão cujo par `ferramenta`+`comando/entrada` casa uma regra `allow` da política local THEN o hook SHALL imprimir `{"permission":"allow"}` no stdout e sair com código `0`, sem contatar o Habblaud.  <!-- event-driven -->
2. WHEN o par `ferramenta`+`comando/entrada` casa uma regra `deny` THEN o hook SHALL imprimir `{"permission":"deny","user_message":"<motivo da regra>"}` e sair com código `0`, sem contatar o Habblaud.  <!-- event-driven -->
3. IF mais de uma regra casa o mesmo pedido THEN o hook SHALL resolver na ordem `deny` > `allow` > escritório, de forma determinística.  <!-- unwanted-behavior -->
4. IF a política local está ausente, ilegível ou traz uma regra com padrão inválido THEN o hook SHALL ignorar a política/regra inválida e seguir o fluxo anterior (registrar e esperar), sem lançar.  <!-- unwanted-behavior -->
5. The hook SHALL avaliar a política local **antes** de registrar o pedido no Habblaud.  <!-- ubiquitous -->

**Independent Test**: com uma política contendo uma regra `allow` (ex.: `Shell` casando `git status`)
e uma `deny` (ex.: `Shell` casando `rm -rf`), rodar o hook para cada comando e conferir as saídas
nativas e a ausência de chamadas ao servidor; com política corrompida, conferir o fluxo anterior.

---

### P2: "Permitir sempre" pelo escritório persiste a regra

**User Story**: Como usuário do Habblaud, quero escolher "permitir sempre" na decisão do Cursor, para
que o Cursor comece a lembrar daquela aprovação (o `updatedPermissions` que ele não tem).

**Why P2**: Complementa o P1 (as regras passam a nascer do uso real), mas o P1 já entrega valor com
regras editadas à mão.

**Acceptance Criteria**:

1. WHEN o usuário escolhe "permitir sempre" na decisão de um pedido do Cursor THEN o servidor SHALL persistir uma regra `allow` na política local do Cursor (ferramenta + padrão derivado do pedido) e concluir a decisão.  <!-- event-driven -->
2. WHEN o mesmo par `ferramenta`+`comando/entrada` volta a pedir decisão THEN o hook SHALL aprovar pela regra persistida, sem novo pedido no escritório.  <!-- event-driven -->
3. IF o provedor do pedido é `cursor` THEN `POST /api/permissions/:id/decision` SHALL aceitar a decisão de "permitir sempre"; IF é `codex` THEN SHALL continuar respondendo `unsupported`.  <!-- unwanted-behavior -->
4. The política local criada pelo "permitir sempre" SHALL ser um arquivo texto legível e editável pelo usuário, documentado no runbook.  <!-- ubiquitous -->
5. The regra persistida por um pedido do Cursor SHALL afetar somente pedidos do provedor `cursor`.  <!-- ubiquitous -->

**Independent Test**: registrar um pedido `beforeShellExecution` e decidir `behavior:"allow"` com
"sempre permitir"; conferir a regra gravada no arquivo local e que um novo pedido idêntico é aprovado
pelo hook sem chamar o servidor; conferir que o mesmo caminho no Codex continua `unsupported`.

---

### P2: Camada base — auto-run/allowlist do Cursor documentado e verificável

**User Story**: Como responsável pelo Habblaud, quero que o auto-run nativo do Cursor seja a camada
base documentada, para que o hook só exista onde precisa decidir.

**Why P2**: Reduz o volume antes do hook e deixa claro o que é responsabilidade do Cursor vs do
Habblaud.

**Acceptance Criteria**:

1. The runbook SHALL documentar que a camada base de "não parar" é o auto-run/allowlist nativo do Cursor (por tipo de ferramenta/comando), com o passo de configuração.  <!-- ubiquitous -->
2. WHEN `npm run cursor:status` roda THEN o sistema SHALL reportar os eventos de decisão instalados e as regras locais vigentes (contagem/lista), sem alterar arquivos.  <!-- event-driven -->
3. The hook do Habblaud SHALL continuar decidindo nos eventos que pedem, independentemente da configuração de auto-run do Cursor.  <!-- ubiquitous -->

**Independent Test**: rodar `cursor:status` sobre um `HOME` temporário com e sem regras e conferir o
relatório; revisar o runbook e conferir o passo de auto-run do Cursor.

---

### P3: Observabilidade do fluxo de decisão

**User Story**: Como investigador, quero registrar quanto o hook decide localmente vs no escritório,
para medir se o travamento caiu.

**Why P3**: Ajuda a avaliar a feature sem instrumentação improvisada; não bloqueia o MVP.

**Acceptance Criteria**:

1. WHEN o hook decide por regra local THEN o hook SHALL registrar localmente (`ferramenta`, `padrão`, `efeito`) para inspeção, sem escrever nada a mais no stdout.  <!-- event-driven -->
2. WHEN `npm run cursor:status` roda THEN o sistema SHALL reportar quantas decisões locais foram registradas desde a última rotação do arquivo.  <!-- event-driven -->

**Independent Test**: disparar decisões por regra e conferir o registro e a contagem no `status`.

---

## Edge Cases

Edge cases are usually unwanted-behavior (IF/THEN) or boundary (WHEN) criteria:

- IF o evento de decisão chega sem comando (`beforeShellExecution` sem `command`) THEN o hook SHALL seguir o fluxo anterior (registrar e esperar), sem lançar.
- IF uma regra usa um padrão (regex) inválido THEN o hook SHALL descartá-la e registrar o motivo, sem interromper o fluxo.
- WHEN duas regras casam (`allow` e `deny`) THEN o hook SHALL aplicar `deny`.
- IF o arquivo de política é um JSON malformado THEN o hook SHALL tratá-lo como ausente e seguir o fluxo anterior.
- IF o "permitir sempre" é escolhido para um pedido sem padrão derivável THEN o servidor SHALL decidir normalmente e NÃO gravar regra (reporta o motivo).
- WHEN não há viewer no escritório THEN o hook SHALL manter o comportamento atual (espera até o timeout e deixa a IDE decidir) — o fail-fast está fora desta feature (ver Assumptions).

---

## Requirement Traceability

Each requirement gets a unique ID for tracking across design, tasks, and validation.

| Requirement ID | Story                           | Phase  | Status  |
| -------------- | ------------------------------- | ------ | ------- |
| CPERM-01       | P1: Decidir só o que importa    | Design | Implementing |
| CPERM-02       | P1: Decidir só o que importa    | Design | Implementing |
| CPERM-03       | P1: Decidir só o que importa    | Design | Implementing |
| CPERM-04       | P1: Decidir só o que importa    | Design | Implementing |
| CPERM-05       | P1: Regras locais (allowlist)   | Design | Implementing |
| CPERM-06       | P1: Regras locais (allowlist)   | Design | Implementing |
| CPERM-07       | P1: Regras locais (allowlist)   | Design | Implementing |
| CPERM-08       | P1: Regras locais (allowlist)   | Design | Implementing |
| CPERM-09       | P1: Regras locais (allowlist)   | Design | Implementing |
| CPERM-10       | P2: "Permitir sempre"           | Design | Implementing |
| CPERM-11       | P2: "Permitir sempre"           | Design | Implementing |
| CPERM-12       | P2: "Permitir sempre"           | Design | Implementing |
| CPERM-13       | P2: "Permitir sempre"           | Design | Implementing |
| CPERM-14       | P2: "Permitir sempre"           | Design | Implementing |
| CPERM-15       | P2: Camada base (auto-run)      | Design | Implementing |
| CPERM-16       | P2: Camada base (auto-run)      | Design | Implementing |
| CPERM-17       | P2: Camada base (auto-run)      | Design | Implementing |
| CPERM-18       | P3: Observabilidade             | Design | Implementing |
| CPERM-19       | P3: Observabilidade             | Design | Implementing |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`, `NOTIF-02`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 19 total, 0 mapped to tasks, 19 unmapped ⚠️

---

## Success Criteria

How we know the feature is successful:

- [x] Um `preToolUse`/`beforeReadFile` do Cursor **não** gera pedido de decisão nem bloqueio por padrão (só observação).
- [x] Um comando coberto por regra local `allow`/`deny` é decidido pelo hook em `< 100 ms`, sem entrar no escritório.
- [x] "Permitir sempre" no escritório grava a regra e o próximo pedido idêntico é aprovado pelo hook sem novo pedido.
- [x] `codex` permanece `unsupported` para "sempre permitir" (sem regressão).
- [x] Gate verde (`typecheck` + `vitest` + `build`), sem regressão das suítes existentes.
