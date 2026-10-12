# Sala de Controle — Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/sala-de-controle/design.md`
**Status**: Draft

---

## Test Coverage Matrix

> Gerado do código (padrões existentes) e da spec. Guias de qualidade encontrados: **nenhum** (`AGENTS.md`/`CONTRIBUTING.md` ausentes) → padrões fortes aplicados, guiados pelos 76 arquivos `*.test.ts` existentes (vitest, `environment: 'node'`, sem jsdom).

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Domínio/serviço (server: hub, parsers, registries, tarefas) | unit | Todos os ramos; 1:1 com as ACs da história; cada *edge case* listado tem teste | `server/**/*.test.ts` | `npx vitest run <arquivo>` |
| Rota/HTTP (server) | integration | Cada rota da tarefa: sucesso + *edge* + erro | `server/**/*.test.ts` | `npm test` |
| Tipo/schema compartilhado (`shared/types.ts`) | none | - (só o gate de build) | - | build gate |
| Modelo de UI do cliente (puro: `*-model.ts`) | unit | 1:1 com as ACs da história | `client/src/ui/*-model.test.ts` | `npx vitest run <arquivo>` |
| UI (DOM/wiring: `*.ts` componentes) | none | - (sem jsdom no repo); a lógica pura fica no `*-model.ts` testado | - | build gate |
| Mod/hook do Cursor (`.mjs`) | none | Verificado pelo lado servidor (payload/contrato) + runbook manual; o `mod/**` não é coberto pelo vitest | - | build gate |

**Coverage Expectation values** - forte default (sem guia): domínio 1:1 com as ACs + *edge cases*; rota = sucesso + *edge* + erro.

## Gate Check Commands

> Gerado do código - confirmar antes do Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Tarefas só com teste de unidade | `npx vitest run <arquivo>` |
| Full | Tarefas com rota/integração | `npm test` |
| Build | Fim de fase ou tarefas só de tipo/wiring | `npm run typecheck && npm test && npm run build` |

---

## Execution Plan

Fases ordenadas e sequenciais — cada fase termina antes da próxima; as tarefas de uma fase rodam em ordem.

### Phase 1: Leitura (P1 — SC-01..SC-05)
```
T1 -> T2
T1 -> T3
T1 -> T4
```

### Phase 2: Diff (P2 — SC-06..SC-09)
```
T5 -> T7
T6 -> T7
T6 -> T8
```

### Phase 3: Triagem (P3 — SC-10..SC-16)
```
T9 -> T10
```

### Phase 4: Mosaico (P4 — SC-17..SC-20)
```
T11 -> T12
T12 -> T13
```

### Phase 5: Tarefas headless (P5 — SC-21..SC-26)
```
T14 -> T17
T15 -> T17
T16 -> T17
T4 -> T18
T17 -> T18
T18 -> T19
T19 -> T20
T16 -> T21
T21 -> T22
```

### Phase 6: Mensagem na IDE (P6 — SC-27..SC-31)
```
T23 -> T24
T24 -> T25
T23 -> T26
```

### Phase 7: Skills (P7 — SC-32..SC-34)
```
T27 -> T28
T28 -> T29
T27 -> T30
T30 -> T31
T29 -> T31
T31 -> T32
T29 -> T32
```

### Phase 8: Salas (P8 — SC-35..SC-40)
```
T18 -> T33
```

---

## Task Breakdown

### T1: Criar o `TranscriptHub` (leitura única + fan-out)

**What**: Um leitor único por transcript, com fan-out para N assinantes (terminal e fonte), sobre o `FileTail` existente, com *fallback* de polling e preservação de ordem.
**Where**: `server/sources/transcript-hub.ts`
**Depends on**: None
**Reuses**: `server/sources/tail.ts` (`FileTail`), padrão de timer de `server/http/terminal.ts`
**Requirement**: SC-03, SC-05

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] `subscribe(path, consumer, opts?)` cria um `FileTail` por path e entrega o mesmo `TailRead` a todos os assinantes
- [x] Respeita um orçamento de leitura por ciclo e preserva a ordem numa rajada (SC-03)
- [x] Dois assinantes no mesmo path ⇒ **uma** leitura por ciclo (SC-05)
- [x] `unsubscribe()` libera o path quando o último assinante sai
- [x] Gate check passes: `npx vitest run server/sources/transcript-hub.test.ts`
- [x] Test count: arquivo verde com os casos de fan-out/rajada/`missing`/`reset` (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): hub de leitura de transcript com fan-out`

---

### T2: Acelerar o hub com `fs.watch` (+ *fallback*)

**What**: `fs.watch` no transcript antecipa a leitura; o polling continua como *fallback* dentro do alvo.
**Where**: `server/sources/transcript-hub.ts` (modify)
**Depends on**: T1
**Reuses**: padrão `watch`/`schedule()` de `server/sources/watcher.ts:830-871,243-251`
**Requirement**: SC-01, SC-04

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] Evento do `fs.watch` dispara `tick()` imediatamente; sem `fs.watch` vale o polling (SC-04)
- [x] `schedule()` agrupa eventos próximos (anti-trovão), como no `watcher.ts`
- [x] Medição sintética: linha gravada → entregue ≤300 ms (p95) com watch ativo (SC-01)
- [x] Gate check passes: `npx vitest run server/sources/transcript-hub.test.ts`
- [x] Test count: casos de watch-atômico e fallback verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `perf(cursor): fs.watch como acelerador do hub com fallback`

---

### T3: `TerminalStreams` consome o hub (fim do `FileTail` por stream)

**What**: O terminal de um agente passa a assinar o hub em vez de criar `FileTail` por conexão; `init`/`append` e o limite `MAX_STREAMS` inalterados.
**Where**: `server/http/terminal.ts` (modify)
**Depends on**: T1
**Reuses**: `TranscriptSource`/`ConversationSource`/`serve`/`pump` (`terminal.ts:97-341`)
**Requirement**: SC-01, SC-05

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] Dois terminais do mesmo agente compartilham **uma** leitura; `/clear` (troca de transcript) e reconexão sem duplicar entradas (SC-05)
- [x] `init` continua sendo a janela recente; `append` em ordem; 429/500 preservados
- [x] Gate check passes: `npm test`
- [x] Test count: `server/http/terminal.test.ts` verde com os novos casos (sem remoção de teste)

**Tests**: integration
**Gate**: full

**Commit**: `perf(cursor): terminal compartilha o leitor via TranscriptHub`

---

### T4: `CursorSource` assina o hub e acelera a presença

**What**: A fonte do Cursor lê o transcript pelo hub (um leitor por agente) e reage ao vivo, reduzindo o atraso de status/atividade.
**Where**: `server/sources/cursor/source.ts` (modify)
**Depends on**: T1
**Reuses**: `CursorSource.reconcile`/`hookEvent`, `cursorToolUses`/github
**Requirement**: SC-02, SC-05

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] A fonte deixa de abrir `FileTail` próprio e assina o hub (SC-05)
- [x] Linha nova no transcript reflete em status/atividade ≤500 ms (SC-02)
- [x] Claude/Codex intactos (nenhuma fonte deles tocada)
- [x] Gate check passes: `npm test`
- [x] Test count: `server/sources/cursor/source.test.ts` verde (sem remoção de teste)

**Tests**: unit
**Gate**: full

**Commit**: `perf(cursor): fonte assina o hub e acelera presença`

---

### T5: Capturar o diff no hook (`afterFileEdit`)

**What**: O `toolInputOf` passa a incluir `edits` (`{old_string,new_string}`) do payload de `afterFileEdit`, sem mascarar (a máscara é do servidor).
**Where**: `mod/habblaud-cursor/hook.mjs` (modify)
**Depends on**: None
**Reuses**: `toolInputOf` (`hook.mjs:117-131`)
**Requirement**: SC-06

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] `toolInputOf` devolve `{file_path, edits:[{old_string,new_string}]}` quando o evento traz `edits`
- [x] Sem `edits`, o comportamento atual é idêntico (retrocompatível)
- [x] Gate check passes: `npm run typecheck`
- [x] Test count: sem remoção; (o `mod/**` não é coberto pelo vitest — verificado no T7)

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): hook transporta os edits do afterFileEdit`

---

### T6: Tipos do diff + variante do `composer`

**What**: `EditDiff` e o campo opcional `Activity.diff`, sem quebrar o protocolo.
**Where**: `shared/types.ts` (modify)
**Depends on**: None
**Reuses**: `Activity` (`shared/types.ts:74-92`)
**Requirement**: SC-06, SC-17

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] `EditDiff { file; added; removed; truncated? }` exportado
- [x] `Activity.diff?: EditDiff` aditivo e opcional
- [x] Gate check passes: `npm run typecheck`
- [x] Test count: n/a (camada de tipo; build gate)

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): tipo do resumo de diff na Activity`

---

### T7: Diff na `Activity` (hook → Office)

**What**: `CursorEvent.diff` e o resumo da edição em `describeCursorTool`/`activityOf`, com segredo mascarado.
**Where**: `server/sources/cursor/rollout.ts` (modify)
**Depends on**: T5, T6
**Reuses**: `describeCursorTool` (`rollout.ts:152`), `maskSecrets`/`truncate` (`shared/activity.ts`)
**Requirement**: SC-06, SC-09

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] Um payload com `edits` produz `Activity.diff` (arquivo + `added`/`removed`) (SC-06)
- [x] Segredo sintético no diff sai mascarado (SC-09)
- [x] Payload sem `edits` segue como hoje
- [x] Gate check passes: `npx vitest run server/sources/cursor/rollout.test.ts`
- [x] Test count: novo caso de diff + máscara verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): activity com resumo de diff mascarado`

---

### T8: Diff no terminal do Cursor (`StrReplace`/`Write`/`MultiEdit`)

**What**: O parser de terminal do Cursor emite entradas `kind:'diff'` (com `+`/`-`, truncamento e máscara) reusando o formato do Claude.
**Where**: `server/sources/cursor/terminal.ts` (modify)
**Depends on**: T6
**Reuses**: `diffInput`/`MultiEdit`/`Write` (`server/sources/terminal.ts:253-308`), `TerminalInputKind='diff'`
**Requirement**: SC-06, SC-07, SC-08, SC-09

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] Edição com remoção+adição exibe `-`/`+` na entrada da ferramenta (SC-06, SC-07)
- [x] Diff acima do limite trunca com indicador (SC-08); segredo mascarado (SC-09)
- [x] Sem `old_string`/`new_string`, mantém o comportamento atual
- [x] Gate check passes: `npx vitest run server/sources/cursor/terminal.test.ts`
- [x] Test count: casos `+`/`-`, truncamento e máscara verdes (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): diff inline no terminal do Cursor`

---

### T9: Modelo da fila "Precisa de você"

**What**: `waitingItems(snapshot)` reúne permissão, `ask` e falha, ordenado por tempo de espera.
**Where**: `client/src/ui/inbox-model.ts` (new)
**Depends on**: None
**Reuses**: `AgentInfo.waitingFor`/`permission`, `Activity.kind:'ask'`+`questions`, `waitingAgents`
**Requirement**: SC-10, SC-13, SC-15

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] Lista motivos (permissão/ask/falha) com agente, motivos e `since` (SC-10, SC-13)
- [x] Vazia quando ninguém espera (SC-15)
- [x] Gate check passes: `npx vitest run client/src/ui/inbox-model.test.ts`
- [x] Test count: casos por tipo + vazio verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): modelo da fila precisa de você`

---

### T10: Modo "Precisa de você" no shell (extensão do alerta existente)

**What**: O alerta "Precisa de você" do `AgentView` vira um modo/filtro com a fila, decisão de permissão e resposta a `ask`.
**Where**: `client/src/ui/drawer.ts` (modify)
**Depends on**: T9
**Reuses**: alerta `AgentView` (:315), `client/src/ui/permission.ts`, `TerminalControl.open/`CTA (:300,440)
**Requirement**: SC-10, SC-11, SC-12, SC-13, SC-14, SC-15, SC-16

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [x] Itens saem da fila ao decidir a permissão (SC-11, SC-12)
- [x] `ask` mostra pergunta/opções; responder pela fila quando há canal (SC-13, SC-14)
- [x] Badge oculto com fila vazia (SC-15); sem deep-link, foca o agente no escritório (SC-16)
- [x] Gate check passes: `npm run typecheck && npm test && npm run build`
- [x] Test count: sem remoção; lógica pura coberta no T9

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): modo precisa de você no drawer`

---

### T11: Modelo do mosaico

**What**: `mosaicCards(snapshot)` produz cards (provedor, status, atividade, último diff) reusando o agrupamento existente.
**Where**: `client/src/ui/mosaic-model.ts` (new)
**Depends on**: None
**Reuses**: `groupRooms` (`model.ts:357`), `Activity.diff`, `STATUS_LABEL`
**Requirement**: SC-17, SC-20

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Um card por agente ao vivo com provedor/status/atividade/diff (SC-17)
- [ ] Ordenação mantém `waiting` no topo mesmo com grid cheio (SC-20)
- [ ] Gate check passes: `npx vitest run client/src/ui/mosaic-model.test.ts`
- [ ] Test count: casos de card e ordenação verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): modelo do mosaico de sessões`

---

### T12: Componente do mosaico

**What**: Um modo de layout com os cards; clique abre o terminal do agente; `waiting` realçado/notificado.
**Where**: `client/src/ui/mosaic.ts` (new)
**Depends on**: T11
**Reuses**: `UiComponent` (`context.ts:7`), `TerminalControl.open`, `notify.ts:41-56`
**Requirement**: SC-17, SC-18, SC-19, SC-20

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Renderiza os cards e abre o terminal no clique (SC-17, SC-18)
- [ ] `waiting` gera badge/notificação reusando `notify.ts` (SC-19); rola preservando `waiting` (SC-20)
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`
- [ ] Test count: sem remoção; lógica pura coberta no T11

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): modo mosaico de sessões`

---

### T13: Registrar o modo mosaico

**What**: Registrar o `UiComponent` do mosaico e o atalho/alternância no shell.
**Where**: `client/src/ui/index.ts` (modify)
**Depends on**: T12
**Reuses**: registro `components`/`root.append` (`index.ts:177,186`)
**Requirement**: SC-18

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] O mosaico aparece e alterna com o shell sem afetar os demais componentes
- [ ] Gate check passes: `npm run typecheck && npm run build`
- [ ] Test count: sem remoção

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): integra o mosaico ao shell`

---

### T14: `WorktreeManager` (worktree + branch com trava de segurança)

**What**: Criar/remover worktree com branch dedicada; nunca apagar conteúdo não commitado.
**Where**: `server/sources/cursor/worktree.ts` (new)
**Depends on**: None
**Reuses**: `node:child_process` (padrão de `server/messages/codex.ts`)
**Requirement**: SC-22, SC-23

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] `create()` cria `git worktree add` com branch por tarefa (SC-22)
- [ ] `remove()` apaga worktree+branch; com alterações não commitadas, **preserva** e sinaliza conflito (SC-23)
- [ ] Gate check passes: `npx vitest run server/sources/cursor/worktree.test.ts`
- [ ] Test count: casos de criação, remoção limpa e conflito verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): worktree e branch por tarefa`

---

### T15: Normalizar o stream-json do CLI

**What**: Converter a saída `--output-format stream-json` do `agent` em linhas equivalentes ao transcript do Cursor (para o `createCursorTerminalParser`).
**Where**: `server/sources/cursor/stream.ts` (new)
**Depends on**: None
**Reuses**: schema de `server/sources/cursor/transcript.ts`, caracterização de `scripts/cursor-poc.ts`
**Requirement**: SC-24

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Um trecho de stream-json vira linhas `{role, message.content[]}` compatíveis com o parser do Cursor
- [ ] Formato desconhecido não lança (degrada para entrada mínima)
- [ ] Gate check passes: `npx vitest run server/sources/cursor/stream.test.ts`
- [ ] Test count: casos felizes + formato divergente verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): normaliza o stream-json headless`

---

### T16: Tipos da tarefa headless

**What**: `CursorTaskInfo` + `OfficeSnapshot.tasks`/`meta.tasks` (aditivos).
**Where**: `shared/types.ts` (modify)
**Depends on**: None
**Reuses**: `OfficeSnapshot` (`shared/types.ts:331-362`)
**Requirement**: SC-21, SC-24

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] `CursorTaskInfo` exportado; `tasks?` aditivo no snapshot/meta
- [ ] Gate check passes: `npm run typecheck`
- [ ] Test count: n/a (camada de tipo)

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): tipos da tarefa headless`

---

### T17: `TaskManager` (spawn, stop, resume, reconcile)

**What**: Abrir/parar/retomar tarefas gerenciadas, observar como sessão comum e reconciliar no boot.
**Where**: `server/sources/cursor/tasks.ts` (new)
**Depends on**: T14, T15, T16
**Reuses**: `Office.addMain/addActivity`, `WorktreeManager`, `stream.ts`, `MessageRegistry`-style `spawn`
**Requirement**: SC-21, SC-24, SC-25, SC-26

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] `create()` lança com prompt/modelo/modo; `stop`/`resume` (`--resume`) mantêm a sessão (SC-21, SC-25)
- [ ] Observabilidade equivalente à IDE via Office (SC-24)
- [ ] `reconcile()` marca `stopped` tarefa órfã (SC-25); binário ausente → `failed` com erro acionável (SC-26)
- [ ] Gate check passes: `npx vitest run server/sources/cursor/tasks.test.ts`
- [ ] Test count: casos create/stop/resume/reconcile/falha verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): gerenciador de tarefas headless`

---

### T18: Integrar o `TaskManager` ao `CursorSource`

**What**: A fonte expõe as tarefas e roteia `transcriptPathOf`/`terminalParser` (transcript normalizado) dos agentes de tarefa.
**Where**: `server/sources/cursor/source.ts` (modify)
**Depends on**: T17, T4
**Reuses**: `AgentSource`, `reconcile`, hub (T4)
**Requirement**: SC-21, SC-24, SC-25

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] `tasks()`/`createTask`/`stopTask`/`resumeTask`/`removeTask` ligados ao Office (SC-21)
- [ ] Terminal da tarefa abre pelo transcript normalizado (SC-24)
- [ ] Gate check passes: `npm test`
- [ ] Test count: `server/sources/cursor/source.test.ts` verde (sem remoção de teste)

**Tests**: unit
**Gate**: full

**Commit**: `feat(cursor): fonte hospeda o ciclo das tarefas`

---

### T19: Rotas de tarefas (`/api/tasks*`)

**What**: `POST/GET/DELETE /api/tasks`, `stop`/`resume`, com a trava local e erros acionáveis.
**Where**: `server/http/app.ts` (modify)
**Depends on**: T18
**Reuses**: `ApiDeps`/dispatcher (`app.ts:19-68,239-439`), travas de `terminal`
**Requirement**: SC-21, SC-25, SC-26

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Rotas em `ApiDeps` com sucesso + erro (400/404/403/409) (SC-21)
- [ ] Parar/retomar refletem na tarefa (SC-25); falha de lançamento vira 4xx acionável (SC-26)
- [ ] Gate check passes: `npm test`
- [ ] Test count: `server/http/http.test.ts` verde com os novos casos (sem remoção de teste)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): rotas de tarefas headless`

---

### T20: Wiring das rotas de tarefas

**What**: Ligar `TaskManager`/rotas em `index.ts` (deps + trava).
**Where**: `server/index.ts` (modify)
**Depends on**: T19
**Reuses**: montagem de fontes/deps (`index.ts:98-216`)
**Requirement**: SC-21

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] As rotas respondem conforme a trava local (ligadas/desligadas)
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`
- [ ] Test count: sem remoção

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): liga as rotas de tarefas no servidor`

---

### T21: Modelo/ação de tarefa no cliente

**What**: Modelo puro + `fetch` para criar/listar/parar/retomar tarefas (usado pelo launcher existente).
**Where**: `client/src/ui/tasks-model.ts` (new)
**Depends on**: T16
**Reuses**: `store.ts` (`fetch('/api/...')`), `DayLauncher` pattern
**Requirement**: SC-21, SC-24

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Modelo monta o formulário (prompt/modo/modelo/isolada) e lê o estado da tarefa (SC-21, SC-24)
- [ ] Gate check passes: `npx vitest run client/src/ui/tasks-model.test.ts`
- [ ] Test count: casos de montagem/estado verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): modelo de tarefa no cliente`

---

### T22: Ação "Nova tarefa" no launcher existente

**What**: Estender o launcher atual com a criação de tarefa; a tarefa aparece como agente na sala.
**Where**: `client/src/ui/index.ts` (modify)
**Depends on**: T21
**Reuses**: `DayLauncher` (`index.ts:162`)
**Requirement**: SC-21

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] A ação cria a tarefa e ela surge na sala do projeto (SC-21)
- [ ] Gate check passes: `npm run typecheck && npm run build`
- [ ] Test count: sem remoção

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): nova tarefa a partir do launcher`

---

### T23: Suporte a `cursor` na `MessageRegistry`

**What**: `canMessage`/presença do Cursor, `cursorPoll` (uma por conversa), `ack` e a trava de auto-followups (N=5).
**Where**: `server/messages/registry.ts` (modify)
**Depends on**: None
**Reuses**: `MessageRegistry` (`registry.ts:178-333`), `describeMessage`
**Requirement**: SC-27, SC-28, SC-29, SC-31

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Mensagem `queued` vira `sent`/`delivered` de forma idempotente por `id` (SC-31)
- [ ] Após 5 entregas automáticas sem resposta, para e exige ação (SC-29); retoma com novo prompt do usuário
- [ ] `unavailableReason` certo quando não há canal (SC-30)
- [ ] Gate check passes: `npx vitest run server/messages/registry.test.ts`
- [ ] Test count: casos de fila/idempotência/trava verde (sem remoção de teste)

**Tests**: unit
**Gate**: full

**Commit**: `feat(cursor): fila de mensagens do Cursor com trava`

---

### T24: Rota de poll da caixa do Cursor

**What**: Rota usada pelo hook do Cursor para buscar a mensagem enfileirada da sessão.
**Where**: `server/messages/http.ts` (modify)
**Depends on**: T23
**Reuses**: rotas `inbox`/`ack` de `messages/http.ts`
**Requirement**: SC-27, SC-28

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] A rota entrega a mensagem da sessão e confirma a entrega (SC-27, SC-28)
- [ ] Corpo inválido → 400; sessão desconhecida → vazio (não quebra)
- [ ] Gate check passes: `npm test`
- [ ] Test count: `server/messages/http.test.ts` verde com os novos casos (sem remoção de teste)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): rota de caixa de entrada do Cursor`

---

### T25: Hook `stop` devolve `followup_message`

**What**: No evento `stop`, o hook busca a mensagem enfileirada e a devolve como `{followup_message}`.
**Where**: `mod/habblaud-cursor/hook.mjs` (modify)
**Depends on**: T24
**Reuses**: `followup-hook.mjs` (forma validada do `followup_message`)
**Requirement**: SC-27, SC-28

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Havendo mensagem, o `stop` devolve `{"followup_message": text}`; sem mensagem, sai silencioso
- [ ] Falha de rede não bloqueia o turno (degrada gracioso)
- [ ] Gate check passes: `npm run typecheck`
- [ ] Test count: sem remoção; (o `mod/**` não é coberto pelo vitest; contrato coberto no T24)

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): hook entrega a mensagem no fim do turno`

---

### T26: Composer reabilitado para o Cursor

**What**: `composerMode` deixa de forçar `off` quando o canal existe; mostra estado da fila; degrada com `CURSOR_OFF_TEXT` sem canal.
**Where**: `client/src/ui/composer-model.ts` (modify)
**Depends on**: T23
**Reuses**: `composerMode`/`CURSOR_OFF_TEXT` (`composer-model.ts:13,31,38`)
**Requirement**: SC-27, SC-30

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Com canal: cursor permite enviar e mostra "na fila"/"entregue" (SC-27)
- [ ] Sem canal: `off` com `CURSOR_OFF_TEXT` (sem regressão à Fase 5) (SC-30)
- [ ] Claude/Codex inalterados
- [ ] Gate check passes: `npx vitest run client/src/ui/composer-model.test.ts`
- [ ] Test count: casos on/off verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): composer da IDE com estado de fila`

---

### T27: Catálogo de skills

**What**: `listSkills(roots)` lê `SKILL.md` (frontmatter `name`/`description`) dos diretórios conhecidos; malformado vira indisponível.
**Where**: `server/skills/catalog.ts` (new)
**Depends on**: None
**Reuses**: `node:fs`; `SkillInfo` (T6-family; definido aqui)
**Requirement**: SC-32, SC-34

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Lista `.cursor/skills`, `.agents/skills`, `~/.cursor/skills` com nome/descrição (SC-32)
- [ ] `SKILL.md` malformado → `available:false` sem lançar (SC-34)
- [ ] Gate check passes: `npx vitest run server/skills/catalog.test.ts`
- [ ] Test count: casos válido/quebrado/ausente verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): catálogo de skills`

---

### T28: Rotas de skills

**What**: `GET /api/skills` (catálogo) e `POST /api/skills/run` (injetar como prompt na sessão-alvo).
**Where**: `server/skills/http.ts` (new)
**Depends on**: T27
**Reuses**: canal de sessão (P5/P6)
**Requirement**: SC-32, SC-33

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] `GET` lista; `POST run` submete o prompt à sessão-alvo (headless/IDE) (SC-32, SC-33)
- [ ] Skill inexistente → 404; corpo inválido → 400
- [ ] Gate check passes: `npm test`
- [ ] Test count: novo `server/skills/http.test.ts` verde (sem remoção de teste)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): rotas de skills`

---

### T29: Ligar as rotas de skills no dispatcher

**What**: Adicionar `skills` ao `ApiDeps` e ao dispatcher.
**Where**: `server/http/app.ts` (modify)
**Depends on**: T28
**Reuses**: `ApiDeps`/dispatcher (`app.ts:19-68`)
**Requirement**: SC-32

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] As rotas respondem com a trava local
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`
- [ ] Test count: sem remoção

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): liga as rotas de skills`

---

### T30: Modelo do painel de skills

**What**: `skillsView(snapshot|lista)` formata os itens e marca indisponíveis (puro).
**Where**: `client/src/ui/skills-model.ts` (new)
**Depends on**: T27
**Reuses**: `SkillInfo`, `providerOf`
**Requirement**: SC-32, SC-34

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Renderiza nome/descrição e marca indisponíveis (SC-32, SC-34)
- [ ] Gate check passes: `npx vitest run client/src/ui/skills-model.test.ts`
- [ ] Test count: casos válido/quebrado verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): modelo do painel de skills`

---

### T31: Componente do painel de skills

**What**: Painel que lista e dispara skills na sessão-alvo.
**Where**: `client/src/ui/skills.ts` (new)
**Depends on**: T30, T29
**Reuses**: `UiComponent` (`context.ts:7`), `fetch`
**Requirement**: SC-32, SC-33

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Lista e executa (dispara o prompt na sessão) (SC-32, SC-33)
- [ ] Gate check passes: `npm run typecheck && npm run build`
- [ ] Test count: sem remoção; lógica pura coberta no T30

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): painel de skills`

---

### T32: Registrar o painel de skills

**What**: Registrar o `UiComponent` de skills e o ponto de acesso no shell.
**Where**: `client/src/ui/index.ts` (modify)
**Depends on**: T31, T29
**Reuses**: registro `components`/`root.append` (`index.ts:177,186`)
**Requirement**: SC-32

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] O painel abre pelo shell sem afetar os demais
- [ ] Gate check passes: `npm run typecheck && npm run build`
- [ ] Test count: sem remoção

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): integra o painel de skills`

---

### T33: Sala do repositório de origem para a tarefa

**What**: Tarefa em worktree entra na sala do repositório de origem, com o nome da tarefa/branch como rótulo; ao remover, o rótulo some sem encerrar a sala.
**Where**: `server/sources/cursor/tasks.ts` (modify)
**Depends on**: T18
**Reuses**: `Office.ensureRoom`/`roomId=normalizeCwd(cwd)` (`office.ts:1021,317`)
**Requirement**: SC-40

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] A tarefa aparece na sala do projeto de origem com rótulo (SC-40)
- [ ] Remover o worktree não encerra a sala do projeto
- [ ] Gate check passes: `npx vitest run server/sources/cursor/tasks.test.ts`
- [ ] Test count: caso sala/rótulo verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): tarefa headless na sala do projeto de origem`

---

### T34: Travas de regressão das salas por projeto

**What**: Testes que fixam o comportamento existente/estendido das salas (projeto= sala, desambiguação, herança, sala padrão, rename persistente).
**Where**: `server/sources/cursor/source.test.ts` (modify)
**Depends on**: None
**Reuses**: `rooms.ts` (`roomDisplayNames`), `office.ts` (`ensureRoom`), `rooms.json`
**Requirement**: SC-35, SC-36, SC-37, SC-38, SC-39

**Tools**:
- MCP: `filesystem`
- Skill: NONE

**Done when**:
- [ ] Cobre workspace→sala (SC-35), basename colidente→pais (SC-36), subagente herda sala (SC-37), sem workspace→padrão (SC-38), rename persiste (SC-39)
- [ ] Gate check passes: `npx vitest run server/sources/cursor/source.test.ts`
- [ ] Test count: casos das 5 ACs verde (sem remoção de teste)

**Tests**: unit
**Gate**: quick

**Commit**: `test(cursor): travas das salas por projeto`

---

## Phase Execution Map

```
Fases 1..8 (sequenciais)

Phase 1
T1 -> T2
T1 -> T3
T1 -> T4

Phase 2
T5 -> T7
T6 -> T7
T6 -> T8

Phase 3
T9 -> T10

Phase 4
T11 -> T12
T12 -> T13

Phase 5
T14 -> T17
T15 -> T17
T16 -> T17
T4 -> T18
T17 -> T18
T18 -> T19
T19 -> T20
T16 -> T21
T21 -> T22

Phase 6
T23 -> T24
T24 -> T25
T23 -> T26

Phase 7
T27 -> T28
T28 -> T29
T27 -> T30
T30 -> T31
T29 -> T31
T31 -> T32
T29 -> T32

Phase 8
T18 -> T33
```

Execução estritamente sequencial dentro de cada fase.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1 TranscriptHub (core) | 1 módulo | ✅ Granular |
| T2 watch acelerador | 1 comportamento (mesmo arquivo) | ✅ Granular |
| T3 terminal consome hub | 1 arquivo | ✅ Granular |
| T4 fonte assina hub | 1 arquivo | ✅ Granular |
| T5 hook edits | 1 função | ✅ Granular |
| T6 tipos diff | 1 arquivo (tipos) | ✅ Granular |
| T7 diff na Activity | 1 módulo | ✅ Granular |
| T8 diff no terminal | 1 módulo | ✅ Granular |
| T9 inbox-model | 1 modelo puro | ✅ Granular |
| T10 modo no drawer | 1 componente | ✅ Granular |
| T11 mosaic-model | 1 modelo puro | ✅ Granular |
| T12 mosaic | 1 componente | ✅ Granular |
| T13 registro mosaic | 1 arquivo | ✅ Granular |
| T14 worktree | 1 módulo | ✅ Granular |
| T15 stream normalize | 1 módulo | ✅ Granular |
| T16 tipos tarefa | 1 arquivo (tipos) | ✅ Granular |
| T17 TaskManager | 1 módulo | ✅ Granular |
| T18 integrar no source | 1 arquivo | ✅ Granular |
| T19 rotas tasks | 1 arquivo | ✅ Granular |
| T20 wiring server | 1 arquivo | ✅ Granular |
| T21 tasks-model | 1 modelo puro | ✅ Granular |
| T22 ação launcher | 1 arquivo | ✅ Granular |
| T23 registry cursor | 1 módulo | ✅ Granular |
| T24 rota inbox cursor | 1 arquivo | ✅ Granular |
| T25 hook stop | 1 função | ✅ Granular |
| T26 composer | 1 modelo | ✅ Granular |
| T27 catálogo skills | 1 módulo | ✅ Granular |
| T28 rotas skills | 1 arquivo | ✅ Granular |
| T29 dispatch skills | 1 arquivo | ✅ Granular |
| T30 skills-model | 1 modelo puro | ✅ Granular |
| T31 painel skills | 1 componente | ✅ Granular |
| T32 registro skills | 1 arquivo | ✅ Granular |
| T33 sala da tarefa | 1 módulo | ✅ Granular |
| T34 travas de salas | 1 arquivo de teste | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | início | ✅ Match |
| T2 | T1 | T1→T2 | ✅ Match |
| T3 | T1 | T1→T3 | ✅ Match |
| T4 | T1 | T1→T4 | ✅ Match |
| T5 | None | início | ✅ Match |
| T6 | None | início | ✅ Match |
| T7 | T5, T6 | T5→T7, T6→T7 | ✅ Match |
| T8 | T6 | T6→T8 | ✅ Match |
| T9 | None | início | ✅ Match |
| T10 | T9 | T9→T10 | ✅ Match |
| T11 | None | início | ✅ Match |
| T12 | T11 | T11→T12 | ✅ Match |
| T13 | T12 | T12→T13 | ✅ Match |
| T14 | None | início | ✅ Match |
| T15 | None | início | ✅ Match |
| T16 | None | início | ✅ Match |
| T17 | T14, T15, T16 | T14→T17, T15→T17, T16→T17 | ✅ Match |
| T18 | T17, T4 | T17→T18, (T4, fase 1) | ✅ Match |
| T19 | T18 | T18→T19 | ✅ Match |
| T20 | T19 | T19→T20 | ✅ Match |
| T21 | T16 | T16→T21 | ✅ Match |
| T22 | T21 | T21→T22 | ✅ Match |
| T23 | None | início | ✅ Match |
| T24 | T23 | T23→T24 | ✅ Match |
| T25 | T24 | T24→T25 | ✅ Match |
| T26 | T23 | T23→T26 | ✅ Match |
| T27 | None | início | ✅ Match |
| T28 | T27 | T27→T28 | ✅ Match |
| T29 | T28 | T28→T29 | ✅ Match |
| T30 | T27 | T27→T30 | ✅ Match |
| T31 | T30, T29 | T30→T31, T29→T31 | ✅ Match |
| T32 | T31, T29 | T31→T32, T29→T32 | ✅ Match |
| T33 | T18 | T18→T33 | ✅ Match |
| T34 | None | início | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | Domínio/serviço | unit | unit | ✅ OK |
| T2 | Domínio/serviço | unit | unit | ✅ OK |
| T3 | Rota/HTTP/stream | integration | integration | ✅ OK |
| T4 | Domínio/serviço | unit | unit | ✅ OK |
| T5 | Mod/hook (.mjs) | none | none | ✅ OK |
| T6 | Tipo/schema | none | none | ✅ OK |
| T7 | Domínio/serviço | unit | unit | ✅ OK |
| T8 | Domínio/serviço | unit | unit | ✅ OK |
| T9 | Modelo de UI (puro) | unit | unit | ✅ OK |
| T10 | UI (DOM/wiring) | none | none | ✅ OK |
| T11 | Modelo de UI (puro) | unit | unit | ✅ OK |
| T12 | UI (DOM/wiring) | none | none | ✅ OK |
| T13 | UI (DOM/wiring) | none | none | ✅ OK |
| T14 | Domínio/serviço | unit | unit | ✅ OK |
| T15 | Domínio/serviço | unit | unit | ✅ OK |
| T16 | Tipo/schema | none | none | ✅ OK |
| T17 | Domínio/serviço | unit | unit | ✅ OK |
| T18 | Domínio/serviço | unit | unit | ✅ OK |
| T19 | Rota/HTTP | integration | integration | ✅ OK |
| T20 | UI (wiring servidor) | none | none | ✅ OK |
| T21 | Modelo de UI (puro) | unit | unit | ✅ OK |
| T22 | UI (DOM/wiring) | none | none | ✅ OK |
| T23 | Domínio/serviço | unit | unit | ✅ OK |
| T24 | Rota/HTTP | integration | integration | ✅ OK |
| T25 | Mod/hook (.mjs) | none | none | ✅ OK |
| T26 | Modelo de UI (puro) | unit | unit | ✅ OK |
| T27 | Domínio/serviço | unit | unit | ✅ OK |
| T28 | Rota/HTTP | integration | integration | ✅ OK |
| T29 | Wiring servidor | none | none | ✅ OK |
| T30 | Modelo de UI (puro) | unit | unit | ✅ OK |
| T31 | UI (DOM/wiring) | none | none | ✅ OK |
| T32 | UI (DOM/wiring) | none | none | ✅ OK |
| T33 | Domínio/serviço | unit | unit | ✅ OK |
| T34 | Domínio/serviço (testes) | unit | unit | ✅ OK |

---

## Tips

- **Reuses = economia** - cada tarefa referencia o código existente
- **Dependências são portões** - nada avança fora de ordem
- **Done when = verificável** - cada checkbox é binário e cita o gate
- **Requisito = rastreável** - toda tarefa aponta para SC-xx
- **Um commit por tarefa** - a mensagem já está planejada
