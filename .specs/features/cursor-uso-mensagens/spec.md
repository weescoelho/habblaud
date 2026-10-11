# Uso do plano e mensagens do Cursor — Fase 5 (Specification)

## Problem Statement

As Fases 1–4 do Cursor já observam a IDE: presença/atividades por hook, permissões, transcript
(terminal/tokens/atividades ricas), subagentes, GitHub e histórico. Faltam as duas capacidades
que a análise diz ser **impossíveis/indesejadas na v1** (Fase 5 de `06` §6.8, dependente de P8/P6):

- **Uso do plano** (P8): o harness `usage` não achou fonte de primeira parte (só config/telemetria e
  `plans/`) → **🔴 confirmado**: não há números de 5h/semana para o Cursor. Hoje a conta `cursor`
  entra em `OfficeSnapshot.accounts` (via `CursorSource.accountEntries()`), então o `UsageCards`
  (client) desenharia um cartão "sem dados de uso" para ela. A estratégia definida (`06` §6.5,
  `05` linha 31/102) é **ocultar o cartão** para sessões/contas do Cursor.
- **Mensagens** (P6): não há injeção confiável de mensagem numa sessão viva (`$.prompt.submit` não
  existe no Cursor; `followup_message` só chega em `stop`/`subagentStop` — forma validada, efeito ao
  vivo **pendente**, lacuna C7). A estratégia (`06` §6.6, `05` linha 26/101) é **não oferecer**
  "Mandar mensagens" na v1: o `MessageComposer` fica oculto quando `provider === 'cursor'`.

Esta feature implementa os dois comportamentos de UI no cliente (o servidor já não dá números de uso —
`cursor/accounts` sem `usage` — e as sessões do Cursor não têm entregador de mensagens, `canMessage`
ausente), além de registrar o desfecho no roteiro e no `STATE.md`.

## Goals

- [ ] Ocultar o cartão de uso (`UsageCards`) para contas do provedor `cursor`, mantendo claude/codex.
- [ ] Não oferecer a caixa de mensagens para agentes do Cursor (`composerMode` → `off`, texto próprio),
      sem regredir claude/codex (a caixa continua a aparecer para eles como hoje).
- [ ] Registrar no roteiro (`06` §6.8) e no `.specs/STATE.md` o desfecho e as limitações (P6 ao vivo
      pendente; P8 cartão oculto).

## Out of Scope

| Feature | Reason |
| ------- | ------ |
| Fonte de uso do Cursor (5h/semana) | P8 confirmou que não existe API/dashboard documentada; cartão oculto é o desfecho |
| Injeção de mensagem via `stop.followup_message` no servidor | Efeito real ao vivo pendente (C7); v1 = não oferecer na UI; o probe `mod/habblaud-cursor/followup-hook.mjs` segue como forma validada |
| Ocultar/reordenar a conta `cursor` do snapshot | `06` §6.5: exibir um único "Cursor" como conta é aceitável; só o cartão de uso sai |
| Mudanças no servidor (`/api/messages`, `accounts`) | Composer oculto e `canMessage` ausente já impedem o envio; nada a mudar de lá nesta fase |
| Publicar/push no fork ou abrir PR | Ação remota: exige go-ahead explícito (blast radius) |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Onde filtrar o cartão de uso | No cliente (`UsageCards.render()`), por `provider === 'cursor'` | O snapshot mantém a conta (aceito por `06` §6.5); a decisão visual é do cliente e é testável como função pura | y |
| Modo da caixa para o Cursor | `off`, texto "Para responder, use o Cursor" | Mesma linguagem dos off existentes ("use o Codex"/"use o terminal do Claude Code"); a gaveta esconde a caixa, o terminal mostra o motivo | y |
| Ordem das regras no `composerMode` | replaying → sub → offline/done → cursor → (codex/env/local/canMessage → ready) | Preserva mensagens mais específicas (timelapse/sub/sessão encerrada); o bloqueio do Cursor só cai sobre sessão principal ao vivo | y |
| Não-regressão | claude/codex seguem o fluxo atual (testes existentes passam sem edição) | A guarda é por `provider`; `cursor` não entra em nenhum ramo de claude/codex | y |
| Docs | Nota em `06` §6.8 + `.specs/STATE.md` (mesmo padrão das Fases 3/4) | Roteiro no repositório raiz; STATE no submódulo | y |
| Idioma | PT-BR (comentários e textos) | Convenção do repositório | y |
| Gate do repositório | `npm run typecheck && npm test && npm run build` (quick: `npx vitest run <arquivo>`) | `package.json` / rodadas anteriores | y |

**Open questions:** none — all resolved or logged above.

## User Stories

### P1: Cartão de uso do Cursor oculto (uso do plano)

**User Story**: Como usuário do Habblaud com o Cursor, quero não ver um cartão de uso de plano para a
conta do Cursor (que não tem fonte de uso local), para não confundir "sem dados" com um problema.

**Why P1**: P8 confirmou que não existe fonte de primeira parte; o cartão "sem dados de uso" seria ruído.

**Acceptance Criteria**:

1. WHEN O `OfficeSnapshot` traz uma conta cujo `provider` é `cursor` THEN o cartão de uso SHALL não ser
   exibido para ela. (`F5-01` — event-driven)
2. WHEN a lista de contas do snapshot é filtrada para os cartões de uso THEN o resultado SHALL conter
   apenas contas com `provider` diferente de `cursor` AND WHEN nenhuma conta restar THEN a seção de uso
   SHALL ficar vazia (`is-empty`). (`F5-02` — event-driven)
3. WHEN A conta é de claude (sem `provider`) ou codex THEN o cartão SHALL continuar aparecendo como hoje.
   (`F5-05` — event-driven)

### P2: Mensagens ao Cursor não oferecidas na v1 (mensagens)

**User Story**: Como usuário do Habblaud com o Cursor, quero não receber a promessa de "mandar mensagem"
na sessão do Cursor, para não esperar uma capacidade que a v1 não entrega.

**Why P2**: P6 validou só a forma (`stop.followup_message`); o efeito real ao vivo segue pendente (C7);
`06` §6.6 decide **não oferecer** na v1.

**Acceptance Criteria**:

4. WHEN O `composerMode` é avaliado para um agente principal ao vivo com `provider === 'cursor'` THEN o
   modo SHALL ser `off` com o texto definido para o Cursor. (`F5-03` — event-driven)
5. WHEN O `composerMode` é avaliado para um sub do Cursor ou para uma sessão do Cursor encerrada/offline
   THEN o resultado SHALL ser o de hoje (mensagem de subagente / "Sessão encerrada"), sem o texto do
   Cursor mascarar esses estados. (`F5-04` — event-driven)
6. WHEN O `composerMode` é avaliado para agentes de claude/codex THEN o comportamento SHALL permanecer
   inalterado AND a suíte existente SHALL continuar verde sem edição. (`F5-05` — unwanted-behavior)

### P3: Registro no roteiro (docs)

**User Story**: Como mantenedor, quero o roteiro e o handoff registrando o desfecho da Fase 5, para
rastrear o que foi implementado e o que depende de validação ao vivo.

**Why P3**: as Fases 3/4 já seguem esse padrão (nota no `06` §6.8 + `STATE.md`).

**Acceptance Criteria**:

7. WHEN A Fase 5 é concluída THEN o roteiro `06` §6.8 e o `.specs/STATE.md` SHALL registrar o desfecho
   e as limitações (P6 ao vivo pendente; P8 cartão oculto). (`F5-06` — event-driven)

## Edge Cases

- Conta do Cursor sem sessões abertas: continua sem cartão (o filtro é por `provider`, não por presença).
- `snapshot.accounts` sem contas do Cursor: comportamento idêntico ao de hoje (nenhuma filtragem visível).
- Sessão do Cursor encerrada: a caixa continua dizendo "Sessão encerrada" (a guarda do Cursor não precede
  o estado de sessão).
- Sub do Cursor: continua "Subagentes não recebem mensagens: escreva para o agente principal".

## Requirement Traceability

| Requirement ID | Story                 | Phase | Status       |
| -------------- | --------------------- | ----- | ------------ |
| F5-01          | P1: Cartão de uso      | Tasks | Implementing |
| F5-02          | P1: Cartão de uso      | Tasks | Implementing |
| F5-03          | P2: Mensagens          | Tasks | Implementing |
| F5-04          | P2: Mensagens          | Tasks | Implementing |
| F5-05          | P1+P2 (não-regressão)  | Tasks | Implementing |
| F5-06          | P3: Roteiro            | Tasks | Implementing |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified
**Coverage:** 6 total, 6 mapped to tasks, 0 unmapped ✅

## Success Criteria

- [ ] Uma conta `cursor` no snapshot não gera cartão de uso; claude/codex continuam iguais.
- [ ] Um agente principal do Cursor ao vivo não oferece a caixa de mensagens ("Para responder, use o Cursor").
- [ ] `npm run typecheck && npm test && npm run build` verdes no submódulo.
- [ ] Nota da Fase 5 no `06` §6.8 (raiz) e Handoff no `.specs/STATE.md`.