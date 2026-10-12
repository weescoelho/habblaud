import { describe, expect, it } from 'vitest';
import type { Activity, AgentInfo, OfficeSnapshot, RoomInfo } from '../../../shared/types';
import { mosaicCards } from './mosaic-model';

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

function room(id: string, slot = 0): RoomInfo {
  return { id, name: id, path: `/p/${id}`, slot, seed: 1, createdAt: 0 };
}

const snapshot = (agents: AgentInfo[], rooms: RoomInfo[] = [room('api')]): OfficeSnapshot => ({
  rev: 0,
  serverTime: 0,
  rooms,
  agents,
  accounts: [],
  meta: { demo: false, sources: [], startedAt: 0, version: '0' },
});

const edit = (id: string, file: string, at: number, diff = { file, added: 2, removed: 1 }): Activity => ({
  id,
  kind: 'edit',
  icon: '✎',
  text: `Editando ${file}`,
  at,
  diff,
});

describe('mosaicCards', () => {
  it('um card por agente ao vivo com provedor, status, atividade e último diff (SC-17)', () => {
    const a = agent({ id: 'ana', roomId: 'api', provider: 'cursor', status: 'working', activity: edit('act-1', 'App.tsx', 1) });
    const cards = mosaicCards(snapshot([a]));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ agentId: 'ana', roomId: 'api', provider: 'cursor', status: 'working' });
    expect(cards[0].activity?.id).toBe('act-1');
    expect(cards[0].diff).toEqual({ file: 'App.tsx', added: 2, removed: 1 });
  });

  it('provedor ausente conta como Claude Code (SC-17)', () => {
    expect(mosaicCards(snapshot([agent({ id: 'ana', roomId: 'api' })]))[0].provider).toBe('claude');
  });

  it('usa o diff mais recente do histórico quando a atividade atual não traz diff (SC-17)', () => {
    const antiga = edit('act-1', 'velho.ts', 1);
    const nova: Activity = { id: 'act-2', kind: 'run', icon: '▶', text: 'Rodando testes', at: 2 };
    const a = agent({ id: 'ana', roomId: 'api', activity: nova, recent: [antiga, nova] });
    expect(mosaicCards(snapshot([a]))[0].diff).toEqual({ file: 'velho.ts', added: 2, removed: 1 });
  });

  it('não lista quem já saiu do escritório (SC-17)', () => {
    expect(mosaicCards(snapshot([agent({ id: 'ana', roomId: 'api', status: 'offline' })]))).toEqual([]);
  });

  it('inclui os subagentes como cards (SC-17)', () => {
    const main = agent({ id: 'ana', roomId: 'api' });
    const sub = agent({ id: 'ana:sub', roomId: 'api', kind: 'sub', parentId: 'ana' });
    expect(mosaicCards(snapshot([main, sub])).map((c) => c.agentId)).toEqual(['ana', 'ana:sub']);
  });

  it('sem snapshot devolve lista vazia', () => {
    expect(mosaicCards(null)).toEqual([]);
  });

  it('mantém quem espera no topo mesmo com o grid cheio (SC-20)', () => {
    const agents = [
      ...Array.from({ length: 8 }, (_, i) => agent({ id: `trab-${i}`, roomId: 'api', startedAt: i })),
      agent({ id: 'espera', roomId: 'api', status: 'waiting', statusSince: 5, startedAt: 100 }),
    ];
    const cards = mosaicCards(snapshot(agents));
    expect(cards[0].agentId).toBe('espera');
    expect(cards).toHaveLength(9);
  });

  it('ordena quem espera do mais antigo para o mais recente (SC-20)', () => {
    const agents = [
      agent({ id: 'a', roomId: 'api', status: 'waiting', statusSince: 90 }),
      agent({ id: 'b', roomId: 'api', status: 'working', startedAt: 1 }),
      agent({ id: 'c', roomId: 'api', status: 'waiting', statusSince: 10 }),
    ];
    expect(mosaicCards(snapshot(agents)).map((x) => x.agentId)).toEqual(['c', 'a', 'b']);
  });
});
