// Eventos dos hooks do Cursor (mod/habblaud-cursor/hook.mjs): o stdin do evento chega aqui e vai para a fonte do
// Cursor (CursorLive), que atualiza o agente na hora. Os eventos só observam (a resposta nunca volta para a sessão),
// mas só valem vindos do próprio computador: a trava (Host local e, fora do Docker, conexão pelo loopback) é
// conferida em http/app.ts (o hook roda na mesma máquina e fala com 127.0.0.1). O guard (http/guard.ts) já exigiu JSON.
//
//   POST /api/cursor/events   (hook)   {event: <stdin do hook, textos cortados>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { CursorLive } from '../sources/cursor/live';

type Rec = Record<string, unknown>;

export interface CursorHookEvent {
  /** O stdin do hook (hook_event_name, conversation_id, workspace_roots...). */
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Corpo de POST /api/cursor/events. Sem `event` (objeto com hook_event_name): 400. */
export function parseCursorEvent(raw: unknown): CursorHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') {
    throw new HttpError(400, 'esperado {event: <JSON do hook do Cursor>}');
  }
  return { event };
}

/** Trata POST /api/cursor/events (método e Host já conferidos). `ok` = a fonte do Cursor aproveitou o evento. */
export async function handleCursorEvent(req: IncomingMessage, res: ServerResponse, deps: { live?: CursorLive }): Promise<void> {
  const body = parseCursorEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(body.event) === true;
    } catch (err) {
      log.warnOnce(`cursor-event:${errMsg(err)}`, `Eventos do Cursor: falha ao aplicar um evento (${errMsg(err)}).`);
    }
  }
  sendJson(res, 200, { ok });
}
