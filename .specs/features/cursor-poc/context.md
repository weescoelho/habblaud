# Cursor POC Context

**Gathered:** 2026-10-10
**Spec:** `.specs/features/cursor-poc/spec.md`
**Status:** Ready for design

---

## Feature Boundary

Entregar o harness portável das POCs **P0–P3** (descritas em `docs/analise/07-poc-priorizados.md`)
e o **esqueleto de extensão `cursor`** (P3: `POST /api/cursor/events` + `CursorSource` mínima),
validados localmente com eventos simulados e prontos para a validação ao vivo numa máquina com
assinatura do Cursor. Não inclui P4–P8, nem push/PR.

---

## Implementation Decisions

### Ambiente e validação

- A validação **ao vivo** (P0/P1/P2/P5) roda em **outra máquina com assinatura Cursor**. Este
  ambiente (remote-server Linux, CLI "Not logged in", sem `hooks.json`, sem transcripts locais)
  não é capaz de executar hooks de IDE.
- Aqui a validação é **local e determinística**: vitest para tudo (rota de ingest, parser,
  instalador, analisador, hook de decisão contra um stub server), usando eventos e fixtures
  sintéticos.
- Cada POC entrega um **runbook** executável na máquina-alvo, que gera o relatório da entrega.

### Código e fork

- Trabalho **via fork**: `projects/habblaud-main` virou repo git em `d5f3718` (upstream
  `marmottajr/habblaud` como remote `upstream`); o usuário adiciona seu fork como `origin`.
  Branch de trabalho: `cursor-poc`.
- Espelhar o Codex: `server/sources/cursor/`, `server/cursor/http.ts`,
  `mod/habblaud-cursor/`, `scripts/cursor-*.ts`.
- Comentários/mensagens em **PT-BR**; sem dependências de runtime novas.
- `.specs/` versionado **dentro do fork** para o commit atômico incluir spec/tasks.

### Fatia MVP (P1)

- Foco em **P3**: rota de ingest + `CursorLive` + `CursorSource` mínima (sessionStart,
  preToolUse/postToolUse, before/afterShellExecution, stop, sessionEnd) provando agente no
  `Office` sem tocar Claude/Codex.

### Harnesses

- **P1 (hooks)**: hook "log tudo" + instalador (merge de `hooks.json` com backup) + analisador
  que rende a matriz evento→dispara?→campos.
- **P0 (transcript)**: hook de captura de `transcript_path` + inspetor de formato (json/jsonl/
  sqlite/opaco) + esqueleto de `transcript.ts`.
- **P2 (decisão)**: hook `before*`/`preToolUse` que registra em `/api/permissions` e faz
  long-poll; harness local com stub que mede o tempo de bloqueio.

### Agent's Discretion

- Nomes exatos dos scripts npm (`cursor:poc:*`), formato interno dos arquivos de captura e a
  estrutura do parser esqueleto (dentro das restrições da spec).

### Declined / Undiscussed Gray Areas → Assumptions

Ver a tabela "Assumptions & Open Questions" da spec (`.specs/features/cursor-poc/spec.md`):
local do `.specs/`, idioma, idiomática do Codex, flag `HABBLAUD_CURSOR`, detecção de presença
por hooks, semântica de `sessionEnd`, diretório de captura e formato do relatório — todos
registrados com o default escolhido e a razão.

---

## Specific References

- `docs/analise/07-poc-priorizados.md` — definição das POCs (hipótese, método, sucesso/falha,
  entregas) e a ordem de prioridade.
- `docs/analise/06-arquitetura-proposta.md` §6.2/§6.3 — arquivos novos e mapa hook→Office.
- `docs/analise/05-matriz-compatibilidade-cursor.md` §5.2/§5.3 — mapa de hooks e superfícies.
- `mod/habblaud-codex/hook.mjs` e `server/sources/codex/*` — precedente direto.

---

## Deferred Ideas

- P4 subagentes, P5 CLI (`cursor-agent --output-format stream-json`), P6 mensagens
  (`followup_message`), P7 histórico/GitHub, P8 uso do plano — todos para a próxima rodada.
- Configurar `origin` = fork do usuário e eventual PR upstream (precisa go-ahead).
- Um modo "página do assistente" de captura que roda sem IDE (correlacionar `conversation_id`).
