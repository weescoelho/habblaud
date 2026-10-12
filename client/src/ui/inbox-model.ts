// Fila "Precisa de você": consolida permissão, AskQuestion e falha dos agentes em espera numa lista única,
// ordenada por tempo de espera. Puro (sem DOM), testado em ui/inbox-model.test.ts.
// A view dedicada (gaveta) usa esta fila; a decisão de permissão e a resposta reusam o cartão existente.
import { ASK_TOOL } from '../../../shared/answers';
import type { AgentInfo, AskQuestion, OfficeSnapshot, PermissionRequestInfo } from '../../../shared/types';

export type WaitingKind = 'permission' | 'ask' | 'error';

export interface WaitingItem {
  agentId: string;
  roomId: string;
  /** Motivo: permissão, pergunta ao usuário (AskUserQuestion) ou falha/outra espera. */
  kind: WaitingKind;
  /** Motivo em PT-BR (AgentInfo.waitingFor). */
  reason: string;
  /** Desde quando espera (AgentInfo.statusSince). */
  since: number;
  /** Perguntas do AskUserQuestion (kind 'ask'), para a fila mostrar as opções. */
  questions?: AskQuestion[];
  /** Pedido respondível pelo escritório (kind 'permission'/'ask'), para decidir pela fila. */
  permissionId?: string;
}

/** Motivo padrão quando o servidor ainda não disse por que o agente espera. */
export const WAITING_FALLBACK = 'responder no terminal';

/** O pedido é uma pergunta ao usuário (AskUserQuestion)? O Codex nunca pergunta pelo escritório. */
function isAsk(p: PermissionRequestInfo): boolean {
  return p.provider !== 'codex' && p.tool === ASK_TOOL && !!p.questions?.length;
}

/** Item da fila para um agente em espera. */
function itemOf(a: AgentInfo): WaitingItem {
  const base = { agentId: a.id, roomId: a.roomId, reason: a.waitingFor ?? WAITING_FALLBACK, since: a.statusSince };
  const p = a.permission;
  if (p && isAsk(p)) return { ...base, kind: 'ask', questions: p.questions, permissionId: p.id };
  if (p) return { ...base, kind: 'permission', permissionId: p.id, ...(p.questions?.length ? { questions: p.questions } : {}) };
  const act = a.activity;
  if (act?.kind === 'ask') return { ...base, kind: 'ask', ...(act.questions?.length ? { questions: act.questions } : {}) };
  return { ...base, kind: 'error' };
}

/**
 * Agentes que precisam de você (permissão/ask/falha), do que espera há mais tempo para o mais recente.
 * A mesma ordem de `waitingAgents`: `waitingItems` só inclui quem está em `waiting` e carrega o motivo.
 */
export function waitingItems(snap: Pick<OfficeSnapshot, 'agents'> | null): WaitingItem[] {
  if (!snap) return [];
  return snap.agents
    .filter((a) => a.status === 'waiting')
    .sort((a, b) => a.statusSince - b.statusSince || a.id.localeCompare(b.id))
    .map(itemOf);
}
