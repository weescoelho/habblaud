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

- **Feature**: `cursor-subagents-history` (`.specs/features/cursor-subagents-history/`) — **Fase 4 do Cursor**: subagentes da IDE por hook, detecção de `git`/`gh` pelo transcript e histórico do terminal.
- **Phase / Task**: **Execute** concluído (T1–T8; `validate_spec.py` 0/0 e `validate_tasks.py` 0 erros). Validação independente (Verifier) **não** executada nesta rodada (autor = implementador; fora do escopo pedido).
- **Completed** (desta feature): T1 campos de subagente em `server/sources/cursor/rollout.ts` (`subagentId`/`subagentType`/`subagentTask`/`parentConversationId`, bordas `working`/`idle`); T2 subagentes na `CursorSource` (`addSub`/`completeSub`, chave `<conta>:s:<id>`, `parentId`, órfão/sem-id no-op, `poll` expira); T3 `cursorToolUses` exportado de `server/sources/cursor/transcript.ts`; T4 `server/sources/cursor/github.ts` (`cursorGitHubCall`/`cursorGitHubEvent`, fallback só-comando); T5 pump do transcript (`FileTail`/`seekEnd`) na `CursorSource`; T6 `server/sources/cursor/history.ts` (`CursorHistory implements HistoryProvider`); T7 registro no `HistorySet` em `server/index.ts` (só com `config.cursor`); T8 roteiro + este Handoff. Gate `typecheck` + `vitest` (107 files, 1373 passed / 2 skipped) + `build`.
- **Resultados documentados**: (a) o transcript do Cursor **não** grava `tool_result` (Fase 3), então a detecção de `git push`/`gh pr create`/`gh pr merge` é **só-comando** e **não confirma o sucesso** (possível falso positivo — limitação v1); CI/release não são emitidos (sem desfecho). (b) `firstAt`/`lastAt` do histórico caem no **mtime** (o transcript não tem horário) e o título sai do 1º prompt; o slug do projeto não é reversível, então `project` só aparece se a linha trouxer `cwd`.
- **In-progress** (file:line): nada.
- **Next step**: rodar o Verifier independente (autor ≠ verificador) para escrever `validation.md`; depois, na máquina com Cursor, validar **ao vivo** (subagentes da IDE, `git push`/PR pelo transcript e o histórico).
- **Blockers**: validação **ao vivo** exige a máquina do usuário; sem transcript/histórico o Cursor degrada para o comportamento por hook (atual).
- **Uncommitted files**: nenhum (este Handoff entra no commit de docs da Fase 4).
- **Branch**: `cursor-poc` (enviado para `origin/cursor-poc`). Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
