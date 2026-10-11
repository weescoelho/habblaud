# Validação — Subagentes, GitHub e histórico do Cursor (Fase 4)

**Veredito: PASS** — os 21 ACs (`CSH-01..21`) casam com o resultado definido pela `spec.md`; gate verde
(`typecheck` + `vitest` + `build`); **21 mutantes** de comportamento injetados, **21 mortos | 0
sobreviventes**. Nenhum AC sem evidência e nenhuma falha de comportamento; restam 2 **lacunas de precisão
de teste** (G1/G2, severidade baixa) que viram fix tasks, sem bloquear a fase.

**Diff validado:** `0de35db..HEAD` (`4a156d5`, branch `cursor-poc`: planejamento `4754793` + T1–T8).
**Data:** 2026-10-11 — verificação independente (Verifier ≠ autor), rederivada dos artefatos, do diff e dos testes.
Commit lateral no workspace raiz `fd97925` (`docs/analise/06-arquitetura-proposta.md` + ponteiro do
submódulo) entrou na revisão do artefato de docs (T8).

## Validation — resultado do gate

**Result**: PASS ✅ (21/21 ACs com evidência `file:line`; sensor 21/21 mortos; gate `typecheck`+`vitest`+`build` verde)

## Critérios de aceite (AC → status → evidência `file:line` + asserção)

O mapeamento AC→`CSH` segue a rastreabilidade de `spec.md:172-196`
(`CSH-01..07` = P1 "Subagentes por hook"; `CSH-08..13` = P1 "GitHub do transcript"; `CSH-14..19` = P1
"Histórico do terminal"; `CSH-20..21` = P2 "Degradação").

### P1 — Subagentes do Cursor por hook

| AC | Status | Evidência (`file:line` + asserção) |
| --- | --- | --- |
| **CSH-01** (`subagentStart` com id e pai → cria `kind:'sub'`, `parentId` do pai, começa `working`) | PASS | `server/sources/cursor/source.test.ts:281-288` — `toMatchObject({kind:'sub',parentId:'cursor:c1',account:'cursor',role:'Explore',title:'Mapear o repositório',status:'working'})`; fallback `parent_conversation_id`→`conversation_id` em `source.test.ts:299-301` (`parentId:'cursor:c1'`); impl. `server/sources/cursor/source.ts:293-297` (derivação do pai) e `:319-328` (`office.addSub`) |
| **CSH-02** (`subagentStop` casa o id → `completeSub`, `done`) | PASS | `source.test.ts:292-294` — `expect(ctx.agent('cursor:s:sa-1')?.status).toBe('done')` e principal segue `idle`; impl. `source.ts:282-290` (Stop → `leave` → `completeSub`) |
| **CSH-03** (`subagent_type`→`role` capitalizado, fallback `Subagente (Cursor)`; `task`→`title`) | PASS | `source.test.ts:285-286` (`role:'Explore'`, `title:'Mapear o repositório'`), `:301-302` (fallback `role:'Subagente (Cursor)'`, `title` `undefined`); parse `rollout.test.ts:112-146` (`subagentType`/`subagentTask`); impl. `rollout.ts:115-118,132-135` e `source.ts:35-38` (`roleOf`) |
| **CSH-04** (`subagentStop` órfão → no-op, sem lançar, principal intacto) | PASS | `source.test.ts:305-311` — `expect(agent('cursor:s:ninguem')).toBeUndefined()` e principal `idle`, com `hook(...)===true`; impl. `source.ts:282-290` (sem tracker → nada) |
| **CSH-05** (`subagentStart` sem id/pai conhecido → degrada, sem sub quebrado, principal intacto) | PASS | `source.test.ts:313-322` — `toBe(false)` para sem-id, sem-pai e pai desconhecido; `agent('cursor:s:sa-4'/'sa-5')` `undefined`; principal `idle`; impl. `source.ts:277-278,293-297` |
| **CSH-06** (`subagentStart`/`Stop` reconhecidos em `HOOK_EVENTS` + bordas `working`/`idle`, sem regressão) | PASS | `rollout.test.ts:241-242` — `statusBorder('subagentStart')→{status:'working'}`, `statusBorder('subagentStop')→{status:'idle'}`; sem regressão nas bordas atuais `rollout.test.ts:227-240`; reconhecimento `source.test.ts:280,308` (`hook(...)===true`); impl. `rollout.ts:220-223`, `source.ts:55-56`. **Corrigido em 2026-10-11**: a verificação original cobriu só o servidor e deixou passar o fio do hook (um evento fora de `EVENTS`/`OBSERVED` nunca chega à fonte) — ver "Correção do CSH-06 (fio do hook)" abaixo |
| **CSH-07** (`subagentStart` sem `Stop` → `poll` expira e completa, sem prender em `working`) | PASS | `source.test.ts:324-335` — após `STALE_PRESENCE_MS`, `expect(agent('cursor:s:sa-6')?.status).toBe('done')` e principal `working`; impl. `source.ts:161-169` (`poll`→`leave`) e `:352-361` (`leave` faz `completeSub` em `kind:'sub'`) |

### P1 — GitHub a partir do transcript do Cursor

| AC | Status | Evidência (`file:line` + asserção) |
| --- | --- | --- |
| **CSH-08** (fonte lê o transcript incrementalmente via `FileTail` p/ `Shell` git/gh) | PASS | `source.test.ts:362-373` — linha `Shell{gh pr create}` anexada gera, no `poll()`, atividade `tool:'GitHub'`; impl. `source.ts:177-206` (`pumpGitHub` + `FileTail.read`) |
| **CSH-09** (comando `git push`/`gh pr create`/`gh pr merge` → `office.githubEvent`) | PASS | `source.test.ts:370-372` — `expect(ctx.agent()?.activity?.tool).toBe('GitHub')`; regras `github.test.ts:45-54` (`pr_opened`/`pr_merged` com `number`) e `:37-43` (`push`); impl. `source.ts:197-204` (emite `office.githubEvent`) e `github.ts:34-63` |
| **CSH-10** (detecção em `server/sources/cursor/github.ts`, sem duplicar regras) | PASS | `github.test.ts:9-10` (`Shell`→`Bash` via `githubCallOf`), `:28-33` (`mcp__…` passa direto); extração única `transcript.test.ts:171-196` (`cursorToolUses`); impl. `github.ts:15-25` (delega `githubCallOf`), `transcript.ts:173-176` |
| **CSH-11** (1º attach a transcript com conteúdo → `seekEnd`, sem reemitir) | PASS | `source.test.ts:365-368` — `git push` pré-existente **não** vira atividade no 1º `poll()` (`tool` ≠ `'GitHub'`); depois do append, `:370-372` vira; impl. `source.ts:180-184` (`seekEnd()` no 1º attach) |
| **CSH-12** (sem `tool_result` → fallback só-comando respeitando `--dry-run`/`--delete`/`--auto`; limitação documentada) | PASS | `github.test.ts:38-43` (`push`→`{kind:'push'}`; `--dry-run`/`--delete`→`undefined`), `:45-54` (`pr create`→`pr_opened` com `repo`; `pr merge 12`→`pr_merged` com `number`; `--auto`→`undefined`), `:56-60` (CI/release→`undefined`); documentado `.specs/STATE.md` (Handoff) e `docs/analise/06-arquitetura-proposta.md` §6.8 (commit raiz `fd97925`); impl. `github.ts:42-63` |
| **CSH-13** (transcript ausente/opaco → degrada sem lançar, presença/atividade intactas) | PASS | `source.test.ts:394-403` — arquivo ausente: `poll()` não lança (`not.toThrow`) e sem atividade GitHub; quando aparece, passa a ler (`toBe('GitHub')`); `:384-392` sem `transcript_path`; impl. `source.ts:186-196` (`catch`/`missing`/`reset` degradam) |

### P1 — Histórico do terminal do Cursor

| AC | Status | Evidência (`file:line` + asserção) |
| --- | --- | --- |
| **CSH-14** (`list()` varre os transcripts e devolve `RecentSession[]` com `account`/`provider`/`sessionId`/`projectDir`/`lastAt`(mtime)/`size`/`open`) | PASS | `history.test.ts:72-85` — `toEqual(['sess-a','sess-b'])` (fora da janela de 7 dias é excluído) e `toMatchObject({account:'cursor',provider:'cursor',sessionId:'sess-a',projectDir:'proj-a',lastAt:statSync(a).mtimeMs,open:true,agentId:'cursor:sess-a'})`, `open:false` sem agente `:85-86`; impl. `history.ts:87-119` |
| **CSH-15** (`list()` inclui `title` do 1º prompt, `project` do `cwd`, `firstAt`=mtime) | PASS | `history.test.ts:100` — `expect(a.title).toBe(truncate(long,90))`; `:101` sem prompt → `undefined`; `:110` `project:'/home/ana/loja'` (cwd da linha) e `:111` sem cwd → `undefined`; `:79-80` `firstAt===statSync(a).mtimeMs`; impl. `history.ts:103-116` e `readCursorSummary` `:201-233` |
| **CSH-16** (`resolve` → `{path, createParser}` com parser novo por chamada) | PASS | `history.test.ts:119-122` — `expect('path' in r && r.path).toBe(path)` e `expect(r.createParser()).not.toBe(r.createParser())`; impl. `history.ts:145` (`createParser: createCursorTerminalParser`) |
| **CSH-17** (conta/sessão desconhecida/inválida ou arquivo fora da conta → 400/404, nunca lança) | PASS | `history.test.ts:124` — `toEqual({status:400,error:'id de sessão inválido'})` p/ `'../../etc/passwd'`; `:125` `toEqual({status:404,error:'conta desconhecida'})`; `:126` sessão 404; `:128-135` link p/ fora da conta → `status:404`; id só `[A-Za-z0-9_-]` `:195-201`; impl. `history.ts:125-151` (valida id + `realpathSync` contido em `root+sep`) |
| **CSH-18** (`config.cursor` ligado → `HistorySet` recebe `CursorHistory`; conta `'cursor'` despachada) | PASS (registro coberto só pelo build; despacho testado) | `history.test.ts:180-193` — `HistorySet([claude, history])` resolve `'cursor'` para o `CursorHistory` (`path` da sessão) e outra conta → 404; `hasAccount('cursor')===true`/`'.outra'===false` `:87-88`; impl. `server/index.ts:128-129` (`if (history && cursor) history.add(new CursorHistory(...))`) |
| **CSH-19** (projeto/transcript ilegível dentro da janela → `list()` ignora sem derrubar) | PASS | `history.test.ts:138-148` — candidato com link quebrado ignorado, `await list()` resolve `['sess-a']`; impl. `history.ts:172-178` (`try/catch` no `stat`) e `:191-194` |

### P2 — Degradação sem transcript/histórico/efeitos

| AC | Status | Evidência (`file:line` + asserção) |
| --- | --- | --- |
| **CSH-20** (sem transcript/histórico/evento → presença e atividades por hook seguem, sem lançar) | PASS | `source.test.ts:384-392` — sem `transcript_path`: `expect(()=>ctx.poll()).not.toThrow()`, `status:'working'`, `activity.tool:'Bash'` e `transcriptPathOf` `undefined`; impl. `source.ts:177-179` (guard `!path`) |
| **CSH-21** (Cursor desligado → fontes/histórico de Claude e Codex inalterados) | PASS (registro condicional coberto só pelo build) | `source.test.ts:257-262` — `expect(accounts.entries()).toEqual([])` e `entriesOf('cursor')===['cursor']` (o Cursor não cria conta externa); isolamento do despacho `history.test.ts:180-193`; impl. `server/index.ts:128-129` (aditivo, guardado por `cursor`) — o diff **não** altera nenhum arquivo de Claude/Codex |

**Status**: 21/21 ACs com evidência `file:line`; 0 falhas de comportamento; 2 lacunas de precisão (G1/G2).

## Edge cases (`spec.md:165-170`)

| Edge case | Status | Evidência |
| --- | --- | --- |
| `subagentStart`/`Stop` sem `hook_event_name` reconhecível → `false`, sem lançar | ✅ | `source.test.ts:135-143` (`{hook_event_name:'desconhecido'}` e `{}` → `false`; estado intacto); `rollout.ts:224-225` |
| `sessionEnd` do principal → subs filhos saem via `closeMain` | ✅ | `source.test.ts:337-344` (`sub sa-7` → `done`; principal `offline`); impl. `source.ts:231-232` |
| Linha de transcript não-JSON / sem `tool_use` → ignorada, sem lançar | ✅ | `transcript.test.ts:191-196` (`[]` p/ inválida/branco/turno/texto); `transcript.ts:173-176` |
| Transcript truncado/rotacionado → `seekEnd`, sem reemitir | ✅ | `source.test.ts:405-415` (`not.toBe('GitHub')` após rotação); impl. `source.ts:192-196` (`r.reset`) |
| `git push --dry-run`/`--delete` ou `gh pr merge --auto` → não emite | ✅ | `github.test.ts:39-42,51-53`; impl. `github.ts:45,57` (`!call.auto`/`!call.noPush`) |
| `resolve` com separadores de caminho → 400 sem tocar o disco | ✅ | `history.test.ts:124,198-200`; impl. `history.ts:126` (`isCursorSessionId` antes de qualquer I/O) |

## Sensor de discriminação (fault injection, um mutante por vez, em worktree descartável)

Metodologia: 21 mutantes de **nível de comportamento** injetados um a um em `/tmp/opencode/csh-wt`
(`git worktree add --detach HEAD`, `node_modules` por symlink; **nunca** `git stash`, nunca o tree real);
cada mutante aplicado, testado (`npx vitest run server/sources/cursor/`) e revertido (`git checkout -- <arquivo>`);
"morto" = exit ≠ 0. Ao final o worktree foi removido e o `git status --porcelain` do tree real voltou a
**0** (baseline preservada; `diff` antes/depois vazio).

| Mutante | Falha de comportamento injetada | Arquivo | Resultado |
| --- | --- | --- | --- |
| M1 | `subagentStop` procura chave errada (`key+'z'`): Start↔Stop não correlaciona por id | `cursor/source.ts` | KILLED (`source.test.ts` "subagentStart…/subagentStop entrega" falha) |
| M2 | `parentId` derivado errado (`<conta>:x:<pai>`) | `cursor/source.ts` | KILLED (1/… falha) |
| M3 | `roleOf` não capitaliza o `subagent_type` | `cursor/source.ts` | KILLED |
| M4 | `task` (título) deixa de ser lido (`input.task`→`input.objective`) | `cursor/rollout.ts` | KILLED (`rollout.test.ts` normalização) |
| M5 | `subagentStop` órfão deixa de ser no-op (`leave(t!)` em inexistente → lança/`false`) | `cursor/source.ts` | KILLED (1 falha) |
| M6 | `subagentStart` sem `subagent_id` deixa de degradar (default `'x'` → cria sub) | `cursor/source.ts` | KILLED (1 falha) |
| M7 | `poll` não completa o sub expirado (só `kind:'main'` sai) | `cursor/source.ts` | KILLED (1 falha: sub preso em `working`) |
| M8 | 1º attach sem `seekEnd()` (reemite `git push` antigo) | `cursor/source.ts` | KILLED (`seekEnd ignora o conteúdo antigo` falha) |
| M9 | Transcript ausente descarta o `tail` (não lê quando reaparece) | `cursor/source.ts` | KILLED (`transcript ausente degrada… aparece` falha) |
| M10 | `pumpGitHub` deixa de emitir `office.githubEvent` | `cursor/source.ts` | KILLED (`a linha nova vira atividade do GitHub` falha) |
| M17 | `statusBorder('subagentStart')` → `idle` (em vez de `working`) | `cursor/rollout.ts` | KILLED (`rollout.test.ts:241`) |
| M18 | `leave` não distingue `sub` do principal (`completeSub` perdido) | `cursor/source.ts` | KILLED (`subagentStop entrega` → status ≠ `done`) |
| M21 | Trava `--dry-run`/`--delete` ignorada (`!call.noPush` removido) | `cursor/github.ts` | KILLED (`github.test.ts:41-42`) |
| M11 | `list()` devolve `provider:'codex'` | `cursor/history.ts` | KILLED (`history.test.ts:75`) |
| M20 | `hasAccount` sempre `true` (conta desconhecida passa) | `cursor/history.ts` | KILLED (`history.test.ts:88`) |
| M12 | `title` do 1º prompt deixa de ser extraído | `cursor/history.ts` | KILLED (`history.test.ts:100`) |
| M13 | `project` (cwd decodificado) deixa de ser extraído | `cursor/history.ts` | KILLED (`history.test.ts:110`) |
| M15 | `sessionId` inválido deixa de dar 400 | `cursor/history.ts` | KILLED (`history.test.ts:124` → 404 em vez de 400) |
| M14 | `resolve` aceita link apontando p/ fora da conta (path traversal) | `cursor/history.ts` | KILLED (`history.test.ts:135` → `path` em vez de `404`) |
| M19 | `resolve` compartilha um parser (não é novo por chamada) | `cursor/history.ts` | KILLED (`history.test.ts:121` `not.toBe`) |
| M16 | Candidato ilegível derruba a listagem (sem `try/catch`) | `cursor/history.ts` | KILLED (`history.test.ts:146` rejeita em vez de resolver) |

**Sensor depth**: lightweight estendido (21 mutantes; feature P1/P2, sem caminho P0 de pagamento/auth).
**Resultado do sensor**: **21/21 mortos**.

**Não-regressão Claude/Codex**: o diff `0de35db..HEAD` não toca nenhum arquivo de `server/sources/{claude,codex}`
nem `server/sources/history.ts`; a única linha em `server/index.ts` é aditiva e guardada por `cursor`.
A suíte inteira (Claude/Codex inclusos) permanece verde no tree real (ver Gate abaixo), e as mutações acima
só provocam falha nos arquivos do Cursor.

## Gates (rodados no tree real, sem mutações, tree limpa)

| Gate | Comando | Resultado |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Testes | `npm test` | 107 arquivos, **1373 passed | 2 skipped (1375)**, exit 0 |
| Build | `npm run build` | exit 0 (client + `dist/server/index.js` 586.7 kb) |
| Arquivos da feature (quick) | `npx vitest run server/sources/cursor/` | **114 passed** (6 arquivos) |

**Integridade dos testes**: baseline independente em `0de35db` = 105 arquivos, **1336 passed | 2 skipped
(1338)**; após a feature = 107 arquivos, **1373 passed | 2 skipped (1375)** → **+2 arquivos, +37 testes**.
O diff não remove nenhum caso (`git diff 0de35db..HEAD | grep -cE '^\-\s*(it|test)\('` = **0**);
a única linha removida em teste é um import de `transcript.test.ts` (substituído por um mais amplo). Sem
enfraquecimento de asserção.

## Lacunas (ranqueadas por severidade)

1. **G1 — BAIXA · CSH-18/CSH-21: o registro condicional do `CursorHistory` no `HistorySet` não é discriminado por teste.**
   `T7` declara `Tests: none` e cobre a tarefa só pelo build gate; a metade "despacho por conta" é testada
   (`history.test.ts:180-193`), mas a condição `if (history && cursor)` (`server/index.ts:128-129`) — que
   garante "só com `config.cursor`" e "não regride Claude/Codex" — não tem asserção própria. **O
   comportamento implementado está correto** (linha aditiva e guardada, idêntica ao padrão do Codex); é
   lacuna de *teste*, não de AC. → **Fix task (baixa)**: extrair a montagem do `HistorySet` para um helper
   testável (ou um teste de fiação) que prove "com Cursor ligado registra `CursorHistory`; desligado não o
   registra, mantendo Claude/Codex".
2. **G2 — BAIXA · CSH-09: o teste de integração do pump não fixa o *tipo* do evento do GitHub.**
   `source.test.ts:370-372` confere só `activity.tool === 'GitHub'`, enquanto a spec (`spec.md:107-108`)
   fala "o evento correspondente" (`pr_opened` para `gh pr create`). O tipo é fixado no nível unitário
   (`github.test.ts:45-54`), mas a asserção de integração não distingue `push` de `pr_opened`. Não é falha
   de comportamento. → **Fix task (baixa)**: no teste do pump, asseverar o `kind` (ou o id de atividade
   `#gh:…:pr_opened`).

**Observações menores (não são lacunas de AC):**
- O `CursorHistory` não lista subagentes do Cursor (sem transcript próprio): decisão documentada
  (`history.ts:10`, `STATE.md`), fora do escopo.
- `firstAt`/`lastAt` caem no mtime (o transcript não grava horário) — coincidem por design; a spec
  (`spec.md:59`) já fixa esse default e o teste pina `statSync(...).mtimeMs`.
- `transcript.test.ts:1` mantém o comentário histórico de `CPOC-*`; sem impacto (o teste da Fase 4 é o
  bloco `cursorToolUses` sintético).

## Requirement Traceability Update

| Requisito | Status anterior | Novo status |
| --- | --- | --- |
| CSH-01..21 | Implementing | ✅ Verified (PASS, com G1/G2 como fix tasks de teste) |

## Nota do Verifier

- Verificação independente rederivada de `spec.md`, `design.md`, `tasks.md`, do diff `0de35db..HEAD` e dos
  testes; **nenhum** código de produção/teste foi alterado no fork (apenas este relatório).
- Mutantes injetados um a um em worktree descartável (`/tmp/opencode/csh-wt`, removido em seguida), com
  `node_modules` do fork por symlink; baseline `git status --porcelain` = **0** antes e depois (isolamento
  confirmado por `diff`). Sem `git stash` em momento algum. Spot-check (M1/M8/M14/M16) confirmou que as
  falhas são as asserções certas, não erro de carga.
- Verdict ancorado em AC: os 21 ACs casam com o resultado da spec; as 2 lacunas (G1/G2) são de *teste*
  (fiação/kind), sem bloqueio do MVP.

---

## Resoluções (fix tasks G1/G2) — 2026-10-11

- **G2 (CSH-09) — corrigida** no commit de fix: `server/sources/cursor/source.test.ts` passa a exigir
  o evento do GitHub específico (`kind: 'git'`, `text: 'Abriu um PR'`) para `gh pr create`, em vez de só
  `activity.tool === 'GitHub'`. Um `push` genérico (texto "Enviou commits…") não passaria.
- **G1 (CSH-18/CSH-21) — aceita conscientemente (não é bug)**: o guard `if (history && cursor)`
  (`server/index.ts`) fica no *entrypoint*, que este repositório não testa unitariamente (nenhum teste
  importa `server/index.ts`); a montagem do `HistorySet` é coberta por build gate e o padrão é idêntico ao
  do Codex. Extrair a montagem só para testar um guard trivial seria refactor sem retorno — fica registrado
  como pendência de cobertura de fiação, não como lacuna de comportamento. Lição `L-003` mantida como
  candidata para uma futura costura de composição testável.

---

## Correção do CSH-06 (fio do hook) — 2026-10-11

**Defeito encontrado em uso real** (relato: "ao abrir subagentes do Cursor, ele não aninha ao agente
principal; aparece como novo agente"). Causa raiz: o tratamento de subagente existe no servidor
(`source.ts` `subagentEvent`/`addSub`, `rollout.ts` `statusBorder`), mas **nunca recebia os eventos** —
o fio do hook estava rompido em **dois pontos**, e a verificação original do CSH-06 só olhou a camada do
servidor (`HOOK_EVENTS`/`statusBorder`):

1. `scripts/cursor-install.ts` (`EVENTS`, que escreve `hooks.json`): **faltavam** `subagentStart`/
   `subagentStop` → o IDE nunca era configurado para chamar o hook nesses eventos.
2. `mod/habblaud-cursor/hook.mjs` (`OBSERVED`): **faltavam** os mesmos eventos → mesmo que chegassem,
   o hook os descartava antes do POST (`hook.mjs:297`).

Em produção, o `source.ts:275-330` era código morto (só passava em testes que chamam `ctx.hook(...)`
direto, furando o script do hook). O harness já tinha os dois eventos desde a `cursor-poc-p4-p8`
(`HARNESS_EVENTS`, CP48-05) — a "correção de método" não tinha sido replicada no produto.

**Correção:** `subagentStart`/`subagentStop` acrescentados a `EVENTS` e a `OBSERVED` (17 eventos no
total, espelhando o harness). Testes que travam a regressão:

- `server/test/cursor-install.test.ts` — `EVENTS` contém os dois eventos (paridade com o harness).
- `server/test/cursor-hook.test.ts` — (a) **paridade** `[...OBSERVED].sort()` = `[...EVENTS].sort()`
  (um evento instalado e não observado — ou o contrário — é silêncio); (b) **ponta a ponta** pelo
  processo: `subagentStart`/`subagentStop` chegam a `/api/cursor/events`.
- `server/test/cursor-setup.test.ts` — texto do `setup` agora "17 eventos".

**Sensor:** removendo `subagentStart` de `OBSERVED` → 2 falhas (paridade + processo); removendo
`subagentStop` de `EVENTS` → 1 falha (instalador). Gate verde: `typecheck` + `vitest` (107 arquivos,
1380 passed/2 skipped) + `build`.

**Pendência do usuário:** o fio só passa a valer na máquina depois de **reinstalar** o hook
(`npm run cursor:setup` reescreve `hooks.json` com os 17 eventos).
