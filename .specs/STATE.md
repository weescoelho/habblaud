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

- **Feature**: `cursor-permissoes` (`.specs/features/cursor-permissoes/`) — **fluxo de permissões do Cursor sem travar**: decisão só para Shell/MCP (corta `preToolUse`/`beforeReadFile`), regras locais `allow`/`deny` aplicadas pelo hook, "permitir sempre" persistido pelo servidor e camada base (auto-run/allowlist do Cursor) documentada.
- **Phase / Task**: **Tasks** concluído (planejamento) — `spec.md` (19 ACs `CPERM-01..19`, 5 stories P1–P3), `context.md`, `design.md` e `tasks.md` (T1–T9 em 4 fases; `validate_spec.py` 0/0 e `validate_tasks.py` 0 erros). Aguardando aprovação para o **Execute**.
- **Completed** (desta feature): `spec.md` + `context.md` + `design.md` + `tasks.md`; `AD-002` registrada. **Rodada anterior**: `cursor-poc` P0–P3 → **GO** (29/29 ACs); `cursor-poc-p4-p8` implementada e validada de forma independente (`validation.md`, commit `8bcce47`; gate `typecheck` + `vitest` 1265 passed / 2 skipped + `build`).
- **In-progress** (file:line): nada — só os artefatos de planejamento desta feature, por commitar.
- **Next step**: aprovar o plano → **Execute** (T1–T9; P1 = T1/T2 já corta o travamento; P2 = T3–T7; docs = T8/T9). Depois, na máquina com Cursor, o runbook `10` fecha a validação **ao vivo** da rodada anterior (P4 re-teste, P5 stream real, P6 injeção real) e a pendência da P2 (≥30 s).
- **Blockers**: validação **ao vivo** P4/P5/P6 e P2 ≥30 s (exigem a máquina do usuário); fail-fast sem viewer ficou fora desta feature (assumption na spec).
- **Uncommitted files**: `.specs/features/cursor-permissoes/{spec,context,design,tasks}.md` (novos) e `.specs/STATE.md` (`AD-002` + este Handoff).
- **Branch**: `cursor-poc` (enviado para `origin/cursor-poc`). Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
