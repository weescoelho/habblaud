---
data: 2026-10-12
etapa: design
---

# Design — Latência do hook de observação do Cursor

- **Data:** 2026-10-12
- **Slug:** `cursor-hook-perf`
- **Plano:** [2026-10-12-cursor-hook-perf.md](../plans/2026-10-12-cursor-hook-perf.md)
- **Status:** aprovado (implementado)

## Contexto e problema

`cursor-permissoes` tirou a **decisão** de `preToolUse`/`beforeReadFile`: esses eventos só observam. A observação continua no caminho crítico da IDE: cada evento lista em `~/.cursor/hooks.json` dispara `node mod/habblaud-cursor/hook.mjs`, que lê o stdin, faz `POST /api/cursor/events` e só então encerra. A IDE espera o **processo fechar**.

No burst de teste (1 shell + 5 MCP + 4 subagents), isso multiplicou CPU, sockets e latência. Sintoma: congelamento da tela do Cursor e queda brusca de performance.

Causas no código (não em MCP específico):

1. **Processo vivo ~1 s depois do POST.** `main()` agenda `process.exit(0)` com 1 s de atraso (workaround Windows/Node). O `fetch` do Node deixa keep-alive para `127.0.0.1:4747`, o loop não esvazia e o timer dispara. Teste atual de observação só exige `< 3 s`.
2. **18 eventos instalados**, todos com spawn+POST. Captura antiga: 465 `preToolUse` + 180 `beforeReadFile`. `afterAgentThought` está na lista; se a IDE disparar por trecho de raciocínio, o spawn acontece mesmo quando o escritório não cria atividade (sem `tool_name`).
3. **Stdin até 8 MB** + `JSON.parse` + `trimInput` recursivo + `JSON.stringify` do evento inteiro. O servidor (`parseCursorEvent`) usa ~10 campos. `afterMCPExecution` com resultado grande (ex.: Excalidraw `read_me`) paga CPU na IDE à toa.

A tela do escritório (SSE 200 ms, `markDirty`) é efeito colateral, não a causa do freeze da IDE.

## Decisões

| Decisão | Escolha |
|---|---|
| Abordagem | Fast-exit + corpo magro + tirar `afterAgentThought` da instalação (opção A do plano) |
| Daemon persistente | Fora. Continua um processo Node por evento |
| Desinstalar `preToolUse` / `beforeReadFile` | Fora. Continua a observação do escritório (reafirma opção D de `cursor-permissoes`) |
| Fire-and-forget do POST de observação | Fora desta versão. Observação ainda espera o POST, com timeout 1,5 s |
| Timeout do POST de observação | Permanece `EVENT_TIMEOUT_MS = 1_500`. O ganho é encerrar o processo na hora, não cortar a espera da rede |
| `afterAgentThought` | Sai de `EVENTS` em `scripts/cursor-install.ts`. Se o hook ainda receber o evento (hooks.json antigo), sai 0 **sem** POST |
| Corpo do POST | Só os campos que `parseCursorEvent` lê (mais `edits`/`file_path` do `afterFileEdit`). Nada de stdin cru, resultado MCP ou texto de thought |
| Stdin | Teto **512 KiB**. Acima: para de ler; se o JSON não parsear, sai 0 sem POST. Eventos de decisão acima do teto seguem a mesma regra (comando/MCP típicos cabem) |
| Keep-alive | Header `Connection: close` no `fetch` do hook. Sem Agent/undici extra |
| `process.exit` atrasado | Só `win32`. Linux/macOS: `process.exit(0)` no callback do `stdout.write`, ou imediato se não houver saída |
| Codex / hooks Claude | Fora. Mesmo padrão de exit 1 s existe em `mod/habblaud-codex/hook.mjs`; não entra neste corte |
| Regras locais / decisão Shell-MCP | Intocadas. Allow local continua sem rede |

## Arquitetura

```
IDE (espera o processo do hook sair)
  └─ node hook.mjs
        ├─ afterAgentThought → exit 0, sem POST
        ├─ demais: parse ≤ 512 KiB → eventBody magro
        ├─ POST /api/cursor/events  (Connection: close, ≤ 1,5 s)
        └─ exit imediato (não-Windows) | exit +1 s (Windows)
              └─ Office: applyHookEvent (inalterado no contrato; thought some na prática)
```

O servidor **não** muda o schema de `POST /api/cursor/events` (`{event: {hook_event_name, …}}`). O `event` fica menor. `CursorSource.hookEvent` / `parseCursorEvent` já tratam campos ausentes.

Presença (`lastHookAt`, `STALE_PRESENCE_MS = 5 min`) continua via `beforeSubmitPrompt`, tools, shell, MCP, `stop`. Sem thought, um turno só de raciocínio longo sem ferramenta ainda tem `beforeSubmitPrompt` no início.

## Comportamento por evento

| Evento | Instalado? | POST? | Bloqueia decisão? |
|---|---|---|---|
| `beforeShellExecution`, `beforeMCPExecution` | sim | sim (e `/api/permissions` se não houver regra local) | sim, até a política/escritório |
| `preToolUse`, `postToolUse`, `beforeReadFile`, `afterFileEdit`, shell/MCP after, `stop`, subagent, session, prompt | sim | sim, corpo magro | não |
| `afterAgentThought` | **não** (install novo) | não, mesmo se disparar | não |

`planInstall` hoje só acrescenta/atualiza eventos de `EVENTS`; não apaga os que saíram da lista. Neste corte ele **também remove** a entrada do Habblaud em eventos que não estão mais em `EVENTS` (no mínimo `afterAgentThought`). Se a lista do evento ficar vazia, a chave some. Sem isso, reinstalar não para o spawn.

Quem não rodar `npm run cursor:install` de novo continua com thought no `hooks.json`; o hook ainda sai sem POST (Task 2), mas a IDE paga o spawn.

## Tratamento de erro

- Habblaud fora do ar / timeout do POST: igual hoje — observação perdida, exit 0, IDE segue.
- Stdin > 512 KiB ou JSON inválido: exit 0, sem POST.
- Windows: keep-alive pode existir; o exit +1 s permanece como rede de segurança (nodejs/node#56645).

## Testes

Determinísticos, sem a IDE:

- Processo real (`server/test/cursor-hook.test.ts`): observação fecha em **< 800 ms** (o spawn do Node na suíte paralela passa de 200 ms; o bound ainda falha se o exit atrasado de 1 s voltar); `afterAgentThought` não chama `/api/cursor/events`; stdin ~400 KiB de `afterMCPExecution` não viaja no POST (só campos magros); bound `< 3 s` some.
- Unidade do `eventBody`: objeto com `result`/`content` enorme não aparece no JSON do POST; campos do `CursorEvent` permanecem.
- `scripts/cursor-install.ts` / `server/test/cursor-install.test.ts`: `EVENTS` não contém `afterAgentThought`; install/uninstall/idempotência.
- `server/sources/cursor/source.test.ts` + `rollout.test.ts`: se um thought chegar via HTTP, a fonte **não quebra** (compat); não é obrigatório gerar atividade.

Verificação manual depois do código: `HABBLAUD_HOOK_DEBUG=1 bash scripts/subagent-terminal-smoke.sh --fast`. Não repetir o burst de 10 vias neste corte.

## Fora de escopo

- Probe lean / tirar Atlassian / `telemetry.js`
- Fire-and-forget, timeout de observação menor, daemon
- Desinstalar `preToolUse` / `beforeReadFile`
- UI do escritório, throttle SSE, timeline
- Hook do Codex e plugin Claude
- Mudar política local ou eventos de decisão

## Relação com specs existentes

Complementa `.specs/features/cursor-permissoes/` (decisão só Shell/MCP). Não reabre a opção D para tools/reads. Só `afterAgentThought` deixa de ser observado: o escritório já não mostrava balão de thought (`activityOf` exige ferramenta).
