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

- **Feature**: `cursor-poc` (`.specs/features/cursor-poc/`) — POCs P0–P3 (transcript, cobertura de hooks, bloqueio de decisão e ingestão no escritório)
- **Phase / Task**: Execute concluído — T1–T18 ✅; validação independente PASS; runbook entregue; **validação ao vivo (P0–P3) concluída** na IDE do Cursor (relatório `docs/relatorio-poc-cursor-2026-10-10.md`, no repo-pai). Decisão **GO** para a Fase 1. Parado antes de P4–P8 (aguardando decisão do usuário).
- **Completed**: 18/18 tasks (T1–T18) commitadas; Fix 1 (`2e7cf02`) fechou a lacuna de CPOC-08 (rota `{ok:false}` para evento desconhecido); Verifier independente PASS (`validation.md`: 29/29 ACs, 12/13 mutações killed, M11 equivalente; gate 1224 passed / 2 skipped); `validate_state.py` exit 0; **POC ao vivo**: P1 ✅ (15 eventos na IDE), P3 ✅ (agente `cursor` no escritório, sem regressão no Codex), P2 ✅ (`allow`/`deny` nativos; bloqueio ~20 s; config 35 s), P0 🟡 parcial (transcript JSONL legível; tool-calls por mapear — C1).
- **In-progress** (file:line): nada — working tree limpo na branch `cursor-poc`.
- **Next step**: decidir P4–P8 (a Fase 1 tem **GO**); fechar as pendências de C1 (tool-calls do transcript) e do critério de ≥30 s do P2. PR upstream só com go-ahead explícito.
- **Blockers**: C1 🟡 parcial (tool-calls do transcript por mapear) e P2 ≥30 s por medir — **não bloqueiam** a Fase 1 (modo "hooks-only").
- **Uncommitted files**: none (`.specs/` do fork versionado; `docs/analise/08-runbook-poc-cursor.md` commitado dentro do fork).
- **Branch**: `cursor-poc` (enviado para `origin/cursor-poc`). Remotes: `origin` = fork `weescoelho/habblaud`; `upstream` = `marmottajr/habblaud`.
