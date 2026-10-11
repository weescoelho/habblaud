# Fluxo de permissões do Cursor Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/cursor-permissoes/design.md`
**Spec**: `.specs/features/cursor-permissoes/spec.md`
**Status**: Implementing

---

## Test Coverage Matrix

> Generated from the codebase (`vitest.config.ts`, `package.json`, `server/README.md`, `server/tsconfig.json`) and the spec - confirm before Execute. Guidelines found: nenhum `AGENTS.md`/`CONTRIBUTING.md` dedicado; segue a convenção do repositório: **vitest colocalizado** (`server/**/*.test.ts`, `client/src/**/*.test.ts`) e o **hook do Cursor rodado como processo real** em `server/test/` com um `HOME`/diretório temporário (`server/test/cursor-hook.test.ts`). A matriz é um **piso**, não teto.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Política local (`mod/habblaud-cursor/policy.mjs`) | unit | 1:1 aos ACs `CPERM-03/05/06/07/08`: eventos padrão/override, `deny`> `allow`, regex inválida descartada, política ausente | `server/test/cursor-policy.test.ts` | `npx vitest run server/test/cursor-policy.test.ts` |
| Hook do Cursor (`mod/habblaud-cursor/hook.mjs`, processo real) | integration | observação sem pedido; decisão por regra **sem** rede; `decisionEvents` reativa `beforeReadFile`; contrato do `suggest_rule`; stdin inválido | `server/test/cursor-hook.test.ts` | `npm test` |
| Regras locais (`server/permissions/cursor-rules.ts`) | unit | `read/add/write`: dedupe, regra inválida descartada, JSON malformado tolerado, teto de regras, escrita atômica | `server/permissions/cursor-rules.test.ts` | `npx vitest run server/permissions/cursor-rules.test.ts` |
| Registro de permissões (`server/permissions/registry.ts`) | unit | sugestão própria do Cursor; `decide` com `suggestion` persiste; `codex` segue `unsupported`; `interrupt` recusado no Cursor; sem `suggest_rule` = sem sugestão | `server/permissions/registry.test.ts` | `npx vitest run server/permissions/registry.test.ts` |
| Cartão do cliente (`client/src/ui/permission.ts`) | unit | rótulo do destino `habblaud`; ramo `cursor`: `always` com sugestão, `interrupt: false` | `client/src/ui/permission.test.ts` | `npx vitest run client/src/ui/permission.test.ts` |
| Instalador (`scripts/cursor-install.ts`) | unit | `status` relata eventos de decisão (config ou padrão), nº de regras e nº de decisões locais; ausência = padrão | `server/test/cursor-install.test.ts` | `npx vitest run server/test/cursor-install.test.ts` |
| Fiação do servidor (`server/index.ts`) | none | - (gate de build cobre) | - | build gate |
| Documentação (runbook, análise) | none | - (gate de build cobre) | - | build gate |

## Gate Check Commands

> Generated from the codebase (`package.json`) - confirm before Execute. O repositório não separa unit/e2e: há **um** runner (vitest). O gate "full" roda a suíte inteira; o "quick" roda o arquivo da task.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Depois de tasks cujo teste é um arquivo só | `npx vitest run <arquivo de teste da task>` |
| Full | Depois de tasks de integração (hook como processo real) ou que tocam o cliente | `npm test` |
| Build | Fim de fase ou task só de fiação/config/docs | `npm run typecheck && npm test && npm run build` |

---

## Execution Plan

As fases rodam em sequência; as tasks de cada fase rodam em ordem. Os diagramas listam **apenas** as dependências reais (`Depends on`) **dentro** da fase (as dependências entre fases — `T7`←`T3`, `T8`←`T2/T4/T7`, `T9`←`T8` — são validadas pelo grafo de fases).

### Phase 1: Política local do hook (P1)

```
T1 → T2
```

### Phase 2: "Permitir sempre" pelo escritório (P2)

```
T3 → T4 → T5
T4 → T6
```

### Phase 3: Status do instalador (P2)

```
T7
```

### Phase 4: Registro e roteiro

```
T8 → T9
```

---

## Task Breakdown

### Phase 1: Política local do hook (P1)

### T1: Módulo de política local `policy.mjs`

**What**: Criar `mod/habblaud-cursor/policy.mjs` (Node puro, sem rede, sem dependências): `DEFAULT_DECISION_EVENTS`, `decisionEventsOf`, `rulesOf`, `subjectOf`, `matchRule`, `deriveRule`, `ruleText`, `allowOutput`/`denyOutput`.
**Where**: `mod/habblaud-cursor/policy.mjs`
**Depends on**: None
**Reuses**: os aliases de `toolNameOf`/`toolInputOf` (`mod/habblaud-cursor/hook.mjs:92`/`:109`) como base de `subjectOf`
**Requirement**: CPERM-03, CPERM-05, CPERM-06, CPERM-07, CPERM-08

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `decisionEventsOf` devolve `{beforeShellExecution, beforeMCPExecution}` sem config e o array de `decisionEvents` quando ele é válido (nomes desconhecidos descartados; vazio = padrão)
- [x] `matchRule` casa por ferramenta + sujeito (`Shell`→`command`, `Read`→`file_path`, MCP→nome, resto→JSON), aplica `deny` > `allow`, ignora regex inválida e regra malformada
- [x] `deriveRule` devolve a regra de prefixo ancorado (`^…(\s|$)`) e `undefined` sem sujeito; `ruleText` gera `Shell(npm test)`
- [x] `server/test/cursor-policy.test.ts` cobre: padrão de eventos; override por config; allow; deny; 2 regras → deny; regex inválida; política ausente; `deriveRule` com e sem sujeito
- [x] Gate check passes: `npx vitest run server/test/cursor-policy.test.ts`
- [x] Test count: 8+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): modulo de politica local do hook de permissoes`

---

### T2: Aplicar a política e oferecer a regra no `hook.mjs`

**What**: Usar a política no hook: trocar `DECISION` por `decisionEventsOf(cfg)`; avaliar `matchRule` **antes** do `POST /api/cursor/events` (casa → imprime a decisão nativa, registra a decisão local e sai sem rede); acrescentar `suggest_rule: deriveRule(...)` ao `permissionBody` quando derivável.
**Where**: `mod/habblaud-cursor/hook.mjs`
**Depends on**: T1
**Reuses**: `run`/`readConfig`/`call`/`decisionOutput`/`permissionBody`/`trimInput` inteiros
**Requirement**: CPERM-01, CPERM-02, CPERM-04, CPERM-09, CPERM-11, CPERM-17, CPERM-18

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `preToolUse`/`beforeReadFile` (observação) só geram `POST /api/cursor/events` — nenhum `POST /api/permissions`, stdout vazio, exit `0`
- [x] Com `decisionEvents` reativando `beforeReadFile`, o pedido volta a ser registrado (degradação graciosa)
- [x] Com uma regra `allow`/`deny` na política, o hook imprime a decisão nativa e **não** faz nenhuma requisição; grava a decisão em `~/.habblaud/cursor-decisions.jsonl` (best-effort)
- [x] Um evento de decisão sem `conversation_id`/ferramenta sai `0`; o pedido registrado carrega `suggest_rule` derivado (e nada quando não dá para derivar)
- [x] `server/test/cursor-hook.test.ts` cobre os casos acima (hook como processo real)
- [x] Gate check passes: `npm test`
- [x] Test count: 12+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full

**Commit**: `feat(cursor): hook aplica politica local e sugere regra`

---

### Phase 2: "Permitir sempre" pelo escritório (P2)

### T3: Regras locais `cursor-rules.ts`

**What**: Criar `server/permissions/cursor-rules.ts`: `CursorRule`, `cursorConfigPath`, `readCursorConfig` (nunca lança), `addCursorRule` (pura, sem duplicar), `writeCursorRule` (lê+mescla+grava com temp+rename).
**Where**: `server/permissions/cursor-rules.ts`
**Depends on**: None
**Reuses**: o formato do arquivo que o hook lê (`mod/habblaud-cursor/hook.mjs:129`, `:35`)
**Requirement**: CPERM-13, CPERM-14

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `readCursorConfig` devolve `{decisionEvents?, rules}` de um JSON válido e `{rules: []}` para ausente/malformado/sem permissão de leitura, sem lançar
- [x] `addCursorRule` não duplica `tool+pattern+effect` e respeita o teto; `writeCursorRule` preserva `port`/`decisionTimeoutS` e faz temp+rename
- [x] `server/permissions/cursor-rules.test.ts` (com `HOME`/diretório temporário) cobre: round-trip, dedupe, malformado, teto, escrita atômica (arquivo final íntegro)
- [x] Gate check passes: `npx vitest run server/permissions/cursor-rules.test.ts`
- [x] Test count: 6+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): leitura e escrita das regras locais de permissao`

---

### T4: Sugestão "sempre permitir" no `registry.ts`

**What**: No `PermissionRegistry`: parsear `suggest_rule` (validado, `effect` forçado `allow`), sintetizar `info.suggestions = [{index:0, rules:[ruleText], destination:'habblaud'}]` para pedidos do Cursor, aceitar `suggestion` do Cursor (seguindo recusando `interrupt`; `codex` inalterado) e chamar `opts.persistCursorRule(rule)` ao resolver `allow` com sugestão.
**Where**: `server/permissions/registry.ts`
**Depends on**: T3
**Reuses**: `parseHookInput`, `register`, `decide`, `resolve`, `addActivity`, `unsupportedByProvider` (`:178`); o tipo `CursorRule` de `./cursor-rules`
**Requirement**: CPERM-10, CPERM-11, CPERM-12, CPERM-14

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Um pedido `provider:'cursor'` com `suggest_rule` sai do `register` com uma sugestão `destination:'habblaud'` e o texto da regra; sem `suggest_rule`, sem sugestão
- [x] `decide` com `{behavior:'allow', suggestion:0}` num pedido do Cursor resolve `allow` e chama `persistCursorRule` **uma** vez com a regra do pedido; sem `suggestion` não chama
- [x] `codex` continua devolvendo `unsupported` para `suggestion` e `interrupt`; `cursor` devolve `unsupported` só para `interrupt`
- [x] `suggest_rule` inválido (tipo/tamanho) é descartado sem lançar
- [x] `server/permissions/registry.test.ts` cobre os casos acima
- [x] Gate check passes: `npx vitest run server/permissions/registry.test.ts`
- [x] Test count: 8+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): sempre permitir do cursor no registro de permissoes`

---

### T5: Fiação da persistência no `server/index.ts`

**What**: Passar `persistCursorRule` ao `PermissionRegistry`: chama `writeCursorRule(config.home, rule)` e, em falha, loga com `log.warnOnce` (a decisão `allow` daquele momento continua valendo).
**Where**: `server/index.ts`
**Depends on**: T4
**Reuses**: o bloco `new PermissionRegistry({...})` (`server/index.ts:131`); `log.warnOnce` (`:27`)
**Requirement**: CPERM-10

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `persistCursorRule` está plugado no `PermissionRegistry` usando `config.home`
- [x] Falha de escrita não derruba o servidor (loga e segue)
- [x] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): fiar a gravacao da regra de sempre permitir`

---

### T6: Cartão do Cursor no `permission.ts`

**What**: No cartão de permissão do cliente: acrescentar o destino `habblaud` ao mapa de rótulos e um ramo `cursor` no `permissionOptions` (`always` quando há sugestão, `interrupt: false`, sem motivo obrigatório).
**Where**: `client/src/ui/permission.ts`
**Depends on**: T4
**Reuses**: `DESTINATIONS`/`destinationLabel` (`:22`/`:30`), `permissionOptions` (`:62`), `KeyedList` de sugestões (`:254`)
**Requirement**: CPERM-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `destinationLabel('habblaud')` devolve um texto claro (ex.: "no Habblaud (regra local do Cursor)")
- [x] `permissionOptions({provider:'cursor', suggestions:[…]})` → `always: true`, `interrupt: false`, `reasonRequired: false`; sem sugestão → `always: false`
- [x] `client/src/ui/permission.test.ts` cobre o rótulo e o ramo `cursor`
- [x] Gate check passes: `npm test`
- [x] Test count: 2+ casos novos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: full

**Commit**: `feat(cursor): cartao de permissoes do cursor com sempre permitir`

---

### Phase 3: Status do instalador (P2)

### T7: `cursor:status` com eventos e regras

**What**: No `status` do instalador: relatar os eventos de decisão vigentes (config `decisionEvents` ou o padrão Shell/MCP), o nº de regras locais (`readCursorConfig`) e o nº de decisões locais (`~/.habblaud/cursor-decisions.jsonl`), sem alterar arquivos.
**Where**: `scripts/cursor-install.ts`
**Depends on**: T3
**Reuses**: o comando `status` (`:310`) e a linha da config (`:323`); `readCursorConfig` de `../server/permissions/cursor-rules`
**Requirement**: CPERM-16, CPERM-19

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `status` imprime os eventos de decisão (config ou padrão `beforeShellExecution`/`beforeMCPExecution`)
- [x] `status` imprime o nº de regras locais e o nº de decisões locais; nenhum arquivo é criado/alterado
- [x] `server/test/cursor-install.test.ts` cobre: com config (eventos+regras) e sem config (padrão, 0 regras)
- [x] Gate check passes: `npx vitest run server/test/cursor-install.test.ts`
- [x] Test count: 4+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): status mostra eventos de decisao e regras locais`

---

### Phase 4: Registro e roteiro

### T8: Runbook de permissões do Cursor

**What**: Criar `docs/analise/11-permissoes-cursor.md` (fork) documentando: a camada base (auto-run/allowlist nativo do Cursor, com o passo de configuração), o formato de `rules`, o fluxo de "sempre permitir", e os eventos que pedem decisão vs observação.
**Where**: `docs/analise/11-permissoes-cursor.md`
**Depends on**: T2, T4, T7
**Reuses**: o formato dos runbooks `docs/analise/08-runbook-poc-cursor.md` e `10-runbook-poc-cursor-p4-p8.md`
**Requirement**: CPERM-15, CPERM-13, CPERM-17

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] O runbook tem o passo de auto-run/allowlist do Cursor e deixa claro que o hook decide independentemente dele
- [x] O formato de `rules` e o efeito do "sempre permitir" estão documentados com um exemplo
- [x] Os eventos que pedem decisão (padrão e override por `decisionEvents`) estão listados
- [x] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `docs(cursor): runbook das permissoes do cursor`

---

### T9: Registrar a feature no roteiro (`06`)

**What**: Acrescentar ao faseamento de `docs/analise/06-arquitetura-proposta.md` (§6.8) uma linha/nota para esta feature (fluxo de permissão sem travar) apontando para `.specs/features/cursor-permissoes/`.
**Where**: `docs/analise/06-arquitetura-proposta.md`
**Depends on**: T8
**Reuses**: a tabela de §6.8 e a nota de §6.4 (limitação "sem `updatedPermissions`")
**Requirement**: CPERM-15

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] §6.8 ganha a fase/item do fluxo de permissão apontando para a feature
- [x] §6.4 deixa de dizer que "sempre permitir" é impossível no Cursor (passa a citar a emulação local)
- [x] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `docs(cursor): registrar as permissoes do cursor no roteiro`

---

## Phase Execution Map

Visual representation of task ordering. Phases run in sequence, and tasks within a phase run in order:

```
Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1:  T1 → T2
Phase 2:  T3 → T4 → T5
          T4 → T6
Phase 3:  T7
Phase 4:  T8 → T9
```

Dependências entre fases (validadas pelo grafo sequencial): `T7`←`T3`; `T8`←`T2`,`T4`,`T7`; `T9`←`T8`.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Módulo `policy.mjs` | 1 módulo (funções puras coesas) | ✅ Granular |
| T2: `hook.mjs` aplica política + `suggest_rule` | 1 arquivo | ✅ Granular |
| T3: `cursor-rules.ts` | 1 módulo | ✅ Granular |
| T4: `registry.ts` (Cursos) | 1 arquivo | ✅ Granular |
| T5: Fiação em `index.ts` | 1 arquivo | ✅ Granular |
| T6: `permission.ts` (cliente) | 1 arquivo | ✅ Granular |
| T7: `cursor-install.ts` status | 1 arquivo | ✅ Granular |
| T8: Runbook | 1 doc | ✅ Granular |
| T9: Ponteiro no `06` | 1 doc | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | — | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | None | — | ✅ Match |
| T4 | T3 | T3 → T4 | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |
| T6 | T4 | T4 → T6 | ✅ Match |
| T7 | T3 (fase anterior) | — (fase única) | ✅ Match |
| T8 | T2, T4, T7 (fases anteriores) | — (sem setas intra-fase) | ✅ Match |
| T9 | T8 | T8 → T9 | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1: `policy.mjs` | Política local | unit | unit | ✅ OK |
| T2: `hook.mjs` | Hook do Cursor (processo real) | integration | integration | ✅ OK |
| T3: `cursor-rules.ts` | Regras locais | unit | unit | ✅ OK |
| T4: `registry.ts` | Registro de permissões | unit | unit | ✅ OK |
| T5: `index.ts` | Fiação do servidor | none | none | ✅ OK |
| T6: `permission.ts` | Cartão do cliente | unit | unit | ✅ OK |
| T7: `cursor-install.ts` | Instalador | unit | unit | ✅ OK |
| T8: runbook | Documentação | none | none | ✅ OK |
| T9: `06` | Documentação | none | none | ✅ OK |

---

## Tips

- **Reduzir antes de automatizar**: T1+T2 já cortam o "parando o tempo todo"; T3–T7 fecham o "sempre permitir".
- **Contrato do `suggest_rule`**: T2 e T4 se encontram no `permissionBody`; o teste do hook confere o JSON e trava a fonte única do padrão.
- **Uma task, um commit**: nada de "já que estou aqui".
