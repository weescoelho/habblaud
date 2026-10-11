# Validação — Transcript do Cursor (terminal, tokens e atividades ricas)

**Veredito: PASS** — os 14 ACs (`CTRANS-01..14`) casam com o resultado definido pela `spec.md`; gate
verde; 18 mutantes de comportamento injetados, **16 mortos | 2 sobreviventes** (ambos lacunas de
precisão em **detalhe de design/assumption**, não em AC — ver Lacunas). Nenhum AC falho e nenhuma
correção de comportamento é necessária; as 2 lacunas são de *teste* (fix tasks de baixa severidade).

**Diff validado:** `57d76ba..HEAD` (`60a0d34`, branch `cursor-poc`: planejamento `5da6c29` + T1–T6).
**Data:** 2026-10-11 — verificação independente (Verifier ≠ autor), rederivada dos artefatos, do diff e dos testes.

## Validation — resultado do gate

**Result**: PASS ✅ (14/14 ACs com evidência `file:line`; sensor 16/18 mortos; gate `typecheck`+`vitest`+`build` verde)

## Critérios de aceite (AC → status → evidência `file:line` + asserção)

O mapeamento AC→CTRANS segue a rastreabilidade de `spec.md:157-172` (CTRANS-01..08 = P1 "Terminal";
CTRANS-09..12 = P1 "Tokens"; CTRANS-13 = P2 "Atividades ricas"; CTRANS-14 = P3 "Tarefas").

| AC | Status | Evidência (`file:line` + asserção) |
| --- | --- | --- |
| **CTRANS-01** (evento com `transcript_path` não vazio → guarda e expõe) | PASS | `server/sources/cursor/source.test.ts:194` — `expect(ctx.source.transcriptPathOf('cursor:c1')).toBe('/tmp/cursor.jsonl')`; impl. `server/sources/cursor/source.ts:128-129` (leitura) e `source.ts:191` (gravação) |
| **CTRANS-02** (sem caminho/`null` → `undefined`, não limpa o guardado) | PASS | `source.test.ts:184,188` (`undefined`); `source.test.ts:200-203` (evento `stop`/`beforeReadFile{null}` **não** limpa → segue `/tmp/cursor.jsonl`); impl. `source.ts:191` (só grava quando truthy) |
| **CTRANS-03** (`terminalParser` de agente conhecido → parser NOVO) | PASS | `source.test.ts:185` (`toBeDefined`); `source.test.ts:195-199` (`expect(p1).not.toBe(p2)`); `source.test.ts:206-210` (desconhecido → `undefined`); impl. `source.ts:133-135` |
| **CTRANS-04** (linha JSONL → `TerminalEntry`; inválida/desconhecida → `[]`) | PASS | `server/sources/cursor/terminal.test.ts:21-29` (user/assistant); `:31-35` (tool); `:107-120` (system); `:122-130` (inválida/desconhecida/em branco → `[]`); impl. `terminal.ts:103-140` |
| **CTRANS-05** (`tool_use` → `tool` estilo `toolView`, cobrindo as ferramentas listadas) | PASS | `terminal.test.ts:39-98` — `Bash(ls -la)` (39-43), `Read(a.ts)` (45-48), `Write(a.ts)` (50-54), `Edit(a.ts)` (56-60), `Glob(**/*.ts)` (62-65), `Grep(foo)` (67-70), `LS(src)` (72-75), `mcp__cursor__list_repos` (77-80), `Task` via delegate (82-85), `GetDynamicTools/AskQuestion/UpdateCurrentStep` (87-98); impl. `terminal.ts:51-78` |
| **CTRANS-06** (`turn_ended` → `system`, `error`/`warn` fora de sucesso) | PASS | `terminal.test.ts:107-110` (`success`→`info`), `:112-115` (`error`→`error`), `:117-120` (`interrupted`→`warn`); impl. `terminal.ts:168-174` |
| **CTRANS-07** (reuso de truncamento e `maskSecrets`) | PASS | `terminal.test.ts:134-141` (segredo `ghp_…` → `gh*_***`, `not.toContain(secret)`); `:144-151` (`'a'.repeat(TEXT_MAX+500)` → termina em `…`, `length ≤ TEXT_MAX+2`); impl. `terminal.ts:145-146,155,160` (`prepare`/`marked`/`maskSecrets`) |
| **CTRANS-08** (não inventar entrada `result`) | PASS | `terminal.test.ts:31-35` — kinds `['assistant','tool','tool']` para texto + 2 `tool_use` (nenhum `result`); o parser só emite `text`/`tool_use`/`turn_ended` (`terminal.ts:128-138`) |
| **CTRANS-09** (`tokensIn += input+cache_read+cache_write`, `tokensOut += output`) | PASS | `source.test.ts:215-219` — `stop` `{100,40,20,5}` → `stats.tokensIn === 125`, `tokensOut === 40`; `afterAgentResponse{output:10}` soma → `50`; impl. `source.ts:193-196`; parse `rollout.test.ts:79-95` |
| **CTRANS-10** (campo ausente → mantém, não inventa) | PASS | `source.test.ts:220-223` — evento sem tokens e `{output_tokens:'x'}` deixam `125/50`; impl. `source.ts:193` (só soma com `event.tokens`) e `rollout.ts:118-120` |
| **CTRANS-11** (Office reflete `stats.tokensIn/tokensOut`) | PASS | `source.test.ts:216,219` — `expect(ctx.agent()?.stats).toMatchObject({tokensIn:125,tokensOut:40})` no snapshot; impl. `source.ts:201` (`office.applyTranscript`) → `server/model/office.ts:663` (`set('stats', …)`) |
| **CTRANS-12** (campo não numérico ignorado, sem lançar) | PASS | `rollout.test.ts:103-110` — `input_tokens:'muitos'` → `{input:0,…}`; `source.test.ts:222`; impl. `rollout.ts:42-45` (`num` só número finito) |
| **CTRANS-13** (`describeCursorTool` traduz as ferramentas próprias) | PASS | `rollout.test.ts:157-163` (`GetDynamicTools`→`other`, texto próprio, `not.toMatch(/^Usando /)`); `:165-171` (`AskQuestion`→`ask`, `detail` da pergunta); `:173-178` (`UpdateCurrentStep`→`plan`); `:180+` (delegate `Task`); `source.test.ts:228-242` (`preToolUse` → `Activity` traduzida); impl. `rollout.ts:143-168` |
| **CTRANS-14** (sem checklist → nenhum `TaskItem`; ausência documentada) | PASS | `source.test.ts:225,241` — `expect(ctx.agent()?.tasks).toEqual([])`; doc no Handoff `.specs/STATE.md` (diff) e no roteiro `docs/analise/06-arquitetura-proposta.md` §6.8 (commit lateral `a4191ea`) |

**Status**: 14/14 ACs com evidência; 0 falhas; 2 lacunas de precisão (G1/G2).

## Edge cases (spec.md:147-153)

| Edge case | Status | Evidência |
| --- | --- | --- |
| Linha não-JSON / forma desconhecida → `[]`, sem lançar | ✅ | `terminal.test.ts:124-125` |
| Vários blocos `tool_use` na mesma mensagem → uma entrada por bloco | ✅ | `terminal.test.ts:31-35` |
| `tool_use` sem o argumento esperado → emite com título possível, sem lançar | ✅ | `terminal.test.ts:100-103` (`Shell{}` → título `Bash`) |
| Linha vazia / só espaços → `[]` | ✅ | `terminal.test.ts:127-128` |
| `transcript_path` ausente/opaco → degrada pelo `FileTail`, sem alterar `transcriptPathOf` | ✅ (inerente) | Comportamento pré-existente da rota (`server/sources/tail.ts`), **fora do diff**; `transcriptPathOf` não muda — sem teste novo (observação) |

## Sensor de discriminação (fault injection, um mutante por vez, em worktree descartável)

Metodologia: 18 mutantes de **nível de comportamento** injetados um a um em `/tmp/opencode/ctrans-wt`
(`git worktree add HEAD`, `node_modules` por symlink; nunca `git stash`, nunca o tree real); cada
mutante aplicado, testado (`npx vitest run <arquivo>`) e revertido (`git checkout -- <arquivo>`);
"morto" = exit ≠ 0. Ao final o worktree foi removido e o `git status --porcelain` do tree real voltou a
**0** (baseline preservada).

| Mutante | Falha de comportamento injetada | Arquivo | Resultado |
| --- | --- | --- | --- |
| M1 | `transcriptPathOf` sempre `undefined` | `source.ts` | KILLED (1 falhou/16) |
| M2 | Nunca grava o `transcript_path` | `source.ts` | KILLED (1 falhou/16) |
| M3 | Evento sem caminho **limpa** o caminho guardado | `source.ts` | KILLED (1 falhou/16) |
| M4 | `terminalParser` sempre `undefined` | `source.ts` | KILLED (2 falharam/16) |
| M5 | `tokensIn` ignora `cache_read`+`cache_write` | `source.ts` | KILLED (1 falhou/16) |
| M6 | Tokens **sobrescreve** em vez de acumular | `source.ts` | KILLED (1 falhou/16) |
| M7 | Office não reflete os tokens | `source.ts` | KILLED (1 falhou/16) |
| M8 | Aliases camelCase de token ignorados | `rollout.ts` | KILLED (1 falhou/24) |
| M9 | `num` deixa `NaN` vazar (campo não numérico corrompe) | `rollout.ts` | KILLED (1 falhou/24) |
| M10 | `GetDynamicTools` perde a tradução dedicada | `rollout.ts` | KILLED (1 falhou/24) |
| M11 | `CallDynamicTool{Task}` perde o delegate | `rollout.ts` | KILLED (1 falhou/24) |
| **M12** | **`UpdateCurrentStep` perde o prefixo `Etapa: `** | `rollout.ts` | **SURVIVED (40 passaram)** → G1 |
| M13 | `turn_ended` sucesso deixa de ser `info` | `terminal.ts` | KILLED (1 falhou/20) |
| M14 | Parser deixa de ser novo por chamada (singleton) | `terminal.ts` | KILLED (2 falharam/36) |
| M15 | `Shell` deixa de virar `Bash` | `terminal.ts` | KILLED (3 falharam/20) |
| M16 | `StrReplace` deixa de virar `Edit` | `terminal.ts` | KILLED (1 falhou/20) |
| M17 | `Write` perde o mapeamento `contents`→`content` | `terminal.ts` | KILLED (1 falhou/20) |
| **M18** | **`at` deixa de ler `timestamp`/`ts`** | `terminal.ts` | **SURVIVED (20 passaram)** → G2 |

**Sensor depth**: lightweight estendido (18 mutantes; feature P1/P2, sem caminho P0 de pagamento/auth).
**Resultado do sensor**: 16/18 mortos — as 2 sobreviventes são de precisão de teste (não de AC).

## Gates (rodados no tree real, sem mutações, tree limpa)

| Gate | Comando | Resultado |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Testes | `npm test` | 105 arquivos, **1335 passed | 2 skipped (1337)**, exit 0 |
| Build | `npm run build` | exit 0 |
| Arquivos de teste da feature (quick) | `npx vitest run server/sources/cursor/{terminal,source,rollout}.test.ts` | **60 passed** (28 → 60: +32 casos) |

**Integridade dos testes**: o único caso removido foi o antigo "MVP sem transcript" de `source.test.ts`
(que exigia `terminalParser` `undefined`), **substituído** por 5 casos (sem caminho / com caminho / agente
desconhecido / tokens / atividade rica) — remoção justificada pela mudança de semântica (T2), sem
enfraquecimento de asserção.

## Lacunas (ranqueadas por severidade)

1. **G1 — BAIXA/COSMÉTICA · M12 sobreviveu: o texto renderizado de `UpdateCurrentStep` não é discriminado.**
   `design.md:128` fixa o balão como `plan`/"Etapa: …", mas `rollout.test.ts:173-178` e `source.test.ts:238-240`
   só conferem `kind === 'plan'` e `toContain('Rodando os testes')` — remover o prefixo `Etapa: ` passa.
   O **AC `CTRANS-13` está satisfeito** ("texto legível" citando o passo), logo não é falha de comportamento;
   é a formatação pinada no *design* que fica sem teste. → **Fix task (baixa)**: asseverar o texto exato
   (`toBe('Etapa: Rodando os testes')`).
2. **G2 — BAIXA · M18 sobreviveu: a derivação do `at` (assumption da spec) não é discriminada.**
   `spec.md:44` fixa `at` como `timestamp`/`ts`, senão o último conhecido, com `Date.now()` de reserva;
   `terminal.test.ts:23,28` usam `expect.any(Number)`, então ignorar `timestamp`/`ts` passa. Ordenação da
   conversa é pela **ordem do arquivo** (não por `at`), o que limita o impacto a um timestamp degradado.
   → **Fix task (baixa)**: um caso com `timestamp`/`ts` explícito conferindo o `at` derivado (e o
   encadeamento "último conhecido").

**Observações menores (não são lacunas de AC):**
- O `Task` cru listado em `CTRANS-05` é coberto pela forma real do transcript (`CallDynamicTool{toolName:'Task'}`,
  `terminal.test.ts:82-85`); um `tool_use` `Task` isolado cairia no default genérico — já exercitado por `Read`
  (`terminal.test.ts:45-48`).
- `tasks.md` T6 aponta `Where: docs/analise/06-arquitetura-proposta.md` sem indicar que o arquivo vive no
  **workspace raiz** (não no submódulo); a atualização **foi feita** no commit lateral `a4191ea`.
- O Handoff de `.specs/STATE.md` registra que a validação independente **não** havia sido executada pelo autor;
  **esta sessão é essa verificação** (o skill exige Verifier sempre-ligado após a última task) — matéria de
  processo, não lacuna de código.

## Requirement Traceability Update

| Requisito | Status anterior | Novo status |
| --- | --- | --- |
| CTRANS-01..14 | Implementing | ✅ Verified (PASS, com G1/G2 como fix tasks de teste) |

## Nota do Verifier

- Verificação independente rederivada de `spec.md`, `design.md`, `tasks.md`, do diff `57d76ba..HEAD` e
  dos testes; **nenhum** código de produção/teste foi alterado no fork (apenas este relatório).
- Mutantes injetados um a um em worktree descartável (`/tmp/opencode/ctrans-wt`, removido em seguida), com
  `node_modules` do fork por symlink; baseline `git status --porcelain` = **0** antes e depois (isolamento
  confirmado). Sem `git stash` em momento algum.
- Verdict ancorado em AC: os 14 ACs casam com o resultado da spec; as 2 sobreviventes do sensor são
  detalhes de *design/assumption* (G1/G2) → fix tasks de teste, sem bloqueio do MVP.
