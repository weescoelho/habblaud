# Validação — Uso do plano e mensagens do Cursor (Fase 5)

**Veredito: PASS** — os 6 ACs (`F5-01..06`) casam com o resultado definido pela `spec.md`; gate verde
(`typecheck` + `vitest` + `build`); **12 mutantes** de comportamento injetados, **10 mortos | 2
sobreviventes** (ambos com a mesma raiz: o consumidor `UsageCards.render()` / a classe `is-empty` não têm
asserção própria — ver G1). Nenhum AC falho e nenhuma correção de comportamento é necessária; resta 1
**lacuna de precisão/cobertura de teste** de severidade baixa que vira fix task.

**Diff validado:** `a0030cf..HEAD` (`8ec1f62`, branch `cursor-poc`: planejamento `7c4c98a` + T2 `fa1d6cc`
+ T3 `29ebd40` + T4 `8ec1f62`).
**Data:** 2026-10-11 — verificação independente (Verifier ≠ autor), rederivada dos artefatos, do diff e dos testes.
Commit lateral no workspace raiz `18234fb` (`docs/analise/06-arquitetura-proposta.md` + ponteiro do
submódulo) entrou na revisão do artefato de docs (T4/F5-06).

## Validation — resultado do gate

**Result**: PASS ✅ (6/6 ACs com evidência `file:line`; sensor 10/12 mortos; gate `typecheck`+`vitest`+`build` verde)

## Critérios de aceite (AC → status → evidência `file:line` + asserção)

O mapeamento AC→`F5` segue a rastreabilidade de `spec.md:112-121` (`F5-01/F5-02/F5-05` = P1 "Cartão de
uso"; `F5-03/F5-04/F5-05` = P2 "Mensagens"; `F5-06` = P3 "Roteiro").

| AC | Status | Evidência (`file:line` + asserção) |
| --- | --- | --- |
| **F5-01** (conta `provider === 'cursor'` no snapshot → cartão **não** exibido) | PASS | `client/src/ui/usage-source.test.ts:71-73` — `expect(result).toEqual([claude, codexAcc])` e `expect(result).not.toContain(cursor)`; impl. `client/src/ui/usage.ts:209` (`filter((a) => a.provider !== 'cursor')`). Consumidor `render()` em `usage.ts:227` (ver G1) |
| **F5-02** (filtra para cartões; só-diferente-de-cursor; nada restando → vazio/`is-empty`) | PASS | `usage-source.test.ts:77-78` — `expect(usageCardAccounts([cursor, cursor])).toEqual([])` e `expect(usageCardAccounts([])).toEqual([])`; impl. `usage.ts:208-210`; `is-empty` deriva de `accounts.length === 0` em `usage.ts:229` (ver G1) |
| **F5-03** (principal ao vivo do Cursor → `off` com o texto definido) | PASS | `client/src/ui/composer-model.test.ts:118-119` — `expect(composerMode(cursor(), ON)).toEqual({ kind: 'off', text: CURSOR_OFF_TEXT })` e `expect(CURSOR_OFF_TEXT).toBe('Para responder, use o Cursor')`; impl. `client/src/ui/composer-model.ts:13` (texto) e `:38` (ramo) |
| **F5-04** (sub do Cursor / sessão encerrada/offline mantêm o estado de hoje, sem o texto do Cursor) | PASS | `composer-model.test.ts:121-125` — sub → `toMatchObject({ kind:'off', text: expect.stringMatching(/^Subagentes/) })`; `status:'offline'`/`'done'` → `toEqual({ kind:'off', text:'Sessão encerrada' })`; `replaying` → `text` casa `/timelapse/`; impl. ordem do ramo **depois** de `replaying`/`sub`/`offline|done` em `composer-model.ts:32-38` |
| **F5-05** (claude/codex inalterados; suíte existente segue verde sem edição) | PASS | claude: `composer-model.test.ts:127` — `expect(composerMode(agent(), ON)).toEqual({ kind:'ready' })` (agente **sem** `provider`); codex: `composer-model.test.ts:107-113` (inalterado no diff); uso: `usage-source.test.ts:68-72` (`codexAcc` permanece) e `:81-84` (sem `provider` não é afetado). O diff **não** altera o caminho de claude/codex (`composer-model.ts:39-43`) |
| **F5-06** (roteiro `06` §6.8 + `.specs/STATE.md` registram desfecho e limitações) | PASS (docs; sem teste) | Roteiro raiz: commit `18234fb` — `docs/analise/06-arquitetura-proposta.md` §6.8, nota "Fase 5 — Uso do plano e mensagens do Cursor" (P8 🔴 cartão oculto; P6 forma validada/efeito ao vivo pendente/C7). Handoff: `.specs/STATE.md` (diff de `.specs/STATE.md:22-29`, Handoff `cursor-uso-mensagens`) |

**Status**: 6/6 ACs com evidência; 0 falhas de comportamento; 1 lacuna de precisão/cobertura (G1).

## Edge cases (`spec.md:104-110`)

| Edge case | Status | Evidência |
| --- | --- | --- |
| Conta do Cursor sem sessões abertas → continua sem cartão (filtro é por `provider`, não por presença) | ✅ | `usage-source.test.ts:70-73` — o filtro não olha `sessions`; impl. `usage.ts:209` |
| `snapshot.accounts` sem contas do Cursor → comportamento idêntico a hoje | ✅ | `usage-source.test.ts:78,83` (lista vazia / sem-`provider` inalterados); impl. `usage.ts:209` |
| Sessão do Cursor encerrada → "Sessão encerrada" (a guarda do Cursor **não** precede o estado de sessão) | ✅ | `composer-model.test.ts:123-124` (`offline`/`done` → `'Sessão encerrada'`); impl. ordem `composer-model.ts:34` antes de `:38` |
| Sub do Cursor → "Subagentes não recebem mensagens: escreva para o agente principal" | ✅ | `composer-model.test.ts:121-122` (`/^Subagentes/`); impl. `composer-model.ts:33` antes de `:38` |

## Sensor de discriminação (fault injection, um mutante por vez, em worktree descartável)

Metodologia: 12 mutantes de **nível de comportamento** injetados um a um em `/tmp/opencode/f5-wt`
(`git worktree add --detach HEAD`, `node_modules` do fork por symlink; **nunca** `git stash`, nunca o tree
real); cada mutante aplicado, testado (`npx vitest run client/src/ui/usage-source.test.ts
client/src/ui/composer-model.test.ts`) e revertido (`git checkout -- <arquivo>`); "morto" = exit ≠ 0. Ao
final o worktree foi removido (`git worktree remove --force`) e o `git status --porcelain` do tree real
voltou a **vazio** (baseline preservada).

| Mutante | Falha de comportamento injetada | Arquivo | Resultado |
| --- | --- | --- | --- |
| U1 | Predicado do filtro invertido (`!== 'cursor'` → `=== 'cursor'`) | `usage.ts` | KILLED (F5-01 "cursor sai" falha) |
| U2 | Filtro removido (`return accounts.slice()`) | `usage.ts` | KILLED (F5-01 falha) |
| U3 | Provider errado no filtro (`!== 'codex'`) | `usage.ts` | KILLED (codex/sem-`provider` falham) |
| **U4** | **`render()` ignora o filtro (usa `snapshot.accounts` cru)** | `usage.ts` | **SURVIVED → G1** |
| **U5** | **`is-empty` invertido (`accounts.length === 0` → `!== 0`)** | `usage.ts` | **SURVIVED → G1** |
| C1 | Ramo do Cursor removido | `composer-model.ts` | KILLED (F5-03 → `ready`) |
| C2 | `provider === 'cursor'` → `'claude'` (nunca casa) | `composer-model.ts` | KILLED (F5-03 falha) |
| C3 | Ordem invertida (ramo movido para **antes** de `replaying`/`sub`/`offline`) | `composer-model.ts` | KILLED (F5-04: sub/offline/done/replay mascarados) |
| C4 | Valor de `CURSOR_OFF_TEXT` errado (`…use o Codex`) | `composer-model.ts` | KILLED (`toBe('Para responder, use o Cursor')`) |
| C5 | Guarda do Cursor também pega claude (`provider === undefined`) | `composer-model.ts` | KILLED (F5-05 claude deixa de ser `ready`) |
| C6 | Guarda do Cursor também pega codex | `composer-model.ts` | KILLED (F5-05 codex deixa de ser `ready`) |
| C7 | Ramo devolve `kind:'hint'` em vez de `'off'` | `composer-model.ts` | KILLED (F5-03 `toEqual` falha) |

**Sensor depth**: lightweight estendido (12 mutantes; feature P1/P2 de UI pura, sem caminho P0 de
pagamento/auth).
**Resultado do sensor**: **10/12 mortos** — as 2 sobreviventes (U4/U5) têm a mesma raiz: o **consumidor**
`UsageCards.render()` não é exercitado por teste (G1).

**Não-regressão Claude/Codex**: o diff `a0030cf..HEAD` não toca `shared/`, `server/sources/{claude,codex}`
nem qualquer outro arquivo de produção; as duas únicas mudanças de produção são aditivas e guardadas por
`provider` (`usage.ts:208-210` + uso em `:227`; `composer-model.ts:13,38`). U3/C5/C6 confirmam que a suíte
distingue a guarda de claude/codex; a suíte inteira (Claude/Codex inclusos) segue verde (ver Gate).

## Gates (rodados no tree real, sem mutações, tree limpa)

| Gate | Comando | Resultado |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Testes | `npm test` | 107 arquivos, **1377 passed | 2 skipped (1379)**, exit 0 |
| Build | `npm run build` | exit 0 (client + `dist/server/index.js` 586.7 kb) |
| Arquivos da feature (quick) | `npx vitest run client/src/ui/usage-source.test.ts client/src/ui/composer-model.test.ts` | **16 passed** (2 arquivos) |

**Integridade dos testes**: baseline da Fase 4 = 107 arquivos, **1373 passed | 2 skipped (1375)**; após a
Fase 5 = 107 arquivos, **1377 passed | 2 skipped (1379)** → **+4 testes, +0 arquivos**. O diff **não** remove
nenhum caso (`git diff a0030cf..HEAD | grep -cE '^\-\s*(it|test)\('` = **0**) e adiciona 4 (`it`) — 1 em
`composer-model.test.ts` (F5-03/F5-04) e 3 em `usage-source.test.ts` (F5-01/F5-02). Sem enfraquecimento de
asserção.

## Lacunas (ranqueadas por severidade)

1. **G1 — BAIXA · F5-01/F5-02: o consumidor `UsageCards.render()` (fiação do filtro + classe `is-empty`) não é discriminado por teste.**
   A cobertura 1:1 cobre só a função pura `usageCardAccounts` (`usage-source.test.ts:66-85`); a linha que a
   aplica no `render()` (`usage.ts:227`) e o `is-empty` (`usage.ts:229`) não têm asserção própria, então os
   mutantes **U4** (usar `snapshot.accounts` cru) e **U5** (`is-empty` invertido) sobrevivem. **O
   comportamento implementado está correto** (o `render()` delega 1:1 ao filtro puro, padrão D4 do
   `design.md:27,31-35`); é lacuna de *teste*/*fiação*, não de AC. O repositório não tem ambiente de DOM
   (`vitest.config.ts:5` — `environment: 'node'`; nenhum teste usa `document.`/`classList`) e a UI segue o
   padrão "lógica pura separada do DOM" — mesma natureza da lacuna de fiação aceita na Fase 4 (CSH G1).
   → **Fix task (baixa)**: extrair a derivação do `render()` (a lista + `is-empty`) para uma função pura
   testável (ex.: `usageCardView(snapshot)`), ou adicionar um teste com DOM que prove "conta `cursor` não
   entra no `sync`" e "só-`cursor` → `is-empty`".

**Observações menores (não são lacunas de AC):**
- `F5-02` menciona explicitamente `is-empty` (`spec.md:70`); a asserção atual (`toEqual([])`) é um proxy
  fiel do resultado (lista vazia ⇒ `is-empty`), mas não pina a classe — mesma raiz de G1.
- A conta `cursor` **continua** no snapshot/statusline (decisão D1/`06` §6.5); nenhum teste afirma isso e a
  feature **não** deveria mexer — fora do diff, sem lacuna.
- `F5-06` é docs (sem teste): o roteiro está no commit lateral da raiz `18234fb` e o Handoff no próprio
  commit do submódulo (`8ec1f62`), ambos inspecionados.

## Requirement Traceability Update

| Requisito | Status anterior | Novo status |
| --- | --- | --- |
| F5-01..06 | Implementing | ✅ Verified (PASS, com G1 como fix task de teste de baixa severidade) |

## Nota do Verifier

- Verificação independente rederivada de `spec.md`, `design.md`, `tasks.md`, do diff `a0030cf..HEAD` (não
  do relato do autor) e dos testes; **nenhum** código de produção/teste foi alterado no fork (apenas este
  relatório).
- Mutantes injetados um a um em worktree descartável (`/tmp/opencode/f5-wt`, removido em seguida), com
  `node_modules` do fork por symlink; baseline `git status --porcelain` do tree real = **vazio** antes e
  depois (isolamento confirmado). Sem `git stash` em momento algum.
- Verdict ancorado em AC: os 6 ACs casam com o resultado da spec; a única sobrevivente (G1, U4/U5) é de
  *fiação/cobertura de teste*, sem cancelar nenhum AC nem bloquear a fase.

---

## Sensor complementar — pós-fix (resolvido em 2026-10-11)

O commit `4f759a4` (`refactor(cursor): testar a derivacao dos cartoes de uso`) extrai a derivação do
`UsageCards.render()` para a função pura `usageCardsView` (`usage.ts`) — lista **e** flag `empty` — e a
testa em `usage-source.test.ts`. Re-checagem do sensor em worktree descartável
(`/tmp/opencode/f5-fix-wt`, com os arquivos corrigidos copiados para o HEAD):

- **U5** (`empty` invertido): o caso `usageCardsView([cursor]) → {cards:[], empty:true}` **falha** com a
  mutação → **U5 morto**.
- **U4** (`render()` ignorando o filtro): residual **aceito conscientemente** — o repositório não monta DOM
  nos testes (`vitest` em `environment:'node'`), então a fiação de `render()` (uma linha que agora **delega**
  à pura) não é exercitável sem ambiente DOM; mesma natureza da fiação aceita na Fase 4 (G1). A lógica
  (filtro + vazio) fica 100% coberta pela pura; resta só o encadeamento de uma linha.

Árvore real limpa antes e depois; worktree removido; sem `git stash`.
