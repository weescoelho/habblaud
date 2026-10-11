# Sala de Controle Context

**Gathered:** 2026-10-11
**Spec:** `.specs/features/sala-de-controle/spec.md`
**Status:** Ready for design

---

## Feature Boundary

Transformar o escritório na **sala de controle** de múltiplos agentes: **ver em tempo real** (responsividade do
terminal/atividades + diffs ao vivo), **triar** ("Precisa de você") e **dirigir** (orquestrador headless,
mensagem na conversa do Cursor e skills), com **uma sala por local de execução** (projeto). Escopo em 8 histórias
(P1–P8), todas incluídas por decisão do usuário. Não substitui o Cursor nem faz injeção em meio ao turno; o motor
é reutilizável por Claude/Codex, mas a primeira fonte rica é o Cursor.

---

## Implementation Decisions

### Canais de "atribuir tarefa" (rodada 1)

- **Dois canais explícitos**: (a) **"Nova tarefa"** — o escritório lança e acompanha um `agent -p` gerenciado,
  isolado por worktree (não aparece como chat da IDE); (b) **"Enviar ao Cursor"** — entrega na conversa viva
  via `stop.followup_message` (espelhada na IDE, mas só ao fim do turno e em conversa já aberta).
- A UI deixa claro qual canal está em uso para não criar expectativa de espelhamento no headless.

### Apresentação dos diffs (rodada 1)

- **Inline** na própria entrada da ferramenta de edição no terminal, com `+`/`-` por linha e contador.
- Sem painel lateral novo nesta fase.

### Isolamento das tarefas headless (rodada 2)

- Por padrão, cada tarefa roda em **git worktree + branch** própria (o escritório cria e limpa), com a
  **opção** de usar o workspace atual.
- A limpeza não destrói alterações não commitadas (preserva e sinaliza — edge case da spec).

### Triagem "Precisa de você" (rodada 2)

- **View dedicada** (atalho + badge no feed) listando cada agente em `waiting` com o motivo
  (permissão / `AskQuestion` / falha).
- Ações in-place: aprovar/negar permissão (já suportado pela Fase 2), "abrir no Cursor" (deep-link
  *best-effort*, com foco no escritório como fallback) e responder `AskQuestion` **quando** o canal de
  mensagem (P6) estiver ativo.

### Fila de mensagem na IDE (rodada 3)

- **Fila com estado visível** ("na fila" → "entregue"), **uma** mensagem por conversa.
- **Trava de segurança**: após **5** entregas automáticas consecutivas sem resposta do usuário, o
  escritório para de entregar sozinho e exige ação explícita (o Cursor limita auto-followups).

### Conteúdo do mosaico (rodada 3)

- Card compacto por agente: **provedor, status, atividade atual e último diff (`+`/`-`)**, agrupado por
  sala. Clique abre o terminal do agente.

### Sala por local de execução (rodada 4)

- **Cada projeto = uma sala** (já é o comportamento do modelo de salas): o agente entra na sala do workspace
  (`workspace_roots[0]` ou `cwd`), e os **subagentes herdam a sala do agente principal**.
- **Tarefa headless em worktree** → aparece na **sala do repositório de origem**, com o **nome da tarefa/branch
  como rótulo** no agente (não abre uma sala por worktree; mantém o projeto agrupado).
- **Sem workspace** → sala padrão (`cursor`). **Workspace multi-raiz** → usa só a primeira raiz (limitação).

### Fidelidade do GitHub (rodada 5)

- **Mantido como está** (decisão: só documentar): no Cursor IDE vigora só o fallback **só-comando** — PR
  aberto/merge e push por comando (**pode falso-positivar**); **CI e release não são detectados** (o transcript
  do Cursor não grava `tool_result`, então não há desfecho para confirmar).
- Claude/Codex seguem confiáveis (usam `gitOperation`/saída/notificação). **Nenhuma fonte real de CI** nesta v1.

### Fio do hook de subagente (rodada 6)

- **Defeito encontrado em uso real** (relato): ao abrir subagentes do Cursor, eles **não aninhavam** ao agente
  principal — apareciam como agentes novos no topo. Causa: `subagentStart`/`subagentStop` **não** estavam em
  `EVENTS` (`scripts/cursor-install.ts`, que escreve `hooks.json`) nem em `OBSERVED`
  (`mod/habblaud-cursor/hook.mjs`), então a IDE nunca chamava o hook nesses eventos e o tratamento no servidor
  (`source.ts` `subagentEvent`/`addSub`) era código morto em produção.
- **Corrigido como bugfix do `CSH-06`** (`cursor-subagents-history`): os dois eventos entraram nas duas listas
  (17 eventos no total, igual ao harness), com testes de paridade (`OBSERVED`×`EVENTS`) e ponta a ponta pelo
  processo. Ver `.specs/features/cursor-subagents-history/validation.md` → "Correção do CSH-06".
- **Impacto na Sala de Controle**: era pré-requisito de **`SC-37`** (subagente na mesma sala do principal) e das
  views de mosaico/triagem (P3/P4), que leem parentesco. Sem o fix, o aninhamento não existiria para a feature.
- **Ação do usuário**: reinstalar o hook (`npm run cursor:setup`) para o `hooks.json` da máquina ganhar os 17
  eventos.

### Agent's Discretion

- **Mecânica de baixa latência**: como combinar `fs.watch` + *fallback* de polling, o *debounce*, o TTL do
  observador e o *fan-out* do leitor compartilhado (desde que cumpra `SC-01`–`SC-05`).
- **Formato do diff capturado** (`afterFileEdit` × `StrReplace`/`Write`), incluindo deduplicação e limites
  de truncamento.
- **Schema/rotas** novas do escritório (tarefas, skills, fila) e onde plugá-las em `server/http/app.ts`.
- **Controles por tarefa** (nome da branch, mensagem, modelo/modo) e detalhes de layout das views novas.

### Declined / Undiscussed Gray Areas → Assumptions

- Perguntas respondíveis pela fila ficam **condicionadas** ao canal de P6 (registrado como `SC-14`).
- Deep-link para o chat do Cursor tratado como *best-effort* (registrado em `SC-16`).
- Alvo de latência (≤300 ms / ≤500 ms) definido como meta medida a partir da gravação no disco; o *flush*
  do Cursor é limitação registrada (assumption da spec).

---

## Specific References

- Cadeia de latência atual: `server/http/terminal.ts` (`POLL_MS = 400`, `READS_PER_POLL = 4`, um `FileTail`
  por conexão, `MAX_STREAMS = 8`, `INIT_TAIL_BYTES = 4 MB`, `INIT_ENTRIES = 500`) e
  `server/sources/cursor/source.ts` (`pollMs = 1000`).
- Padrão já existente a reusar: `server/sources/watcher.ts` (`fs.watch` como "acelerador" com *fallback* a
  polling) e `server/sources/codex/source.ts` (`watchFile`).
- Diff real no hook: `afterFileEdit` → `{file_path, edits:[{old_string,new_string}]}` (hoje só `file_path` é
  lido em `mod/habblaud-cursor/hook.mjs`).
- Peças já prontas: `Activity.kind === 'ask'` + `AskQuestion`/`questions` (`shared/types.ts`,
  `server/sources/cursor/rollout.ts`), permissões por hook (Fase 2), `AgentStatus = 'waiting'`/`waitingFor`.
- Canal headless: `cursor-agent -p --trust --force --output-format stream-json --stream-partial-output`
  (`--resume`, `--mode plan|ask`, `--model`); parser de stream-json já existe no POC (`scripts/cursor-poc.ts`).
- Canal de mensagem: `stop`/`subagentStop` com `followup_message` (probe
  `mod/habblaud-cursor/followup-hook.mjs`).
- Skills: `SKILL.md` em `.cursor/skills`, `.agents/skills`, `~/.cursor/skills` (+ compatibilidade).
- GitHub por transcript (sem rede/token): operações + desfecho em `server/sources/github.ts` (`gitOperation` >
  saída do comando > notificação de término > MCP) e **fallback só-comando** em `server/sources/cursor/github.ts`;
  avisos/efeitos (festa/alarme) em `shared/github.ts` (`RoomEffects`).
- Sala por projeto (já existe): `workspace_roots[0]`/`cwd` → `roomId = normalizeCwd(cwd)` → `ensureRoom`
  (`server/sources/cursor/rollout.ts:105`, `server/sources/cursor/source.ts:253`, `server/model/office.ts:317`);
  nome = basename desambiguado (`server/model/rooms.ts`); renomear persiste (`rooms.json`); o subagente herda a
  sala do pai (`office.ts:587`). Captura real: `"workspace_roots":["/home/dummy-user/habblaud"]` em
  `docs/cursor-export/*.jsonl`.

---

## Deferred Ideas

- **Ordem de prioridade** é ajustável (default P1→P7); P5–P7 podem virar specs próprias se a P1–P4 já
  resolverem a dor.
- **Aceitar/rejeitar diffs** pelo escritório (aplicar/reverter) — fica para outra feature.
- **Agentes de nuvem** (`&`) e delegação remota — superfície separada.
- **`agent acp` / escritório como servidor MCP** (agentes reportando progresso) — investigação futura.
- **Medir o *flush* real do transcript do Cursor** para separar o que é nosso do que é da plataforma.
