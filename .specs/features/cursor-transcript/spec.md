# Transcript do Cursor — terminal, atividades ricas e tokens (Specification)

## Problem Statement

A Fase 1 do Cursor entregou a `CursorSource` **só por hooks**: `transcriptPathOf`/`terminalParser`
devolvem `undefined` (`server/sources/cursor/source.ts:121-129`) e o painel não tem como abrir a
conversa da sessão. O `transcript_path` já vem nos hooks e é normalizado em `CursorEvent`
(`server/sources/cursor/rollout.ts:57-84`), mas é descartado — assim como os campos de tokens
(`input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`) que `stop` e
`afterAgentResponse` trazem (relatório P1). O Cursor também usa nomes de ferramenta próprios
(`Shell`, `StrReplace`, `CallDynamicTool`, `GetDynamicTools`, `AskQuestion`, `UpdateCurrentStep`,
`List`), que hoje caem no genérico do `describeCursorTool`. Esta feature (Fase 3 de `06` §6.8)
liga o transcript à fonte: terminal, atividades ricas e tokens — reusando os helpers do terminal
existente e, sem `transcript_path`, degradando para o comportamento atual.

## Goals

- [x] Guardar o `transcript_path` por conversa e expô-lo em `transcriptPathOf(agentId)`.
- [x] Criar `server/sources/cursor/terminal.ts` (`createCursorTerminalParser`) e ligá-lo em
      `terminalParser(agentId)`, reconstruindo user/assistant/tool/system das linhas JSONL.
- [x] Acumular tokens dos eventos de hook em `AgentStats` e refletir no Office, sem regredir.
- [x] Traduzir os nomes de ferramenta do Cursor que valem a pena numa `Activity` legível.
- [x] Registrar, como resultado, que o transcript observado **não** traz checklist (tarefas).

## Out of Scope

| Feature                                                       | Reason                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Histórico de sessões / efeitos `git`/`gh` (Fase 4)            | Depende de `history.ts` próprio; fora do terminal/tokens desta fase         |
| Subagentes por transcript (só por hook já é Fase 1)           | Escopo da Fase 4 (`06` §6.8)                                                |
| Injeção de mensagem / uso do plano (Fase 5)                   | Bloqueado por C7/C6; independente desta fase                               |
| Reescrever `transcript.ts` (inspetor de POC)                  | Continua sendo o inspetor do harness; o terminal é um arquivo novo          |
| Emitir `TerminalEntry` do tipo `result`                       | O transcript observado não carrega resultados de ferramenta (ver below)     |
| Derivar `TaskItem` sem evidência                              | Nenhuma ferramenta/traço de checklist observado — não inventar (ver below)  |
| UI/rotas novas do cliente                                     | O terminal já é dirigido por `terminalParser`/`transcriptPathOf`            |
| Publicar/push no fork ou abrir PR                             | Ação remota: exige go-ahead explícito (blast radius)                        |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Formato do transcript | JSONL `{"role":…,"message":{"content":[…{"type":"text"\|"tool_use",…}]}}` + `{"type":"turn_ended","status":…}` | Mapeado ao vivo (lacuna C1) e confirmado no export real | y |
| `transcript_path` nulo/ausente | Não grava/limpa o caminho; `transcriptPathOf` segue `undefined` | Eventos como `beforeReadFile` trazem `transcript_path:null`; o caminho é estável por conversa | y |
| Sem timestamp nas linhas | `at` vem de `timestamp`/`ts` quando houver; senão do último conhecido (`Date.now()` só como reserva) | O transcript do Cursor não grava timestamp; a ordem do arquivo já é a ordem da conversa | y |
| Entradas `result` no terminal | **Não** emitidas: o transcript real não traz `tool_result` (0 em 28+10 linhas) | Não inventar resultado que não existe; o que não há vira ausência documentada | y |
| Tarefas (checklist) | **Não** derivadas: nenhuma ferramenta/traço de checklist observado (`UpdateCurrentStep` é passo, não lista) | `05` matriz: "nenhuma ferramenta de tarefas observada"; não implementar meia-boca | y |
| Tokens | Somar cada evento que traga campos: `tokensIn = input + cache_read + cache_write`, `tokensOut = output` | Segue a instrução da fase; se `stop`/`afterAgentResponse` repetirem o total, o número vira limite superior (aceito na v1) | y |
| Campo de token ausente | Não mexe no acumulado (nunca regride) | Um evento parcial não pode zerar o que já foi contado | y |
| Nomes de ferramenta do transcript | `Shell`→Bash, `StrReplace`→Edit, `CallDynamicTool`/`MCP:x`→`mcp__…`; resto pelo nome cru | Mesmo mapeamento de `describeCursorTool`; o desconhecido cai no genérico | y |
| Ids/dedupe | Id por posição da linha + índice do bloco; parser novo por leitura | O `FileTail` não relê; um parser por conexão mantém ids estáveis | y |
| Idioma | PT-BR (comentários e textos) | Convenção do repositório | y |
| Gate do repositório | `npm run typecheck && npm test && npm run build` (quick: `npx vitest run <arquivo>`) | `package.json` / rodadas anteriores | y |

**Open questions:** none — all resolved or logged above.

## User Stories

### P1: Terminal da conversa do Cursor ⭐ MVP

**User Story**: Como usuário do Habblaud com o Cursor, quero abrir a conversa da sessão como no
Claude Code/Codex, para acompanhar prompts, respostas e ferramentas em tempo real.

**Why P1**: Sem transcript a sessão do Cursor é opaca; é o núcleo da Fase 3.

**Acceptance Criteria**:

1. WHEN um evento de hook do Cursor traz `transcript_path` não vazio THEN o `CursorSource` SHALL
   guardá-lo por conversa e `transcriptPathOf(agentId)` SHALL devolvê-lo.  <!-- event-driven -->
2. IF o evento não traz `transcript_path` ou ele é nulo THEN `transcriptPathOf(agentId)` SHALL
   continuar `undefined`, sem limpar um caminho já guardado e sem quebrar o resto do Habblaud.  <!-- unwanted-behavior -->
3. WHEN `terminalParser(agentId)` é chamado para um agente conhecido do Cursor THEN o `CursorSource`
   SHALL devolver um parser NOVO do Cursor (`createCursorTerminalParser`).  <!-- event-driven -->
4. The `createCursorTerminalParser` SHALL converter cada linha JSONL do transcript em `TerminalEntry`
   (`user`/`assistant`/`tool`/`system`) e SHALL devolver `[]` para linha inválida, desconhecida ou
   irrelevante, sem lançar.  <!-- ubiquitous -->
5. The parser SHALL mapear cada bloco `tool_use` a uma entrada `tool` com título no estilo `toolView`
   (ex.: `Bash(ls -la)`, `Read(a.ts)`, `Edit(a.ts)`, `Glob(**/*.ts)`), cobrindo `Shell`, `Read`,
   `Write`, `StrReplace`, `Glob`, `Grep`, `CallDynamicTool`, `GetDynamicTools`, `AskQuestion` e `Task`.  <!-- ubiquitous -->
6. WHEN a linha é `{"type":"turn_ended","status":…}` THEN o parser SHALL emitir uma entrada `system`
   de fim de turno, marcando `error`/`warn` quando o status não for de sucesso.  <!-- event-driven -->
7. The parser SHALL reusar as regras do terminal (`prepare`/`marked`/`maskSecrets`/truncamento), de
   modo que mensagens e argumentos longos saiam truncados e segredos saiam mascarados.  <!-- ubiquitous -->
8. IF o transcript observado não traz resultados de ferramenta THEN o parser SHALL não emitir entrada
   `result` (nenhum `tool_result` é inventado).  <!-- unwanted-behavior -->

**Independent Test**: alimentar `createCursorTerminalParser()` com linhas sintéticas (um prompt, uma
resposta com texto + `tool_use` `Shell`/`Read`/`StrReplace`/`CallDynamicTool`, um `turn_ended`) e
conferir os `TerminalEntry` (kinds, títulos, tool, máscara/truncamento); depois, com linhas inválidas,
conferir `[]` sem lançar.

### P1: Tokens acumulados do Cursor

**User Story**: Como usuário do Habblaud, quero ver os tokens consumidos pela sessão do Cursor, para
acompanhar o custo como nas outras ferramentas.

**Why P1**: Os hooks já trazem os números; é barato exibir e fecha a paridade de `AgentStats`.

**Acceptance Criteria**:

1. WHEN um evento de hook traz `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`
   THEN o `CursorSource` SHALL acumular `tokensIn += input + cache_read + cache_write` e
   `tokensOut += output` naquele agente.  <!-- event-driven -->
2. IF um evento não traz um campo de token THEN o `CursorSource` SHALL manter o acumulado (nunca
   regride) e SHALL não inventar número.  <!-- unwanted-behavior -->
3. WHEN os tokens de um agente são acumulados THEN o `Office` SHALL refletir `stats.tokensIn` e
   `stats.tokensOut` no `AgentInfo` daquele agente.  <!-- event-driven -->
4. IF um evento traz um campo de token com valor não numérico THEN o `CursorSource` SHALL ignorá-lo,
   sem lançar nem corromper o acumulado.  <!-- unwanted-behavior -->

**Independent Test**: empurrar um `stop` com os quatro campos e conferir `stats.tokensIn`/`tokensOut`
no snapshot do Office; empurrar um `afterAgentResponse` só com `output_tokens` e conferir a soma;
empurrar um evento sem tokens e conferir que os números não mudam.

### P2: Atividades ricas das ferramentas do Cursor

**User Story**: Como usuário do Habblaud, quero que as ferramentas próprias do Cursor apareçam
traduzidas no escritório, para entender o que o agente está fazendo sem abrir o terminal.

**Why P2**: Complementa o P1; o P1 já entrega a conversa, mas o balão fica genérico.

**Acceptance Criteria**:

1. The `describeCursorTool` SHALL traduzir `GetDynamicTools`, `AskQuestion` e `UpdateCurrentStep` em
   `Activity` legível (kind/ícone/texto), mantendo o nome cru quando não houver tradução dedicada.  <!-- ubiquitous -->
2. WHEN um evento de hook `preToolUse` traz `tool_name` de uma ferramenta própria do Cursor THEN a
   `Activity` adicionada ao Office SHALL usar a tradução dedicada (não o genérico "Usando …").  <!-- event-driven -->

**Independent Test**: chamar `describeCursorTool` para `GetDynamicTools`/`AskQuestion`/
`UpdateCurrentStep` e conferir kind/texto; empurrar um `preToolUse` com `tool_name` desses no teste
da fonte e conferir a `Activity` no agente.

### P3: Tarefas do Cursor — resultado da investigação

**User Story**: Como responsável pelo Habblaud, quero que a ausência de checklist seja registrada
como resultado, para não manter aberta uma lacuna que já foi investigada.

**Why P3**: A matriz `05` marca tarefas como "a confirmar"; a amostra real responde: não há checklist.

**Acceptance Criteria**:

1. IF o transcript observado não expõe ferramenta nem traço de checklist THEN o sistema SHALL não
   derivar `TaskItem` (nem parcialmente) e SHALL documentar a ausência.  <!-- unwanted-behavior -->

**Independent Test**: reconstruir uma sessão a partir de linhas com `UpdateCurrentStep`/sem `List` e
conferir `tasks` vazio no agente (nenhuma tarefa inventada).

## Edge Cases

- IF uma linha não é JSON ou tem forma desconhecida THEN o parser SHALL devolvê-la como `[]` (sem entrada), sem lançar.
- WHEN uma mensagem assistant traz vários blocos `tool_use` THEN o parser SHALL emitir uma entrada `tool` por bloco.
- IF um `tool_use` não traz o argumento esperado (ex.: `Shell` sem `command`) THEN o parser SHALL ainda emitir a entrada com o título possível (ex.: `Bash`), sem lançar.
- WHEN o parser recebe uma linha vazia ou só com espaços THEN ele SHALL devolver `[]` (nenhuma entrada).
- IF o `transcript_path` aponta um arquivo ausente/opaco THEN o terminal SHALL degradar pelo caminho já existente (`FileTail`), sem alterar `transcriptPathOf`.

## Requirement Traceability

| Requirement ID | Story                              | Phase  | Status       |
| -------------- | ---------------------------------- | ------ | ------------ |
| CTRANS-01      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-02      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-03      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-04      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-05      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-06      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-07      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-08      | P1: Terminal da conversa           | Design | Implementing |
| CTRANS-09      | P1: Tokens acumulados              | Design | Implementing |
| CTRANS-10      | P1: Tokens acumulados              | Design | Implementing |
| CTRANS-11      | P1: Tokens acumulados              | Design | Implementing |
| CTRANS-12      | P1: Tokens acumulados              | Design | Implementing |
| CTRANS-13      | P2: Atividades ricas               | Design | Implementing |
| CTRANS-14      | P3: Tarefas (resultado)            | Design | Implementing |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified
**Coverage:** 14 total, 14 mapped to tasks, 0 unmapped ✅

## Success Criteria

- [x] Abrir o terminal de um agente Cursor com `transcript_path` mostra a conversa (user/assistant/tool/system).
- [x] Sem `transcript_path`/com ele nulo, `transcriptPathOf` segue `undefined` e nada quebra.
- [x] `stats.tokensIn`/`tokensOut` do agente crescem com `stop`/`afterAgentResponse`, sem regredir.
- [x] `GetDynamicTools`/`AskQuestion`/`UpdateCurrentStep` geram `Activity` legível.
- [x] Nenhum `TaskItem` é inventado; a ausência de checklist fica documentada.
- [x] Gate verde (`typecheck` + `vitest` + `build`), sem regressão das suítes existentes.
