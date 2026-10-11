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

- **Feature**: `cursor-uso-mensagens` (`.specs/features/cursor-uso-mensagens/`) — **Fase 5 do Cursor**: uso do plano (ocultar o cartão) e mensagens (não oferecer na v1).
- **Phase / Task**: **Execute** concluído (T1–T4; `validate_spec.py` 0/0 e `validate_tasks.py` 0 erros). Validação independente (Verifier) será executada por subagente separado (autor ≠ verificador).
- **Completed** (desta feature): T1 `spec.md`/`design.md`/`tasks.md`; T2 `client/src/ui/usage.ts` (`usageCardAccounts`, filtro por `provider !== 'cursor'` no `UsageCards.render`; a conta `cursor` segue no snapshot/statusline); T3 `client/src/ui/composer-model.ts` (`CURSOR_OFF_TEXT` + ramo `provider === 'cursor'` → `off`, depois de replay/sub/offline, sem tocar em claude/codex); T4 roteiro (`06` §6.8, raiz) + este Handoff. Gate `typecheck` + `vitest` (107 files, 1378 passed / 2 skipped) + `build`.
- **Resultados documentados**: (a) o Cursor **não tem** fonte local de uso do plano (P8: **🔴 confirmado** — só config/telemetria e `plans/`) → cartão de uso oculto na v1. (b) a v1 **não oferece** "Mandar mensagens" (P6 validou só a **forma** do `stop.followup_message`; efeito ao vivo pendente, lacuna C7) — o probe `mod/habblaud-cursor/followup-hook.mjs` segue como caminho validado para uma v2.
- **In-progress** (file:line): nada.
- **Next step**: rodar o Verifier independente (autor ≠ verificador) para escrever `validation.md`; depois, na máquina com Cursor, medir o efeito **ao vivo** do `followup_message` (P6/C7).
- **Blockers**: a validação ao vivo de mensagens exige a máquina do usuário; a UI degrada para "responder no Cursor".
- **Uncommitted files**: nenhum (este Handoff entra no commit de docs da Fase 5).
- **Branch**: `cursor-poc` (enviado para `origin/cursor-poc`). Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
