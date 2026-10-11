# Uso do plano e mensagens do Cursor — Fase 5 Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/cursor-uso-mensagens/design.md`
**Spec**: `.specs/features/cursor-uso-mensagens/spec.md`
**Status**: Implementing

---

## Test Coverage Matrix

> Gerado da base (`vitest.config.ts`, `package.json`, `client/tsconfig.json`) e da spec — confirmar antes do Execute. O repositório usa **vitest colocalizado** (`client/src/**/*.test.ts`). As funções testadas são **puras** (`usageCardAccounts`, `composerMode`); nenhuma fixture real de conta/uso é versonada. A matriz é um **piso**, não teto.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| `client/src/ui/usage.ts` | unit | 1:1 a F5-01/F5-02: `usageCardAccounts` filtra só `provider !== 'cursor'`; claude (sem provider)/codex permanecem; lista vazia quando só há cursor | `client/src/ui/usage-source.test.ts` | `npx vitest run client/src/ui/usage-source.test.ts` |
| `client/src/ui/composer-model.ts` | unit | 1:1 a F5-03/F5-04/F5-05: principal Cursor ao vivo → `off` com `CURSOR_OFF_TEXT`; sub do Cursor e sessão encerrada mantêm as mensagens atuais; codex/claude inalterados | `client/src/ui/composer-model.test.ts` | `npx vitest run client/src/ui/composer-model.test.ts` |
| Docs (roteiro `06` no raiz, `.specs/STATE.md` no submódulo) | none | F5-06 — nota §6.8 e Handoff; inspecionável (sem teste) | - | build gate |

## Gate Check Commands

> Gerado de `package.json` — confirmar antes do Execute. Um só runner (vitest); `typecheck` para o cliente e o servidor.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Tasks cujo teste é 1–2 arquivos do cliente | `npx vitest run client/src/ui/usage-source.test.ts client/src/ui/composer-model.test.ts` |
| Full | Task que toca o caminho de UI compartilhado (composer/usage) | `npm test` |
| Build | Fim de fase (docs/wiring incl.) | `npm run typecheck && npm test && npm run build` |

---

## Execution Plan

Uma única fase (as duas mudanças de UI são independentes entre si; a docs fecha o ciclo). O
diagrama lista **apenas** as dependências reais (`Depends on`):

```
T1 → T2
T1 → T3
T2 → T4
T3 → T4
```

---

## Task Breakdown

### T1: Planejar uso e mensagens do Cursor (Fase 5)

**What**: Escrever `spec.md` (ACs `F5-01..06` em EARS, matriz de assunções, out-of-scope), `design.md`
(diagrama + decisões D1–D4 + arquivos) e este `tasks.md`, no padrão das features irmãs
(`cursor-transcript`, `cursor-subagents-history`). Rodar `validate_spec.py cursor-uso-mensagens` e
`validate_tasks.py cursor-uso-mensagens` até **0 erros**.
**Where**: `.specs/features/cursor-uso-mensagens/`
**Depends on**: None
**Reuses**: `06` §6.5/§6.6/§6.8, `05` linhas 26/31/101/102, relatório P4–P8
**Requirement**: (planejamento — habilita T2–T4)

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `spec.md`/`design.md`/`tasks.md` criados no padrão das irmãs
- [x] `validate_spec.py` → 0 erros; `validate_tasks.py` → 0 erros
- [x] Commit único `docs(cursor): planejar uso e mensagens do cursor`

**Tests**: none
**Gate**: validators

**Commit**: `docs(cursor): planejar uso e mensagens do cursor`

---

### T2: Ocultar o cartão de uso para o Cursor

**What**: Em `client/src/ui/usage.ts`, exportar `usageCardAccounts(accounts: readonly AccountInfo[]): AccountInfo[]`
devolvendo `accounts.filter((a) => a.provider !== 'cursor')` e usar no `UsageCards.render()` no lugar do
`snapshot.accounts` cru; `is-empty`/`--count`/`list.sync` já derivam do resultado filtrado.
**Where**: `client/src/ui/usage.ts`
**Depends on**: T1
**Reuses**: o padrão já existente de `render()` (linhas 216–221) e `AccountInfo.provider`
**Requirement**: F5-01, F5-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `usageCardAccounts` filtra contas com `provider === 'cursor'` e mantém claude/codex/sem-provider
- [x] `render()` usa o filtro (conta do Cursor fica fora dos cartões)
- [x] testes em `usage-source.test.ts`: cursor sai, claude/codex ficam, só-cursor → vazio (`[]`)
- [x] Gate check passes: `npx vitest run client/src/ui/usage-source.test.ts`
- [x] Sem regressão: `npm test` (suíte completa, focus claude/codex) — opcional neste task se T3 rodar em seguida
- [x] Commit único `feat(cursor): ocultar o cartao de uso para o cursor`

**Tests**: unit
**Gate**: quick (full se conveniente)

**Commit**: `feat(cursor): ocultar o cartao de uso para o cursor`

---

### T3: Não oferecer mensagens aos agentes do Cursor

**What**: Em `client/src/ui/composer-model.ts`, exportar `CURSOR_OFF_TEXT = 'Para responder, use o Cursor'`
e, no `composerMode`, após os ramos de `replaying`/`sub`/`offline|done`, acrescentar
`if (agent?.provider === 'cursor') return { kind: 'off', text: CURSOR_OFF_TEXT }` (a gaveta esconde a
caixa; o terminal mostra o motivo). Não tocar nos ramos de claude/codex.
**Where**: `client/src/ui/composer-model.ts`
**Depends on**: T1
**Reuses**: o `agent()` helper e o `env` do arquivo de teste existente
**Requirement**: F5-03, F5-04, F5-05

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] principal do Cursor ao vivo (enabled+local+`canMessage`) → `{kind:'off', text: CURSOR_OFF_TEXT}`
- [ ] sub do Cursor → mensagem de subagente (não a do Cursor); sessão do Cursor encerrada → "Sessão encerrada"
- [ ] casos de claude/codex atuais seguem passando sem edição (não-regressão F5-05)
- [ ] `composer-model.test.ts` cobre os casos acima
- [ ] Gate check passes: `npx vitest run client/src/ui/composer-model.test.ts`
- [ ] Commit único `feat(cursor): nao oferecer mensagens para sessoes do cursor`

**Tests**: unit
**Gate**: quick (full final na T4)

**Commit**: `feat(cursor): nao oferecer mensagens para sessoes do cursor`

---

### T4: Registrar a Fase 5 no roteiro e handoff

**What**: Adicionar no roteiro `docs/analise/06-arquitetura-proposta.md` §6.8 (repositório **raiz**) a nota
da Fase 5 no mesmo estilo das Fases 3/4 (status implementado + o que foi feito + limitações: P6 ao vivo
pendente, P8 🔴 cartão oculto; feature `.specs/features/cursor-uso-mensagens/`). No submódulo, atualizar o
`.specs/STATE.md` (Handoff para `cursor-uso-mensagens` com decisões/resultados) e marcar T2–T4 `[x]` neste
`tasks.md` com a rastreabilidade no mesmo commit. Rodar o gate full (`typecheck` + `npm test` + `build`) e,
no raiz, commit da nota + bump do submódulo (padrão do commit lateral das Fases 3/4).
**Where**: `.specs/STATE.md` (submódulo) · raiz: `docs/analise/06-…`
**Depends on**: T2, T3
**Reuses**: o padrão das notas das Fases 2b/3/4 no §6.8
**Requirement**: F5-06

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] nota da Fase 5 no §6.8 do roteiro (raiz), no estilo das anteriores
- [ ] `.specs/STATE.md` com Handoff da Fase 5 (decisões, resultados, próximos passos/lacunas ao vivo)
- [ ] this `tasks.md` todo `[x]` com rastreabilidade atualizada
- [ ] Gate check passes: `npm run typecheck && npm test && npm run build` (submódulo)
- [ ] Commits: `docs(cursor): registrar uso e mensagens do cursor no roteiro` (submódulo) e nota+bump na raiz
- [ ] Árvore do submódulo limpa (sem pendências)

**Tests**: none
**Gate**: build

**Commit**: `docs(cursor): registrar uso e mensagens do cursor no roteiro`