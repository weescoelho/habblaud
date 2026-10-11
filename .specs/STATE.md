# STATE

## Decisions

### AD-001
- **Decision**: Uma ferramenta nova (Claude Code, Codex, Cursor…) entra como um `AgentSource` **aditivo** (`Provider` ganha um membro na união) e, quando decide permissões, reusa o `PermissionRegistry` com comportamento **guardado por `provider`** — nunca reescrevendo o produto nem duplicando `Office`/`Hub`/long-poll.
- **Reason**: `06` §6.1/§6.2 recomendam estender (o pedido "se for possível estender, é prioridade"); o modelo multi-provedor já existe e o `Office`/`Hub`/cliente já são dirigidos por `provider`.
- **Trade-off**: duplica a forma da fonte por ferramenta e exige cuidado com arquivos compartilhados (a união `Provider` tem `Record<Provider,…>` exaustivos que passam a pedir a chave nova; o registro de permissões precisa de guardas por provider para não regredir as outras ferramentas).
- **Scope**: `shared/types.ts` (união `Provider`), `server/sources/*`, `server/permissions/*`, `server/accounts/*`, instaladores e hooks.
- **Date**: 2026-10-10
- **Status**: active

### AD-002
- **Decision**: O "sempre permitir" do Cursor é emulado por uma **política local** (`~/.habblaud/cursor-hook.json` → `rules`): o **hook** deriva o padrão (prefixo ancorado) e o envia no pedido (`suggest_rule`); o **servidor** expõe como sugestão, valida e **grava** a regra; o **hook**, na próxima vez, aplica a regra e decide sem contatar o Habblaud. A redução do volume é feita por `decisionEvents` (padrão: só `beforeShellExecution`/`beforeMCPExecution` viram decisão; o resto segue observação).
- **Reason**: o Cursor não expõe `updatedPermissions` e o hook dele só expressa `allow`/`deny`; a derivação no hook mantém uma **fonte única** do padrão (o servidor grava opaco), e o arquivo já era lido pelo hook.
- **Trade-off**: arquivo compartilhado (servidor grava × hook lê) exige escrita atômica (temp+rename) e tolerância a JSON malformado; o padrão derivado é de prefixo (previsível, não coringa); falha ao gravar não desfaz a aprovação do momento.
- **Scope**: `mod/habblaud-cursor/{policy,hook}.mjs`, `server/permissions/{registry,cursor-rules}.ts`, `server/index.ts`, `client/src/ui/permission.ts`, `scripts/cursor-install.ts`.
- **Date**: 2026-10-11
- **Status**: active

## Handoff

- **Feature**: `sala-de-controle` (`.specs/features/sala-de-controle/`) — observabilidade em tempo real, triagem, controle de agentes e salas por projeto (8 histórias `SC-01..SC-40`). Pré-requisito corrigido: bugfix do `CSH-06` (`cursor-subagents-history`).
- **Phase / Task**: **Design + Tasks escritos**; aguardando aprovação do usuário para iniciar o **Execute** (batches ~7 tasks; Verifier independente ao final). Bugfix do `CSH-06` concluído neste commit (fio do hook de subagente: `EVENTS`+`OBSERVED`).
- **Completed** (recente): bugfix `CSH-06` — `subagentStart`/`subagentStop` em `scripts/cursor-install.ts` (`EVENTS`) e `mod/habblaud-cursor/hook.mjs` (`OBSERVED`), com paridade `OBSERVED`×`EVENTS` e teste ponta a ponta (`server/test/cursor-hook.test.ts`, `cursor-install.test.ts`, `cursor-setup.test.ts`; 17 eventos). `sala-de-controle`: `spec.md` (`validate_spec.py --strict` 0/0), `context.md` (rodadas 1–6), `design.md` e `tasks.md` (34 tasks / 8 fases).
- **Resultados documentados**: subagentes do Cursor **não aninhavam** porque os eventos de subagente nunca chegavam ao servidor (código morto em produção); corrigido — exige **reinstalar** o hook (`npm run cursor:setup`) para valer na máquina. `sala-de-controle` depende disso em `SC-37` (subagente na mesma sala do principal).
- **In-progress** (file:line): `.specs/features/sala-de-controle/tasks.md` — corrigir os diagramas para o `validate_tasks.py` passar 0 erros (fences com box-drawing → uma aresta `Tx -> Ty` por linha).
- **Next step**: corrigir os diagramas, rodar `validate_tasks.py` (0 erros), apresentar design+tasks e pedir aprovação do Execute.
- **Blockers**: aprovação do usuário para o Execute; validação **ao vivo** do `stop.followup_message` (máquina do usuário — lacuna C7).
- **Uncommitted files**: `.specs/features/sala-de-controle/` (spec/context/design/tasks) — feature em rascunho, ainda não commitada.
- **Branch**: `cursor-poc-v2`. Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
