# Subagentes, GitHub e histórico do Cursor Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/cursor-subagents-history/design.md`
**Spec**: `.specs/features/cursor-subagents-history/spec.md`
**Status**: Implementing

---

## Test Coverage Matrix

> Generated from the codebase (`vitest.config.ts`, `package.json`, `server/tsconfig.json`) and the spec - confirm before Execute. O repositório segue a convenção de **vitest colocalizado** (`server/**/*.test.ts`), com o `Office`/`AccountsService` de verdade nos testes da fonte (padrão de `cursor/source.test.ts`). Fixtures são **sintéticas** (nada de conversa real). A matriz é um **piso**, não teto.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Normalizador do Cursor (`cursor/rollout.ts`) | unit | 1:1 a `CSH-03/CSH-06`: campos de subagente (`subagent_id`/`subagent_type`/`task`/`parent_conversation_id` + camelCase), ausentes viram `undefined`; `statusBorder('subagentStart')='working'`/`'subagentStop'='idle'`, sem regredir os eventos atuais | `server/sources/cursor/rollout.test.ts` | `npx vitest run server/sources/cursor/rollout.test.ts` |
| Fonte do Cursor (`cursor/source.ts`) | unit | 1:1 a `CSH-01/02/04/05/07` (subagentes: Start cria, Stop entrega, órfão/sem id degrada, poll expira) e `CSH-08/11/13/20` (pump: `seekEnd`, transcript ausente degrada, presença por hook intacta) | `server/sources/cursor/source.test.ts` | `npx vitest run server/sources/cursor/source.test.ts` |
| Extração do transcript (`cursor/transcript.ts`) | unit | `CSH-10` (base): `cursorToolUses` extrai `{name,input}` de `content[].tool_use` e `tool_calls[]`; linha inválida/`turn_ended` = `[]`, sem lançar | `server/sources/cursor/transcript.test.ts` | `npx vitest run server/sources/cursor/transcript.test.ts` |
| GitHub do Cursor (`cursor/github.ts`) | unit | 1:1 a `CSH-09/10/12`: `Shell`→`Bash` via `githubCallOf`; fallback só-comando (`pr_create`/`pr_merge`/`push`) e travas `--dry-run`/`--delete`/`--auto`; com resultado delega a `detectGitHubResult`; MCP do GitHub segue normal | `server/sources/cursor/github.test.ts` | `npx vitest run server/sources/cursor/github.test.ts` |
| Histórico do Cursor (`cursor/history.ts`) | unit | 1:1 a `CSH-14/15/16/17/19`: varredura, campos de `RecentSession`, título do 1º prompt, `resolve` (200/400/404), candidato ilegível ignorado | `server/sources/cursor/history.test.ts` | `npx vitest run server/sources/cursor/history.test.ts` |
| Wiring do servidor (`server/index.ts`) | none | `CSH-18/21` (registro do `CursorHistory` só com `config.cursor`; despacho por conta coberto em `history.test.ts`) | - | build gate |
| Docs (roteiro `06`, `.specs/STATE.md`) | none | - (gate de build cobre) | - | build gate |

## Gate Check Commands

> Generated from the codebase (`package.json`) - confirm before Execute. O repositório não separa unit/e2e: há **um** runner (vitest). O gate "quick" roda o(s) arquivo(s) da task; o "full" roda a suíte inteira; o "build" é o fim de fase.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Tasks cujo teste é um arquivo só | `npx vitest run <arquivo de teste da task>` |
| Full | Task que toca o caminho de atividade usado pela fonte (rollout + source) | `npm test` |
| Build | Fim de fase ou task só de docs/wiring | `npm run typecheck && npm test && npm run build` |

---

## Execution Plan

As fases rodam em sequência; as tasks de cada fase rodam em ordem. Os diagramas listam **apenas** as dependências reais (`Depends on`) **dentro** da fase (as dependências entre fases — `T8`←`T2`,`T5`,`T7` — são validadas pelo grafo de fases).

### Phase 1: Subagentes do Cursor por hook (P1)

```
T1 → T2
```

### Phase 2: GitHub a partir do transcript do Cursor (P1)

```
T3 → T4 → T5
```

### Phase 3: Histórico do terminal do Cursor (P1)

```
T6 → T7
```

### Phase 4: Registro no roteiro e handoff (P2)

```
T8
```

---

## Task Breakdown

### Phase 1: Subagentes do Cursor por hook (P1)

### T1: Campos de subagente no `cursor/rollout.ts`

**What**: Acrescentar a `CursorEvent` os campos `subagentId?`, `subagentType?`, `subagentTask?` e `parentConversationId?` e lê-los no `parseCursorEvent` por aliases defensivos (`subagent_id`/`subagentId`, `subagent_type`/`subagentType`, `task`, `parent_conversation_id`/`parentConversationId`); ausentes ficam `undefined`. Mapear `subagentStart` → `working` e `subagentStop` → `idle` no `statusBorder`, sem alterar as bordas já tratadas.
**Where**: `server/sources/cursor/rollout.ts`
**Depends on**: None
**Reuses**: os helpers `firstStr`/aliases defensivos do próprio arquivo; o `switch` de `statusBorder`
**Requirement**: CSH-03, CSH-06

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] um evento com `subagent_id`/`subagent_type`/`task`/`parent_conversation_id` normaliza `subagentId`/`subagentType`/`subagentTask`/`parentConversationId`
- [x] aliases camelCase (`subagentId`, `subagentType`, `parentConversationId`) também são lidos; ausentes viram `undefined` (sem lançar)
- [x] `statusBorder('subagentStart')` → `working`; `statusBorder('subagentStop')` → `idle`; as bordas atuais (`sessionStart`, `stop`, `beforeShellExecution`…) não mudam
- [x] `server/sources/cursor/rollout.test.ts` cobre os casos acima
- [x] Gate check passes: `npx vitest run server/sources/cursor/rollout.test.ts`
- [x] Test count: 8+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): ler os campos de subagente dos eventos de hook`

---

### T2: Subagentes na `CursorSource`

**What**: Reconhecer `subagentStart`/`subagentStop` no `HOOK_EVENTS` e tratá-los num ramo próprio do `hookEvent`: chave do sub `<conta>:s:<subagentId>` (`kind:'sub'`) e `parentId` do principal (`<conta>:<parent_conversation_id>`, senão `<conta>:<conversation_id>`); Start cria via `office.addSub` (`role` do `subagent_type` capitalizado, fallback `Subagente (Cursor)`; `title` do `task`; `sessionId` do sub; `background:false`; `startedAt`), Stop entrega via `office.completeSub` e solta o tracker. Órfão (`Stop` sem `Start`) e Start sem `subagent_id`/pai degradam (no-op, sem criar sub quebrado, `return false`). `leave` fica sub-aware (`completeSub` em vez de `closeMain`) e `poll` completa o sub expirado; `sessionEnd` do principal solta os trackers de sub filhos.
**Where**: `server/sources/cursor/source.ts`
**Depends on**: T1
**Reuses**: `office.addSub`/`completeSub` (`office.ts:573`/`:610`), `reconcile`/`decide`/`leave`, `parseCursorEvent`/`statusBorder`
**Requirement**: CSH-01, CSH-02, CSH-04, CSH-05, CSH-07

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `subagentStart` com `subagent_id` e pai conhecido cria um agente `kind:'sub'`, `parentId` do principal, `role` do `subagent_type` e `title` do `task`, `status:'working'`
- [x] `subagentStop` casando o `subagent_id` completa o sub (`status:'done'`), sem tocar o principal
- [x] `subagentStop` sem `subagentStart` (órfão) e `subagentStart` sem `subagent_id`/pai são no-op (nenhum sub quebrado), sem lançar e com a sessão principal intacta
- [x] `subagentStart` sem `subagentStop` é completado no `poll()` depois de expirar a presença (não fica preso em `working`)
- [x] `sessionEnd` do principal encerra os subs filhos (via `closeMain`), e nenhum tracker de sub fica pendurado
- [x] `server/sources/cursor/source.test.ts` cobre os casos acima
- [x] Gate check passes: `npx vitest run server/sources/cursor/source.test.ts`
- [x] Test count: 20+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): tratar subagentes da IDE na fonte`

---

### Phase 2: GitHub a partir do transcript do Cursor (P1)

### T3: Extração reusável de `tool_use` em `cursor/transcript.ts`

**What**: Exportar `cursorToolUses(line)` (e o tipo do bloco `CursorToolUse { name; input }`) reusando `toolBlocks`/`blocksOf`, para que `cursor/github.ts` leia os `tool_use` de uma linha sem duplicar o parsing do schema. Linha inválida/`turn_ended` devolve `[]`, sem lançar.
**Where**: `server/sources/cursor/transcript.ts`
**Depends on**: None
**Reuses**: `parseJsonObject`/`toolBlocks`/`blocksOf` do próprio arquivo (fonte única da extração)
**Requirement**: CSH-10

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `cursorToolUses('{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"git push"}}]}}')` devolve `[{ name:'Shell', input:{ command:'git push' } }]`
- [x] o estilo OpenAI (`tool_calls:[{function:{name,arguments}}]`) também é extraído (aliases defensivos)
- [x] linha inválida, em branco ou `{"type":"turn_ended"}` devolve `[]`, sem lançar
- [x] `server/sources/cursor/transcript.test.ts` cobre os casos acima
- [x] Gate check passes: `npx vitest run server/sources/cursor/transcript.test.ts`
- [x] Test count: 6+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `refactor(cursor): expor a extracao de tool_use do transcript`

---

### T4: Detecção git/gh do transcript em `cursor/github.ts`

**What**: Criar `server/sources/cursor/github.ts` com `cursorGitHubCall(name, input)` (delega `Shell`→`Bash` a `githubCallOf`, senão repassa) e `cursorGitHubEvent(call, result?)`: com `result` presente usa `detectGitHubResult` (mesmas regras do Claude/Codex); sem `result` (o Cursor não grava `tool_result`), um fallback só-comando emite `pr_create`→`pr_opened`, `pr_merge`→`pr_merged` (respeitando `auto`) e `push`→`push` (respeitando `noPush`), completando `number`/`repo`/`branch` quando conhecidos e devolvendo `undefined` para CI/release (desfecho desconhecido). Nada de duplicar as regras do git/gh.
**Where**: `server/sources/cursor/github.ts`
**Depends on**: T3
**Reuses**: `githubCallOf` (`github.ts:235`), `detectGitHubResult` (`:454`), `GitHubCall`/`GitHubEvent`
**Requirement**: CSH-09, CSH-10, CSH-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `cursorGitHubCall('Shell', { command:'git push origin main' })` devolve uma `GitHubCall` de `Bash` com a op `push` (via `githubCallOf`)
- [x] `cursorGitHubCall('Shell', { command:'ls' })` e `cursorGitHubCall('Read', …)` devolvem `undefined`
- [x] sem resultado: `git push origin main` → `{ kind:'push' }`; `git push --dry-run`/`--delete` → `undefined`; `gh pr create --title x` → `pr_opened`; `gh pr merge 12` → `pr_merged` (com `number`); `gh pr merge --auto` → `undefined`
- [x] com resultado (um `result` que o `detectGitHubResult` entende) a decisão vem do resultado (ex.: `git push` que falhou **não** emite)
- [x] CI/release do Cursor (`gh run watch`, `gh release create`) devolvem `undefined` (desfecho desconhecido: fora do escopo)
- [x] `server/sources/cursor/github.test.ts` cobre os casos acima
- [x] Gate check passes: `npx vitest run server/sources/cursor/github.test.ts`
- [x] Test count: 10+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): detectar git/gh do transcript do cursor`

---

### T5: Pump do transcript na `CursorSource`

**What**: Dar `tail?`/`tailPath?` ao `CursorTracker` e, no `poll()`, bombear o `transcriptPath` de cada agente (já guardado na Fase 3): no primeiro attach (ou troca de caminho) criar um `FileTail` e fazer `seekEnd()` (só o que for escrito depois vira evento); ler as linhas novas, extrair `cursorToolUses`, converter com `cursorGitHubCall`/`cursorGitHubEvent` e emitir `office.githubEvent(t.key, ev, { key: githubEventKey(ev), at, live:true })`. Transcript ausente devolve `missing` (degrada, sem lançar); truncado/rotacionado (`reset`) faz `seekEnd()` sem reemitir o antigo. A presença/atividade por hook fica intacta.
**Where**: `server/sources/cursor/source.ts`
**Depends on**: T4
**Reuses**: `FileTail` (`tail.ts:25`, `seekEnd`/`read`), `cursorGitHubCall`/`cursorGitHubEvent` (`./github`), `cursorToolUses` (`./transcript`), `githubEventKey` (`shared/github.ts:73`), `office.githubEvent` (`office.ts:512`)
**Requirement**: CSH-08, CSH-11, CSH-13, CSH-20

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] a fonte lê o transcript de forma incremental: um `tool_use` `Shell{command:'git push origin main'}` escrito **depois** do attach gera, no `poll()`, uma atividade `tool:'GitHub'` no agente
- [ ] conteúdo pré-existente no attach **não** gera evento (`seekEnd()`), mas um `poll()` sobre a linha nova gera
- [ ] sem `transcript_path`, `poll()` não lança e a presença/atividade por hook segue igual
- [ ] transcript ausente/opaco não lança; um transcript truncado (`reset`) recomeça do fim sem reemitir o antigo
- [ ] `server/sources/cursor/source.test.ts` cobre os casos acima
- [ ] Gate check passes: `npm test`
- [ ] Test count: 24+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: full

**Commit**: `feat(cursor): bombear o transcript p/ os eventos do github`

---

### Phase 3: Histórico do terminal do Cursor (P1)

### T6: `CursorHistory` em `cursor/history.ts`

**What**: Criar `server/sources/cursor/history.ts` (`CursorHistory implements HistoryProvider`, `provider='cursor'`): `list()` varre `~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl` modificados na janela e devolve `RecentSession[]` com `account:'cursor'`, `provider:'cursor'`, `sessionId` = id da pasta, `projectDir` = slug do projeto, `lastAt`/`firstAt` do mtime (o transcript não tem horário), `size`, `open`/`agentId` via `openAgentOf` e `title` = primeiro prompt lido com `createCursorTerminalParser` (cache por mtime+tamanho; candidato ilegível é ignorado com `warnOnce`). `resolve(account, sessionId)` valida o id (`[A-Za-z0-9_-]`) → 400, acha a conta → 404 e devolve `{ path, createParser: createCursorTerminalParser }` com o arquivo real dentro da pasta da conta (nunca lança).
**Where**: `server/sources/cursor/history.ts`
**Depends on**: None
**Reuses**: `HistoryProvider` (`source.ts:138`), `HISTORY_LIMIT`/`HISTORY_MAX_AGE_MS` (`history.ts`), `openMainAgent` (`history.ts:78`), `createCursorTerminalParser` (`cursor/terminal.ts:178`), `mapLimit`/cache da forma do `CodexHistory`
**Requirement**: CSH-14, CSH-15, CSH-16, CSH-17, CSH-19

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `list()` devolve a sessão com `account:'cursor'`, `provider:'cursor'`, `sessionId`, `projectDir`, `lastAt`/`firstAt` do mtime, `size` e `open:false` (sem agente aberto)
- [ ] `title` sai do primeiro prompt via `createCursorTerminalParser`; um transcript sem prompt não inventa título
- [ ] `resolve('cursor', id)` devolve `path` e um `createParser` novo por chamada; `resolve('cursor','../etc')` → 400; `resolve('outra', id)` → 404; nada lança
- [ ] um projeto/transcript ilegível dentro da janela é ignorado sem derrubar a listagem
- [ ] `server/sources/cursor/history.test.ts` cobre os casos acima
- [ ] Gate check passes: `npx vitest run server/sources/cursor/history.test.ts`
- [ ] Test count: 10+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): historico do terminal a partir dos transcripts`

---

### T7: Registro do `CursorHistory` no `HistorySet`

**What**: No boot do servidor, quando `history` existe e o Cursor está ligado (`config.cursor`), registrar `history.add(new CursorHistory({ accounts: () => accounts.entriesOf('cursor'), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) }))`, ao lado do registro do Codex. Desligar o Cursor (ou o terminal) mantém Claude/Codex inalterados.
**Where**: `server/index.ts`
**Depends on**: T6
**Reuses**: `HistorySet.add` (`source.ts:159`), `accounts.entriesOf('cursor')` (`accounts/service.ts:202`), `openMainAgent` (`history.ts:78`)
**Requirement**: CSH-18, CSH-21

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] com `config.cursor`, o `HistorySet` recebe o `CursorHistory` e a conta `'cursor'` é despachada para ele
- [ ] sem `config.cursor` (ou sem terminal), nada é registrado e o histórico de Claude/Codex segue igual
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `feat(cursor): registrar o historico do cursor no servidor`

---

### Phase 4: Registro no roteiro e handoff (P2)

### T8: Registrar a Fase 4 no roteiro e o handoff

**What**: Acrescentar ao faseamento de `docs/analise/06-arquitetura-proposta.md` (§6.8) uma nota da Fase 4 (subagentes por hook, GitHub pelo transcript e histórico do terminal) apontando para `.specs/features/cursor-subagents-history/`, e atualizar o Handoff de `.specs/STATE.md` com o resultado — inclusive a limitação: sem `tool_result` no transcript, a detecção de `git push`/`gh pr create`/`gh pr merge` é só-comando e **não confirma sucesso** (possível falso positivo, v1).
**Where**: `docs/analise/06-arquitetura-proposta.md`
**Depends on**: T2, T5, T7
**Reuses**: a tabela de §6.8 e a nota da Fase 3 (mesmo formato); o Handoff de `.specs/STATE.md`
**Requirement**: CSH-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] §6.8 ganha a nota da Fase 4 apontando para `.specs/features/cursor-subagents-history/`
- [ ] o Handoff de `.specs/STATE.md` resume a feature e registra a limitação (sem `tool_result` → sem confirmação de sucesso)
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `docs(cursor): registrar subagentes, github e historico no roteiro`

---

## Phase Execution Map

Visual representation of task ordering. Phases run in sequence, and tasks within a phase run in order:

```
Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1:  T1 → T2
Phase 2:  T3 → T4 → T5
Phase 3:  T6 → T7
Phase 4:  T8
```

Dependências entre fases (validadas pelo grafo sequencial): `T2`←`T1`; `T4`←`T3`; `T5`←`T4`; `T7`←`T6`; `T8`←`T2`,`T5`,`T7`.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: `cursor/rollout.ts` (subagentes) | 1 arquivo | ✅ Granular |
| T2: `cursor/source.ts` (subagentes) | 1 arquivo | ✅ Granular |
| T3: `cursor/transcript.ts` (extração) | 1 arquivo | ✅ Granular |
| T4: `cursor/github.ts` (detecção) | 1 módulo novo | ✅ Granular |
| T5: `cursor/source.ts` (pump) | 1 arquivo | ✅ Granular |
| T6: `cursor/history.ts` (histórico) | 1 módulo novo | ✅ Granular |
| T7: `server/index.ts` (wiring) | 1 arquivo | ✅ Granular |
| T8: Roteiro + handoff | 1 doc (raiz) | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | — | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | None | — | ✅ Match |
| T4 | T3 | T3 → T4 | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |
| T6 | None | — | ✅ Match |
| T7 | T6 | T6 → T7 | ✅ Match |
| T8 | T2, T5, T7 (fases anteriores) | — (sem setas intra-fase) | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1: `cursor/rollout.ts` | Normalizador do Cursor | unit | unit | ✅ OK |
| T2: `cursor/source.ts` (subagentes) | Fonte do Cursor | unit | unit | ✅ OK |
| T3: `cursor/transcript.ts` (extração) | Extração do transcript | unit | unit | ✅ OK |
| T4: `cursor/github.ts` | GitHub do Cursor | unit | unit | ✅ OK |
| T5: `cursor/source.ts` (pump) | Fonte do Cursor | unit | unit | ✅ OK |
| T6: `cursor/history.ts` | Histórico do Cursor | unit | unit | ✅ OK |
| T7: `server/index.ts` (wiring) | Wiring do servidor | none | none | ✅ OK |
| T8: roteiro/handoff | Docs | none | none | ✅ OK |

---

## Tips

- **Um par por id**: o tracker do sub é a única memória; Start cria, Stop entrega, poll expira.
- **Nada de festa falsa**: `seekEnd` no 1º attach e as travas de `--dry-run`/`--delete`/`--auto`.
- **Não inventar**: sem `tool_result` não há desfecho — o fallback só-comando é a v1 documentada.
- **Uma task, um commit**: nada de "já que estou aqui".
