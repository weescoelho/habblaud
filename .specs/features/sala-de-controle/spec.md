# Sala de Controle — Observabilidade, triagem e controle de agentes (Specification)

## Problem Statement

O escritório já observa o Cursor (Fases 1–5: presença/atividades por hook, permissões, transcript,
subagentes, histórico e GitHub), mas três dores reais de quem opera vários agentes persistem:

1. **Latência do espelho.** O terminal do escritório demora a refletir a conversa: o transcript é lido
   por *polling* (`server/http/terminal.ts` com `POLL_MS = 400` e **um `FileTail` por conexão**;
   `server/sources/cursor/source.ts` com `pollMs = 1000`), sem o acelerador `fs.watch` que o próprio
   repositório já usa em `server/sources/watcher.ts` e `server/sources/codex/source.ts`.
2. **Falta de visibilidade.** Não se vê *o que* o agente está programando (o `afterFileEdit` traz o
   diff real — `{file_path, edits:[{old_string,new_string}]}` — e hoje só o `file_path` é lido), nem
   uma triagem única de "quem precisa de você" (permissão / `AskQuestion` / falha), nem um mosaico de
   N sessões para acompanhar em paralelo sem abrir chat por chat.
3. **Falta de controle.** Não se abre/atribui tarefas paralelas, não se envia mensagem na conversa
   viva da IDE pelo escritório e não se lista/usa skills.

Esta feature entrega a **sala de controle**: ver em tempo real, triar e dirigir agentes. O motor é
reutilizável pelos demais provedores; a primeira fonte é o Cursor (mecanismos ricos: hooks com diff,
`AskQuestion`, CLI headless com stream-json e skills).

## Goals

- [ ] O terminal espelha o transcript em **≤300 ms (p95)** e as atividades em **≤500 ms**, com
      `fs.watch` como acelerador, *fallback* para polling e **um leitor por agente**.
- [ ] O diff da edição (arquivo + linhas `+`/`-`) aparece **inline** na entrada da ferramenta,
      mascarando segredos e truncando com indicador.
- [ ] Uma **view dedicada "Precisa de você"** (permissão / `AskQuestion` / falha) com *badge* no feed.
- [ ] Um **mosaico de sessões** com provedor, status, atividade e último diff por card.
- [ ] **Lançar/parar/retomar tarefas headless** isoladas (worktree + branch), observáveis como uma
      sessão comum.
- [ ] **Enfileirar mensagem** para uma conversa viva do Cursor (entrega ao fim do turno) com trava de
      segurança contra loop.
- [ ] **Listar e disparar skills** a partir do escritório.
- [ ] **Sala por local de execução**: cada projeto (workspace) vira uma sala com os seus agentes e
      subagentes; tarefas headless aparecem na sala do projeto de origem com o rótulo da tarefa.

## Out of Scope

Explicitamente excluído, para evitar *scope creep*.

| Feature | Reason |
| ------- | ------ |
| Agentes de nuvem do Cursor (prefácio `&` / automations) | A v1 dirige apenas sessões **locais** (headless) e a IDE local; o resto é superfície remota |
| Injeção em **meio** ao turno na IDE | Indisponível: `stop.followup_message` entrega só ao **fim** do turno e `beforeSubmitPrompt` **não** injeta contexto (só bloqueia) |
| Aceitar/rejeitar/apagar diffs pelo escritório | A v1 é **somente leitura** dos diffs; aplicar/reverter pertence ao Cursor |
| Fonte de uso do plano do Cursor | Já resolvido (cartão oculto) na Fase 5 (`cursor-uso-mensagens`) |
| Execução de skills de provedores ≠ Cursor | O catálogo pode ler diretórios de compatibilidade, mas a **execução** fica no Cursor |
| Uma sala por raiz em workspaces multi-raiz | O Cursor entrega uma lista em `workspace_roots`; a v1 usa só a primeira raiz como sala |
| Detecção confiável de CI/release no Cursor IDE | Sem `tool_result` no transcript, o desfecho é indisponível; a v1 mantém o fallback só-comando e **não detecta CI/release** no Cursor |
| Multi-usuário, autenticação remota e sincronização entre máquinas | O escritório é local (`bind` local); não há servidor multiusuário |
| Publicar/`push`/abrir PR | Ação remota: exige go-ahead explícito (blast radius) |
| Teste end-to-end **ao vivo** no CI | Depende da máquina com Cursor; entra como runbook/validação manual, não como gate automático |

---

## Assumptions & Open Questions

Toda ambiguidade é resolvida ou registrada aqui — nada fica silenciosamente indefinido.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Alvo de latência | Terminal ≤300 ms (p95); atividades ≤500 ms | Mede a partir da linha **gravada no disco**; o *flush* do transcript pelo Cursor está fora do nosso controle (hipótese a medir no runbook) | y |
| Mecanismo de baixa latência | `fs.watch` como acelerador + *fallback* a polling | Padrão já existente em `watcher.ts`; em Docker/bind-mount os eventos podem não chegar, então o *fallback* é obrigatório (SC-04) | y |
| Leitor de transcript | Um tailer compartilhado por agente, com *fan-out* para N terminais | Hoje cada conexão abre o próprio `FileTail` (até `MAX_STREAMS = 8`) e relê até 4 MB no *init* | y |
| Diff truncado | Truncar acima de um limite (definido no Design) com indicador e conteúdo completo sob demanda | Mesmo padrão de `RESULT_PREVIEW_LINES` (resultados já truncam) | y |
| Segredos no diff | Passar por `maskSecrets` antes de exibir/persistir | Regra da casa: transcript e terminal já mascaram segredos | y |
| Isolamento da tarefa headless | Padrão **worktree + branch por tarefa**, com opção de workspace atual | Evita colisão de arquivos entre tarefas paralelas (decisão da rodada 2) | y |
| Execução forçada na tarefa | `--force`/`--trust` só com opt-in explícito por tarefa; padrão sem forçar | Reduz blast radius; documenta que headless sem `--trust` pode travar pedindo aprovação | y |
| Modelo/modo expostos na tarefa | `plan`/`ask`/agent + `--model`; padrão `plan` | Alinha com os modos documentados do Cursor e reduz risco | y |
| Limite de auto-followups | N = 5 entregas automáticas consecutivas sem resposta do usuário | O Cursor limita auto-followups; a trava evita loop com a IA (SC-29) | y |
| Fila de mensagem na IDE | **Uma** mensagem enfileirada por conversa, com estado visível | Decisão da rodada 3: fila + estado + trava de segurança | y |
| Canais de tarefa | **Dois botões explícitos**: headless gerenciado e mensagem na IDE | Decisão da rodada 1; deixa claro que o headless não espelha na IDE | y |
| Onde mostrar o diff | **Inline** no card da ferramenta no terminal | Decisão da rodada 1; preserva o contexto da conversa | y |
| Onde vive a triagem | **View dedicada** + badge no feed | Decisão da rodada 2 | y |
| Diretórios de skills | `.cursor/skills`, `.agents/skills`, `~/.cursor/skills` e compatibilidade (`SKILL.md`) | Diretórios documentados do Cursor; leitura de *frontmatter* é simples | y |
| Efeito **ao vivo** da mensagem na IDE | Fiação + **degradação graciosa**; validação ao vivo é tarefa de runbook separada | Lacuna C7: a *forma* do `stop.followup_message` foi validada, o efeito real segue pendente | y |
| Deep-link para o chat do Cursor | *Best-effort*; se indisponível, foca o agente no próprio escritório | A existência de um deep-link para chat não é garantida (SC-16) | y |
| Idioma | PT-BR (UI e comentários) | Convenção do repositório | y |
| Gate do repositório | `npm run typecheck && npm test && npm run build` (quick: `npx vitest run <arquivo>`) | `package.json` e rodadas anteriores | y |
| Workspace multi-raiz | Usar apenas `workspace_roots[0]` (a primeira raiz) | O hook entrega uma lista; a v1 assume a primeira raiz como a sala (limitação registrada) | y |
| Sala de tarefa em worktree | Sala do **repositório de origem** + nome da tarefa/branch como rótulo no agente | Mantém o projeto agrupado e casa com "uma sala por projeto" (decisão da rodada 4) | y |
| Sala quando não há workspace | Sala padrão `cursor` | Comportamento atual (`DEFAULT_ROOM`); evita um agente "sem sala" | y |
| Fidelidade do GitHub no Cursor IDE | Manter o atual: PR aberto/merge e push por comando (**pode falso-positivar**); CI e release não detectados | Decisão da rodada 5 ("só documentar"); o transcript do Cursor não grava `tool_result`, então o desfecho é indisponível | y |

**Open questions:** none — all resolved or logged above.

---

## User Stories

### P1: Responsividade do espelho (terminal + atividades) ⭐ MVP

**User Story**: Como engenheiro que opera vários agentes, quero que o terminal e as atividades do
escritório reflitam o que o Cursor faz **em tempo real**, para não depender de reabrir o chat para
ver o que já aconteceu.

**Why P1**: é a dor relatada diretamente ("o texto demora aparecer"); é fundacional — as demais
histórias são percebidas pior enquanto o espelho for lento — e a correção reusa o padrão que o
repositório já tem (`fs.watch` acelerador), portanto é de baixo risco.

**Acceptance Criteria**:

1. WHEN uma linha nova é gravada no transcript do agente no disco THEN o terminal do escritório SHALL exibir a entrada correspondente em até 300 ms (percentil 95). (`SC-01` — event-driven)
2. WHEN o transcript do agente muda THEN as atividades e o status no escritório SHALL refletir a mudança em até 500 ms. (`SC-02` — event-driven)
3. WHEN uma rajada de muitas linhas é gravada de uma vez THEN o sistema SHALL entregar todas em ordem, sem perda, respeitando um orçamento limitado de leitura por ciclo. (`SC-03` — event-driven)
4. IF o observador de arquivos do sistema operacional não estiver disponível ou perder eventos THEN o sistema SHALL cair para polling e ainda entregar dentro do limite de polling. (`SC-04` — unwanted-behavior)
5. The sistema SHALL manter no máximo um leitor de transcript por agente, independentemente do número de terminais conectados. (`SC-05` — ubiquitous)

**Independent Test**: abrir dois terminais do mesmo agente, injetar linhas no transcript e medir que
ambos recebem em ordem dentro do alvo, com uma única leitura no servidor; derrubar o observador e
confirmar que o *fallback* entrega igual.

---

### P2: Diffs ao vivo inline (o que está programando)

**User Story**: Como engenheiro, quero ver o **diff** (arquivo e linhas `+`/`-`) de cada edição do
agente direto na conversa, para acompanhar o que ele está programando sem abrir o Cursor.

**Why P2**: é o maior ganho de observabilidade por menor custo — o dado já chega no hook
(`afterFileEdit`) e no transcript (`StrReplace`/`Write`), faltando apenas capturá-lo e exibi-lo.

**Acceptance Criteria**:

6. WHEN o agente edita um arquivo THEN o terminal SHALL exibir, na própria entrada da ferramenta, o caminho do arquivo e as linhas do diff. (`SC-06` — event-driven)
7. WHEN uma edição remove e adiciona texto THEN o diff exibido SHALL distinguir linhas removidas (`-`) de linhas adicionadas (`+`). (`SC-07` — event-driven)
8. IF o diff exceder o limite de exibição THEN o sistema SHALL truncá-lo com indicador explícito e manter o conteúdo completo acessível sob demanda. (`SC-08` — unwanted-behavior)
9. The sistema SHALL mascarar segredos no conteúdo do diff antes de exibi-lo ou persisti-lo. (`SC-09` — ubiquitous)

**Independent Test**: simular uma edição com trechos removido/adicionado, incluindo um segredo
sintético e um diff acima do limite, e conferir `+`/`-`, truncamento e máscara.

---

### P3: Fila "Precisa de você" (triagem única)

**User Story**: Como engenheiro, quero uma fila única com tudo o que **exige a minha ação** (permissão,
pergunta, falha), para não perder um pedido de confirmação no meio de vários chats.

**Why P3**: ataca diretamente "ver se está pedindo confirmação"; as peças já existem (permissões da
Fase 2, `Activity.kind === 'ask'` com `questions`, `stop.status`), falta consolidá-las numa fila.

**Acceptance Criteria**:

10. WHEN um agente entra em `waiting` por permissão, `AskQuestion` ou falha THEN o escritório SHALL listá-lo na view dedicada com o motivo em até 500 ms. (`SC-10` — event-driven)
11. WHEN o usuário aprova ou nega uma permissão pela fila THEN o agente SHALL receber a decisão. (`SC-11` — event-driven)
12. WHEN uma permissão é decidida THEN o item correspondente SHALL sair da fila. (`SC-12` — event-driven)
13. WHEN o agente em espera traz uma `AskQuestion` THEN a fila SHALL exibir a pergunta e as respectivas opções. (`SC-13` — event-driven)
14. WHERE o canal de mensagem estiver ativo THEN o usuário SHALL poder responder à `AskQuestion` pela fila. (`SC-14` — optional-feature)
15. WHILE nenhum agente estiver em espera THEN a fila SHALL exibir estado vazio e o badge SHALL ficar oculto. (`SC-15` — state-driven)
16. IF a abertura do chat no Cursor (deep-link) não estiver disponível THEN o escritório SHALL focar o agente dentro do próprio escritório. (`SC-16` — unwanted-behavior)

**Independent Test**: fazer um agente pedir permissão e outro abrir uma `AskQuestion`; conferir a
ordem/motivo na fila, aprovar/negar e ver o item sair, e o estado vazio quando ninguém espera.

---

### P4: Mosaico de sessões + notificações (paralelizar sem abrir chat)

**User Story**: Como engenheiro, quero um grid de todos os agentes ao vivo com status, atividade e
último diff, para acompanhar vários trabalhos em paralelo num só olhar.

**Why P4**: materializa "paralelizar e ter observabilidade"; os dados já estão no `OfficeSnapshot`,
então é sobretudo cliente.

**Acceptance Criteria**:

17. WHILE houver um ou mais agentes ao vivo THEN o mosaico SHALL exibir um card compacto por agente com provedor, status, atividade atual e último diff. (`SC-17` — state-driven)
18. WHEN o usuário aciona um card THEN o escritório SHALL abrir o terminal daquele agente. (`SC-18` — event-driven)
19. WHEN um agente transita para `waiting` THEN o escritório SHALL emitir uma notificação (badge e, quando permitido, notificação do sistema). (`SC-19` — event-driven)
20. IF o número de agentes ao vivo exceder a capacidade do grid THEN o mosaico SHALL rolar ou paginar sem ocultar agentes em `waiting`. (`SC-20` — unwanted-behavior)

**Independent Test**: com 3+ agentes, conferir card/conteúdo, clique abrindo o terminal e o
realce/notificação de quem entra em `waiting` mesmo com o grid cheio.

---

### P5: Orquestrador headless (abrir e atribuir tarefas)

**User Story**: Como engenheiro, quero abrir tarefas a partir do escritório e vê-las rodar
isoladamente (worktree/branch própria), observáveis como qualquer sessão, para paralelizar trabalho
de verdade.

**Why P5**: é o diferencial de **controle** — atribuir tarefas e paralelizar; já há base validada
(P5 provou o stream-json do `cursor-agent`).

**Acceptance Criteria**:

21. WHEN o usuário cria uma tarefa THEN o escritório SHALL lançar uma sessão headless gerenciada do Cursor com o prompt, o modelo e o modo informados. (`SC-21` — event-driven)
22. WHERE a tarefa estiver marcada como isolada THEN o escritório SHALL criar um worktree com branch dedicada antes de lançar. (`SC-22` — optional-feature)
23. WHEN uma tarefa gerenciada é excluída THEN o escritório SHALL remover o worktree e a branch criados para ela. (`SC-23` — event-driven)
24. WHILE uma tarefa gerenciada roda THEN o escritório SHALL derivar a mesma observabilidade de uma sessão da IDE (status, atividade, terminal e tokens). (`SC-24` — state-driven)
25. WHEN o usuário para uma tarefa THEN o escritório SHALL encerrar o processo e marcá-la como parada AND WHEN o usuário a retoma THEN o escritório SHALL continuar a mesma sessão. (`SC-25` — complex)
26. IF o lançamento falhar (binário ausente ou erro de worktree) THEN o escritório SHALL exibir um erro acionável e marcar a tarefa como falha. (`SC-26` — unwanted-behavior)

**Independent Test**: criar uma tarefa isolada, ver o worktree/branch surgirem e a observabilidade
aparecer; parar e retomar; forçar falha (binário ausente) e ver o erro; excluir e ver a limpeza.

---

### P6: Mensagem na conversa do Cursor (fila no fim do turno)

**User Story**: Como engenheiro, quero mandar uma mensagem para uma conversa viva do Cursor pelo
escritório e vê-la aparecer no chat (espelhada), para dirigir o agente sem trocar de janela.

**Why P6**: atende "atribuir tarefas pelo office (espelhado pelo Cursor)". É o único canal de
mensagem que o Cursor aceita em conversa viva (`stop.followup_message`), entregue ao fim do turno.

**Acceptance Criteria**:

27. WHEN o usuário envia uma mensagem para uma conversa viva do Cursor THEN o escritório SHALL exibi-la como "na fila" e entregá-la ao fim do turno atual. (`SC-27` — event-driven)
28. WHEN o turno termina THEN o escritório SHALL entregar a mensagem enfileirada e marcá-la como "entregue". (`SC-28` — event-driven)
29. IF cinco mensagens automáticas consecutivas forem entregues sem uma resposta do usuário THEN o escritório SHALL interromper a entrega automática e exigir ação explícita. (`SC-29` — unwanted-behavior)
30. WHERE o canal de mensagens estiver desligado ou indisponível THEN a caixa SHALL permanecer oculta ou desabilitada com o texto do Cursor, sem regressão à Fase 5. (`SC-30` — optional-feature)
31. The escritório SHALL não perder nem duplicar uma mensagem enfileirada através de reconexões. (`SC-31` — ubiquitous)

**Independent Test**: enfileirar uma mensagem e vê-la entregue no fim do turno (ou, sem canal,
vê-la retida com estado); simular reconexão e conferir que não há perda/duplicidade.

---

### P7: Catálogo e disparo de skills

**User Story**: Como engenheiro, quero listar as skills disponíveis e usá-las pelo escritório, para
aproveitar o que já está instalado sem digitar o nome de cor.

**Why P7**: completa "listar skills e usá-las de pelo próprio office"; depende do canal de sessão
(headless direto; IDE pela fila da P6).

**Acceptance Criteria**:

32. WHEN o usuário abre o painel de skills THEN o escritório SHALL listar as skills dos diretórios conhecidos com nome e descrição. (`SC-32` — event-driven)
33. WHEN o usuário executa uma skill THEN o escritório SHALL submetê-la como prompt à sessão-alvo (headless ou IDE). (`SC-33` — event-driven)
34. IF um arquivo de skill estiver malformado ou sem *frontmatter* THEN o escritório SHALL listá-lo como indisponível em vez de quebrar o painel. (`SC-34` — unwanted-behavior)

**Independent Test**: com uma skill válida e outra quebrada nas raízes, abrir o painel (ambas
aparecem, a quebrada marcada) e executar a válida, vendo-a chegar à sessão-alvo como prompt.

---

### P8: Sala por local de execução (projeto = sala)

**User Story**: Como engenheiro, quero que cada projeto onde um agente roda vire uma sala com os seus
agentes e subagentes, para separar mentalmente o trabalho de cada repositório sem abrir chat por chat.

**Why P8**: consolida a separação por projeto que o modelo de salas já oferece e estende-a às tarefas
headless; torna explícito um comportamento hoje implícito e o protege de regressão.

**Acceptance Criteria**:

35. WHEN um agente reporta um workspace (`workspace_roots[0]` ou `cwd`) THEN o escritório SHALL exibi-lo na sala daquele projeto. (`SC-35` — event-driven)
36. WHEN o basename de duas salas colidir THEN o escritório SHALL desambiguá-las incluindo os diretórios pais. (`SC-36` — event-driven)
37. WHEN um subagente inicia THEN ele SHALL aparecer na mesma sala do agente principal. (`SC-37` — event-driven)
38. IF um evento não trouxer workspace nem `cwd` THEN o escritório SHALL colocar o agente na sala padrão. (`SC-38` — unwanted-behavior)
39. WHEN o usuário renomeia uma sala THEN o novo nome SHALL persistir por pasta entre reinícios. (`SC-39` — event-driven)
40. WHEN uma tarefa headless é lançada em worktree THEN ela SHALL aparecer na sala do repositório de origem, com o nome da tarefa ou branch como rótulo. (`SC-40` — event-driven)

**Independent Test**: rodar agentes em dois projetos distintos e confirmar duas salas (com os
subagentes na sala certa); renomear uma e reiniciar (o nome persiste); criar uma tarefa headless em
worktree e vê-la na sala do projeto de origem com o rótulo da tarefa.

---

## Edge Cases

- IF o transcript não existe (agente recém-criado) THEN o terminal SHALL exibir estado vazio sem erro e assumir o `seekEnd` ao surgir. (`SC-01`)
- IF uma sessão do Cursor é encerrada com uma mensagem ainda na fila THEN o escritório SHALL marcar a mensagem como não entregue. (`SC-31`)
- WHEN o escritório reinicia THEN as tarefas headless previamente lançadas SHALL ser reconciliadas (marcadas como paradas se o processo não existe mais). (`SC-25`)
- IF o worktree a remover tiver alterações não commitadas THEN o escritório SHALL não apagar o conteúdo, preservando o diretório e sinalizando o conflito. (`SC-23`)
- WHEN dois terminais observam o mesmo agente e um deles reconecta THEN o `init` SHALL reconstruir o histórico sem duplicar entradas já vistas. (`SC-05`)
- IF o workspace for multi-raiz THEN o escritório SHALL usar apenas a primeira raiz como a sala. (`SC-35`)
- WHEN um worktree de tarefa é removido THEN o rótulo da tarefa SHALL desaparecer sem encerrar a sala do projeto de origem. (`SC-40`)

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| -------------- | ----- | ----- | ------ |
| SC-01 | P1: Responsividade | - | Pending |
| SC-02 | P1: Responsividade | - | Pending |
| SC-03 | P1: Responsividade | - | Pending |
| SC-04 | P1: Responsividade | - | Pending |
| SC-05 | P1: Responsividade | - | Pending |
| SC-06 | P2: Diffs ao vivo | - | Pending |
| SC-07 | P2: Diffs ao vivo | - | Pending |
| SC-08 | P2: Diffs ao vivo | - | Pending |
| SC-09 | P2: Diffs ao vivo | - | Pending |
| SC-10 | P3: Fila "Precisa de você" | - | Pending |
| SC-11 | P3: Fila "Precisa de você" | - | Pending |
| SC-12 | P3: Fila "Precisa de você" | - | Pending |
| SC-13 | P3: Fila "Precisa de você" | - | Pending |
| SC-14 | P3: Fila "Precisa de você" | - | Pending |
| SC-15 | P3: Fila "Precisa de você" | - | Pending |
| SC-16 | P3: Fila "Precisa de você" | - | Pending |
| SC-17 | P4: Mosaico | - | Pending |
| SC-18 | P4: Mosaico | - | Pending |
| SC-19 | P4: Mosaico | - | Pending |
| SC-20 | P4: Mosaico | - | Pending |
| SC-21 | P5: Orquestrador headless | - | Pending |
| SC-22 | P5: Orquestrador headless | - | Pending |
| SC-23 | P5: Orquestrador headless | - | Pending |
| SC-24 | P5: Orquestrador headless | - | Pending |
| SC-25 | P5: Orquestrador headless | - | Pending |
| SC-26 | P5: Orquestrador headless | - | Pending |
| SC-27 | P6: Mensagem na IDE | - | Pending |
| SC-28 | P6: Mensagem na IDE | - | Pending |
| SC-29 | P6: Mensagem na IDE | - | Pending |
| SC-30 | P6: Mensagem na IDE | - | Pending |
| SC-31 | P6: Mensagem na IDE | - | Pending |
| SC-32 | P7: Skills | - | Pending |
| SC-33 | P7: Skills | - | Pending |
| SC-34 | P7: Skills | - | Pending |
| SC-35 | P8: Sala por local de execução | - | Pending |
| SC-36 | P8: Sala por local de execução | - | Pending |
| SC-37 | P8: Sala por local de execução | - | Pending |
| SC-38 | P8: Sala por local de execução | - | Pending |
| SC-39 | P8: Sala por local de execução | - | Pending |
| SC-40 | P8: Sala por local de execução | - | Pending |

**ID format:** `[CATEGORY]-[NUMBER]` (ex.: `AUTH-01`, `CART-03`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified
**Coverage:** 40 total; o mapeamento para tasks será definido na fase Tasks.

## Success Criteria

- [ ] Duas linhas gravadas no transcript aparecem em dois terminais do mesmo agente dentro do alvo de latência, com uma única leitura do arquivo no servidor.
- [ ] Uma edição do agente mostra, na conversa, o arquivo e o diff `+`/`-`, com segredos mascarados e truncamento visível.
- [ ] Um pedido de permissão e uma `AskQuestion` aparecem na fila "Precisa de você"; aprovar/negar remove o item.
- [ ] Três agentes ao vivo aparecem no mosaico; entrar em `waiting` gera badge/notificação.
- [ ] Uma tarefa isolada cria worktree+branch, aparece observável, e é parada/retomada/limpa.
- [ ] Uma mensagem para conversa viva aparece "na fila" e é entregue ao fim do turno (ou fica retida com a degradação graciosa quando o canal está desligado).
- [ ] Uma skill válida é listada e executada; uma skill quebrada não derruba o painel.
- [ ] Dois projetos abertos geram duas salas (cada uma com os seus subagentes); renomear uma sala persiste entre reinícios; uma tarefa headless aparece na sala do projeto de origem com o rótulo da tarefa.
- [ ] `npm run typecheck && npm test && npm run build` verdes no submódulo.
