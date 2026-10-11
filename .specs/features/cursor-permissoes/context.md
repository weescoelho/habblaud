# Cursor Permissões Context

**Gathered:** 2026-10-11
**Spec:** `.specs/features/cursor-permissoes/spec.md`
**Status:** Ready for design

---

## Feature Boundary

Adaptar o fluxo de permissões do Cursor para que o agente **pare só quando precisa de você**:
cortar os eventos que pedem decisão por padrão (Shell/MCP), aplicar regras locais `allow`/`deny`
no hook sem bloquear, persistir "permitir sempre" a partir do escritório e documentar/verificar a
camada base (auto-run/allowlist nativo do Cursor). Não inclui terminal (Fase 3), histórico (Fase 4)
nem mensagens (Fase 5).

---

## Implementation Decisions

### Eventos que pedem decisão

- Padrão reduzido a `beforeShellExecution` e `beforeMCPExecution`; `preToolUse` e `beforeReadFile`
  passam a ser **observação** (continuam indo para `POST /api/cursor/events`).
- O conjunto é sobrescrevível por `decisionEvents` na config local, para quem quiser o rigor antigo.

### Regras locais (allowlist do hook)

- A política vive em `~/.habblaud/cursor-hook.json` (mesmo arquivo que o hook já lê hoje), numa chave
  nova de regras (`rules`), com `allow`/`deny` por ferramenta e padrão de comando/entrada.
- Avaliação **antes** de registrar no Habblaud; ordem `deny` > `allow` > escritório.
- Política ausente/ilegível/regra inválida = cai no fluxo anterior, sem lançar.

### "Permitir sempre" pelo escritório

- O Cursor não expressa "sempre" no hook; a decisão de "permitir sempre" é resolvida **no Habblaud**,
  que grava a regra `allow` no arquivo de política lido pelo hook.
- `POST /api/permissions/:id/decision` passa a aceitar "sempre permitir" para `cursor`; `codex`
  continua `unsupported` (hoje `server/permissions/registry.ts:177-180` recusa para os dois).

### Camada base (Cursor)

- Auto-run/allowlist nativo do Cursor é a base recomendada e documentada no runbook.
- `cursor:status` reporta eventos de decisão instalados e regras locais vigentes (somente leitura).

### Agent's Discretion

- Forma exata do schema de `rules` (nomes de campo, sintaxe de padrão/regex) e do arquivo de
  observabilidade: decisão de Design, desde que legível/editável à mão e documentada.
- Como derivar o "padrão" a partir do pedido no "permitir sempre" (ex.: comando exato vs prefixo):
  decisão de Design, priorizando previsibilidade sobre esperteza.

### Declined / Undiscussed Gray Areas → Assumptions

- **Fail-fast sem viewer** (só bloquear quando o escritório está aberto): oferecido no alinhamento e
  **não priorizado**. Registrado como assumption na spec — o hook mantém a espera até o timeout.
- **Gestão de regras pela UI**: fora de escopo; v1 usa o arquivo local + "permitir sempre" no diálogo.

---

## Specific References

- Captura real: `preToolUse` 465, `beforeReadFile` 180, `beforeShellExecution` 82 (`docs/cursor-export/p4-events.jsonl`).
- Hoje o hook registra pedido em `DECISION = {beforeShellExecution, beforeMCPExecution, beforeReadFile, preToolUse}` (`mod/habblaud-cursor/hook.mjs:55`).
- `registry.ts` já trata `cursor` como `hookOnly` (sem sugestões/perguntas) — mudar só para "sempre permitir".

---

## Deferred Ideas

- Fail-fast quando não há viewer no escritório (reavaliar após medir o volume com S1–S3).
- UI de gestão de regras (listar/editar/apagar) e uso de matchers do Cursor no instalador.
- Heurística de "comando perigoso" para sugerir `deny` por padrão.
- Emitir `ask` explícito quando o auto-run do Cursor estiver desligado (comportamento híbrido).
