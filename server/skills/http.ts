// Rotas de skills (P7 · SC-32/SC-33): o painel lista as skills dos diretórios conhecidos e dispara uma delas como
// prompt na sessão-alvo. A trava (recurso ligado + Host local) é conferida em http/app.ts; o guard (http/guard.ts)
// já exigiu JSON e Origin local no POST. O canal de entrega é injetado (`submit`): headless/IDE conforme o dono da
// sessão (reusa a fila da P6).
//
//   GET  /api/skills        (página)  ?agentId=<id> ou ?cwd=<dir>: 200 {skills: SkillInfo[]}
//   POST /api/skills/run    (página)  {agentId, skill}: 200 {ok: true} | 400 | 404 | 409
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SkillInfo } from '../../shared/types';
import { HttpError, readJson, sendJson } from '../http/app';

const ID_MAX = 300;

/** Resultado de submeter o prompt: `ok`, ou o status/motivo para a resposta da rota. */
export type SkillRunResult = { ok: true } | { ok: false; status: number; error: string };

export interface SkillRoutesDeps {
  /** Catálogo de um projeto (cwd). Normalmente `listSkills(skillRoots(cwd, home))`. */
  list(cwd: string): SkillInfo[];
  /** Cwd do projeto de um agente (a sala), ou undefined (agente desconhecido). */
  projectOf(agentId: string): string | undefined;
  /** Projeto padrão quando o pedido não diz agente nem cwd. */
  cwd(): string;
  /** Submete o prompt à sessão-alvo (headless ou IDE, pelo canal de mensagem). */
  submit(agentId: string, prompt: string): SkillRunResult;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function shortStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= ID_MAX ? v.trim() : undefined;
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'método não permitido' });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else sendJson(res, 500, { error: 'erro interno' });
}

/** Corpo de POST /api/skills/run: `{agentId, skill}`. Corpo inválido: lança HttpError(400). */
export function parseSkillRun(raw: unknown): { agentId: string; skill: string } {
  const r = rec(raw);
  const agentId = shortStr(r?.agentId);
  const skill = shortStr(r?.skill);
  if (!r || !agentId || !skill) throw new HttpError(400, 'esperado {agentId, skill}');
  return { agentId, skill };
}

/** O prompt que representa a skill na sessão-alvo (o mesmo comando que o usuário digitaria). */
export function skillPrompt(name: string): string {
  return `/${name}`;
}

export function createSkillRoutes(deps: SkillRoutesDeps): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const list = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const agentId = shortStr(url.searchParams.get('agentId') ?? undefined);
    const cwd = shortStr(url.searchParams.get('cwd') ?? undefined) ?? (agentId ? deps.projectOf(agentId) : undefined) ?? deps.cwd();
    sendJson(res, 200, { skills: deps.list(cwd) });
  };

  const run = async (req: IncomingMessage, res: ServerResponse) => {
    const { agentId, skill } = parseSkillRun(await readJson(req));
    const cwd = deps.projectOf(agentId);
    if (cwd === undefined) return sendJson(res, 404, { error: 'agente desconhecido: ele já saiu do escritório?' });
    const found = deps.list(cwd).find((s) => s.name === skill);
    if (!found) return sendJson(res, 404, { error: `skill desconhecida: ${skill}` });
    if (!found.available) return sendJson(res, 409, { error: `a skill "${skill}" está indisponível: o SKILL.md está malformado` });
    const r = deps.submit(agentId, skillPrompt(found.name));
    if (!r.ok) return sendJson(res, r.status, { error: r.error });
    sendJson(res, 200, { ok: true });
  };

  return (req, res, path) => {
    const method = req.method ?? 'GET';
    if (path === '/api/skills') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
      return list(req, res);
    }
    if (path === '/api/skills/run') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      run(req, res).catch((err) => fail(res, err));
      return;
    }
    sendJson(res, 404, { error: 'rota desconhecida' });
  };
}
