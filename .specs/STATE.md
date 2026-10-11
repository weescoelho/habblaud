# STATE

## Decisions

### AD-001
- **Decision**: Uma ferramenta nova (Claude Code, Codex, Cursor…) entra como um `AgentSource` **aditivo** (`Provider` ganha um membro na união) e, quando decide permissões, reusa o `PermissionRegistry` com comportamento **guardado por `provider`** — nunca reescrevendo o produto nem duplicando `Office`/`Hub`/long-poll.
- **Reason**: `06` §6.1/§6.2 recomendam estender (o pedido "se for possível estender, é prioridade"); o modelo multi-provedor já existe e o `Office`/`Hub`/cliente já são dirigidos por `provider`.
- **Trade-off**: duplica a forma da fonte por ferramenta e exige cuidado com arquivos compartilhados (a união `Provider` tem `Record<Provider,…>` exaustivos que passam a pedir a chave nova; o registro de permissões precisa de guardas por provider para não regredir as outras ferramentas).
- **Scope**: `shared/types.ts` (união `Provider`), `server/sources/*`, `server/permissions/*`, `server/accounts/*`, instaladores e hooks.
- **Date**: 2026-10-10
- **Status**: active

## Handoff

- **Feature**: `cursor-poc-p4-p8` (`.specs/features/cursor-poc-p4-p8/`) — POCs P4–P8 (uso/plano, subagentes, CLI `stream-json`, injeção no `stop`, histórico + efeitos `git`/`gh`)
- **Phase / Task**: Execute concluído — T1–T8 ✅ (a feature anterior `cursor-poc`/P0–P3 ficou com **GO**). Validação independente **pendente**.
- **Completed**: 8/8 tasks commitadas (T1 `33de82e` … T8 no repo-pai `f0fcf12`); harness entregue: subcomandos `usage`/`subagents`/`cli`/`followup`/`history` + probe `mod/habblaud-cursor/followup-hook.mjs`; runbook `docs/analise/10-runbook-poc-cursor-p4-p8.md` (fork); **gate build verde** (`typecheck` + `vitest` **1265 passed / 2 skipped** + `build`). Evidência real (export do usuário): **P8** ❌ provável (sem fonte de primeira parte → ocultar cartão), **P7** sucesso parcial (2 sessões: 25 e 9 turnos), **P4** "não observado" na amostra antiga (método corrigido — hooks de subagente agora instalados).
- **In-progress** (file:line): nada — working tree do fork limpo (o repo-pai tem o ponteiro do submodule por commitar).
- **Next step**: rodar o **Verifier independente** (autor ≠ verificador) → escrever `.specs/features/cursor-poc-p4-p8/validation.md`, marcar os ACs como `Verified` e rodar `validate_state.py cursor-poc-p4-p8`; depois, na máquina com Cursor, executar o runbook `10` para fechar **P4** (re-teste), **P5** (stream real) e **P6** (injeção real). PR upstream só com go-ahead explícito.
- **Blockers**: validação **ao vivo** de P4/P5/P6 pendente (exige a máquina do usuário). Pendência antiga: P2 ≥30 s por medir (não bloqueia a Fase 1).
- **Uncommitted files**: none no fork; no repo-pai resta o **ponteiro do submodule** (`projects/habblaud-main`) e o `HANDOFF.md` (untracked).
- **Branch**: `cursor-poc` (enviado para `origin/cursor-poc`). Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
