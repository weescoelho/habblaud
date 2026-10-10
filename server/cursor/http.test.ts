// Rota dos eventos dos hooks do Cursor: o parse do corpo ({event:{hook_event_name}}) e o manuseio que repassa à
// fonte do Cursor ao vivo (um falso) e responde {ok}. Sem a fonte, ou se ela falha: 200 {ok:false} (nunca 500).
// A trava de rede em si (Host/loopback) é testada nas rotas de verdade em server/http/http.test.ts (T7). Dados
// sintéticos.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../http/app';
import { setQuiet } from '../log';
import type { CursorLive } from '../sources/cursor/live';
import { request } from '../test/permission-server';
import { handleCursorEvent, parseCursorEvent } from './http';

setQuiet(true);

const EVENT = {
  hook_event_name: 'preToolUse',
  conversation_id: 'c1',
  workspace_roots: ['/p/loja'],
  tool_name: 'Shell',
  tool_input: { command: 'ls' },
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** Servidor mínimo que chama handleCursorEvent direto (a rota de verdade entra em T7). */
async function serve(live?: CursorLive): Promise<string> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/cursor/events') return void res.writeHead(404).end();
    handleCursorEvent(req, res, { live }).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () =>
    new Promise((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('POST /api/cursor/events: parse e manuseio', () => {
  it('parseCursorEvent aceita só {event:{hook_event_name}}; o resto é 400', () => {
    expect(parseCursorEvent({ event: EVENT })).toEqual({ event: EVENT });
    for (const body of [{}, { event: 'x' }, { event: {} }, { event: { conversation_id: 'c' } }, []]) {
      expect(() => parseCursorEvent(body), JSON.stringify(body)).toThrow(HttpError);
    }
  });

  it('repassa o evento à fonte do Cursor e devolve {ok:true}', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const base = await serve({ applyHookEvent: (e) => (calls.push(e), true) });
    expect(await request(base, '/api/cursor/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: true } });
    expect(calls).toEqual([EVENT]);
  });

  it('sem a fonte do Cursor: 200 {ok:false}', async () => {
    const base = await serve();
    expect(await request(base, '/api/cursor/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('fonte que não aproveita o evento (hook desconhecido): 200 {ok:false}', async () => {
    const base = await serve({ applyHookEvent: () => false });
    expect(await request(base, '/api/cursor/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('fonte que lança: 200 {ok:false} (nunca 500)', async () => {
    const base = await serve({
      applyHookEvent: () => {
        throw new Error('quebrou');
      },
    });
    expect(await request(base, '/api/cursor/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('corpo inválido: 400; sem JSON: 415; acima de 256 KB: 413', async () => {
    const base = await serve({ applyHookEvent: () => true });
    for (const body of [{}, { event: 'x' }, { event: {} }, []]) {
      expect((await request(base, '/api/cursor/events', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(base, '/api/cursor/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const big = { event: { ...EVENT, tool_input: { command: 'x'.repeat(300 * 1024) } } };
    expect((await request(base, '/api/cursor/events', { method: 'POST', body: big })).status).toBe(413);
  });
});
