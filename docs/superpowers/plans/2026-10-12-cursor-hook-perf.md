---
data: 2026-10-12
etapa: plano
---

# Plano — Latência do hook de observação do Cursor

- **Data:** 2026-10-12
- **Slug:** `cursor-hook-perf`
- **Spec:** [2026-10-12-cursor-hook-perf-design.md](../specs/2026-10-12-cursor-hook-perf-design.md)
- **Etapa:** plano aprovado; spec aguarda ok do usuário antes de `/implement`

TDD por task. Não commitar neste plano (o `/implement` pergunta a granularidade).

## Task 1 — Provar o atraso (teste vermelho)

Arquivo: `server/test/cursor-hook.test.ts`

- Apertar o bound de observação de `< 3_000` ms para **`< 200` ms** (tempo até `child.on('close')`).
- Caso novo: `afterAgentThought` contra o stub **não** gera `POST /api/cursor/events` e sai 0 em `< 200` ms.
- Caso novo: stdin ~400 KiB em `afterMCPExecution` (campo `result` enorme); o corpo do POST **não** contém esse `result`.

Verificação: `npx vitest run server/test/cursor-hook.test.ts` — os bounds novos falham no código atual.

## Task 2 — Encerrar o hook na hora

Arquivo: `mod/habblaud-cursor/hook.mjs` (`call`, `main`)

- `fetch` com header `Connection: close`.
- `afterAgentThought`: depois do parse, `return undefined` **antes** do POST (mesmo se ainda estiver em `OBSERVED`).
- Não-Windows: `process.exit(0)` no callback de `stdout.write`, ou imediato se não houver saída. Sem timer de 1 s.
- `win32`: manter o `setTimeout(..., 1_000).unref()` atual.

Verificação: Task 1 verde no Linux deste repo.

## Task 3 — Corpo magro e teto de stdin

Arquivo: `mod/habblaud-cursor/hook.mjs` (`eventBody`, `readStdin`, constantes)

- `MAX_STDIN = 512 * 1024`. Estouro: para de ler; JSON inválido → sai 0 sem POST.
- `eventBody` copia só o que `parseCursorEvent` lê: `hook_event_name` (e alias), ids de conversa, `workspace_roots`/`cwd`, `tool_name`/`tool_input`, `command`, `transcript_path`, tokens, campos de subagent, `file_path`/`edits`. Strings de `tool_input`/`edits` ainda passam por `trimInput` (teto 8_000).
- Não incluir chaves livres (`result`, `content` do MCP, thought, stdin cru).

Testes: unidade de `eventBody` no mesmo `cursor-hook.test.ts` (já importa o módulo); casos da Task 1 de payload grande.

Compat servidor: `server/cursor/http.test.ts` e `server/sources/cursor/source.test.ts` — um evento só com os campos magros ainda aplica atividade/status. Sem mudança de rota.

## Task 4 — Não instalar `afterAgentThought`

Arquivos: `scripts/cursor-install.ts` (`EVENTS`); `server/test/cursor-install.test.ts`

- Tirar `afterAgentThought` de `EVENTS`.
- `planInstall` **remove** a entrada do Habblaud em eventos que não estão mais em `EVENTS` (senão o `hooks.json` antigo continua disparando spawn). Se a lista ficar vazia, apaga a chave.
- `HOOK_EVENTS` / `statusBorder` no servidor **ficam** (evento residual não quebra a fonte).
- Testes: install novo não grava `afterAgentThought`; reinstall sobre um `hooks.json` que já tinha thought **tira** a entrada nossa e deixa hooks alheios nesse evento; uninstall continua varrendo o arquivo inteiro.

Verificação: `npx vitest run server/test/cursor-install.test.ts server/test/cursor-setup.test.ts`

Quem já instalou precisa `npm run cursor:install` de novo para o Cursor parar de spawnar thought. Documentar isso na verificação manual.

## Task 5 — (não nesta versão)

Fire-and-forget / timeout de observação 200 ms: só se 1–4 não bastarem na verificação manual. Não implementar agora.

## Arquivos

| Arquivo | Tasks |
|---|---|
| `mod/habblaud-cursor/hook.mjs` | 2, 3 |
| `server/test/cursor-hook.test.ts` | 1, 2, 3 |
| `scripts/cursor-install.ts` | 4 |
| `server/test/cursor-install.test.ts` | 4 |
| `server/test/cursor-setup.test.ts` | 4 (se assertar a lista `EVENTS`) |
| `server/sources/cursor/source.test.ts` | 3 (evento magro) |
| `server/cursor/http.test.ts` | 3 se o contrato do POST for exercitado lá |

Sem mudança em `client/`, `server/model/office.ts`, `server/http/sse.ts`, `scripts/plugin-full-integration-probe.sh`.

## Verificação final

```
npx vitest run server/test/cursor-hook.test.ts \
  server/test/cursor-install.test.ts \
  server/sources/cursor/source.test.ts \
  server/sources/cursor/rollout.test.ts \
  server/cursor/http.test.ts
```

Na IDE, depois do código: `HABBLAUD_HOOK_DEBUG=1 bash scripts/subagent-terminal-smoke.sh --fast` e `npm run cursor:install` para aplicar o `EVENTS` novo. Não repetir o burst de 10 vias neste corte.
