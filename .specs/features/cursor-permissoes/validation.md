# Validação — Fluxo de permissões do Cursor sem travar

**Veredito: PASS** — o relatório do Verifier registrou 1 mutante sobrevivente (M12) e 3 lacunas de baixa
severidade; **as 3 lacunas foram corrigidas depois da verificação** (ver "Resoluções"); com os testes
adicionados, **18/18 mutantes morrem**. Nenhuma lacuna afeta o comportamento implementado.

**Diff validado:** `54e7f69..HEAD` (`d581e17`, branch `cursor-poc`, 11 commits).
**Data:** 2026-10-11 — verificação independente (Verifier ≠ autor), rederivada dos artefatos/diff/testes.

## Critérios de aceite (AC → status → evidência `file:line`)

O mapeamento AC→CPERM segue a tabela de rastreabilidade de `spec.md:186-206`
(CPERM-01..04 = P1 "Decidir só o que importa"; CPERM-05..09 = P1 "Regras locais";
CPERM-10..14 = P2 "Permitir sempre"; CPERM-15..17 = P2 "Camada base"; CPERM-18..19 = P3 "Observabilidade").

| AC | Status | Evidência |
| --- | --- | --- |
| **CPERM-01** (P1.1: instalar marca decisão só Shell/MCP; resto é observação) | PASS | `mod/habblaud-cursor/policy.mjs:20` (padrão só `beforeShellExecution`/`beforeMCPExecution`); `server/test/cursor-policy.test.ts:33-38`; `server/test/cursor-hook.test.ts:170-181` (`beforeReadFile`/`preToolUse` observação por padrão) |
| **CPERM-02** (P1.2: observação → `POST /api/cursor/events` + sair 0, sem registrar/bloquear) | PASS | `mod/habblaud-cursor/hook.mjs:314` (evento sempre enviado), `hook.mjs:317` (observação não registra), `hook.mjs:371` (exit 0); `server/test/cursor-hook.test.ts:127-136` |
| **CPERM-03** (P1.3: `decisionEvents` da config substitui o conjunto padrão) | PASS | `mod/habblaud-cursor/policy.mjs:29-37` (`decisionEventsOf`), `hook.mjs:304`; `server/test/cursor-policy.test.ts:39-46`, `server/test/cursor-hook.test.ts:182-191` |
| **CPERM-04** (P1.4: evento de decisão sem `conversation_id`/ferramenta derivável → sair 0 sem decidir) | PASS | `mod/habblaud-cursor/hook.mjs:318` (não registra sem conversa/ferramenta; guard pré-existente, inalterado no diff); `server/test/cursor-hook.test.ts:265-275` (registry fica vazio). ⚠️ conflita com a Edge `spec.md:173` — ver Lacuna G2 |
| **CPERM-05** (regras.1: par casa `allow` → `{"permission":"allow"}` no stdout, sair 0, sem contatar) | PASS | `mod/habblaud-cursor/hook.mjs:303-311` (política avaliada antes de qualquer rede), `policy.mjs:128-129` (`allowOutput`); `server/test/cursor-hook.test.ts:192-204` ("sem nenhuma requisição") |
| **CPERM-06** (regras.2: casa `deny` → `{"permission":"deny","user_message":<motivo>}`, sair 0, sem contatar) | PASS | `mod/habblaud-cursor/policy.mjs:132-135` (`denyOutput` com a `note` da regra), `hook.mjs:310`; `server/test/cursor-hook.test.ts:206-213` |
| **CPERM-07** (regras.3: múltiplas regras → `deny` > `allow` > escritório, determinístico) | PASS | `mod/habblaud-cursor/policy.mjs:78-95` (`matchRule`: `deny` retorna antes de `allow`); `server/test/cursor-policy.test.ts:74-90`; mutante M1 morto |
| **CPERM-08** (regras.4: política ausente/ilegível ou regra com padrão inválido → ignorar e seguir fluxo anterior, sem lançar) | PASS | `mod/habblaud-cursor/hook.mjs:159-168` (`readPolicy` tolerante a arquivo ausente/malformado), `policy.mjs:41-61` (`rulesOf` descarta regra malformada), `policy.mjs:86-90` (`new RegExp` com try/catch); `server/test/cursor-policy.test.ts:48-65,91-97`, `server/test/cursor-hook.test.ts:215-223`; mutantes M3 e M18 mortos |
| **CPERM-09** (regras.5: política avaliada ANTES de registrar o pedido) | PASS | `mod/habblaud-cursor/hook.mjs:303-312` (decisão local acontece antes do `POST /api/cursor/events` e do registro); `server/test/cursor-hook.test.ts:192-204` |
| **CPERM-10** (sempre.1: "permitir sempre" → servidor persiste regra `allow` e conclui) | PASS | `server/permissions/registry.ts:463` (sugestão própria `destination: 'habblaud'`), `registry.ts:569` (`persistCursorRule` ao decidir com `suggestion`), `server/index.ts:141-144` (`writeCursorRule`); `server/permissions/cursor-rules.ts:84-91` (`addCursorRule`) e `93-115` (`writeCursorRule`); `server/permissions/registry.test.ts:472-481`, `server/permissions/cursor-rules.test.ts:76-93` |
| **CPERM-11** (sempre.2: mesmo par volta → hook aprova pela regra persistida sem novo pedido) | PASS (cobertura em partes) | round-trip de escrita/leitura: `server/permissions/cursor-rules.test.ts:76-84`; hook aprova por regra do mesmo arquivo: `server/test/cursor-hook.test.ts:192-204`. ⚠️ sem teste fim-a-fim persistir→aprovar — ver Lacuna G3 |
| **CPERM-12** (sempre.3: `cursor` aceita "sempre"; `codex` segue `unsupported`) | PASS | `server/permissions/registry.ts:188-190` (`unsupportedByProvider`: cursor recusa só `interrupt`; codex recusa `suggestion` também); `server/permissions/registry.test.ts:493-505`; mutantes M7, M8, M11 mortos |
| **CPERM-13** (sempre.4: política é arquivo texto legível/editável, documentado) | PASS | `server/permissions/cursor-rules.ts:93-115` (JSON pretty-printed, preserva `port`/`decisionTimeoutS` e regras anteriores: `cursor-rules.test.ts:76-84`); documentado em `docs/analise/11-permissoes-cursor.md:80-89` (Seção 2 — política local) |
| **CPERM-14** (sempre.5: regra persistida afeta só pedidos do provedor `cursor`) | PASS | `server/permissions/registry.ts:317-330` (`cursorRule` só quando `provider === 'cursor'`), `registry.ts:463`; só o hook do Cursor manda `suggest_rule` (`mod/habblaud-cursor/hook.mjs:211,248-259`); `server/permissions/registry.test.ts:455-481` |
| **CPERM-15** (base.1: runbook documenta auto-run/allowlist nativo + passo de config) | PASS (documentação) | `docs/analise/11-permissoes-cursor.md:39-74` (Run Modes, tabela, passos de config, `permissions.json`) |
| **CPERM-16** (base.2: `cursor:status` reporta eventos de decisão + regras vigentes, sem alterar arquivos) | PASS | `scripts/cursor-install.ts:316-333` (status é read-only: só `readCursorConfig`), `cursor-install.ts:330-332` (eventos de decisão, nº de regras, nº de decisões locais); `server/test/cursor-install.test.ts:242-249,255-280`; mutante M15 morto |
| **CPERM-17** (base.3: hook decide independentemente do auto-run do Cursor) | PASS (inerente + doc) | hook não lê config do Cursor — decisão por política própria: `mod/habblaud-cursor/hook.mjs:303-311`; explicitado em `docs/analise/11-permissoes-cursor.md:71-74` ("o hook do Habblaud decide independentemente do Run Mode") |
| **CPERM-18** (obs.1: decisão local registrada localmente — ferramenta, padrão, efeito — sem stdout extra) | PASS | `mod/habblaud-cursor/hook.mjs:44` (`DECISIONS_FILE`), `hook.mjs:171-179` (`logLocalDecision` best-effort), `hook.mjs:309-310` (registra e imprime só a decisão nativa); `server/test/cursor-hook.test.ts:201-203` |
| **CPERM-19** (obs.2: `cursor:status` reporta nº de decisões locais) | PASS | `server/permissions/cursor-rules.ts:117` (`countLocalDecisions`), `scripts/cursor-install.ts:332`; `server/permissions/cursor-rules.test.ts:105-110`, `server/test/cursor-install.test.ts:255-280` |

19/19 ACs com evidência; 0 falhas.

## Sensor de discriminação (fault injection, um mutante por vez, em worktree descartável)

Metodologia: 18 mutantes de nível de comportamento (nunca `git stash`, nunca o tree real; cada mutante
aplicado, testado e revertido em `/tmp/opencode/cperm-wt`, `node_modules` por symlink do fork; "morto" =
`npx vitest run <arquivos>` com exit ≠ 0).

| Mutante | Descrição da falha injetada | Arquivo | Resultado |
| --- | --- | --- | --- |
| M1 | `deny` deixa de vencer `allow` no `matchRule` | `policy.mjs` | KILLED (1 falhou / 8) |
| M2 | Defaults de decisão passam a incluir `beforeReadFile`/`preToolUse` | `policy.mjs` | KILLED (3 falharam / 24) |
| M3 | Regex inválida deixa de ser ignorada (sem try/catch) | `policy.mjs` | KILLED (2 falharam / 24) |
| M4 | `deriveRule` perde a ancoragem de Shell (`^base(\s\|$)`) | `policy.mjs` | KILLED (1 falhou / 8) |
| M5 | Hook decide localmente mas continua contatando o servidor (sem `return`) | `hook.mjs` | KILLED (2 falharam / 16) |
| M6 | `beforeReadFile` volta a virar evento de decisão | `hook.mjs` | KILLED (1 falhou / 16) |
| M7 | Codex passa a aceitar `suggestion` | `registry.ts` | KILLED (1 falhou / 35) |
| M8 | `suggest_rule` deixa de forçar `effect: 'allow'` | `registry.ts` | KILLED (1 falhou / 35) |
| M9 | Sugestão do Cursor perde o destino `'habblaud'` | `registry.ts` | KILLED (2 falharam / 35) |
| M10 | `decide` deixa de chamar `persistCursorRule` | `registry.ts` | KILLED (1 falhou / 35) |
| M11 | Cursor passa a recusar também `suggestion` | `registry.ts` | KILLED (3 falharam / 35) |
| **M12** | **Escrita de regra deixa de ser atômica (write direto no arquivo)** | `cursor-rules.ts` | SURVIVED na sessão do Verifier (7/7 passaram) — depois **KILLED** pelo teste de atomicidade adicionado (ver Resoluções, R1) |
| M13 | Dedupe de regras quebrado (repetida não vai para o fim) | `cursor-rules.ts` | KILLED (1 falhou / 7) |
| M14 | Teto de 200 regras removido | `cursor-rules.ts` | KILLED (1 falhou / 7) |
| M15 | `cursor:status` deixa de reportar eventos/regras/decisões | `cursor-install.ts` | KILLED (1 falhou / 16) |
| M16 | Cartão do Cursor mostra "sempre" mesmo sem sugestão | `permission.ts` (UI) | KILLED (1 falhou / 10) |
| M17 | Cartão do Cursor passa a oferecer "interromper" | `permission.ts` (UI) | KILLED (1 falhou / 10) |
| M18 | `readPolicy` lança com arquivo ausente/malformado (sem tolerância) | `hook.mjs` | KILLED (1 falhou / 16 — o teste `HABBLAUD_PORT vale como reserva…` roda sem config e exigiria o throw) |

**17/18 mortos na sessão do Verifier.** O único sobrevivente (M12) indicava lacuna de *teste* (o
comportamento atômico está implementado em `cursor-rules.ts:107-109`), não falha de comportamento — e
ficou coberto depois (ver Resoluções).

## Gates (rodados no fork real, sem mutações, tree limpa)

| Gate | Comando | Resultado |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Testes | `npm test` | 103 arquivos, **1296 passed | 2 skipped (1298)**, exit 0 (já com os testes das Resoluções: +1 atomicidade, +1 fim-a-fim) |
| Build | `npm run build` | exit 0 |

## Lacunas (rankeadas por severidade; todas resolvidas em seguida — ver Resoluções)

1. **G1 — MÉDIO-BAIXA · M12 sobreviveu: a atomicidade da escrita de regras não era discriminada por teste.**
   `server/permissions/cursor-rules.test.ts:86-93` conferia integridade do arquivo e ausência de `*.tmp-*`,
   mas uma escrita direta (sem temp+rename, que é justamente o mutante M12) passa nos dois. O comportamento
   atômico correto existe (`cursor-rules.ts:107-109`), mas nenhum teste o provava. → **RESOLVIDA (R1)**:
   um teste que sabota o passo intermediário confere que o arquivo final nunca fica parcialmente gravado.
2. **G2 — BAIXA · Spec internamente contraditória no caso "sem comando".** A Edge `spec.md:173`
   ("`beforeShellExecution` sem `command` → registrar e esperar") conflita com a AC `spec.md:82`/CPERM-04
   ("sem ferramenta derivável → sair 0 sem decidir"). O comportamento implementado segue CPERM-04:
   sem `tool_name` e sem `command`, `toolNameOf` devolve `undefined` (`hook.mjs:100-116`) e o hook observa
   sem registrar (`hook.mjs:318`, guard pré-existente, inalterado no diff). → **RESOLVIDA (R2)**: a Edge
   `spec.md:173` foi reescrita para a semântica real (sem comando e sem ferramenta → observação, sem lançar).
3. **G3 — BAIXA · CPERM-11 sem teste fim-a-fim.** O ciclo "permitir sempre → persistir → hook aprovar sem
   servidor" era coberto em partes separadas (`registry.test.ts:472-481`; `cursor-rules.test.ts:76-84`;
   `cursor-hook.test.ts:192-204`), mas não existia um único teste unindo `decide(suggestion)` →
   `writeCursorRule` → `run hook` → aprovação local. → **RESOLVIDA (R3)**: novo fim-a-fim de processo
   (`server/test/cursor-hook.test.ts:215-236`) roda o hook duas vezes com a política real gravada pelo
   `persistCursorRule` (mesma fiação de `server/index.ts`) e confere a aprovação local sem rede.

Sem AC falho: as 3 lacunas eram de precisão de teste/spec, não de comportamento divergente entregue ao usuário.

## Resoluções (pós-verificação, executadas pelo orquestrador)

- **R1 (G1/M12)** — `server/permissions/cursor-rules.test.ts:95-104`: teste discriminante de atomicidade —
  ocupa o caminho do arquivo temporário (`<config>.tmp-<pid>`) com um diretório para a gravação falhar; o
  mutante (escrita direta no lugar) sobrescreveria o arquivo antes de falhar, o teste confere que o conteúdo
  **antigo** fica íntegro (`{ok:false}` + regras antigas). Rerodado: M12 agora é morto (8/8 no arquivo).
- **R2 (G2)** — `.specs/features/cursor-permissoes/spec.md:173`: a Edge "sem comando" passou a dizer que o
  hook não deriva sujeito nem regra e registra como observação, sem lançar — consistente com CPERM-04.
- **R3 (G3)** — `server/test/cursor-hook.test.ts:215-236`: fim-a-fim do "sempre permitir" —
  `beforeShellExecution` registra com sugestão `habblaud` → `decide({behavior:'allow', suggestion:0})`
  persiste a regra via `writeCursorRule` (fiação real de `server/index.ts`) → o próximo pedido idêntico é
  aprovado pelo hook sem rede (`live.calls` permanece com 1) e sem novo registro, com a decisão local em
  `cursor-decisions.jsonl`.

Refeito após as resoluções: gates verdes (typecheck; 1296 passed | 2 skipped; build) e `git status --porcelain` limpo.
Somente as Resoluções alteram o fork depois da sessão do Verifier.

## Nota do Verifier

- Verificação derivada dos artefatos e do diff `54e7f69..HEAD`; nenhum código de produção/teste foi
  alterado no fork (apenas este relatório). `git status --porcelain` limpo ao final.
- Mutantes injetados um a um em worktree descartável (`/tmp/opencode/cperm-wt`, removida em seguida),
  com `node_modules` do fork por symlink; cada mutante confirmado (`COUNT == 1`) antes de aplicar e
  revertido com `git checkout -- <arquivo>` após o teste.