# Transcript do Cursor Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/cursor-transcript/design.md`
**Spec**: `.specs/features/cursor-transcript/spec.md`
**Status**: Implementing

---

## Test Coverage Matrix

> Generated from the codebase (`vitest.config.ts`, `package.json`, `server/tsconfig.json`) and the spec - confirm before Execute. O repositório segue a convenção de **vitest colocalizado** (`server/**/*.test.ts`), com o `Office`/`AccountsService` de verdade nos testes da fonte (padrão de `cursor/source.test.ts`). Fixtures são **sintéticas** (nada de conversa real). A matriz é um **piso**, não teto.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Terminal do Cursor (`cursor/terminal.ts`) | unit | 1:1 a `CTRANS-04/05/06/07/08`: `user`/`assistant`/`tool` (`Shell`, `Read`, `Write`, `StrReplace`, `Glob`, `Grep`, `CallDynamicTool`, `GetDynamicTools`, `AskQuestion`, `UpdateCurrentStep`, `List`, `Task`), `turn_ended` (sucesso/erro), linha inválida = `[]`, máscara/truncamento | `server/sources/cursor/terminal.test.ts` | `npx vitest run server/sources/cursor/terminal.test.ts` |
| Fonte do Cursor (`cursor/source.ts`) | unit | `CTRANS-01/02/03` (caminho/terminal: grava, nunca limpa, parser novo) e `CTRANS-09/10/11/12` (tokens no Office: soma, campo ausente não regride); `tasks` fica vazio | `server/sources/cursor/source.test.ts` | `npx vitest run server/sources/cursor/source.test.ts` |
| Normalizador do Cursor (`cursor/rollout.ts`) | unit | `CTRANS-09/10/12` (tokens no evento) e `CTRANS-13` + `CTRANS-14` (tradução de `GetDynamicTools`/`AskQuestion`/`UpdateCurrentStep`/`Task`) | `server/sources/cursor/rollout.test.ts` | `npx vitest run server/sources/cursor/rollout.test.ts` |
| Docs (roteiro `06`, `.specs/STATE.md`) | none | - (gate de build cobre) | - | build gate |

## Gate Check Commands

> Generated from the codebase (`package.json`) - confirm before Execute. O repositório não separa unit/e2e: há **um** runner (vitest). O gate "quick" roda o(s) arquivo(s) da task; o "full" roda a suíte inteira; o "build" é o fim de fase.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Tasks cujo teste é um arquivo só | `npx vitest run <arquivo de teste da task>` |
| Full | Task que toca o caminho de atividade usado pela fonte (rollout + source) | `npm test` |
| Build | Fim de fase ou task só de docs | `npm run typecheck && npm test && npm run build` |

---

## Execution Plan

As fases rodam em sequência; as tasks de cada fase rodam em ordem. Os diagramas listam **apenas** as dependências reais (`Depends on`) **dentro** da fase (as dependências entre fases — `T4`←`T3`, `T6`←`T4`,`T5` — são validadas pelo grafo de fases).

### Phase 1: Terminal da conversa do Cursor (P1)

```
T1 → T2
```

### Phase 2: Tokens acumulados do Cursor (P1)

```
T3 → T4
```

### Phase 3: Atividades ricas das ferramentas (P2)

```
T5
```

### Phase 4: Registro no roteiro e handoff (P3)

```
T6
```

---

## Task Breakdown

### Phase 1: Terminal da conversa do Cursor (P1)

### T1: Parser do terminal `cursor/terminal.ts`

**What**: Criar `server/sources/cursor/terminal.ts` com `createCursorTerminalParser()` (um parser novo por leitura) e o interna `cursorToolView`: converter cada linha JSONL (`{"role":…,"message":{"content":[…]}}` com blocos `text`/`tool_use`, e `{"type":"turn_ended","status":…}`) em `TerminalEntry` (`user`/`assistant`/`tool`/`system`); ids por posição da linha + índice do bloco; `[]` para linha inválida/desconhecida; `at` de `timestamp`/`ts` quando houver (senão o último; `Date.now()` como reserva); reusar `prepare`/`marked`/`oneLine`/`maskSecrets`/`toolView`.
**Where**: `server/sources/cursor/terminal.ts`
**Depends on**: None
**Reuses**: helpers de `server/sources/terminal.ts` (`prepare`, `marked`, `oneLine`, `toolView`, `maskSecrets`, `TEXT_MAX`, `INPUT_MAX`, `TITLE_ARG_MAX`); `codex/terminal.ts` como forma de referência
**Requirement**: CTRANS-04, CTRANS-05, CTRANS-06, CTRANS-07, CTRANS-08

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] prompt (`role:"user"`, bloco `text`) vira entrada `user`; resposta (`role:"assistant"`, bloco `text`) vira entrada `assistant`
- [x] cada bloco `tool_use` vira uma entrada `tool` com título no estilo `toolView`: `Shell`→`Bash(cmd)`, `Read`→`Read(path)`, `Write`→`Write(path)` (de `contents`), `StrReplace`→`Edit(path)` (diff), `Glob`→`Glob(glob_pattern)`, `Grep`, `CallDynamicTool`→`mcp__<ns>__<tool>` (e `Task` → delegate), `GetDynamicTools`, `AskQuestion`, `UpdateCurrentStep`, `List`→`LS`
- [x] `{"type":"turn_ended","status":…}` vira entrada `system` (`info` em sucesso; `warn`/`error` quando o status não é de sucesso)
- [x] linha inválida/desconhecida/em branco devolve `[]`, sem lançar; vários `tool_use` na mesma linha geram várias entradas
- [x] segredos mascarados e textos longos truncados pelas regras do terminal (reuso de `prepare`/`maskSecrets`)
- [x] `server/sources/cursor/terminal.test.ts` cobre: user, assistant, cada ferramenta acima, `turn_ended` (sucesso e erro), linha inválida, máscara de segredo
- [x] Gate check passes: `npx vitest run server/sources/cursor/terminal.test.ts`
- [x] Test count: 10+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): terminal da conversa a partir do transcript`

---

### T2: Caminho e parser na `CursorSource`

**What**: Guardar o `transcript_path` por conversa no `CursorTracker` (só quando o evento traz um caminho não vazio; nunca limpar) e ligar `transcriptPathOf(agentId)` a ele; `terminalParser(agentId)` devolve um `createCursorTerminalParser()` novo quando o tracker existe (senão `undefined`). Atualizar o caso antigo "MVP sem transcript" de `source.test.ts`.
**Where**: `server/sources/cursor/source.ts`
**Depends on**: T1
**Reuses**: `hookEvent` (`:150`), `reconcile` (`:184`), `createCursorTerminalParser` de `./terminal`
**Requirement**: CTRANS-01, CTRANS-02, CTRANS-03

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] um evento com `transcript_path` não vazio faz `transcriptPathOf(agentId)` devolvê-lo
- [ ] um evento posterior sem `transcript_path` (ou com `null`) **não** limpa o caminho já guardado; sem caminho, `transcriptPathOf` segue `undefined`
- [ ] `terminalParser(agentId)` devolve um parser novo para um agente conhecido e `undefined` para um desconhecido
- [ ] `server/sources/cursor/source.test.ts` substitui o caso "MVP sem transcript" por: sem caminho → `undefined`; com caminho → definido (e o parser definido)
- [ ] Gate check passes: `npx vitest run server/sources/cursor/source.test.ts`
- [ ] Test count: 12+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): guardar e expor o transcript_path da sessao`

---

### Phase 2: Tokens acumulados do Cursor (P1)

### T3: Tokens no evento `CursorEvent`

**What**: Acrescentar `CursorTokens` e `CursorEvent.tokens?` e ler os campos no `parseCursorEvent`: `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens` (aliases camelCase); cada campo ausente/não numérico vale `0`; sem nenhum campo útil, `tokens` fica `undefined`.
**Where**: `server/sources/cursor/rollout.ts`
**Depends on**: None
**Reuses**: os helpers `num`/aliases defensivos do próprio arquivo (o padrão `firstStr`/`firstRec`)
**Requirement**: CTRANS-09, CTRANS-10, CTRANS-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] um `stop` com os quatro campos normaliza `tokens = { input, output, cacheRead, cacheWrite }`
- [ ] um evento sem nenhum campo de token fica sem `tokens`; um campo não numérico é ignorado (`0`), sem lançar
- [ ] aliases camelCase (`inputTokens`, `cacheReadTokens`…) também são lidos
- [ ] `server/sources/cursor/rollout.test.ts` cobre os casos acima
- [ ] Gate check passes: `npx vitest run server/sources/cursor/rollout.test.ts`
- [ ] Test count: 6+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): ler os campos de tokens dos eventos de hook`

---

### T4: Tokens acumulados no escritório

**What**: Dar `stats: AgentStats` ao `CursorTracker`; em `hookEvent`, somar `tokensIn += input + cacheRead + cacheWrite` e `tokensOut += output` a cada evento com `tokens` e chamar `office.applyTranscript(t.key, { tasks: [], stats: { ...t.stats } })` quando o agente está no escritório (nunca regride quando o campo falta).
**Where**: `server/sources/cursor/source.ts`
**Depends on**: T3
**Reuses**: `office.applyTranscript` (`office.ts:650`), `TranscriptSummary` (`:79`), `AgentStats` (`shared/types.ts:118`), `reconcile` (`:184`)
**Requirement**: CTRANS-09, CTRANS-10, CTRANS-11, CTRANS-12

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] um `stop` com os quatro campos reflete `stats.tokensIn = input+read+write` e `stats.tokensOut = output` no snapshot do Office
- [ ] um `afterAgentResponse` só com `output_tokens` **soma** ao acumulado
- [ ] um evento sem tokens (ou com campo não numérico) não muda os números
- [ ] `tasks` do agente segue vazio (nenhum `TaskItem` derivado)
- [ ] `server/sources/cursor/source.test.ts` cobre os casos acima
- [ ] Gate check passes: `npx vitest run server/sources/cursor/source.test.ts`
- [ ] Test count: 14+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: quick

**Commit**: `feat(cursor): refletir tokens acumulados no escritorio`

---

### Phase 3: Atividades ricas das ferramentas (P2)

### T5: Traduções ricas no `describeCursorTool`

**What**: Acrescentar ao `describeCursorTool` ramos dedicados a `GetDynamicTools` (`other`, "Carregando as ferramentas do Cursor"), `AskQuestion` (`ask`, "Fazendo uma pergunta a você") e `UpdateCurrentStep` (`plan`, "Etapa: …"), e tratar `CallDynamicTool` com `toolName` `Task` como `delegate` (via `describeTool('Task', …)`), mantendo o nome cru quando não houver tradução.
**Where**: `server/sources/cursor/rollout.ts`
**Depends on**: None
**Reuses**: `describeTool` (`shared/activity.ts:650`), `describeCursorTool` (`:96`), `make`/truncate de `shared/activity.ts`
**Requirement**: CTRANS-13, CTRANS-14

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] `describeCursorTool('GetDynamicTools', {})` → `kind` `other` e texto legível (não o genérico "Usando …")
- [ ] `describeCursorTool('AskQuestion', { questions:[{ prompt:'…' }] })` → `kind` `ask` com o texto da pergunta
- [ ] `describeCursorTool('UpdateCurrentStep', { current_step:'…' })` → `kind` `plan` citando o passo
- [ ] um `CallDynamicTool` com `toolName:'Task'` vira `delegate`; sem `Task`, segue `mcp__…` (caso atual)
- [ ] um evento `preToolUse` com `tool_name` de `GetDynamicTools`/`AskQuestion`/`UpdateCurrentStep` gera a `Activity` traduzida no agente (teste da fonte), com `tasks` vazio
- [ ] `server/sources/cursor/rollout.test.ts` e `server/sources/cursor/source.test.ts` cobrem os casos acima
- [ ] Gate check passes: `npm test`
- [ ] Test count: 16+ casos passam (sem deleções silenciosas)

**Tests**: unit
**Gate**: full

**Commit**: `feat(cursor): atividades ricas das ferramentas do cursor`

---

### Phase 4: Registro no roteiro e handoff (P3)

### T6: Registrar a Fase 3 no roteiro e o handoff

**What**: Acrescentar ao faseamento de `docs/analise/06-arquitetura-proposta.md` (§6.8) uma nota da Fase 3 (transcript/terminal, tokens e atividades ricas) apontando para `.specs/features/cursor-transcript/`, e atualizar o Handoff de `.specs/STATE.md` com o resultado (inclusive: sem checklist no transcript → nenhum `TaskItem` derivado; sem `tool_result` → nenhuma entrada `result`).
**Where**: `docs/analise/06-arquitetura-proposta.md`
**Depends on**: T4, T5
**Reuses**: a tabela de §6.8 e a nota da Fase 2b (mesmo formato); o Handoff de `.specs/STATE.md`
**Requirement**: CTRANS-14

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] §6.8 ganha a nota da Fase 3 apontando para `.specs/features/cursor-transcript/`
- [ ] o Handoff de `.specs/STATE.md` resume a feature e registra a ausência de checklist/resultado como resultado
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build`

**Tests**: none
**Gate**: build

**Commit**: `docs(cursor): registrar o transcript do cursor no roteiro`

---

## Phase Execution Map

Visual representation of task ordering. Phases run in sequence, and tasks within a phase run in order:

```
Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1:  T1 → T2
Phase 2:  T3 → T4
Phase 3:  T5
Phase 4:  T6
```

Dependências entre fases (validadas pelo grafo sequencial): `T4`←`T3`; `T6`←`T4`,`T5`.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Parser `cursor/terminal.ts` | 1 módulo novo | ✅ Granular |
| T2: `cursor/source.ts` (caminho + parser) | 1 arquivo | ✅ Granular |
| T3: `cursor/rollout.ts` (tokens) | 1 arquivo | ✅ Granular |
| T4: `cursor/source.ts` (tokens no Office) | 1 arquivo | ✅ Granular |
| T5: `cursor/rollout.ts` (traduções) | 1 arquivo | ✅ Granular |
| T6: Roteiro + handoff | 1 doc | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | — | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | None | — | ✅ Match |
| T4 | T3 | T3 → T4 | ✅ Match |
| T5 | None | — (fase única) | ✅ Match |
| T6 | T4, T5 (fases anteriores) | — (sem setas intra-fase) | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1: `cursor/terminal.ts` | Terminal do Cursor | unit | unit | ✅ OK |
| T2: `cursor/source.ts` (caminho) | Fonte do Cursor | unit | unit | ✅ OK |
| T3: `cursor/rollout.ts` (tokens) | Normalizador do Cursor | unit | unit | ✅ OK |
| T4: `cursor/source.ts` (tokens) | Fonte do Cursor | unit | unit | ✅ OK |
| T5: `cursor/rollout.ts` (traduções) | Normalizador do Cursor | unit | unit | ✅ OK |
| T6: roteiro/handoff | Docs | none | none | ✅ OK |

---

## Tips

- **Título primeiro**: a maior parte do valor do terminal está em `cursorToolView` (título legível); o `input` é bônus.
- **Não inventar**: sem `tool_result` no transcript e sem checklist, o certo é a ausência documentada (T5/T6).
- **Uma task, um commit**: nada de "já que estou aqui".
