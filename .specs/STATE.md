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

- **Feature**: `cursor-poc` (`.specs/features/cursor-poc/`)
- **Phase / Task**: Design — escrevendo `design.md`
- **Completed**: Spec aprovada (29 ACs, IDs `CPOC-01..29`), context aprovado, reconhecimento do código (fontes Codex, rota de eventos, permissões, Office, instalador/hook, contas) concluído
- **In-progress** (file:line): `.specs/features/cursor-poc/design.md` — em redação
- **Next step**: concluir `design.md`, apresentar para aprovação e derivar `tasks.md`
- **Blockers**: none
- **Uncommitted files**: `.specs/` (untracked no fork), `projects/habblaud-main` na branch `main`
- **Branch**: main (branch de trabalho planejada: `cursor-poc`)
