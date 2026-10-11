// Histórico do terminal do Cursor (o HistoryProvider 'cursor', ver sources/source.ts): as conversas recentes de cada
// conta do Cursor (abertas ou já encerradas), listadas a partir dos transcripts que a IDE grava em
// <conta>/projects/<slug-do-projeto>/agent-transcripts/<id>/<id>.jsonl modificados nos últimos 7 dias. De cada
// arquivo lê só o começo (o primeiro prompt: o título; e um `cwd` defensivo, quando a linha o trouxer) e guarda o
// resultado enquanto o mtime e o tamanho não mudam.
//
// O transcript do Cursor NÃO grava título nem horário (Fase 3, lacuna C1): por isso o título sai do primeiro prompt
// (via createCursorTerminalParser) e firstAt/lastAt caem no mtime. O slug do projeto não é reversível com segurança
// (um segmento com '-' viraria outro caminho), então não inventamos o `cwd` a partir dele: `project` só aparece se
// alguma linha do transcript trouxer um `cwd` legível. Os subagentes do Cursor não têm transcript próprio aqui.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { truncate } from '../../../shared/activity';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { createCursorTerminalParser } from './terminal';

/** Começo do transcript lido (o primeiro prompt costuma caber; senão procuramos só aqui). */
const HEAD_BYTES = 128 * 1024;
/** Arquivos lidos ao mesmo tempo (a listagem é assíncrona: não trava o polling do escritório). */
const READ_CONCURRENCY = 8;
const TITLE_MAX = 90;

/** O id de uma conversa do Cursor vira o nome da pasta/arquivo (<id>/<id>.jsonl): sem separadores de caminho. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** O id de uma sessão do Cursor tem formato de pasta (sem `/`): é também o nome do transcript. */
export function isCursorSessionId(v: string): boolean {
  return SESSION_ID.test(v);
}

export interface CursorHistoryAccount {
  id: string;
  /** Pasta do Cursor lida por este processo (no Docker, a montada). */
  dir: string;
}

export interface CursorHistoryOptions {
  accounts: () => readonly CursorHistoryAccount[];
  /** Agente principal da sessão, se ela ainda estiver aberta no escritório. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

/** O começo do transcript: o primeiro prompt (título) e o `cwd`, quando uma linha o trouxer. */
export interface CursorSessionSummary {
  title?: string;
  project?: string;
}

interface Candidate {
  account: string;
  sessionId: string;
  /** Pasta do projeto em `projects/` (o slug do Cursor): o `projectDir` do RecentSession. */
  projectDir: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export class CursorHistory implements HistoryProvider {
  readonly provider = 'cursor' as const;
  /** Metadados por caminho, válidos enquanto mtime e tamanho forem os mesmos. */
  private cache = new Map<string, { mtimeMs: number; size: number; summary: CursorSessionSummary }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;
  /** Arquivos lidos de verdade (sem cache) desde o início: só para os testes. */
  reads = 0;

  constructor(private readonly opts: CursorHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  /** Sessões recentes de todas as contas, da atividade mais recente para a mais antiga. */
  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) all.push(...(await this.candidates(acc, now)));
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const summaries = await mapLimit(picked, READ_CONCURRENCY, (c) => this.summaryOf(c));
    // Esquece os arquivos que saíram da janela (o cache não cresce sem limite).
    const keep = new Set(picked.map((c) => c.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);

    const out: RecentSession[] = [];
    for (const [i, c] of picked.entries()) {
      const s = summaries[i];
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      // Sem horário no transcript, firstAt/lastAt caem no mtime (é o único "quando" confiável).
      const r: RecentSession = {
        account: c.account,
        provider: 'cursor',
        sessionId: c.sessionId,
        projectDir: c.projectDir,
        firstAt: c.mtimeMs,
        lastAt: c.mtimeMs,
        size: c.size,
        open: !!agentId,
      };
      if (s.project) r.project = s.project;
      if (s.title) r.title = s.title;
      if (agentId) r.agentId = agentId;
      out.push(r);
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * Transcript da sessão `sessionId` da conta, validado: conta conhecida, id sem separadores de caminho e o arquivo
   * (com links resolvidos) dentro da pasta da conta. Nunca lança.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!isCursorSessionId(sessionId)) return { status: 400, error: 'id de sessão inválido' };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: 'conta desconhecida' };
    const notFound: HistoryResolveResult = { status: 404, error: 'sessão não encontrada' };
    let root: string;
    let slugs: string[];
    try {
      root = realpathSync(acc.dir);
      slugs = readdirSync(join(acc.dir, 'projects'));
    } catch {
      return notFound; // conta sem projects/ (ou sumiu)
    }
    for (const slug of slugs) {
      const candidate = join(acc.dir, 'projects', slug, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
      if (!existsSync(candidate)) continue;
      try {
        const real = realpathSync(candidate);
        // Um link dentro da pasta da conta apontando para fora não serve.
        if (!real.startsWith(root + sep) || !statSync(real).isFile()) continue;
        return { path: real, createParser: createCursorTerminalParser };
      } catch {
        // sumiu entre a listagem e a leitura
      }
    }
    return notFound;
  }

  /** Transcripts (<slug>/agent-transcripts/<id>/<id>.jsonl) modificados dentro da janela. */
  private async candidates(acc: CursorHistoryAccount, now: number): Promise<Candidate[]> {
    const out: Candidate[] = [];
    let slugs: string[];
    try {
      slugs = (await readdir(join(acc.dir, 'projects'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return out; // conta sem projects/ (ainda)
    }
    for (const projectDir of slugs) {
      let ids: string[];
      try {
        ids = (await readdir(join(acc.dir, 'projects', projectDir, 'agent-transcripts'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        continue;
      }
      for (const sessionId of ids) {
        if (!isCursorSessionId(sessionId)) continue;
        const path = join(acc.dir, 'projects', projectDir, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
        try {
          const st = await stat(path);
          if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
          out.push({ account: acc.id, sessionId, projectDir, path, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // apagado/ilegível no meio da listagem
        }
      }
    }
    return out;
  }

  private async summaryOf(c: Candidate): Promise<CursorSessionSummary> {
    const hit = this.cache.get(c.path);
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.summary;
    let summary: CursorSessionSummary;
    try {
      this.reads++;
      summary = await readCursorSummary(c.path, c.size);
    } catch (err) {
      log.warnOnce(`cursor-history:${errMsg(err)}`, `Histórico do Cursor: transcript ilegível (${errMsg(err)}).`);
      summary = {};
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, summary });
    return summary;
  }
}

/** Lê o começo do transcript (de tamanho `size`) e extrai o primeiro prompt (título) e o `cwd`, quando houver. */
export async function readCursorSummary(path: string, size: number): Promise<CursorSessionSummary> {
  const fh = await open(path, 'r');
  try {
    const length = Math.max(0, Math.min(HEAD_BYTES, size));
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    if (bytesRead < size) lines.pop(); // a última linha veio cortada
    const parser = createCursorTerminalParser();
    const summary: CursorSessionSummary = {};
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      if (!summary.project) {
        const cwd = cwdOf(line);
        if (cwd) summary.project = cwd;
      }
      if (summary.title) continue;
      let entries;
      try {
        entries = parser.push(line);
      } catch {
        continue;
      }
      const user = entries.find((e) => e.kind === 'user');
      if (user?.kind === 'user' && user.text.trim()) summary.title = truncate(user.text, TITLE_MAX);
      if (summary.title && summary.project) break;
    }
    return summary;
  } finally {
    await fh.close();
  }
}

/** O `cwd` da primeira linha que o trouxer (defensivo: o schema do Cursor pode variar). Nunca lança. */
function cwdOf(line: string): string | undefined {
  if (!line.includes('"cwd"')) return undefined;
  try {
    const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
    if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
  } catch {
    // linha inválida: tenta a próxima
  }
  return undefined;
}

/** map() assíncrono com no máximo `limit` tarefas ao mesmo tempo (mantém a ordem). */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
