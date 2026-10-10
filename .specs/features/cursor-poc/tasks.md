# Cursor POC Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/cursor-poc/design.md`
**Spec**: `.specs/features/cursor-poc/spec.md`
**Status**: Draft

---

## Test Coverage Matrix

> Generated from the codebase (`vitest.config.ts`, `package.json`, `server/README.md`, `server/tsconfig.json`) and the spec - confirm before Execute. Guidelines found: none dedicated (`AGENTS.md`/`CONTRIBUTING.md` absent); the repo convention (README "Testes") is followed: vitest colocalizado, fixtures sintéticas em `server/test/fixtures.ts`, scripts do host testados em `server/test/` com HOME/config dirs falsos e processos de verdade. A matriz segue esse padrão (que é um **piso**, não teto).

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Protocolo compartilhado (tipos, ex.: união `Provider`) | none | - (gate de build cobre) | - | build gate |
| Lógica pura do cliente (rótulo de ferramenta) | unit | todos os ramos; 1:1 ao AC de rótulo sem regressão | `client/src/ui/*.test.ts` | `npx vitest run client/src/ui` |
| Configuração do servidor | unit | flag ligada/desligada e padrão | `server/config.test.ts` | `npx vitest run server/config.test.ts` |
| Fonte de agentes e normalizadores (`sources/cursor/*`) | unit + integration | todos os ramos; 1:1 aos ACs CPOC; todo edge listado tem teste; sem regressão do `Office` | `server/sources/cursor/*.test.ts` | `npx vitest run server/sources/cursor` |
| Rota de ingest (`server/cursor/http.ts`, `server/http/app.ts`) | integration | rota feliz + cada edge (workspace_roots, out-of-order) + erros (403/405/400/413/{ok:false}) | `server/cursor/http.test.ts`, `server/http/*.test.ts` | `npx vitest run server/cursor server/http` |
| Registro de permissões (`server/permissions/registry.ts`) | unit + integration | todos os ramos por `provider`; regressão de Claude **e** Codex obrigatória | `server/permissions/*.test.ts` | `npx vitest run server/permissions` |
| Hooks (mods, processo de verdade) | integration | observação, decisão (allow/deny), tempo esgotado, Habblaud fora do ar, stdin inválido | `server/test/cursor-hook.test.ts` | `npx vitest run server/test/cursor-hook.test.ts` |
| Scripts/instaladores (processo de verdade, HOME falso) | unit + integration | planos puros + merge/backup/idempotência + classificação/relatório | `server/test/cursor-install.test.ts`, `server/test/cursor-poc.test.ts` | `npx vitest run server/test/cursor-install.test.ts server/test/cursor-poc.test.ts` |
| Documentação (runbook) | none | - (gate de build cobre) | - | build gate |

## Gate Check Commands

> Generated from the codebase (`package.json`) - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Depois de tasks com testes unitários apenas | `npx vitest run <caminho(s) de teste da task>` |
| Full | Depois de tasks com testes de integração/e2e | `npm test` |
| Build | Fim de fase ou task só de config/docs/contrato | `npm run typecheck && npm test && npm run build` |

---

## Execution Plan

As fases rodam em sequência; as tasks de cada fase rodam em ordem. Os diagramas abaixo listam **apenas** as dependências reais (`Depends on`) dentro da fase.

### Phase 1: Fundação

```
T1 · T2
```

### Phase 2: Ingest mínimo e agente Cursor (POC P3)

```
T3 → T5 → T8
T4 → T5
T3 → T6 → T7 → T8
```

### Phase 3: Descoberta do transcript (POC P0)

```
T9 → T10
```

### Phase 4: Cobertura de hooks (POC P1)

```
T11 → T12
```

### Phase 5: Bloqueio do hook de decisão (POC P2)

```
T13 → T14 → T15
T14 → T16
```

### Phase 6: Registro e runbook

```
T17 → T18
```

---

## Task Breakdown

### Phase 1: Fundação

### T1: Reconhecer o Cursor como provedor no protocolo

**What**: Adicionar `'cursor'` à união `Provider` e atualizar os dois `Record<Provider, …>` exaustivos (rótulo da UI e aliases de shell) para o `typecheck` continuar verde.
**Where**: `shared/types.ts` (+ ripple obrigatório: `client/src/ui/provider.ts`, `server/accounts/detect.ts`)
**Depends on**: None
**Reuses**: a união `Provider` existente (`shared/types.ts:17`); a forma da chave `codex` em `PROVIDER_NAME` (`client/src/ui/provider.ts:10`) e em `ALIAS_TOOLS` (`server/accounts/detect.ts:212`)
**Requirement**: CPOC-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `Provider = 'claude' | 'codex' | 'cursor'` (aditivo; `provider` ausente continua `'claude'`)
- [x] `PROVIDER_NAME` ganha `cursor: 'Cursor'`; `ALIAS_TOOLS` ganha `cursor` com regex que nunca casa com aliases de `claude`/`codex`
- [x] `client/src/ui/provider.test.ts` cobre `PROVIDER_NAME.cursor` e `providerOf({ provider: 'cursor' })`; `server/accounts/detect.test.ts` (novo) cobre `parseToolAliases(_, _, 'cursor')` devolvendo `[]`
- [x] Gate check passes: `npm run typecheck && npx vitest run client/src/ui server/accounts`
- [x] Test count: 3+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(cursor): reconhecer o Cursor como provedor no protocolo`

---

### T2: Ligar/desligar a observação do Cursor por configuração

**What**: Adicionar a flag booleana `cursor` ao `ServerConfig`, ligada por padrão e desligável com `HABBLAUD_CURSOR=0`.
**Where**: `server/config.ts`
**Depends on**: None
**Reuses**: o padrão de `codex` (`server/config.ts:51` e `:171`)
**Requirement**: CPOC-06

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `ServerConfig.cursor` existe com doc em PT-BR; default `true`; `HABBLAUD_CURSOR=0` (e `off`) → `false`; `HABBLAUD_CURSOR=1` → `true`
- [x] `server/config.test.ts` (novo) cobre default, desligado e ligado via `loadConfig({ HOME: <tmp>, HABBLAUD_IN_DOCKER: '0', ...env }, [])`
- [x] Gate check passes: `npx vitest run server/config.test.ts`
- [x] Test count: 3 casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick
**Status**: ✅ Done

**Commit**: `feat(cursor): adicionar a flag HABBLAUD_CURSOR`

---

### Phase 2: Ingest mínimo e agente Cursor (POC P3)

### T3: Contrato da parte "ao vivo" do Cursor

**What**: Criar a interface `CursorLive` (aplicar o stdin de um evento de hook ao escritório; `false` = evento desconhecido).
**Where**: `server/sources/cursor/live.ts`
**Depends on**: T1
**Reuses**: a forma de `CodexLive` (`server/sources/codex/live.ts`), sem o parâmetro `account` (o Cursor tem conta única)
**Requirement**: CPOC-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `CursorLive.applyHookEvent(input: Record<string, unknown>): boolean` definido e exportado, com doc em PT-BR
- [ ] Gate check passes: `npm run typecheck`

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): definir o contrato CursorLive`

---

### T4: Normalizar eventos de hook e traduzir ferramentas do Cursor

**What**: Criar a camada de mapeamento: parseiam do evento normalizado (`hook_event_name`, `conversation_id`, `workspace_roots[0]`, `cwd`, `tool_name`, `tool_input`, `command`, `transcript_path` com aliases defensivos), tradução de ferramenta e o mapa hook→status.
**Where**: `server/sources/cursor/rollout.ts`
**Depends on**: T1
**Reuses**: molde de `describeCodexTool` (`server/sources/codex/rollout.ts:304`) e `mcpName` (`:244`); descritores `describeCommand`/`describeTool` (`shared/activity.ts:605`/`:650`)
**Requirement**: CPOC-02, CPOC-10

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `parseCursorEvent(input)` devolve `CursorEvent` normalizado; campos ausentes viram `undefined`; lê aliases defensivos (`command`/`cmd`, `cwd`/`workspace` etc.) sem lançar
- [ ] `describeCursorTool(rawName, input)` traduz `Shell`→`describeCommand`, `Read`/`Write`/`Grep`/`Glob`/`Task`/`WebSearch`→`describeTool`, `MCP:<tool>`→`mcp__<tool>`
- [ ] `statusBorder(event)` mapeia os eventos tratados (`sessionStart`, `beforeSubmitPrompt`, `preToolUse`/`postToolUse`/`postToolUseFailure`, `beforeShellExecution`→`shell`, `afterShellExecution`→`working`, `before`/`afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `afterAgentResponse`/`afterAgentThought`, `stop`→`idle`) e devolve `undefined` para desconhecidos
- [ ] `server/sources/cursor/rollout.test.ts` cobre normalização (com/sem `workspace_roots`), cada alias de ferramenta, `MCP:` e o mapa de status; 1:1 aos ACs desta task
- [ ] Gate check passes: `npx vitest run server/sources/cursor`
- [ ] Test count: 10+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): normalizar eventos de hook e traduzir ferramentas`

---

### T5: Manter os agentes Cursor no escritório a partir dos hooks

**What**: Implementar `CursorSource` (`AgentSource` + `CursorLive`): registra a conta única via `setProviderAccounts('cursor', …)`, mantém tracker por `conversation_id`, aplica bordas de status (informação mais nova vence) e expira presença sem evento novo.
**Where**: `server/sources/cursor/source.ts`
**Depends on**: T3, T4
**Reuses**: forma de `CodexSource` (`server/sources/codex/source.ts:170`, `register():201`, `sources():253`, `decide():670`, `enter():441`, `leave():483`, `applyHookEvent():790`); `Office.addMain/:308`, `setStatus/:374`, `addActivity/:682`, `closeMain/:546`; `AccountsService.setProviderAccounts` (`server/accounts/service.ts:131`)
**Requirement**: CPOC-01, CPOC-03, CPOC-04, CPOC-08, CPOC-10

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `sessionStart` cria/atualiza o agente (`provider:'cursor'`, `sessionId = conversation_id`) na sala de `workspace_roots[0]` (ou `cwd`/sala padrão); `preToolUse`/`postToolUse`/`postToolUseFailure` registram `Activity` e põem em `working`; `beforeShellExecution`→`shell`; `afterShellExecution`→`working`; `stop`→`idle`; `sessionEnd`→`closeMain`
- [ ] Evento fora de `HOOK_EVENTS` → `applyHookEvent` devolve `false` sem lançar
- [ ] Borda fora de ordem não regride o estado (a mais recente vence, por `statusAt`)
- [ ] Relógio de presença remove o agente quando `now - lastHookAt > STALE_PRESENCE_MS`
- [ ] `transcriptPathOf()` e `terminalParser()` devolvem `undefined` (MVP sem transcript)
- [ ] `server/sources/cursor/source.test.ts` cobre a sequência `sessionStart → preToolUse → stop → sessionEnd`, a sala padrão sem `workspace_roots`, evento desconhecido, out-of-order, expiração e a conta registrada; sem regressão do `Office`
- [ ] Gate check passes: `npm test`
- [ ] Test count: 10+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): manter agentes Cursor no escritório pelos hooks`

---

### T6: Rota de ingest — parse e manuseio do evento

**What**: Criar `parseCursorEvent` (corpo `{event:{hook_event_name}}`, senão `HttpError(400)`) e `handleCursorEvent` (aplica em `CursorLive` e responde `200 {ok}`).
**Where**: `server/cursor/http.ts`
**Depends on**: T3
**Reuses**: cópia estrutural de `server/codex/http.ts` (`parseCodexEvent:37`, `handleCodexEvent:63`) com `HttpError`/`readJson`/`sendJson` (`server/http/app.ts`)
**Requirement**: CPOC-05, CPOC-08

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `parseCursorEvent` aceita só `{ event: { hook_event_name: string } }`; `{}`, `{event:'x'}`, `{event:{}}` e `[]` lançam `HttpError(400)`
- [ ] `handleCursorEvent` chama `live.applyHookEvent(event)` e responde `200 {ok}`; sem `live` responde `200 {ok:false}`; `try/catch` → `{ok:false}` (nunca 500)
- [ ] `server/cursor/http.test.ts` cobre os dois caminhos com uma `CursorLive` falsa (parse, `{ok:true}`, `{ok:false}` sem fonte e fonte que lança)
- [ ] Gate check passes: `npx vitest run server/cursor`
- [ ] Test count: 4+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): criar parse e manuseio da rota de eventos`

---

### T7: Ligar `POST /api/cursor/events` com a trava local

**What**: Adicionar a rota em `server/http/app.ts` com a trava idêntica à do Codex (Host local + loopback fora do Docker) e o campo `cursorEvents` no `/api/health`.
**Where**: `server/http/app.ts`
**Depends on**: T6
**Reuses**: bloco da rota do Codex (`server/http/app.ts:334`) e `codexEvents` (`:259`); `isLoopbackHost`/`isLoopbackAddress` (`server/http/guard.ts`)
**Requirement**: CPOC-05, CPOC-06, CPOC-09

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `POST /api/cursor/events` → `handleCursorEvent(req, res, { live: deps.cursorLive })`; `deps.cursorLive?: CursorLive` no `deps`
- [ ] `GET`/outro método → `405`; Host não-local ou conexão não-loopback (fora do Docker) → `403`; corpo sem `event`/`hook_event_name` → `400`; corpo > 256 KB → `413`; sem `cursorLive` → `200 {ok:false}`
- [ ] `/api/health` inclui `cursorEvents: !!deps.cursorLive`
- [ ] `server/http/http.test.ts` cobre `403` (Host de rede + endereço remoto), `405`, `400`, `413`, `200 {ok:true}` e `{ok:false}` sem fonte, além de `health.cursorEvents`
- [ ] Gate check passes: `npm test`
- [ ] Test count: 6+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): expor POST /api/cursor/events com trava local`

---

### T8: Ligar a fonte do Cursor no servidor

**What**: Instanciar a `CursorSource` quando `config.cursor` está ligada, adicioná-la ao `SourceSet` e expor `cursorLive` ao handler HTTP.
**Where**: `server/index.ts`
**Depends on**: T2, T5, T7
**Reuses**: wiring do Codex (`server/index.ts:96`–`:101`, `:195`) e o log de contas (`:262`–`:270`)
**Requirement**: CPOC-06, CPOC-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `config.cursor` ligada cria `new CursorSource({ accounts, office, home: config.home })`, adicionada a `agents`; `cursorLive = cursor`; `cursorLive` passado no `createApiHandler`
- [ ] `HABBLAUD_CURSOR=0` → nenhuma fonte criada, `cursorLive` ausente, sem mudança nas fontes Claude/Codex
- [ ] Log de boot informa as contas/sessões do Cursor (ou "desligado"), em PT-BR
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): ligar a fonte do Cursor no servidor`

---

### Phase 3: Descoberta do transcript (POC P0)

### T9: Esqueleto de parser e inspetor do transcript

**What**: Criar `classifyTranscript`, `inspectTranscript` e `parseCursorTranscriptLine` — caracterizam o arquivo (json/jsonl/sqlite/opaco) e mapeiam linhas reconhecidas para `Activity`, sem lançar para formatos desconhecidos.
**Where**: `server/sources/cursor/transcript.ts`
**Depends on**: T1
**Reuses**: `describeTool` (`shared/activity.ts:650`); leitura por `node:fs` e `node:sqlite` (sem binário externo)
**Requirement**: CPOC-22, CPOC-23

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `classifyTranscript(path)` devolve `'json' | 'jsonl' | 'sqlite' | 'opaco'` (sniff dos primeiros bytes; SQLite por `SQLite format 3\0`)
- [ ] `inspectTranscript(path)` lista chaves/contagens (json/jsonl) ou tabelas+contagens (`node:sqlite`), sem lançar em formato opaco
- [ ] `parseCursorTranscriptLine(line)` mapeia linha reconhecida para `{ activities, role? }` (com `kind` e `label`); linha desconhecida → vazio, sem lançar
- [ ] `server/sources/cursor/transcript.test.ts` cobre classificação dos 4 formatos, contagens/roles de JSONL, tabelas de um SQLite sintético, linha de fixture → `Activity` e linha desconhecida sem exceção
- [ ] Gate check passes: `npx vitest run server/sources/cursor`
- [ ] Test count: 8+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): esqueleto de parser e inspetor do transcript`

---

### T10: CLI do harness — base e subcomando `transcript`

**What**: Criar `scripts/cursor-poc.ts` com a base de argumentos e o subcomando `transcript --path <arquivo>` (classifica, lista campos/tabelas; arquivo inexistente → erro + saída ≠ 0).
**Where**: `scripts/cursor-poc.ts`
**Depends on**: T9
**Reuses**: `inspectTranscript`/`classifyTranscript` (T9); helpers de caminho de `scripts/statusline-install.ts`
**Requirement**: CPOC-18, CPOC-19, CPOC-20, CPOC-21

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `tsx scripts/cursor-poc.ts transcript --path <f>` imprime a classificação e as chaves/tabelas observadas com contagens
- [ ] JSONL reporta nº de linhas, papéis distintos e presença de campos de tool-call; SQLite lista tabelas e contagens sem binário externo
- [ ] `--path` inexistente → mensagem clara e `process.exitCode !== 0`; `--help`/sem subcomando → uso, saída 0
- [ ] `server/test/cursor-poc.test.ts` (novo) spawna o script (`tsx`) sobre fixtures `jsonl`/`json`/SQLite sintéticos e o caminho inexistente, conferindo a saída e o código
- [ ] Gate check passes: `npm test`
- [ ] Test count: 5+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): CLI do harness com o subcomando transcript`

---

### Phase 4: Cobertura de hooks (POC P1)

### T11: Hook de captura "log tudo"

**What**: Criar `mod/habblaud-cursor/poc-hook.mjs`: lê o stdin e anexa `{ts, dir, event}` (JSONL) ao diretório de captura (inclui `transcript_path` e o dump do stdin); sempre sai `0`.
**Where**: `mod/habblaud-cursor/poc-hook.mjs`
**Depends on**: None
**Reuses**: `readStdin`/saída silenciosa de `mod/habblaud-codex/hook.mjs`
**Requirement**: CPOC-12, CPOC-17

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Recebe um JSON no stdin e anexa uma linha `{ts, dir, event}` no diretório de captura (padrão `~/.habblaud/cursor-poc/`, override `HABBLAUD_CURSOR_POC_DIR`)
- [ ] Evento com `transcript_path`: o valor e o dump do stdin são gravados no diretório de captura
- [ ] stdin inválido/não-JSON → sai `0` sem escrever nada
- [ ] `server/test/cursor-poc.test.ts` cobre a captura (HOME falso), o dump do transcript e o stdin inválido, rodando o hook como processo
- [ ] Gate check passes: `npm test`
- [ ] Test count: 4+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): hook de captura log-tudo da POC P1`

---

### T12: Subcomandos `install`/`uninstall`/`report` do harness

**What**: Estender `scripts/cursor-poc.ts` com os subcomandos `install`/`uninstall` (merge idempotente de `~/.cursor/hooks.json` com backup) e `report` (matriz "evento → dispara? (contagem) → campos").
**Where**: `scripts/cursor-poc.ts`
**Depends on**: T10, T11
**Reuses**: `readSettings`/`writeSettings`/`quotePath`/`tildify` (`scripts/statusline-install.ts`); comando do `poc-hook.mjs` (T11)
**Requirement**: CPOC-11, CPOC-13, CPOC-14, CPOC-15, CPOC-16

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `install` grava/mergeia os hooks do harness em `~/.cursor/hooks.json` (ou `<projeto>/.cursor/hooks.json` com `--project`), preserva os hooks existentes e faz backup do arquivo anterior; `hooks.json` ausente → cria `{"version":1,"hooks":{}}`; rodar 2× é idempotente
- [ ] `uninstall` remove só os hooks do harness, preservando os demais
- [ ] `report` lê o diretório de captura e imprime a matriz Markdown "evento → dispara? (contagem) → campos"; diretório vazio → mensagem explicativa e código `0`
- [ ] `server/test/cursor-poc.test.ts` cobre install (criação/merge/backup/idempotência), uninstall e report (matriz + diretório vazio), com HOME falso
- [ ] Gate check passes: `npm test`
- [ ] Test count: 8+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): install/uninstall/report do harness de hooks`

---

### Phase 5: Bloqueio do hook de decisão (POC P2)

### T13: Guardar o registro de permissões por provedor (cursor)

**What**: Estender `PermissionRegistry` para aceitar `provider: 'cursor'` (parse, resolução do agente por `conversation_id`, recusa de `interrupt`/"sempre permitir") com o comportamento **guardado por provider**, sem regressão de Claude/Codex.
**Where**: `server/permissions/registry.ts`
**Depends on**: T1
**Reuses**: `parseHookInput` (`:257`), `unsupportedByCodex` (`:166`→generalizar), `register` (`:383`), `resolveCodexAgent` (`:573`), `codexToolView` (`server/permissions/codex.ts`); rotas `server/permissions/http.ts`
**Requirement**: CPOC-24, CPOC-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `parseHookInput` aceita `provider: 'cursor'` mantendo o shape de `PermissionRequestInfo`
- [ ] `register` resolve o agente do Cursor pelo `conversation_id` (`session_id`) e monta título/resumo pela tradução de ferramenta do Cursor; `interrupt` e sugestão são `unsupported` para `cursor` (como para `codex`)
- [ ] Snapshots/decisões/expiração/esquecimento continuam idênticos para `claude` e `codex` (nenhuma mudança de comportamento fora da guarda `provider === 'cursor'`)
- [ ] `server/permissions/cursor.test.ts` (novo) cobre registrar/decidir/expirar `cursor` e a recusa de `interrupt`/sugestão; `server/permissions/registry.test.ts` e `server/permissions/codex.test.ts` continuam verdes
- [ ] Gate check passes: `npm test`
- [ ] Test count: 6+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): registrar pedidos do Cursor no PermissionRegistry`

---

### T14: Hook de decisão e observação do Cursor

**What**: Criar `mod/habblaud-cursor/hook.mjs`: observa eventos em `POST /api/cursor/events` e, nos eventos `before*Execution`/`preToolUse`, registra em `POST /api/permissions` (`provider:'cursor'`) e faz long-poll; imprime `{"permission":"allow"|"deny"}` flat. Nunca lança.
**Where**: `mod/habblaud-cursor/hook.mjs`
**Depends on**: T6, T7, T13
**Reuses**: estrutura `run`/`call`/`readStdin`/`decisionOutput` de `mod/habblaud-codex/hook.mjs`; config em `~/.habblaud/cursor-hook.json` (`{port, decisionTimeoutS}`)
**Requirement**: CPOC-24, CPOC-25, CPOC-26, CPOC-27

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Evento de observação → `POST /api/cursor/events`, nada no stdout, sai `0`
- [ ] `beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`/`preToolUse` → registra com `provider:'cursor'` e espera; `allow`/`deny` → `{"permission":"allow"|"deny"}` (+ `user_message` no deny) no stdout e saída `0`
- [ ] Tempo esgotado ou Habblaud fora do ar → sai `0` sem imprimir decisão; stdin inválido → sai `0` sem escrever
- [ ] Nenhuma exceção não tratada (rede de segurança de saída `0`)
- [ ] `server/test/cursor-hook.test.ts` (novo) e a extensão de `server/test/permission-server.ts` (`cursor: true`) cobrem observação, allow, deny, tempo esgotado, fonte fora do ar e stdin inválido, rodando o hook como processo
- [ ] Gate check passes: `npm test`
- [ ] Test count: 8+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): hook de decisão e observação`

---

### T15: Instalador dos hooks reais do Cursor

**What**: Criar `scripts/cursor-install.ts` (`install`/`uninstall`/`status`) que grava o `hook.mjs` real em `~/.cursor/hooks.json` (ou no projeto com `--project`), com merge, backup e idempotência.
**Where**: `scripts/cursor-install.ts`
**Depends on**: T14
**Reuses**: `scripts/codex-install.ts` (`planInstall`/`planUninstall`/`installState`), `readSettings`/`writeSettings`/`quotePath`/`tildify` (`scripts/statusline-install.ts`); formato plano `{"version":1,"hooks":{"<evento>":[…]}}`
**Requirement**: CPOC-24

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `install` acrescenta o comando do `hook.mjs` aos eventos tratados, preservando hooks alheios, na mesma posição, com backup; idempotente
- [ ] `uninstall` remove só os nossos handlers; `status` informa instalado/ausente
- [ ] `hooks.json` ausente é criado; arquivo quebrado não é destruído sem backup
- [ ] `server/test/cursor-install.test.ts` (novo) cobre as funções puras e o comando de verdade sobre `HOME`/`hooks.json` falsos (merge, backup, idempotência, uninstall, status)
- [ ] Gate check passes: `npm test`
- [ ] Test count: 8+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): instalador dos hooks reais em hooks.json`

---

### T16: Harness de bloqueio (subcomando `decision`)

**What**: Estender `scripts/cursor-poc.ts` com o subcomando `decision`: sobe um stub de `POST /api/permissions` + `GET /:id/wait` que segura `N` s, roda o `hook.mjs` com um `beforeShellExecution` sintético e reporta o tempo de bloqueio e o limite seguro observado.
**Where**: `scripts/cursor-poc.ts`
**Depends on**: T14
**Reuses**: `server/test/permission-server.ts` como referência do stub; o `hook.mjs` (T14)
**Requirement**: CPOC-28, CPOC-29

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `decision --hold <N>` mede e reporta que o hook bloqueou ~`N` s e aplicou a decisão (`{permission}`)
- [ ] Se `N` excede o limite seguro configurado, reporta o limite seguro observado e sai com código ≠ 0
- [ ] `server/test/cursor-poc.test.ts` cobre o caminho feliz (bloqueio medido + decisão aplicada) e o excesso do limite
- [ ] Gate check passes: `npm test`
- [ ] Test count: 4+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): harness de medição do bloqueio de decisão`

---

### Phase 6: Registro e runbook

### T17: Registrar os scripts no typecheck e no npm

**What**: Incluir `scripts/cursor-install.ts` e `scripts/cursor-poc.ts` no `server/tsconfig.json` e adicionar os scripts npm `cursor:install|uninstall|status` e `cursor:poc:install|uninstall|report|transcript|decision`.
**Where**: `server/tsconfig.json`, `package.json`
**Depends on**: T10, T12, T15, T16
**Reuses**: bloco `include` de `server/tsconfig.json` e o bloco `scripts` de `package.json` (padrão `codex:*`)
**Requirement**: CPOC-07, CPOC-11

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Os dois scripts novos aparecem no `include` de `server/tsconfig.json` e são verificados por `npm run typecheck`
- [ ] `package.json` expõe `cursor:install|uninstall|status` e `cursor:poc:install|uninstall|report|transcript|decision` via `tsx`
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `build(cursor): registrar scripts no typecheck e no npm`

---

### T18: Runbook único das POCs P0–P3

**What**: Escrever o runbook que executa P0–P3 numa máquina com Cursor e devolve os relatórios de cada POC (cobertura, transcript, bloqueio e ingest).
**Where**: `docs/analise/08-runbook-poc-cursor.md`
**Depends on**: T17
**Reuses**: comandos `cursor:*`/`cursor:poc:*` (T17); achados/entregas de `docs/analise/07-poc-priorizados.md`
**Requirement**: Success Criteria (runbook único)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Passo a passo: instalar hooks do harness, coletar eventos, gerar matriz (P1), inspecionar transcript (P0), instalar hook real e medir bloqueio (P2) e validar a ingest no escritório (P3)
- [ ] Cada POC tem o comando exato, a evidência esperada e o critério de sucesso/falha
- [ ] Gate check passes: `npm run typecheck`

**Tests**: none
**Gate**: build

**Commit**: `docs(cursor): runbook das POCs P0-P3`

---

## Phase Execution Map

Phases run in sequence; tasks within a phase run in order. Arrows mirror the `Depends on` fields exactly (cross-phase dependencies are omitted from the per-phase diagrams and are validated by the cross-check table below).

| Phase | Ordem / dependências |
| ----- | -------------------- |
| 1 | T1, T2 (independentes) |
| 2 | T3 → T5 → T8; T4 → T5; T3 → T6 → T7 → T8 |
| 3 | T9 → T10 |
| 4 | T11 → T12 |
| 5 | T13 → T14 → T15; T14 → T16 |
| 6 | T17 → T18 |

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Provider + 2 Records | 1 conceito (protocolo), 3 arquivos por ripple de compilação | ⚠️ Coeso — merge obrigatório: a união e os dois `Record<Provider, …>` exaustivos quebram o `typecheck` se separados (ver Risks & Concerns do design) |
| T2: Flag de config | 1 arquivo, 1 flag | ✅ Granular |
| T3: Interface `CursorLive` | 1 arquivo, 1 contrato | ✅ Granular |
| T4: Normalizador/rollout | 1 arquivo, funções coesas | ✅ Granular |
| T5: `CursorSource` | 1 arquivo (classe da fonte) | ✅ Granular |
| T6: `server/cursor/http.ts` | 1 arquivo, 1 rota | ✅ Granular |
| T7: Rota em `app.ts` | 1 arquivo, 1 rota + health | ✅ Granular |
| T8: Wiring em `index.ts` | 1 arquivo | ✅ Granular |
| T9: `transcript.ts` | 1 arquivo (esqueleto P0) | ✅ Granular |
| T10: CLI base + `transcript` | 1 arquivo, 1 subcomando | ✅ Granular |
| T11: `poc-hook.mjs` | 1 arquivo | ✅ Granular |
| T12: `install`/`uninstall`/`report` | 1 arquivo, conjunto coeso do harness | ✅ Granular |
| T13: `registry.ts` (provider cursor) | 1 arquivo, guarda por provider | ✅ Granular |
| T14: `hook.mjs` | 1 arquivo | ✅ Granular |
| T15: `cursor-install.ts` | 1 arquivo | ✅ Granular |
| T16: `decision` | 1 arquivo, 1 subcomando | ✅ Granular |
| T17: tsconfig + package.json | 1 conceito (registro), 2 arquivos coesos | ⚠️ Coeso — o registro do typecheck e do npm não se separa sem deixar o outro quebrado |
| T18: Runbook | 1 arquivo | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | (sem seta) | ✅ Match |
| T2 | None | (sem seta) | ✅ Match |
| T3 | T1 | T3 (cross-phase, omitida) | ✅ Match |
| T4 | T1 | T4 (cross-phase, omitida) | ✅ Match |
| T5 | T3, T4 | T3 → T5, T4 → T5 | ✅ Match |
| T6 | T3 | T3 → T6 | ✅ Match |
| T7 | T6 | T6 → T7 | ✅ Match |
| T8 | T2, T5, T7 | T5 → T8, T7 → T8 (T2 cross-phase) | ✅ Match |
| T9 | T1 | T9 (cross-phase, omitida) | ✅ Match |
| T10 | T9 | T9 → T10 | ✅ Match |
| T11 | None | (sem seta) | ✅ Match |
| T12 | T10, T11 | T11 → T12 (T10 cross-phase) | ✅ Match |
| T13 | T1 | T13 (cross-phase, omitida) | ✅ Match |
| T14 | T6, T7, T13 | T13 → T14 (T6/T7 cross-phase) | ✅ Match |
| T15 | T14 | T14 → T15 | ✅ Match |
| T16 | T14 | T14 → T16 | ✅ Match |
| T17 | T10, T12, T15, T16 | T17 (todas cross-phase) | ✅ Match |
| T18 | T17 | T17 → T18 | ✅ Match |

Nenhuma dependência aponta para frente (toda dependência aponta para trás ou dentro da mesma fase).

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1 | Protocolo + lógica pura do cliente | none / unit | unit | ✅ OK |
| T2 | Configuração | unit | unit | ✅ OK |
| T3 | Contrato (`live.ts`) | none | none | ✅ OK |
| T4 | Fonte/normalizadores | unit + integration | unit | ✅ OK (unit cobre 1:1; integração em T5) |
| T5 | Fonte de agentes | unit + integration | integration | ✅ OK |
| T6 | Rota de ingest | integration | integration | ✅ OK |
| T7 | Rota de ingest | integration | integration | ✅ OK |
| T8 | Wiring (sem camada de teste no repo) | none | none | ✅ OK |
| T9 | Fonte/normalizadores | unit + integration | unit | ✅ OK |
| T10 | Scripts/instaladores | unit + integration | integration | ✅ OK |
| T11 | Hook (mod) | integration | integration | ✅ OK |
| T12 | Scripts/instaladores | unit + integration | integration | ✅ OK |
| T13 | Registro de permissões | unit + integration | integration | ✅ OK |
| T14 | Hook (mod) | integration | integration | ✅ OK |
| T15 | Scripts/instaladores | unit + integration | integration | ✅ OK |
| T16 | Scripts/instaladores | unit + integration | integration | ✅ OK |
| T17 | Config/build | none | none | ✅ OK |
| T18 | Documentação | none | none | ✅ OK |

---

## Tips

- **Ordem = POCs**: a Fase 2 (P3, MVP) destrava a Fase 1; P0 (Fase 3), P1 (Fase 4) e P2 (Fase 5) entregam os harnesses e relatórios.
- **Reuses = economia**: sempre partir de `server/sources/codex/*`, `server/codex/http.ts`, `mod/habblaud-codex/hook.mjs` e `scripts/codex-install.ts`.
- **Ripple de compilação**: só o membro novo na união `Provider` (T1) exige tocar os dois `Record<Provider, …>`; nenhuma outra task depende disso.
- **Um commit por task**, com a mensagem planejada; PT-BR no código e nos comentários.
- **Push/PR só com go-ahead explícito** (blast radius).
