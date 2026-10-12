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
- **Phase / Task**: **Execute em andamento — lotes B1 (T1–T8), B2 (T9–T13) e B3 (T14–T22) concluídos**. B3 = `605141e`..`31eb4dd` (worker fez T14–T21, parou no meio do T22 por erro transitório de provedor; o orquestrador concluiu o T22 — `TaskLauncher` no `client/src/ui/index.ts`). Gate do lote: `npm run typecheck && npm test && npm run build` → 114 arquivos / **1488 passed / 2 skipped**, build OK. Resta **B4 (P6+P7+P8, T23–T34)** e o Verifier. Usuário aprovou o Execute com 4 lotes (B4 = P6+P7+P8 = 12).
- **Completed** (recente): B3 — `WorktreeManager` (T14), normalizador stream-json (T15), tipos `CursorTaskInfo`/`tasks` aditivos (T16), `TaskManager` create/stop/resume/reconcile (T17), integração no `CursorSource` (T18), rotas `/api/tasks*` (T19–T20), modelo de tarefa no cliente (T21) e ação "Nova tarefa" no launcher (T22). B1/B2 — leitura por hub + diff + triagem + mosaico.
- **In-progress** (file:line): nada; próximo é despachar o **lote B4** (P6 mensagens T23–T26; P7 skills T27–T32; P8 salas T33–T34).
- **Next step**: despachar B4; ao fim, rodar o **Verifier independente** (autor ≠ verificador) + `validate_state.py`.
- **Blockers**: validação **ao vivo** do `stop.followup_message` (máquina do usuário — lacuna C7).
- **Uncommitted files**: nenhum. Config local da máquina: capturador da POC ainda instalado em `~/.cursor/hooks.json` (17 eventos com 2 comandos) — limpar com `npm run cursor:poc:uninstall` quando quiser.
- **Branch**: `cursor-poc-v2`. Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
