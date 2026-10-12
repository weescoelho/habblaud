import { describe, expect, it } from 'vitest';
import type { Activity, AgentInfo, AskQuestion, PermissionRequestInfo } from '../../../shared/types';
import { WAITING_FALLBACK, waitingItems } from './inbox-model';

function agent(p: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'roomId'>): AgentInfo {
  return {
    kind: 'main',
    name: p.id,
    look: 'f',
    role: p.kind === 'sub' ? 'Explore' : 'Agente principal',
    sessionId: `s-${p.id}`,
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...p,
  };
}

const snap = (agents: AgentInfo[]) => ({ agents });

const questions: AskQuestion[] = [
  { index: 0, question: 'Qual banco?', header: 'Stack', options: [
    { index: 0, label: 'Postgres' },
    { index: 1, label: 'SQLite' },
  ] },
];

const askActivity: Activity = { id: 'act-1', kind: 'ask', icon: '❓', text: 'Perguntou: Qual banco?', at: 5, questions };

function permission(over: Partial<PermissionRequestInfo> = {}): PermissionRequestInfo {
  return { id: 'perm-1', tool: 'Bash', title: 'Bash(npm test)', text: 'Rodando os testes', icon: '▶', createdAt: 10, expiresAt: 99_999, ...over };
}

describe('waitingItems', () => {
  it('lista a permissão com agente, motivo e desde (SC-10)', () => {
    const a = agent({ id: 'marina', roomId: 'api', status: 'waiting', statusSince: 50, waitingFor: 'aprovar uma permissão', permission: permission() });
    expect(waitingItems(snap([a]))).toEqual([
      { agentId: 'marina', roomId: 'api', kind: 'permission', reason: 'aprovar uma permissão', since: 50, permissionId: 'perm-1' },
    ]);
  });

  it('lista o AskUserQuestion do pedido com as perguntas e as opções (SC-13)', () => {
    const p = permission({ id: 'perm-ask', tool: 'AskUserQuestion', title: 'AskUserQuestion', questions });
    const a = agent({ id: 'joao', roomId: 'api', status: 'waiting', statusSince: 20, waitingFor: 'responder uma pergunta', permission: p });
    const [item] = waitingItems(snap([a]));
    expect(item.kind).toBe('ask');
    expect(item.permissionId).toBe('perm-ask');
    expect(item.questions).toEqual(questions);
  });

  it('lista o ask da atividade quando não há pedido no escritório (SC-13)', () => {
    const a = agent({ id: 'ana', roomId: 'loja', status: 'waiting', statusSince: 30, waitingFor: 'responder uma pergunta', activity: askActivity });
    const [item] = waitingItems(snap([a]));
    expect(item).toEqual({ agentId: 'ana', roomId: 'loja', kind: 'ask', reason: 'responder uma pergunta', since: 30, questions });
  });

  it('marca como falha quem espera sem permissão nem pergunta (SC-10)', () => {
    const a = agent({ id: 'bia', roomId: 'site', status: 'waiting', statusSince: 40, waitingFor: 'confiar nesta pasta' });
    const [item] = waitingItems(snap([a]));
    expect(item.kind).toBe('error');
    expect(item.reason).toBe('confiar nesta pasta');
  });

  it('usa o motivo padrão quando o servidor não disse por que espera (SC-10)', () => {
    const a = agent({ id: 'caio', roomId: 'site', status: 'waiting', statusSince: 10 });
    expect(waitingItems(snap([a]))[0].reason).toBe(WAITING_FALLBACK);
  });

  it('ordena do que espera há mais tempo para o mais recente (SC-10)', () => {
    const agents = [
      agent({ id: 'nova', roomId: 'api', status: 'waiting', statusSince: 90, waitingFor: 'aprovar uma permissão', permission: permission({ id: 'p-nova' }) }),
      agent({ id: 'antiga', roomId: 'api', status: 'waiting', statusSince: 10, waitingFor: 'aprovar uma permissão', permission: permission({ id: 'p-antiga' }) }),
      agent({ id: 'meio', roomId: 'api', status: 'waiting', statusSince: 50, waitingFor: 'aprovar uma permissão', permission: permission({ id: 'p-meio' }) }),
    ];
    expect(waitingItems(snap(agents)).map((i) => i.agentId)).toEqual(['antiga', 'meio', 'nova']);
  });

  it('fila vazia quando ninguém espera (SC-15)', () => {
    const agents = [agent({ id: 'trab', roomId: 'api', status: 'working' }), agent({ id: 'ocioso', roomId: 'api', status: 'idle' }), agent({ id: 'fim', roomId: 'api', status: 'done' })];
    expect(waitingItems(snap(agents))).toEqual([]);
  });

  it('lista só quem transita para waiting, mesmo com pedido pendente (SC-10)', () => {
    const a = agent({ id: 'saiu', roomId: 'api', status: 'done', permission: permission() });
    expect(waitingItems(snap([a]))).toEqual([]);
  });

  it('sem snapshot devolve fila vazia (SC-15)', () => {
    expect(waitingItems(null)).toEqual([]);
  });
});
