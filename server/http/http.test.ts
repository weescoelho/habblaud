import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModSummary, OfficeSnapshot, PermissionRequestInfo, UpdateStatus, CursorTaskInfo } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office, type OfficeDeps } from '../model/office';
import { MISSING_BIN, type TaskHost, type TaskInput, type TaskRemoveResult } from '../sources/cursor/tasks';
import { tempDir } from '../test/fixtures';
import { createApiHandler, type ApiDeps } from './app';
import { createRequestGuard, hostAllowed, hostnameOf, isLoopbackHost, originAllowed, parseAllowedHosts } from './guard';
import { Hub } from './sse';
import { createStaticHandler, IMMUTABLE, REVALIDATE } from './static';

setQuiet(true);

interface Env {
  base: string;
  office: Office;
  close: () => Promise<void>;
}

async function start(
  extra: Partial<ApiDeps> = {},
  officeExtra: Partial<OfficeDeps> = {},
  bind = '127.0.0.1',
): Promise<Env & { cleanup: () => void }> {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const dist = join(tmp.dir, 'dist');
  mkdirSync(join(dist, 'assets', 'brand'), { recursive: true });
  mkdirSync(join(dist, 'bundle'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Habblaud</title>');
  writeFileSync(join(dist, 'bundle', 'main-abc12345.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'brand', 'logo-mark.png'), 'png');
  writeFileSync(join(dist, 'assets', 'manifest.json'), '{}');
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
    ...officeExtra,
  });
  late.office = office;
  const hub = new Hub(office, { throttleMs: 10 });
  hub.start();
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: '9.9.9', inDocker: false, ...extra });
  const serveStatic = createStaticHandler(dist);
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) serveStatic(req, res, url.pathname);
  });
  await new Promise<void>((ok) => server.listen(0, bind, ok));
  const port = (server.address() as AddressInfo).port;
  office.addMain({ id: '.claude:1', account: '.claude', sessionId: 's1', cwd: '/p/loja', role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  return {
    base: `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`,
    office,
    close: () =>
      new Promise((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
    cleanup: tmp.cleanup,
  };
}

async function snapshotOf(base: string): Promise<OfficeSnapshot> {
  return (await (await fetch(`${base}/api/snapshot`)).json()) as OfficeSnapshot;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Primeiro IPv4 de rede (não-loopback) da máquina, para provar a trava de conexão local. Sem ele, o caso remoto é pulado. */
function nonLoopbackIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return undefined;
}

/** Requisição crua (o fetch não deixa trocar o cabeçalho Host). */
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end(opts.body);
  });
}

describe('API HTTP', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start();
  });
  afterEach(async () => {
    await env.close();
    env.cleanup();
  });

  it('GET /api/snapshot', async () => {
    const res = await fetch(`${env.base}/api/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const snap = (await res.json()) as OfficeSnapshot;
    expect(snap.rev).toBeGreaterThan(0);
    expect(snap.agents.map((a) => a.id)).toEqual(['.claude:1']);
    expect(snap.accounts[0]).toMatchObject({ id: '.claude', sessions: 1 });
    expect(snap.meta.version).toBe('9.9.9');
  });

  it('GET /api/stream envia retry, snapshot e feed; depois as mudanças', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${env.base}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (re: RegExp) => {
      while (!re.test(text)) text += dec.decode((await reader.read()).value, { stream: true });
    };
    await readUntil(/event: feed\n/);
    expect(text).toMatch(/^retry: 2000\n\nevent: snapshot\ndata: \{/);
    env.office.addActivity('.claude:1', { id: 'act-x', at: Date.now(), kind: 'read', icon: '📖', text: 'Lendo a.ts' }, true);
    await readUntil(/"id":"act-x"/);
    expect(text).toContain('event: feed\ndata: [{"id":"act-x"');
    ctrl.abort();
  });

  it('GET /api/agents/:id e /api/health', async () => {
    const ok = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ agent: { id: '.claude:1' }, history: [] });
    expect((await fetch(`${env.base}/api/agents/nao-existe`)).status).toBe(404);
    const health = await (await fetch(`${env.base}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, version: '9.9.9', demo: false, docker: false, terminal: false, accounts: [{ id: '.claude', usageStatus: 'disabled' }] });
  });

  it('GET /api/updates e POST /api/updates/check sem verificador: desligado', async () => {
    expect(await (await fetch(`${env.base}/api/updates`)).json()).toEqual({ version: '9.9.9', state: 'off', available: false });
    const check = await fetch(`${env.base}/api/updates/check`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(await check.json()).toMatchObject({ state: 'off' });
    expect((await fetch(`${env.base}/api/updates/check`)).status).toBe(405);
    expect(((await (await fetch(`${env.base}/api/health`)).json()) as { updates: unknown }).updates).toEqual({ state: 'off', available: false });
  });

  it('com verificador: GET devolve o status e o POST pede uma verificação manual', async () => {
    const status: UpdateStatus = { state: 'ok', repo: 'dono/nome', checkedAt: 1, latest: '10.0.0', url: 'https://github.com/dono/nome/releases/tag/v10.0.0', available: true };
    const calls: { manual?: boolean }[] = [];
    const other = await start({ updates: { status: () => status, check: async (o) => (calls.push(o), status) } });
    try {
      expect(await (await fetch(`${other.base}/api/updates`)).json()).toEqual({ version: '9.9.9', ...status });
      const res = await fetch(`${other.base}/api/updates/check`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      expect(await res.json()).toMatchObject({ latest: '10.0.0', available: true });
      expect(calls).toEqual([{ manual: true }]);
      expect(((await (await fetch(`${other.base}/api/health`)).json()) as { updates: unknown }).updates).toEqual({ state: 'ok', latest: '10.0.0', available: true });
    } finally {
      await other.close();
      other.cleanup();
    }
  });

  it('terminal desligado: 403 JSON e meta.terminal false', async () => {
    const res = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}/terminal`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/desligado/);
    expect((await snapshotOf(env.base)).meta.terminal).toBe(false);
  });

  it('personagem: PUT e DELETE desligados sem o terminal (403)', async () => {
    const res = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}/character`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Ana', seed: 1, parts: {} }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/desligado/);
    const del = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}/character`, { method: 'DELETE', headers: JSON_HEADERS, body: '{}' });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: string }).error).toMatch(/desligado/);
  });

  it('POST /api/demo liga e desliga', async () => {
    const on = await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) });
    expect(await on.json()).toEqual({ ok: true, demo: true });
    expect((await snapshotOf(env.base)).meta.demo).toBe(true);
    expect((await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":1}' })).status).toBe(400);
    expect((await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: '{' })).status).toBe(400);
    expect((await fetch(`${env.base}/api/demo`)).status).toBe(405);
  });

  it('DNS rebinding: Host de outro domínio é recusado em qualquer rota', async () => {
    const port = new URL(env.base).port;
    for (const path of ['/api/snapshot', '/api/stream', '/', '/bundle/main-abc12345.js']) {
      const r = await raw(env.base, path, { headers: { Host: `attacker.example:${port}` } });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('"agents"');
    }
    expect((await raw(env.base, '/api/health', { headers: { Host: `localhost:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `[::1]:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `192.168.0.10:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `habblaud.lan:${port}` } })).status).toBe(200);
  });

  it('CSRF: POST exige JSON e origem local', async () => {
    const demoOn = JSON.stringify({ enabled: true });
    // Formulário/fetch "simples" de outro site: text/plain, sem preflight.
    const plain = await fetch(`${env.base}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: demoOn });
    expect(plain.status).toBe(415);
    const form = await raw(env.base, '/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'enabled=true' });
    expect(form.status).toBe(415);
    const cross = await raw(env.base, '/api/demo', { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'http://attacker.example' }, body: demoOn });
    expect(cross.status).toBe(403);
    expect((await snapshotOf(env.base)).meta.demo).toBe(false);
    const port = new URL(env.base).port;
    const same = await raw(env.base, '/api/demo', { method: 'POST', headers: { ...JSON_HEADERS, Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, body: demoOn });
    expect(same.status).toBe(200);
  });

  it('respostas JSON com nosniff e CORP same-origin; sem CORS', async () => {
    const res = await fetch(`${env.base}/api/snapshot`, { headers: { Origin: 'http://attacker.example' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rotas desconhecidas: 404 JSON (inclusive o antigo POST /api/usage, que não existe mais)', async () => {
    const res = await fetch(`${env.base}/api/nada`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'rota desconhecida' });
    const usage = await fetch(`${env.base}/api/usage`, { method: 'POST', headers: JSON_HEADERS, body: '{"accounts":[]}' });
    expect(usage.status).toBe(404);
  });

  it('estáticos: SPA fallback, immutable só no /bundle (hash) e revalidação no resto', async () => {
    const page = await fetch(`${env.base}/sala/qualquer`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Habblaud</title>');
    expect(page.headers.get('cache-control')).toBe(REVALIDATE);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const bundle = await fetch(`${env.base}/bundle/main-abc12345.js`);
    expect(bundle.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(bundle.headers.get('content-type')).toMatch(/javascript/);
    // client/public: nome fixo, pode mudar a cada build.
    for (const path of ['/assets/brand/logo-mark.png', '/assets/manifest.json']) {
      const res = await fetch(`${env.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(REVALIDATE);
      const etag = res.headers.get('etag')!;
      expect(etag).toMatch(/^W\/"/);
      expect(res.headers.get('last-modified')).toBeTruthy();
      const again = await fetch(`${env.base}${path}`, { headers: { 'If-None-Match': etag } });
      expect(again.status).toBe(304);
      const since = await fetch(`${env.base}${path}`, { headers: { 'If-Modified-Since': res.headers.get('last-modified')! } });
      expect(since.status).toBe(304);
      const stale = await fetch(`${env.base}${path}`, { headers: { 'If-None-Match': 'W/"outro"' } });
      expect(stale.status).toBe(200);
    }
    expect((await fetch(`${env.base}/assets/nao-existe.js`)).status).toBe(404);
    expect((await fetch(`${env.base}/bundle/nao-existe.js`)).status).toBe(404);
    // Tentativa de sair da pasta cai no index.html, nunca em arquivos de fora.
    const escape = await fetch(`${env.base}/..%2F..%2Fetc%2Fpasswd`);
    expect(await escape.text()).toContain('<title>Habblaud</title>');
  });
});

describe('POST /api/cursor/events (eventos dos hooks do Cursor)', () => {
  const LAN = nonLoopbackIPv4();

  it('repassa o evento à fonte do Cursor e devolve {ok}; sem a fonte, {ok:false}', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const live = await start({ cursorLive: { applyHookEvent: (e) => (calls.push(e), true) } });
    try {
      const res = await fetch(`${live.base}/api/cursor/events`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ event: { hook_event_name: 'sessionStart', conversation_id: 'c1', workspace_roots: ['/p/loja'] } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toEqual([{ hook_event_name: 'sessionStart', conversation_id: 'c1', workspace_roots: ['/p/loja'] }]);
      expect(((await (await fetch(`${live.base}/api/health`)).json()) as { cursorEvents: boolean }).cursorEvents).toBe(true);
    } finally {
      await live.close();
      live.cleanup();
    }

    const off = await start();
    try {
      const res = await fetch(`${off.base}/api/cursor/events`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ event: { hook_event_name: 'sessionStart' } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false });
      expect(((await (await fetch(`${off.base}/api/health`)).json()) as { cursorEvents: boolean }).cursorEvents).toBe(false);
    } finally {
      await off.close();
      off.cleanup();
    }
  });

  it('a fonte que lança não derruba a rota: 200 {ok:false}', async () => {
    const env = await start({
      cursorLive: {
        applyHookEvent: () => {
          throw new Error('quebrou');
        },
      },
    });
    try {
      const res = await fetch(`${env.base}/api/cursor/events`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ event: { hook_event_name: 'preToolUse' } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      await env.close();
      env.cleanup();
    }
  });

  it('Host que não é local: 403; GET: 405; sem JSON: 415; corpo inválido: 400; acima de 256 KB: 413', async () => {
    const calls: unknown[] = [];
    const env = await start({ cursorLive: { applyHookEvent: (e) => (calls.push(e), true) } });
    try {
      const port = new URL(env.base).port;
      for (const host of [`habblaud.lan:${port}`, `192.168.0.10:${port}`]) {
        const r = await raw(env.base, '/api/cursor/events', {
          method: 'POST',
          headers: { ...JSON_HEADERS, Host: host },
          body: JSON.stringify({ event: { hook_event_name: 'sessionStart' } }),
        });
        expect(r.status, host).toBe(403);
        expect(r.body).toMatch(/próprio computador/);
      }
      expect((await fetch(`${env.base}/api/cursor/events`)).status).toBe(405);
      expect((await raw(env.base, '/api/cursor/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
      for (const body of [{}, { event: 'x' }, { event: {} }, { event: { hook_event_name: 1 } }, []]) {
        const r = await fetch(`${env.base}/api/cursor/events`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
      const big = JSON.stringify({ event: { hook_event_name: 'sessionStart', padding: 'x'.repeat(300 * 1024) } });
      expect((await raw(env.base, '/api/cursor/events', { method: 'POST', headers: JSON_HEADERS, body: big })).status).toBe(413);
      expect(calls).toHaveLength(0);
    } finally {
      await env.close();
      env.cleanup();
    }
  });

  it.skipIf(!LAN)('conexão pelo endereço de rede (não-loopback) é 403 mesmo com Host local', async () => {
    const calls: unknown[] = [];
    const env = await start({ cursorLive: { applyHookEvent: (e) => (calls.push(e), true) } }, {}, LAN);
    try {
      const port = new URL(env.base).port;
      const r = await raw(env.base, '/api/cursor/events', {
        method: 'POST',
        headers: { ...JSON_HEADERS, Host: `127.0.0.1:${port}` },
        body: JSON.stringify({ event: { hook_event_name: 'sessionStart', conversation_id: 'c1' } }),
      });
      expect(r.status).toBe(403);
      expect(r.body).toMatch(/próprio computador/);
      expect(calls).toHaveLength(0);
    } finally {
      await env.close();
      env.cleanup();
    }
  });
});

describe('personagem do projeto (PUT/DELETE /api/agents/:id/character)', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start({ terminal: true });
  });
  afterEach(async () => {
    await env.close();
    env.cleanup();
  });

  const url = (id = '.claude:1') => `${env.base}/api/agents/${encodeURIComponent(id)}/character`;
  const put = (body: unknown, id?: string) => fetch(url(id), { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const agentOf = async (id = '.claude:1') => (await snapshotOf(env.base)).agents.find((a) => a.id === id)!;

  it('PUT grava e o snapshot traz nome, seed, peças e custom; DELETE volta ao sorteio', async () => {
    const before = await agentOf();
    const res = await put({ name: '  Ana   Backend ', seed: 7, parts: { hairStyle: 'bob', skin: '#5A3623' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(async () =>
      expect(await agentOf()).toMatchObject({ name: 'Ana Backend', seed: 7, parts: { skin: '#5a3623', hairStyle: 'bob' }, custom: true }),
    );
    const del = await fetch(url(), { method: 'DELETE', headers: JSON_HEADERS, body: '{}' });
    expect(del.status).toBe(200);
    await vi.waitFor(async () => expect(await agentOf()).toMatchObject({ name: before.name, seed: before.seed }));
    expect((await agentOf()).custom).toBeUndefined();
  });

  it('400 para nome, seed ou peças inválidos', async () => {
    for (const body of [
      { name: '', seed: 1, parts: {} },
      { name: 'a'.repeat(25), seed: 1, parts: {} },
      { name: 'Ana', seed: -1, parts: {} },
      { name: 'Ana', seed: 1, parts: { skin: 'red' } },
      { name: 'Ana', seed: 1, parts: { lanyard: '#ffffff' } },
      { name: 'Ana', seed: 1 },
      { name: 'Ana', seed: 1, parts: null },
    ]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('404 para subagente e agente desconhecido; 409 para nome de quem está no escritório', async () => {
    env.office.addSub({ id: 's1:x', parentId: '.claude:1', sessionId: 's1', role: 'Explore', background: false, startedAt: Date.now() });
    expect((await put({ name: 'Ana', seed: 1, parts: {} }, 's1:x')).status).toBe(404);
    expect((await put({ name: 'Ana', seed: 1, parts: {} }, 'nao-existe')).status).toBe(404);
    for (const id of ['s1:x', 'nao-existe']) expect((await fetch(url(id), { method: 'DELETE', headers: JSON_HEADERS, body: '{}' })).status).toBe(404);
    env.office.addMain({ id: '.claude:2', account: '.claude', sessionId: 's2', cwd: '/p/web', role: 'Agente principal', startedAt: Date.now(), status: 'working' });
    const other = env.office.get('.claude:2')!.name;
    const res = await put({ name: other, seed: 1, parts: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(`${other} já está no escritório em web`);
  });

  it('403 com Host que não é local (mesmo liberado em HABBLAUD_ALLOWED_HOSTS); 405 para GET', async () => {
    const port = new URL(env.base).port;
    const r = await raw(env.base, `/api/agents/${encodeURIComponent('.claude:1')}/character`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, Host: `habblaud.lan:${port}` },
      body: JSON.stringify({ name: 'Ana', seed: 1, parts: {} }),
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/próprio computador/);
    const get = await fetch(url());
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('PUT, DELETE');
  });
});

describe('GET /api/mod/summary (mod do Claude Code)', () => {
  let env: Awaited<ReturnType<typeof start>>;
  const perms = new Map<string, PermissionRequestInfo>();
  const summary = async (query = ''): Promise<ModSummary> => (await (await fetch(`${env.base}/api/mod/summary${query}`)).json()) as ModSummary;

  beforeEach(async () => {
    perms.clear();
    env = await start({}, { permissions: () => perms });
    const now = Date.now();
    // .claude:1 (sessão s1, /p/loja, trabalhando) vem do start(); um subagente dela espera em segundo plano.
    env.office.addSub({ id: 's1:a1', parentId: '.claude:1', sessionId: 's1', role: 'Explore', background: true, startedAt: now });
    env.office.setStatus('s1:a1', 'waiting', 'aprovar uma permissão');
    // Outra sessão da mesma conta, esperando há mais tempo, e uma da outra conta com o mesmo id de sessão.
    env.office.addMain({ id: '.claude:2', account: '.claude', sessionId: 's2', cwd: '/p/app', role: 'Agente principal', startedAt: now, status: 'waiting', waitingFor: 'responder no terminal' });
    env.office.addMain({ id: '.claude-conta2:3', account: '.claude-conta2', sessionId: 's1', cwd: '/p/site', role: 'Agente principal', startedAt: now, status: 'idle' });
  });
  afterEach(async () => {
    await env.close();
    env.cleanup();
  });

  it('sem parâmetros: o escritório inteiro (presentes, trabalhando, quem espera do mais antigo ao mais novo)', async () => {
    const s = await summary();
    expect(s).toMatchObject({ version: '9.9.9', agents: 4, working: 1 });
    expect(s.waiting.map((w) => w.id).sort()).toEqual(['.claude:2', 's1:a1']);
    const app = s.waiting.find((w) => w.id === '.claude:2')!;
    expect(app).toEqual({ id: '.claude:2', name: app.name, room: 'app', account: '.claude', waitingFor: 'responder no terminal', since: app.since, answerable: false });
    expect(typeof app.since).toBe('number');
    expect(s.waiting.map((w) => w.since)).toEqual([...s.waiting.map((w) => w.since!)].sort((a, b) => a - b));
  });

  it('?account&session: tira a própria sessão (principal e subagentes); a mesma sessão em outra conta fica', async () => {
    const s = await summary('?account=.claude&session=s1');
    expect(s).toMatchObject({ agents: 2, working: 0 });
    expect(s.waiting.map((w) => w.id)).toEqual(['.claude:2']);
    // Só a sessão (sem conta) também basta; só a conta não exclui nada.
    expect((await summary('?session=s1')).agents).toBe(1);
    expect((await summary('?account=.claude')).agents).toBe(4);
  });

  it('answerable = há pedido de permissão para responder pelo escritório', async () => {
    perms.set('.claude:2', { id: 'p1', tool: 'Bash', title: 'Bash(npm test)', text: 'Rodando os testes', icon: '🧪', createdAt: Date.now(), expiresAt: Date.now() + 300_000 });
    env.office.markDirty();
    const s = await summary('?account=.claude&session=s1');
    expect(s.waiting).toMatchObject([{ id: '.claude:2', answerable: true, waitingFor: 'responder no terminal' }]);
  });

  it('agentes do demo ficam de fora (mesmo esperando); quem encerrou também', async () => {
    await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) });
    const snap = await snapshotOf(env.base);
    expect(snap.agents.some((a) => a.id.startsWith('demo:'))).toBe(true);
    env.office.closeMain('.claude-conta2:3');
    const s = await summary();
    expect(s.agents).toBe(3);
    expect(s.waiting.every((w) => !w.id.startsWith('demo:'))).toBe(true);
  });

  it('só GET/HEAD (405 com Allow)', async () => {
    const res = await fetch(`${env.base}/api/mod/summary`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect((await fetch(`${env.base}/api/mod/summary`, { method: 'HEAD' })).status).toBe(200);
  });
});

describe('guarda de Host/Origin', () => {
  const allowed = parseAllowedHosts(' Meu-Mac.local:4747 , habblaud.lan ');

  it('hostnameOf e HABBLAUD_ALLOWED_HOSTS', () => {
    expect([...allowed]).toEqual(['meu-mac.local', 'habblaud.lan']);
    expect(hostnameOf('LocalHost:4747')).toBe('localhost');
    expect(hostnameOf('[::1]:4747')).toBe('::1');
    expect(hostnameOf('a b')).toBeUndefined();
    expect(hostnameOf('[::1]lixo')).toBeUndefined();
  });

  it('Host: IPs, localhost e liberados sim; domínios de fora não', () => {
    expect(hostAllowed(undefined, allowed)).toBe(true);
    for (const h of ['localhost:4747', 'app.localhost', '127.0.0.1:4747', '[::1]:1', '10.0.0.5:4747', 'meu-mac.local:4747']) expect(hostAllowed(h, allowed)).toBe(true);
    for (const h of ['attacker.example:4747', 'localhost.attacker.example', '127.0.0.1.nip.io', '', 'x y']) expect(hostAllowed(h, allowed)).toBe(false);
  });

  it('isLoopbackHost: só localhost, *.localhost, 127.x e ::1 (terminal)', () => {
    for (const h of ['localhost:4747', 'LOCALHOST', 'app.localhost:1', '127.0.0.1:4747', '127.8.9.10', '[::1]:4747']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of [undefined, '', '10.0.0.5:4747', '192.168.0.10', '0.0.0.0:4747', 'habblaud.lan', 'meu-mac.local:4747', '[::]:4747', 'localhost.attacker.example', '127.0.0.1.nip.io', 'x y']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('Origin: ausente, mesma origem ou local', () => {
    expect(originAllowed(undefined, 'localhost:4747', allowed)).toBe(true);
    expect(originAllowed('http://localhost:4747', 'localhost:4747', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', '127.0.0.1:4747', allowed)).toBe(true); // Vite dev com proxy
    expect(originAllowed('http://192.168.0.10:4747', '192.168.0.10:4747', allowed)).toBe(true);
    expect(originAllowed('http://attacker.example', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('http://1.2.3.4', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('null', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('file://', 'localhost:4747', allowed)).toBe(false);
  });
});

describe('tarefas headless (/api/tasks*)', () => {
  const taskInfo = (over: Partial<CursorTaskInfo> = {}): CursorTaskInfo => ({
    id: 'task-1',
    prompt: 'arruma a loja',
    mode: 'plan',
    agentId: 'cursor:task:task-1',
    roomId: 'loja',
    label: 'arruma a loja',
    status: 'running',
    createdAt: 1,
    ...over,
  });

  /** Host mínimo: cada caso troca só os métodos que importam. */
  const host0 = (over: Partial<TaskHost> = {}): TaskHost => ({
    tasks: () => [],
    createTask: async () => taskInfo(),
    stopTask: () => undefined,
    resumeTask: async () => undefined,
    removeTask: async () => ({ removed: false, reason: 'missing' }),
    ...over,
  });

  it('GET /api/tasks devolve a lista; sem o host, 403', async () => {
    const off = await start();
    try {
      const res = await fetch(`${off.base}/api/tasks`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/desligadas/);
    } finally {
      await off.close();
      off.cleanup();
    }

    const on = await start({ tasks: host0({ tasks: () => [taskInfo(), taskInfo({ id: 'task-2', agentId: 'cursor:task:task-2', status: 'done' })] }) });
    try {
      const res = await fetch(`${on.base}/api/tasks`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tasks: CursorTaskInfo[] }).tasks.map((t) => [t.id, t.status])).toEqual([
        ['task-1', 'running'],
        ['task-2', 'done'],
      ]);
    } finally {
      await on.close();
      on.cleanup();
    }
  });

  it('POST /api/tasks cria (201 {task}) com prompt/modo/modelo/isolada; 400 para corpo inválido', async () => {
    const seen: TaskInput[] = [];
    const host = host0({
      createTask: async (input) => (seen.push(input), taskInfo({ prompt: input.prompt, mode: input.mode ?? 'plan', label: input.label ?? input.prompt })),
    });
    const env = await start({ tasks: host });
    try {
      const res = await fetch(`${env.base}/api/tasks`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ prompt: '  arruma a loja  ', cwd: '/p/loja', mode: 'agent', model: 'gpt', label: 'Loja', isolated: false, force: true }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ task: taskInfo({ prompt: 'arruma a loja', mode: 'agent', label: 'Loja' }) });
      expect(seen).toEqual([{ prompt: 'arruma a loja', cwd: '/p/loja', mode: 'agent', model: 'gpt', label: 'Loja', isolated: false, force: true }]);

      for (const body of [{}, { prompt: '' }, { prompt: 'x' }, { prompt: 'x', cwd: '' }, { prompt: 'x', cwd: '/p', mode: 'turbo' }, { prompt: 'x', cwd: '/p', isolated: 'no' }, { prompt: 'x', cwd: '/p', force: 1 }]) {
        const bad = await fetch(`${env.base}/api/tasks`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
        expect(bad.status, JSON.stringify(body)).toBe(400);
      }
      expect(seen).toHaveLength(1);
    } finally {
      await env.close();
      env.cleanup();
    }
  });

  it('POST /api/tasks: falha de lançamento vira 409 com o erro acionável', async () => {
    const env = await start({ tasks: host0({ createTask: async () => taskInfo({ status: 'failed', error: MISSING_BIN }) }) });
    try {
      const res = await fetch(`${env.base}/api/tasks`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ prompt: 'x', cwd: '/p' }) });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(MISSING_BIN);
    } finally {
      await env.close();
      env.cleanup();
    }
  });

  it('POST /api/tasks/:id/stop e /resume refletem a tarefa; id desconhecido 404; retomada falha 409', async () => {
    const host = host0({
      stopTask: (id) => (id === 'task-1' ? taskInfo({ status: 'stopped' }) : undefined),
      resumeTask: async (id) => (id === 'task-1' ? taskInfo({ status: 'running' }) : id === 'task-failed' ? taskInfo({ id, status: 'failed', error: MISSING_BIN }) : undefined),
    });
    const env = await start({ tasks: host });
    try {
      const stop = await fetch(`${env.base}/api/tasks/task-1/stop`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      expect(stop.status).toBe(200);
      expect(((await stop.json()) as { task: CursorTaskInfo }).task).toMatchObject({ id: 'task-1', status: 'stopped' });
      expect((await fetch(`${env.base}/api/tasks/nope/stop`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(404);

      const resume = await fetch(`${env.base}/api/tasks/task-1/resume`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      expect(resume.status).toBe(200);
      expect(((await resume.json()) as { task: CursorTaskInfo }).task).toMatchObject({ id: 'task-1', status: 'running' });
      expect((await fetch(`${env.base}/api/tasks/nope/resume`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(404);
      const failed = await fetch(`${env.base}/api/tasks/task-failed/resume`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      expect(failed.status).toBe(409);
      expect(((await failed.json()) as { error: string }).error).toBe(MISSING_BIN);
    } finally {
      await env.close();
      env.cleanup();
    }
  });

  it('DELETE /api/tasks/:id: removed 200; missing 404; dirty/failed 409', async () => {
    const reasons: Record<string, TaskRemoveResult> = {
      'task-1': { removed: true },
      'task-dirty': { removed: false, reason: 'dirty' },
      'task-fail': { removed: false, reason: 'failed' },
    };
    const env = await start({ tasks: host0({ removeTask: async (id) => reasons[id] ?? { removed: false, reason: 'missing' } }) });
    try {
      const ok = await fetch(`${env.base}/api/tasks/task-1`, { method: 'DELETE', headers: JSON_HEADERS });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ removed: true });
      expect((await fetch(`${env.base}/api/tasks/nope`, { method: 'DELETE', headers: JSON_HEADERS })).status).toBe(404);
      for (const id of ['task-dirty', 'task-fail']) {
        const conflict = await fetch(`${env.base}/api/tasks/${id}`, { method: 'DELETE', headers: JSON_HEADERS });
        expect(conflict.status, id).toBe(409);
        expect(((await conflict.json()) as { error: string }).error).toMatch(/preservada|remover/);
      }
    } finally {
      await env.close();
      env.cleanup();
    }
  });

  it('trava local e método: Host remoto 403; método errado 405 com Allow', async () => {
    const env = await start({ tasks: host0() });
    try {
      const port = new URL(env.base).port;
      const remote = await raw(env.base, '/api/tasks', { headers: { Host: `habblaud.lan:${port}` } });
      expect(remote.status).toBe(403);
      expect(remote.body).toMatch(/próprio computador/);

      const list = await fetch(`${env.base}/api/tasks`, { method: 'PUT', headers: JSON_HEADERS });
      expect(list.status).toBe(405);
      expect(list.headers.get('allow')).toBe('GET, POST');
      const one = await fetch(`${env.base}/api/tasks/task-1`, { method: 'GET' });
      expect(one.status).toBe(405);
      expect(one.headers.get('allow')).toBe('DELETE');
      const stopGet = await fetch(`${env.base}/api/tasks/task-1/stop`);
      expect(stopGet.status).toBe(405);
      expect(stopGet.headers.get('allow')).toBe('POST');
    } finally {
      await env.close();
      env.cleanup();
    }
  });
});
