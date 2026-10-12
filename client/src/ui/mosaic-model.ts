// Modelo do mosaico de sessões: um card compacto por agente ao vivo (provedor, status, atividade atual e
// último diff), com quem precisa de você no topo. Puro (sem DOM), testado em ui/mosaic-model.test.ts.
import type { Activity, AgentInfo, AgentStatus, EditDiff, OfficeSnapshot, Provider } from '../../../shared/types';
import { groupRooms, isPresent } from './model';
import { providerOf } from './provider';

export interface MosaicCard {
  agentId: string;
  roomId: string;
  provider: Provider;
  status: AgentStatus;
  /** Atividade atual do agente (a mais recente), quando houver. */
  activity?: Activity;
  /** Último resumo de diff visto (o card mostra o que ele andou programando). */
  diff?: EditDiff;
}

/** Último diff conhecido do agente: a atividade atual tem prioridade; senão, a mais recente que trouxe diff. */
function lastDiff(a: AgentInfo): EditDiff | undefined {
  if (a.activity?.diff) return a.activity.diff;
  for (let i = a.recent.length - 1; i >= 0; i--) if (a.recent[i]!.diff) return a.recent[i]!.diff;
  return undefined;
}

function cardOf(a: AgentInfo): MosaicCard {
  const activity = a.activity;
  const diff = lastDiff(a);
  return {
    agentId: a.id,
    roomId: a.roomId,
    provider: providerOf(a),
    status: a.status,
    ...(activity ? { activity } : {}),
    ...(diff ? { diff } : {}),
  };
}

/**
 * Quem precisa de você vem primeiro (do que espera há mais tempo para o mais recente); o resto mantém a ordem
 * por sala/chegada (a ordenação é estável, então o comparador devolve 0 entre os demais).
 */
function mosaicOrder(a: AgentInfo, b: AgentInfo): number {
  const wa = a.status === 'waiting' ? 0 : 1;
  const wb = b.status === 'waiting' ? 0 : 1;
  if (wa !== wb) return wa - wb;
  if (wa === 0) return a.statusSince - b.statusSince || a.id.localeCompare(b.id);
  return 0;
}

/**
 * Cards do mosaico: um por agente ao vivo (presente), na ordem das salas, com quem espera o usuário no topo —
 * assim um grid cheio nunca esconde um agente em `waiting` (SC-17, SC-20).
 */
export function mosaicCards(snap: Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts'> | null): MosaicCard[] {
  if (!snap) return [];
  const agents = groupRooms(snap)
    .flatMap((g) => g.nodes.flatMap((n) => [n.agent, ...n.subs]))
    .filter(isPresent);
  return agents.slice().sort(mosaicOrder).map(cardOf);
}
