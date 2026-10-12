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
- **Phase / Task**: **Execute em andamento — lotes B1 (T1–T8) e B2 (T9–T13) concluídos**. B2 = `1db1fbd`..`6037bc9`. Gate do lote verificado pelo orquestrador: `npm run typecheck && npm test && npm run build` → 110 arquivos / **1426 passed / 2 skipped**, build OK. Próximo: **lote B3 (P5, T14–T22)**. Usuário aprovou o Execute com 4 lotes de sub-agentes (B1 P1+P2=8, B2 P3+P4=5, B3 P5=9, B4 P6+P7+P8=12).
- **Completed** (recente): B2 — fila "Precisa de você" (`client/src/ui/inbox-model.ts` T9 + seção no `drawer.ts` T10) e mosaico de sessões (`client/src/ui/mosaic-model.ts` T11 + `mosaic.ts` T12 + registro em `index.ts` T13). B1 — `TranscriptHub`/`fs.watch` (T1/T2), `TerminalStreams`/`CursorSource` assinam o hub (T3/T4), diff `afterFileEdit`→`Activity`→terminal (T5–T8). Antes: bugfixes `CSH-06`/`CSH-22` e artefatos da `sala-de-controle`.
- **In-progress** (file:line): nada; próximo é despachar o **lote B3** (P5 tarefas headless T14–T22).
- **Next step**: despachar B3 (fase P5) ao worker; depois B4 e, ao fim, o **Verifier independente** (autor ≠ verificador) + `validate_state.py`.
- **Blockers**: validação **ao vivo** do `stop.followup_message` (máquina do usuário — lacuna C7).
- **Uncommitted files**: nenhum. Config local da máquina: capturador da POC ainda instalado em `~/.cursor/hooks.json` (17 eventos com 2 comandos) — limpar com `npm run cursor:poc:uninstall` quando quiser.
- **Branch**: `cursor-poc-v2`. Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
