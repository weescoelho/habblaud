# Cursor POC P4–P8 Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/cursor-poc-p4-p8/design.md`
**Spec**: `.specs/features/cursor-poc-p4-p8/spec.md`
**Status**: Em execução (T1 ✅, T2 ✅, T3 ✅, T4 ✅, T5 ✅, T6 ✅, T7 ✅; T8 pendente)

---

## Test Coverage Matrix

> Generated from the codebase (`vitest.config.ts`, `package.json`, `server/README.md`) and the spec - confirm before Execute. Guidelines found: none dedicated (`AGENTS.md`/`CONTRIBUTING.md` absent); segue a convenção do repositório: vitest colocalizado, scripts do host testados em `server/test/` com `HOME`/diretórios falsos e, quando útil, processos de verdade. A matriz é um **piso**, não teto.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Harness CLI (`scripts/cursor-poc.ts`) | unit | cada subcomando: 1:1 aos ACs `CP48-*`; todo edge listado tem teste; nunca lança para dado estranho | `server/test/cursor-poc.test.ts` | `npx vitest run server/test/cursor-poc.test.ts` |
| Hook/probe (`mod/habblaud-cursor/*.mjs`, processo real) | integration | forma da saída, `stop` vs outro evento, stdin inválido | `server/test/cursor-poc.test.ts` | `npm test` |
| Documentação (runbook, análise) | none | - (gate de build cobre) | - | build gate |

## Gate Check Commands

> Generated from the codebase (`package.json`) - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Depois de tasks com testes unitários apenas | `npx vitest run server/test/cursor-poc.test.ts` |
| Full | Depois de tasks com testes de integração (processo de verdade) | `npm test` |
| Build | Fim de fase ou task só de config/docs | `npm run typecheck && npm test && npm run build` |

---

## Execution Plan

As fases rodam em sequência; as tasks de cada fase rodam em ordem. Os diagramas listam **apenas** as dependências reais (`Depends on`) **dentro** da fase (as dependências entre fases — `T7`←`T1..T6`, `T8`←`T7` — são validadas pelo próprio grafo de fases).

### Phase 1: Uso/plano (POC P8)

```
T1
```

### Phase 2: Subagentes (POC P4)

```
T2
```

### Phase 3: CLI headless (POC P5)

```
T3
```

### Phase 4: Injeção de mensagem (POC P6)

```
T4 → T5
```

### Phase 5: Histórico e efeitos (POC P7)

```
T6
```

### Phase 6: Registro e runbook

```
T7 → T8
```

---

## Task Breakdown

### Phase 1: Uso/plano (POC P8)

### T1: Subcomando `usage` do harness

**What**: Adicionar o subcomando `usage` (e `--path`) ao `scripts/cursor-poc.ts`: varre os locais candidatos do Cursor (`~/.cursor`, `~/.cursor-server`, `~/.config/Cursor`), **ignorando** `projects|skills|plugins|extensions|node_modules`, lista os candidatos a uso/plano (`usage|plan|limit|quota|billing|credit|ai-tracking|statsig|agent-cli-state|state.vscdb`) com caminho/tamanho/mtime, e descreve cada JSON (chaves de topo) e SQLite (tabelas+contagens). Nunca faz rede e nunca imprime valores. Registrar o script npm `cursor:poc:usage`.
**Where**: `scripts/cursor-poc.ts`
**Depends on**: None
**Reuses**: o padrão de `inspectSqlite`/`classifyTranscript` (`server/sources/cursor/transcript.ts:205`/`:99`); o `RunContext`/`run`/`parseArgs` do harness (`scripts/cursor-poc.ts:414`/`:430`/`:95`)
**Requirement**: CP48-01, CP48-02, CP48-03, CP48-04

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `scanUsage(root)`/`describeUsageFile(path)` (exportadas) listam candidatos e devolvem, para JSON, as chaves de topo; para SQLite, os nomes de tabela e as contagens
- [x] `usage --path <dir>` sobre um `HOME`/diretório temporário lista um `usage.json` e um `state.vscdb` sintético; sem candidatos → mensagem explicativa e saída `0`; arquivo ilegível não lança
- [x] `server/test/cursor-poc.test.ts` cobre: listagem+chaves JSON; tabelas SQLite; diretório inexistente (saída 0); arquivo ilegível
- [x] Gate check passes: `npx vitest run server/test/cursor-poc.test.ts`
- [x] Test count: 4+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick
**Status**: ✅ Complete

**Commit**: `feat(cursor): subcomando usage do harness (p8)`

---

### Phase 2: Subagentes (POC P4)

### T2: Subagentes — instalar hooks e correlacionar

**What**: Acrecentar `subagentStart`/`subagentStop` a `HARNESS_EVENTS` (correção de método: o harness nunca os instalou) e adicionar o subcomando `subagents`, que lê o diretório de captura e correlaciona `Start`↔`Stop` por `subagent_id`/`conversation_id`, reportando pares (com `parent_conversation_id`) e órfãos; sem eventos → "não observado" e saída `0`. Registrar o script npm `cursor:poc:subagents`.
**Where**: `scripts/cursor-poc.ts`
**Depends on**: None
**Reuses**: `readCapturedEvents`/`captureDirOf` (`scripts/cursor-poc.ts:247`/`:235`); `parseCursorEvent` (`server/sources/cursor/rollout.ts:65`)
**Requirement**: CP48-05, CP48-06, CP48-07, CP48-08, CP48-09

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `HARNESS_EVENTS` inclui `subagentStart`/`subagentStop`; `install` passa a gravá-los (teste confirma os 17 eventos no `hooks.json`)
- [x] `correlateSubagents(events)` casa Start↔Stop pelo id, marca órfão quando falta o Start e reporta o pai quando há `parent_conversation_id`
- [x] Sem eventos de subagente → "não observado" e saída `0`; `events.jsonl` com linhas corrompidas não lança
- [x] `server/test/cursor-poc.test.ts` cobre: par casado, órfão, nenhum; e o `install` com os dois eventos novos
- [x] Gate check passes: `npx vitest run server/test/cursor-poc.test.ts`
- [x] Test count: 5+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick
**Status**: ✅ Complete

**Commit**: `feat(cursor): subcomando subagents e hooks de subagente (p4)`

---

### Phase 3: CLI headless (POC P5)

### T3: Subcomando `cli` (stream-json)

**What**: Adicionar o subcomando `cli [--path]` que lê um NDJSON do `cursor-agent -p --output-format stream-json` (arquivo ou `stdin`) e conta os tipos de evento (`system|user|assistant|tool_call|result`), reporta o `session_id` e a diversidade de ferramentas; linhas não-JSON são contadas como ilegíveis. Registrar o script npm `cursor:poc:cli`.
**Where**: `scripts/cursor-poc.ts`
**Depends on**: None
**Reuses**: a leitura de `stdin` do estilo `mod/habblaud-cursor/poc-hook.mjs:25`; aliases defensivos de `rollout.ts:20` (`firstStr`)
**Requirement**: CP48-10, CP48-11, CP48-12, CP48-13

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `parseCliStream(text)` conta tipos, extrai `session_id` e soma ferramentas (`tool_call.tool_name|name`, `tool_calls[].function.name`)
- [x] `cli --path <arquivo>` sobre NDJSON sintético (`system`,`assistant`,2 `tool_call` de nomes distintos,`result`,1 linha corrompida) reporta contagens, `session_id`, diversidade e ilegíveis; sem `--path` → lê `stdin`
- [x] Stream vazio → contagens zeradas e saída `0`
- [x] `server/test/cursor-poc.test.ts` cobre os casos acima
- [x] Gate check passes: `npx vitest run server/test/cursor-poc.test.ts`
- [x] Test count: 4+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick
**Status**: ✅ Complete

**Commit**: `feat(cursor): subcomando cli para o stream-json (p5)`

---

### Phase 4: Injeção de mensagem (POC P6)

### T4: Probe `followup-hook.mjs`

**What**: Criar `mod/habblaud-cursor/followup-hook.mjs`: lê o `stdin`; se `hook_event_name === 'stop'`, imprime `{"followup_message": <texto>}` (texto de `HABBLAUD_CURSOR_POC_FOLLOWUP`); para qualquer outro evento ou stdin inválido, sai `0` sem imprimir nada. Node puro, nunca lança.
**Where**: `mod/habblaud-cursor/followup-hook.mjs`
**Depends on**: None
**Reuses**: `readStdin`/rede de segurança de saída do `mod/habblaud-cursor/poc-hook.mjs:25`
**Requirement**: CP48-14, CP48-17

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Com `{hook_event_name:'stop'}` no stdin e `HABBLAUD_CURSOR_POC_FOLLOWUP` definido, imprime `{"followup_message":"…"}` e sai `0`
- [x] Com evento ≠ `stop` ou stdin inválido, sai `0` sem escrever nada
- [x] `server/test/cursor-poc.test.ts` spawna o probe (processo de verdade) e cobre os dois casos
- [x] Gate check passes: `npm test`
- [x] Test count: 3+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full
**Status**: ✅ Complete

**Commit**: `feat(cursor): probe de followup da p6`

---

### T5: Subcomando `followup`

**What**: Adicionar o subcomando `followup [--message <texto>]` que spawna o probe com um `{hook_event_name:'stop'}` sintético e valida que a saída é JSON com `followup_message` string; saída inválida → código ≠ `0`. Registrar o script npm `cursor:poc:followup`.
**Where**: `scripts/cursor-poc.ts`
**Depends on**: T4
**Reuses**: `runDecisionHook` (`scripts/cursor-poc.ts:353`) como molde do spawn; a constante do caminho do probe
**Requirement**: CP48-15, CP48-16

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `followup --message "oi"` roda o probe, imprime `✓` e sai `0` com o `followup_message` esperado
- [x] Saída não-JSON do probe → o harness reporta e sai ≠ `0`
- [x] `server/test/cursor-poc.test.ts` cobre o caminho feliz e o de saída inválida (probe forjado)
- [x] Gate check passes: `npm test`
- [x] Test count: 3+ casos passam (sem deleções silenciosas)

**Tests**: integration
**Gate**: full
**Status**: ✅ Complete

**Commit**: `feat(cursor): subcomando followup que valida o probe (p6)`

---

### Phase 5: Histórico e efeitos (POC P7)

### T6: Subcomando `history` (sessões + `git`/`gh`)

**What**: Adicionar o subcomando `history [--projects <dir>]` que varre `*/agent-transcripts/<id>/<id>.jsonl` (padrão `~/.cursor/projects`), resume cada sessão (id, mtime, nº de turnos por `role`, ferramentas via `parseCursorTranscriptLine`) e detecta efeitos `git push`/`gh pr create|merge`. Diretório inexistente → mensagem e saída `0`. Registrar o script npm `cursor:poc:history`.
**Where**: `scripts/cursor-poc.ts`
**Depends on**: None
**Reuses**: `parseCursorTranscriptLine` (`server/sources/cursor/transcript.ts:247`); `describeCursorTool` (`server/sources/cursor/rollout.ts:96`)
**Requirement**: CP48-18, CP48-19, CP48-20, CP48-21

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `enumerateSessions(projectsDir)` devolve id/mtime/turnos/ferramentas por sessão; `detectEffects(text)` acha `git push`, `gh pr create`, `gh pr merge`
- [x] `history --projects <dir>` sobre fixtures sintéticas (uma sessão com `git push`/`gh pr create`, uma linha corrompida) reporta as sessões, ferramentas e efeitos; diretório inexistente → mensagem e saída `0`
- [x] Reusa o parser (linha desconhecida não lança)
- [x] `server/test/cursor-poc.test.ts` cobre os casos acima
- [x] Gate check passes: `npx vitest run server/test/cursor-poc.test.ts`
- [x] Test count: 4+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick
**Status**: ✅ Complete

**Commit**: `feat(cursor): subcomando history para sessoes e efeitos (p7)`

---

### Phase 6: Registro e runbook

### T7: Runbook único das POCs P4–P8

**What**: Criar `docs/analise/10-runbook-poc-cursor-p4-p8.md` com um passo por POC (P4–P8): comando, o que observar e critério de sucesso/falha, incluindo o re-teste do P4 com os hooks de subagente e o comando do P5 (`cursor-agent -p … --output-format stream-json`) e do P6 (instalar o probe no `stop`).
**Where**: `docs/analise/10-runbook-poc-cursor-p4-p8.md`
**Depends on**: T1, T2, T3, T4, T5, T6
**Reuses**: `docs/analise/08-runbook-poc-cursor.md` (formato do runbook P0–P3)
**Requirement**: CP48-22

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] O runbook tem um passo por POC (P4, P5, P6, P7, P8) com comando, observação e critério de sucesso/falha
- [x] Os comandos casam com os subcomandos entregues (`cursor:poc:usage|subagents|cli|followup|history`)
- [x] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build
**Status**: ✅ Complete

**Commit**: `docs(cursor): runbook das pocs p4-p8`

---

### T8: Registrar resultados P4–P8 na análise (repo-pai)

**What**: Atualizar `docs/analise/07-poc-priorizados.md` (seção de resultados P4–P8), `00-resumo-e-ledger.md`, `05-matriz-compatibilidade-cursor.md` e `docs/relatorio-poc-cursor-2026-10-10.md` com o veredicto de cada POC; adicionar `docs/cursor-export/` ao `.gitignore` (dados pessoais não vão a commit).
**Where**: `docs/analise/07-poc-priorizados.md`
**Depends on**: T7
**Reuses**: o formato da tabela de resultados P0–P3 em `07`
**Requirement**: CP48-23

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `07` ganha a tabela de resultados P4–P8 (com a ressalva do método do P4 e a ausência de fonte de uso no P8)
- [ ] `00`/`05`/`relatorio` citam o veredicto de P4–P8 e o runbook `10`
- [ ] `.gitignore` do repo-pai ignora `docs/cursor-export/`
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build
**Status**: ⬜ Pending

**Commit**: `docs(cursor): registrar os resultados das pocs p4-p8`

---

## Phase Execution Map

| Phase | Tasks | Entrega |
| ----- | ----- | ------- |
| 1 | T1 | Analisador de uso/plano (P8) |
| 2 | T2 | Hooks de subagente + correlacionador (P4) |
| 3 | T3 | Caracterizador do `stream-json` do CLI (P5) |
| 4 | T4, T5 | Probe de followup + validador (P6) |
| 5 | T6 | Histórico + efeitos `git`/`gh` (P7) |
| 6 | T7, T8 | Runbook + registro na análise |

## Task Granularity Check

- T1–T3, T6 tocam **um** arquivo (`scripts/cursor-poc.ts`) cada; T4 um arquivo (`followup-hook.mjs`); T5 um arquivo; T7/T8 são docs.
- Cada task é independentemente verificável (gate) e independentemente commitável.

## Diagram-Definition Cross-Check

- Phase 4: diagrama `T4 → T5` ⇔ `T5 Depends on: T4` ✅
- Phase 6: diagrama `T7 → T8` ⇔ `T8 Depends on: T7` ✅
- Fases 1,2,3,5: task única, sem seta ✅

## Test Co-location Validation

- Testes do harness e do probe: `server/test/cursor-poc.test.ts` (vizinho dos testes existentes do Cursor) ✅
- Consistente com a matriz e com a convenção do repositório ✅

## Tips

- **Reuso é rei**: o parser (`transcript.ts`) já entende o schema real (C1) — o `history` não reimplementa nada.
- **Real antes de sintético**: depois de `T6`, rodar `history`/`usage`/`subagents` contra `docs/cursor-export/` responde P4/P7/P8 sem a máquina do usuário.
- **Uma task, um commit**: nada de "já que estou aqui".
