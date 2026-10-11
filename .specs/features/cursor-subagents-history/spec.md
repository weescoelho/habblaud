# Subagentes, GitHub e histórico do Cursor (Specification)

## Problem Statement

As Fases 1–3 do Cursor entregaram a `CursorSource` só por hooks (presença/atividades), o terminal da
conversa (`createCursorTerminalParser`) e os tokens (`AgentStats`). Faltam as três peças da **Fase 4**
(`06` §6.8, P4/P7): (1) **subagentes** — a IDE emite `subagentStart`/`subagentStop` (a rodada P0–P3
não os instalava; o `HARNESS_EVENTS` do harness já os inclui), mas a fonte não trata os eventos e o
`HOOK_EVENTS` nem os reconhece, então um subagente disparado pela IDE some do escritório; (2) **GitHub**
— o transcript do Cursor registra os `tool_use` `Shell` com `git push`/`gh pr create`/`gh pr merge`, mas
nada lê isso, então publicar pelo Cursor não anima a sala como no Claude Code/Codex; (3) **histórico** —
o Cursor grava `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, mas não há
`HistoryProvider` do Cursor, então conversas encerradas não aparecem em `/api/sessions/recent`. Esta
feature fecha a Fase 4 reusando as peças que já existem (`office.addSub`/`completeSub`,
`server/sources/github.ts`, `history.ts`/`HistorySet`, `FileTail`), sem regredir Claude/Codex e
degradando quando o transcript/histórico/efeitos não estão disponíveis.

## Goals

- [ ] Tratar `subagentStart`/`subagentStop` no `CursorSource`, correlacionando por `subagent_id`
      (Start↔Stop) e ligando o subagente ao pai (`parent_conversation_id`, senão `conversation_id`).
- [ ] Usar `subagent_type` como `role` e `task` como `title`; degradar (não quebrar) em órfãos e
      eventos sem id/pai.
- [ ] Ler o transcript incrementalmente (`FileTail`) e detectar `git push`/`gh pr create`/`gh pr merge`
      nos `tool_use` `Shell`, alimentando `office.githubEvent` como as outras ferramentas.
- [ ] Criar `server/sources/cursor/history.ts` (`CursorHistory implements HistoryProvider`) e registrá-lo
      no `HistorySet` só quando `config.cursor`.
- [ ] Documentar a limitação do transcript (sem `tool_result`: a detecção por comando não confirma sucesso).
- [ ] Não regredir Claude/Codex nem o Cursor das fases anteriores; degradar sem lançar.

## Out of Scope

| Feature                                                                 | Reason                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Injeção de mensagem / uso do plano (Fase 5)                            | Bloqueado por C6/C7; independente desta fase (P6/P8)                          |
| Reconhecer os hooks de subagente **do Codex/Claude**                    | Fora do escopo: aqui só o `CursorSource`                                      |
| Emitir CI/release do Cursor (`gh run watch`, `gh release create`)       | Sem `tool_result` no transcript não dá para saber o desfecho (v1)             |
| Derivar `TaskItem`/checklist de subagentes                              | Nenhum traço de checklist observado (permanece da Fase 3)                     |
| Reescrever `transcript.ts` (inspetor da POC)                            | O inspetor fica; só ganha a extração reusável dos blocos de ferramenta         |
| UI/rotas novas do cliente                                              | O histórico e os efeitos já são dirigidos por `HistorySet`/`office.githubEvent` |
| Publicar/push no fork ou abrir PR                                       | Ação remota: exige go-ahead explícito (blast radius)                          |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Campos dos hooks de subagente | `subagent_id` (id do sub), `subagent_type` (papel), `task` (título), `parent_conversation_id` (pai; senão `conversation_id`) | Runbook `10` P4 e `correlateSubagents`/`subagentParentOf` do harness | y |
| Correlação Start↔Stop | Por `subagent_id`; Stop sem Start = órfão que degrada | É o id estável do par (harness P4); órfão não pode quebrar a sessão | y |
| `subagent_id`/pai ausente | Degrada (no-op): nenhum subagente quebrado é criado | "Campos ausentes viram undefined"; não inventar parentesco | y |
| Chave do subagente | `<conta>:s:<subagentId>` (distinta da do principal `<conta>:<conversationId>`) | Separa o espaço de ids e casa o `parentId` (`<conta>:<parentConversationId>`) | y |
| Papel/título do sub | `subagent_type` capitalizado (fallback `Subagente (Cursor)`); `task` como `title` | Espelha `roleOf`/`title` do Codex e o balão do `Task` | y |
| Onde detectar git/gh | No **transcript** (`Shell`/`Bash` `tool_use`), com um pump incremental na fonte | A IDE não manda hook de shell confiável para git/gh; o transcript registra | y |
| Primeiro attach ao transcript | `seekEnd()` (só o que for escrito depois vira evento) | Evita reemitir efeitos antigos (festa falsa) de uma conversa já adiantada | y |
| Resultado do comando | **Não** existe `tool_result` no transcript (Fase 3): fallback só-comando para `pr_create`/`pr_merge`/`push`, respeitando `--dry-run`/`--delete`/`--auto` | Único lastro possível na v1; limitação **documentada** (pode haver falso positivo) | y |
| CI/release pelo Cursor | **Não** emitidos (decisão por saída ausente) | Sem `tool_result` não dá para saber o desfecho; não inventar | y |
| Efeitos de sala | Reusar `office.githubEvent` (festa/alarme/aviso) sem rota nova | Já é o caminho comum do Claude/Codex (`shared/github.ts`) | y |
| Local do transcript | `<home>/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | Runbook `10` P7 e POC `enumerateSessions` | y |
| `projectDir`/`project` | `projectDir` = pasta do projeto (`<slug>`); `project` = cwd decodificado quando der para inferir, senão ausente | Mesma forma de `RecentSession` do Codex; sem inventar caminho | y |
| Título/horários (histórico) | 1º prompt via `createCursorTerminalParser`; `firstAt`/`lastAt` pelo mtime quando o transcript não traz horário | O transcript do Cursor não grava timestamp (Fase 3) | y |
| Path traversal em `resolve` | `sessionId` só `[A-Za-z0-9_-]`; arquivo precisa ficar dentro da pasta da conta | Mesma trava do Codex/Claude; `resolve` nunca lança | y |
| Registro no servidor | `CursorHistory` entra no `HistorySet` só quando `config.cursor` (e terminal ligado) | Mesma trava das outras fontes; desligar o Cursor não afeta Claude/Codex | y |
| Idioma | PT-BR (comentários e textos) | Convenção do repositório | y |
| Gate do repositório | `npm run typecheck && npm test && npm run build` (quick: `npx vitest run <arquivo>`) | `package.json` / rodadas anteriores | y |

**Open questions:** none — all resolved or logged above.

## User Stories

### P1: Subagentes do Cursor por hook ⭐ MVP

**User Story**: Como usuário do Habblaud com o Cursor, quero que os subagentes disparados pela sessão
apareçam como subagentes no escritório, para acompanhar o trabalho paralelo como no Claude Code/Codex.

**Why P1**: É a lacuna P4; sem isto a IDE pode rodar subagentes invisíveis.

**Acceptance Criteria**:

1. WHEN um evento de hook `subagentStart` traz um `subagent_id` e um pai conhecido THEN o
   `CursorSource` SHALL criar o subagente no Office (`addSub`) com `parentId` derivado de
   `parent_conversation_id` (senão do `conversation_id`) e ele SHALL começar em `working`.  <!-- event-driven -->
2. WHEN um evento `subagentStop` casa o `subagent_id` de um `subagentStart` visto antes THEN o
   `CursorSource` SHALL completar o subagente (`completeSub`, status `done`).  <!-- event-driven -->
3. The `CursorSource` SHALL usar `subagent_type` como `role` do subagente (com fallback
   `Subagente (Cursor)`) e `task` como `title`.  <!-- ubiquitous -->
4. IF um `subagentStop` chega sem `subagentStart` correspondente THEN o `CursorSource` SHALL ignorá-lo
   como subagente (no-op), sem lançar nem alterar a sessão principal.  <!-- unwanted-behavior -->
5. IF um `subagentStart` chega sem `subagent_id` ou sem pai conhecido THEN o `CursorSource` SHALL
   degradar (nenhum subagente quebrado é criado), mantendo a sessão principal intacta.  <!-- unwanted-behavior -->
6. The eventos `subagentStart`/`subagentStop` SHALL ser reconhecidos em `HOOK_EVENTS` e mapeados em
   `statusBorder` (`working`/`idle`), sem regredir os eventos já tratados.  <!-- ubiquitous -->
7. IF um `subagentStart` nunca recebe `subagentStop` THEN o `CursorSource` SHALL completar o subagente
   quando a presença expira (poll), sem deixá-lo preso em `working`.  <!-- unwanted-behavior -->

**Independent Test**: empurrar `sessionStart` do principal, um `subagentStart` (`subagent_id`, `parent_conversation_id`, `subagent_type`, `task`) e conferir no snapshot do Office um agente `kind:'sub'`, `parentId` do principal, `role` do tipo e `title` da tarefa, `status:'working'`; empurrar o `subagentStop` e conferir `done`; empurrar um `subagentStop`/`subagentStart` sem id/pai e conferir no-op sem lançar; avançar o relógio além de `STALE_PRESENCE_MS`, `poll()` e conferir o sub `done`.

### P1: GitHub a partir do transcript do Cursor

**User Story**: Como usuário do Habblaud, quero que `git push`, `gh pr create` e `gh pr merge` feitos
pelo Cursor animem a sala, para ver a publicação como nas outras ferramentas.

**Why P1**: É a lacuna P7 (efeitos de sala); sem isto publicar pelo Cursor não aparece no escritório.

**Acceptance Criteria**:

1. WHEN a `CursorSource` conhece o `transcript_path` de uma conversa THEN ela SHALL ler o arquivo
   incrementalmente (`FileTail`) à procura de blocos `tool_use` de `Shell` cujo comando seja `git`/`gh`.  <!-- event-driven -->
2. WHEN um comando `git push`/`gh pr create`/`gh pr merge` aparece num `tool_use` do transcript THEN a
   `CursorSource` SHALL emitir o evento correspondente via `office.githubEvent`.  <!-- event-driven -->
3. The nova detecção SHALL morar em `server/sources/cursor/github.ts` (`cursorGitHubCall` →
   `githubCallOf`; `cursorGitHubEvent` → `detectGitHubResult`), sem duplicar as regras do git/gh.  <!-- ubiquitous -->
4. WHEN o pump se liga a um transcript que já tinha conteúdo THEN ele SHALL posicionar a leitura no fim
   (`seekEnd`), para não reemitir efeitos antigos.  <!-- event-driven -->
5. IF o transcript não traz `tool_result` (o Cursor não grava resultados) THEN a detecção SHALL, sem
   resultado, usar um fallback só-comando para `pr_create`/`pr_merge`/`push`, respeitando
   `--dry-run`/`--delete`/`--auto`, e SHALL documentar a limitação (não confirma sucesso).  <!-- unwanted-behavior -->
6. IF o arquivo do transcript está ausente ou opaco THEN o pump SHALL degradar (sem lançar), mantendo a
   presença e as atividades por hook.  <!-- unwanted-behavior -->

**Independent Test**: escrever um transcript sintético com um `tool_use` `Shell{command:'gh pr create --title x'}`; ligar a fonte (hook com `transcript_path`) e conferir que o conteúdo pré-existente **não** gera evento (seekEnd); anexar um `tool_use` `Shell{command:'git push origin main'}` e, no `poll()`, conferir uma atividade `tool:'GitHub'` no agente; repetir com transcript ausente e conferir que o `poll()` não lança e a presença por hook segue.

### P1: Histórico do terminal do Cursor

**User Story**: Como usuário do Habblaud, quero ver as sessões recentes do Cursor no histórico do
terminal, para reabrir conversas encerradas como nas outras ferramentas.

**Why P1**: É a lacuna P7; sem isto o histórico do Cursor fica invisível.

**Acceptance Criteria**:

1. WHEN `CursorHistory.list()` roda THEN ele SHALL varrer
   `~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl` e devolver `RecentSession[]` com `account`
   `'cursor'`, `provider` `'cursor'`, `sessionId` = id da pasta, `projectDir`, `lastAt` (mtime sem
   horário no transcript), `size` e `open`.  <!-- event-driven -->
2. The `list()` SHALL incluir `title` (o primeiro prompt via `createCursorTerminalParser`), `project`
   (cwd decodificado quando der para inferir) e `firstAt` (mtime quando o transcript não traz horário).  <!-- ubiquitous -->
3. WHEN `resolve(account, sessionId)` acha a sessão THEN ele SHALL devolver `{ path, createParser }` com
   `createParser = createCursorTerminalParser` (um parser novo por chamada).  <!-- event-driven -->
4. IF `account`/`sessionId` são desconhecidos/inválidos, ou o arquivo resolve para fora da pasta da
   conta THEN `resolve` SHALL devolver 400/404 e SHALL nunca lançar (proteção contra path traversal).  <!-- unwanted-behavior -->
5. WHEN `config.cursor` está ligado THEN o servidor SHALL registrar `CursorHistory` no `HistorySet`,
   e a conta `'cursor'` SHALL ser despachada para ele.  <!-- event-driven -->
6. IF um projeto/transcript do Cursor está ilegível dentro da janela THEN o `list()` SHALL ignorar
   aquele candidato sem derrubar a listagem (degradação).  <!-- unwanted-behavior -->

**Independent Test**: criar `projects/<slug>/agent-transcripts/<id>/<id>.jsonl` sintético; `list()` devolve a sessão com `account`/`provider`/`sessionId`/`projectDir`/`size`/`open:false` e o `title` do primeiro prompt; `resolve('cursor', id)` devolve `path` e um `createParser` novo por chamada; `resolve('cursor', '../etc')` → 400 e `resolve('outra', id)` → 404; `HistorySet` com o `CursorHistory` despacha a conta `'cursor'` para ele.

### P2: Degradação sem transcript/histórico/efeitos

**User Story**: Como responsável pelo Habblaud, quero que a ausência do transcript, do histórico ou de
efeitos não quebre o escritório, nem que desligar o Cursor afete as outras ferramentas.

**Why P2**: A Fase 4 é aditiva; nada pode regredir o que já funciona.

**Acceptance Criteria**:

1. IF não há transcript, histórico nem evento do GitHub do Cursor THEN o Habblaud SHALL seguir
   funcionando com a presença e as atividades por hook, sem lançar.  <!-- unwanted-behavior -->
2. IF o Cursor está desligado/oculto (`config.cursor` falso) THEN as fontes e o histórico de Claude e
   Codex SHALL ficar inalterados.  <!-- unwanted-behavior -->

**Independent Test**: construir a `CursorSource` sem nenhum `transcript_path`, rodar `poll()` e conferir presença/atividade por hook e `transcriptPathOf` `undefined`; montar um `HistorySet` sem o `CursorHistory` e conferir que as contas de Claude/Codex seguem resolvendo como antes.

## Edge Cases

- IF `subagentStart`/`subagentStop` não traz `hook_event_name` reconhecível THEN a fonte SHALL devolver `false` (evento ignorado), sem lançar.
- WHEN o `sessionEnd` do principal chega THEN os subagentes ainda presentes SHALL sair junto pelo `closeMain` (o Office já encerra os descendentes).
- IF uma linha do transcript não é JSON ou não traz `tool_use` THEN o pump SHALL ignorá-la, sem lançar.
- WHEN o transcript é truncado/rotacionado THEN o pump SHALL recomeçar do fim (`seekEnd`), sem reemitir efeitos antigos.
- IF o comando `git push` é `--dry-run`/`--delete` ou o `gh pr merge` é `--auto` THEN a detecção SHALL não emitir o evento (nada foi publicado de verdade).
- IF `resolve` recebe um `sessionId` com separadores de caminho THEN ele SHALL devolver 400 sem tocar o disco.

## Requirement Traceability

| Requirement ID | Story                              | Phase  | Status       |
| -------------- | ---------------------------------- | ------ | ------------ |
| CSH-01         | P1: Subagentes por hook            | Design | Implementing |
| CSH-02         | P1: Subagentes por hook            | Design | Implementing |
| CSH-03         | P1: Subagentes por hook            | Design | Implementing |
| CSH-04         | P1: Subagentes por hook            | Design | Implementing |
| CSH-05         | P1: Subagentes por hook            | Design | Implementing |
| CSH-06         | P1: Subagentes por hook            | Design | Implementing |
| CSH-07         | P1: Subagentes por hook            | Design | Implementing |
| CSH-08         | P1: GitHub do transcript           | Design | Implementing |
| CSH-09         | P1: GitHub do transcript           | Design | Implementing |
| CSH-10         | P1: GitHub do transcript           | Design | Implementing |
| CSH-11         | P1: GitHub do transcript           | Design | Implementing |
| CSH-12         | P1: GitHub do transcript           | Design | Implementing |
| CSH-13         | P1: GitHub do transcript           | Design | Implementing |
| CSH-14         | P1: Histórico do terminal          | Design | Implementing |
| CSH-15         | P1: Histórico do terminal          | Design | Implementing |
| CSH-16         | P1: Histórico do terminal          | Design | Implementing |
| CSH-17         | P1: Histórico do terminal          | Design | Implementing |
| CSH-18         | P1: Histórico do terminal          | Design | Implementing |
| CSH-19         | P1: Histórico do terminal          | Design | Implementing |
| CSH-20         | P2: Degradação                     | Design | Implementing |
| CSH-21         | P2: Degradação                     | Design | Implementing |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified
**Coverage:** 21 total, 21 mapped to tasks, 0 unmapped ✅

## Success Criteria

- [ ] Subagentes da IDE aparecem no escritório (kind `sub`, `parentId`, `role`, `title`) e entregam ao Stop.
- [ ] Órfãos e eventos sem id/pai degradam sem lançar; Start sem Stop completa no poll.
- [ ] `git push`/`gh pr create`/`gh pr merge` do transcript animam a sala (push/pr) e não reemitem conteúdo antigo.
- [ ] `GET /api/sessions/recent` lista as sessões do Cursor e `resolve` reabre a conversa (parser do Cursor).
- [ ] Sem transcript/histórico/efeitos, e com o Cursor desligado, Claude/Codex seguem inalterados.
- [ ] Gate verde (`typecheck` + `vitest` + `build`), sem regressão das suítes existentes.
