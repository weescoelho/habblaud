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

- **Feature**: `sala-de-controle` (`.specs/features/sala-de-controle/`) — observabilidade em tempo real, triagem, controle de agentes e salas por projeto (8 histórias `SC-01..SC-40`). Pré-requisitos corrigidos: `CSH-06` (fio do hook de subagente) e `CSH-22` (terminal do sub).
- **Phase / Task**: **Design + Tasks finalizados e validados** — `validate_spec.py` 0/0; `validate_tasks.py` 0 erros / 12 avisos (avisos = `Tests: none` de tarefas de tipo/wiring/hook, já declaradas como `none` na matriz de cobertura). 34 tasks / 8 fases. Aguardando a decisão do usuário sobre o **Execute** (offer de sub-agentes obrigatório: 34 > 1 batch).
- **Completed** (recente): bugfix `CSH-06` (17 eventos em `EVENTS`+`OBSERVED`) e `CSH-22` (transcript próprio do sub resolvido no Stop). Artefatos da `sala-de-controle` (spec/context/design/tasks) commitados; runbook `12` e o bugfix `CSH-22` já commitados.
- **In-progress** (file:line): nenhum código; `.specs/features/sala-de-controle/tasks.md` pronto para o Execute.
- **Next step**: apresentar o plano de Execute (batches ~7: P1+P2, P3+P4, P5, P6+P7, P8 + Verifier independente ao final) e obter o go-ahead; então iniciar T1.
- **Blockers**: aprovação do usuário para o Execute; validação **ao vivo** do `stop.followup_message` (máquina do usuário — lacuna C7).
- **Uncommitted files**: nenhum da feature (artefatos commitados). Config local da máquina: capturador da POC ainda instalado em `~/.cursor/hooks.json` (17 eventos com 2 comandos) — limpar com `npm run cursor:poc:uninstall` quando quiser.
- **Branch**: `cursor-poc-v2`. Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
