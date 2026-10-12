// Rotas de skills (server/skills/http.ts) sobre HTTP de verdade: GET lista o catálogo do projeto (por agente ou cwd) e
// POST run submete o prompt à sessão-alvo. Skill/agente desconhecidos e skill indisponível dão 404/409; corpo torto,
// 400; método errado, 405. O catálogo e a entrega são falsos (o que a rota faz é o alvo aqui).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillInfo } from '../../shared/types';
import { request } from '../test/permission-server';
import { createSkillRoutes, type SkillRoutesDeps } from './http';

const ALFA: SkillInfo[] = [
  { name: 'revisar-pr', description: 'Revisa um PR', source: 'project', path: '/p/alfa/.cursor/skills/revisar-pr', available: true },
  { name: 'deploy', source: 'user', path: '/p/home/.cursor/skills/deploy', available: false },
];
const BETA: SkillInfo[] = [{ name: 'testar', description: 'Roda a suíte', source: 'project', path: '/p/beta/.agents/skills/testar', available: true }];

interface Harness {
  base: string;
  submits: Array<[string, string]>;
  close(): Promise<void>;
}

async function serveSkills(over: Partial<SkillRoutesDeps> = {}): Promise<Harness> {
  const submits: Array<[string, string]> = [];
  const deps: SkillRoutesDeps = {
    list: (cwd) => (cwd === '/p/beta' ? BETA : ALFA),
    projectOf: (id) => (id === 'nao-existe' ? undefined : id === 'cursor:beta' ? '/p/beta' : '/p/alfa'),
    cwd: () => '/p/alfa',
    submit: (agentId, prompt) => {
      submits.push([agentId, prompt]);
      return agentId === 'cursor:full' ? { ok: false, status: 429, error: 'já há 5 mensagens esperando' } : { ok: true };
    },
    ...over,
  };
  const routes = createSkillRoutes(deps);
  const server = http.createServer((req, res) => {
    routes(req, res, new URL(req.url ?? '/', 'http://x').pathname);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    submits,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

let srv: Harness | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const postRun = (s: Harness, body: unknown, headers?: Record<string, string>) => request(s.base, '/api/skills/run', { method: 'POST', body, headers });

describe('rotas de skills', () => {
  it('GET lista o catálogo do projeto: por agente (?agentId), por cwd (?cwd) ou o padrão (SC-32)', async () => {
    srv = await serveSkills();
    expect((await request(srv.base, '/api/skills')).json).toEqual({ skills: ALFA });
    expect((await request(srv.base, '/api/skills?agentId=cursor:beta')).json).toEqual({ skills: BETA });
    expect((await request(srv.base, '/api/skills?cwd=/p/beta')).json).toEqual({ skills: BETA });
    // Agente desconhecido cai no projeto padrão (não quebra o painel).
    expect((await request(srv.base, '/api/skills?agentId=nao-existe')).json).toEqual({ skills: ALFA });
  });

  it('POST run submete o prompt da skill à sessão-alvo (SC-33)', async () => {
    srv = await serveSkills();
    const r = await postRun(srv, { agentId: 'cursor:1', skill: 'revisar-pr' });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(srv.submits).toEqual([['cursor:1', '/revisar-pr']]);
  });

  it('skill ou agente desconhecido: 404; skill indisponível: 409; sem canal: o status da entrega', async () => {
    srv = await serveSkills();
    expect((await postRun(srv, { agentId: 'cursor:1', skill: 'nao-existe' })).status).toBe(404);
    expect((await postRun(srv, { agentId: 'nao-existe', skill: 'revisar-pr' })).status).toBe(404);
    const off = await postRun(srv, { agentId: 'cursor:1', skill: 'deploy' });
    expect(off.status).toBe(409);
    expect(off.json).toMatchObject({ error: expect.stringMatching(/indisponível/) });
    const full = await postRun(srv, { agentId: 'cursor:full', skill: 'revisar-pr' });
    expect(full.status).toBe(429);
    expect(full.json).toMatchObject({ error: 'já há 5 mensagens esperando' });
    expect(srv.submits).toEqual([['cursor:full', '/revisar-pr']]);
  });

  it('corpo inválido → 400; método errado → 405; rota desconhecida → 404', async () => {
    srv = await serveSkills();
    for (const body of [{}, { agentId: 'cursor:1' }, { skill: 'revisar-pr' }, { agentId: 'cursor:1', skill: '   ' }, { agentId: 'cursor:1', skill: 'x'.repeat(500) }]) {
      const r = await postRun(srv, body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await postRun(srv, { agentId: 'cursor:1', skill: 'revisar-pr' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await request(srv.base, '/api/skills/run')).status).toBe(405);
    expect((await request(srv.base, '/api/skills', { method: 'POST', body: {} })).status).toBe(405);
    expect((await request(srv.base, '/api/skills/x')).status).toBe(404);
  });
});
