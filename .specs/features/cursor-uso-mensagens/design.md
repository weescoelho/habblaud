# Uso do plano e mensagens do Cursor — Fase 5 (Design)

## Overview

Duas decisões de UI no cliente, ambas **aditivas e guardadas por `provider`** (mesmo princípio do
`AD-001`): o Cursor não tem fonte de uso (P8 🔴) nem injeção confiável de mensagens na v1 (P6/C7),
logo o produto **oculta** o cartão de uso e a caixa de mensagens para ele — sem tocar no servidor
(as sessões do Cursor já não têm `usage` nem entregador de mensagens, `canMessage` ausente).

```
client/src/ui/usage.ts            client/src/ui/composer-model.ts
  UsageCards.render()                composerMode(agent, env)
      │  accounts = usageCardAccounts(snapshot.accounts)      │
      ▼                              ▼ (guarda por provider)    ▼
  só não-cursor → cartões          replaying → sub → offline → cursor → claude/codex…
  (a conta cursor continua             ^ CURSOR_OFF_TEXT = 'Para responder, use o Cursor'
   no snapshot/statusline)                 (gaveta esconde · terminal mostra o motivo)
```

## Decisions

| # | Decision | Rationale | Trade-off / status |
| - | -------- | --------- | ------------------ |
| D1 | Filtrar por `provider` **no cliente**, não no snapshot | `06` §6.5 aceita exibir um único "Cursor" como conta; o "sem cartão" é uma decisão visual e vira função pura testável | A conta segue visível em statusline/ajuda; muda o cliente só |
| D2 | `composerMode` → `off` para `provider === 'cursor'` com texto próprio | Mesma linguagem dos off existentes; v1 = não oferecer (P6) | O toca-telas espera "responder no próprio Cursor" |
| D3 | Guarda do Cursor **depois** de replay/sub/offline | Preserva estados mais específicos (timelapse, subagente, sessão encerrada) | O bloqueio só cobre sessão principal ao vivo |
| D4 | Função pura `usageCardAccounts(accounts)` exportada e testada | Padrão do repo (lógica pura separada do DOM, ex. `composer-model`) | Teste 1:1 aos ACs sem DOM |

## Components & Responsibilities

### `client/src/ui/usage.ts`
- Exporta `usageCardAccounts(accounts: readonly AccountInfo[]): AccountInfo[]` — filtra
  `provider !== 'cursor'`. `UsageCards.render()` passa a usá-lo (a lista sync/chips/`is-empty`/`--count`
  já derivam do resultado).
- Sem mudança de `createCard`/`updateCard` (o `provider` do Cursor nunca chega a `updateCard`).

### `client/src/ui/composer-model.ts`
- Exporta `CURSOR_OFF_TEXT = 'Para responder, use o Cursor'`.
- Em `composerMode(agent, env)`: após os ramos de `replaying`/`sub`/`offline|done`, um ramo
  `if (agent?.provider === 'cursor') return { kind: 'off', text: CURSOR_OFF_TEXT }`.
- Efeito herdado: a gaveta esconde a caixa no `off`; o terminal mostra o motivo no lugar dela.

## Files

| File | Action |
| ---- | ------ |
| `client/src/ui/usage.ts` | edit — `usageCardAccounts` + uso em `render()` |
| `client/src/ui/usage-source.test.ts` | edit — casos `F5-01/F5-02` |
| `client/src/ui/composer-model.ts` | edit — `CURSOR_OFF_TEXT` + ramo no `composerMode` |
| `client/src/ui/composer-model.test.ts` | edit — casos `F5-03/F5-04/F5-05` |
| `.specs/STATE.md` (submódulo) | edit — Handoff Fase 5 |
| `docs/analise/06-arquitetura-proposta.md` (raiz) | edit — nota Fase 5 em §6.8 |

## Non-goals confirmed

- Sem mudança de servidor: `/api/messages`, `accounts`, `UsageCards` do servidor ficam como estão.
- Sem cartão novo nem fonte nova de uso (P8).
- Sem oferecer mensagens (P6 pendente ao vivo) na Web UI.