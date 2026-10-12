// Terminal (Server-Sent Events) em GET /api/agents/:id/terminal: a conversa da sessão
// (prompts, respostas, ferramentas e resultados) reconstruída do transcript JSONL por sources/terminal.ts.
// Eventos nomeados: init | append (o `data` é o de TerminalMessage em shared/types.ts). A rota
// (http/app.ts) já conferiu que o recurso está ligado e que o acesso é local.
//
// Cada conexão tem o próprio parser (o da ferramenta do agente: SourceSet.parserFor; o do Claude Code por padrão):
// ao conectar, lê o fim do transcript (≈4 MB, últimas 500 entradas) e manda `init`; depois, as linhas novas vêm de
// UMA assinatura do TranscriptHub por agente/transcript (o mesmo leitor serve N terminais, com `fs.watch` de
// acelerador) e viram `append`. O `init` continua sendo uma leitura pontual por conexão.
// Transcript truncado/substituído (ou trocado por /clear no mesmo processo) = parser novo e `init` de
// novo. Agentes do demo não têm transcript: a conversa fictícia sai de demoTerminalEntries a cada ~500 ms.
// Sessões do histórico (GET /api/sessions/:conta/:sessionId/terminal, http/sessions.ts) usam o mesmo
// leitor sobre o transcript já validado pela rota, com polling mais espaçado (~2 s).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { demoTerminalEntries } from '../../shared/demo/terminal';
import type { Activity, AgentInfo, TerminalEntry, TerminalInit } from '../../shared/types';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';
import { FileTail, type TailRead } from '../sources/tail';
import { createTerminalParser, type TerminalParser } from '../sources/terminal';
import { TranscriptHub, type HubSubscription } from '../sources/transcript-hub';
import { sendJson } from './app';
import { frame } from './sse';

/** Terminais abertos ao mesmo tempo (cada um lê o transcript por conta própria). */
export const MAX_STREAMS = 8;
/** Quanto do fim do transcript é lido para o `init`. */
export const INIT_TAIL_BYTES = 4 * 1024 * 1024;
/** Entradas mandadas no `init` (as mais recentes). */
export const INIT_ENTRIES = 500;
export const POLL_MS = 400;
export const DEMO_POLL_MS = 500;
/** Sessão do histórico: quase sempre encerrada (o polling só pega uma retomada com /resume). */
export const SESSION_POLL_MS = 2_000;
const PING_MS = 15_000;
/** Cliente lento demais (buffer acumulado acima disto) é desconectado; o EventSource reconecta. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** Leituras (de até 8 MB cada) por ciclo de polling: o resto fica para o próximo. */
const READS_PER_POLL = 4;
const MAX_INIT_READS = 64;
/** Prefixo dos ids dos agentes de demonstração (ver Office.setDemo). */
const DEMO_PREFIX = 'demo:';

export interface TerminalOptions {
  office: Office;
  /** Caminho do transcript de um agente real (SourceSet.transcriptPathOf). */
  transcriptPathOf: (agentId: string) => string | undefined;
  /**
   * Parser da conversa de um agente real (SourceSet.parserFor): um NOVO a cada chamada. Ausente, ou undefined,
   * = createParser.
   */
  parserFor?: (agentId: string) => TerminalParser | undefined;
  /** Fábrica do parser padrão (testes); padrão: createTerminalParser (o do Claude Code). */
  createParser?: () => TerminalParser;
  /** Leitor compartilhado do transcript (uma leitura por agente serve N terminais). Padrão: um novo hub. */
  hub?: TranscriptHub;
  /** Conversa fictícia dos agentes do demo (testes); padrão: demoTerminalEntries. */
  demoEntries?: (agent: AgentInfo, history: Activity[]) => TerminalEntry[];
  maxStreams?: number;
  initTailBytes?: number;
  initEntries?: number;
  pollMs?: number;
  demoPollMs?: number;
  sessionPollMs?: number;
  pingMs?: number;
}

/** O que mudou desde o último ciclo: `init` substitui tudo; `stop` = não há mais o que acompanhar. */
interface PollResult {
  init?: TerminalInit;
  append?: TerminalEntry[];
  stop?: boolean;
}

/** De onde vem a conversa de uma conexão. */
interface ConversationSource {
  readonly intervalMs: number;
  /** Conversa recente, para o `init`. */
  load(): TerminalInit;
  poll(): PollResult;
  /** Solta o que a conexão segurava (ex.: a assinatura do hub). */
  dispose?(): void;
}

/** Passa as linhas pelo parser; uma linha que o faça falhar é pulada sem perder o resto do lote. */
function parseInto(parser: TerminalParser, lines: readonly string[], out: TerminalEntry[]): void {
  for (const line of lines) {
    let entries: TerminalEntry[];
    try {
      entries = parser.push(line);
    } catch (err) {
      log.warnOnce(`terminal-parse:${errMsg(err)}`, `Terminal: linha do transcript ignorada (${errMsg(err)}).`);
      continue;
    }
    for (const e of entries) out.push(e);
  }
}

/**
 * Agente real (ou sessão do histórico): o `init` é uma leitura pontual do fim do transcript (janela recente) e as
 * linhas novas vêm do `TranscriptHub` — o mesmo leitor por path serve todos os terminais daquele agente (SC-05).
 * `transcriptPathOf` informa a troca de transcript do principal (/clear); numa sessão do histórico ele nunca muda.
 */
class TranscriptSource implements ConversationSource {
  /** Path do transcript que a assinatura acompanha (undefined quando a sessão sumiu do mapa). */
  private path: string;
  private sub: HubSubscription | null = null;
  /** Leituras do hub ainda não consumidas pelo `poll()`. */
  private pending: TailRead[] = [];
  /** Criado em load(), que sempre roda antes do primeiro poll(). */
  private parser!: TerminalParser;

  constructor(
    private readonly agentId: string,
    path: string,
    private readonly o: Required<Pick<TerminalOptions, 'transcriptPathOf' | 'createParser' | 'initTailBytes' | 'initEntries' | 'hub'>>,
    readonly intervalMs: number,
  ) {
    this.path = path;
  }

  load(): TerminalInit {
    this.parser = this.o.createParser();
    // Janela recente: leitura pontual própria (o hub só entrega o que vier depois de assinar).
    const tail = new FileTail(this.path);
    const offset = tail.seekTail(this.o.initTailBytes);
    const keep = this.o.initEntries;
    let entries: TerminalEntry[] = [];
    let dropped = false;
    for (let i = 0; i < MAX_INIT_READS; i++) {
      const r = tail.read();
      parseInto(this.parser, r.lines, entries);
      // Descarta o excesso pelo caminho (transcript com muitas entradas pequenas).
      if (entries.length > keep * 2) {
        entries = entries.slice(-keep);
        dropped = true;
      }
      if (!r.more) break;
    }
    if (entries.length > keep) {
      entries = entries.slice(-keep);
      dropped = true;
    }
    this.pending = [];
    this.ensureSub();
    return { agentId: this.agentId, entries, truncated: offset > 0 || dropped };
  }

  poll(): PollResult {
    // /clear ou /resume no mesmo processo: o principal continua o mesmo, o transcript é outro.
    const path = this.o.transcriptPathOf(this.agentId);
    if (path && path !== this.path) {
      this.sub?.unsubscribe();
      this.sub = null;
      this.path = path;
      return { init: this.load() };
    }
    if (!this.pending.length) return { append: [] };
    const reads = this.pending;
    this.pending = [];
    // Truncado/substituído: o hub releu do começo; reconstrói o `init` (parser novo) e descarta essas linhas.
    if (reads.some((r) => r.reset)) return { init: this.load() };
    const fresh: TerminalEntry[] = [];
    for (const r of reads) parseInto(this.parser, r.lines, fresh);
    return { append: fresh };
  }

  dispose(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    this.pending = [];
  }

  /** Uma assinatura por conexão no leitor compartilhado do path atual. */
  private ensureSub(): void {
    if (this.sub) return;
    this.sub = this.o.hub.subscribe(this.path, { onRead: (r) => this.pending.push(r) });
  }
}

/** Agente do demo: conversa fictícia montada do título e das atividades simuladas. */
class DemoSource implements ConversationSource {
  /** Ids da última lista gerada (o que o cliente já tem). */
  private sent = new Set<string>();

  constructor(
    private readonly agentId: string,
    private readonly o: { office: Office; demoEntries: NonNullable<TerminalOptions['demoEntries']>; initEntries: number },
    readonly intervalMs: number,
  ) {}

  private list(): TerminalEntry[] | undefined {
    const d = this.o.office.detail(this.agentId);
    return d ? this.o.demoEntries(d.agent, d.history) : undefined;
  }

  load(): TerminalInit {
    const all = this.list() ?? [];
    this.sent = new Set(all.map((e) => e.id));
    const entries = all.slice(-this.o.initEntries);
    return { agentId: this.agentId, entries, truncated: entries.length < all.length };
  }

  poll(): PollResult {
    const all = this.list();
    if (!all) return { stop: true };
    const fresh = all.filter((e) => !this.sent.has(e.id));
    this.sent = new Set(all.map((e) => e.id));
    return { append: fresh };
  }
}

interface Stream {
  res: ServerResponse;
  timer: ReturnType<typeof setInterval> | null;
  source: ConversationSource;
}

export class TerminalStreams {
  private streams = new Set<Stream>();
  private pinger: ReturnType<typeof setInterval> | null = null;
  private readonly createParser: () => TerminalParser;
  private readonly demoEntries: NonNullable<TerminalOptions['demoEntries']>;
  private readonly hub: TranscriptHub;
  /** Só fecha o hub no stop() se foi ele que o criou (injeta compartilhado com a fonte: T4). */
  private readonly ownsHub: boolean;
  private readonly maxStreams: number;
  private readonly initTailBytes: number;
  private readonly initEntries: number;
  private readonly pollMs: number;
  private readonly demoPollMs: number;
  private readonly sessionPollMs: number;
  private readonly pingMs: number;

  constructor(private readonly opts: TerminalOptions) {
    this.createParser = opts.createParser ?? createTerminalParser;
    this.demoEntries = opts.demoEntries ?? demoTerminalEntries;
    this.hub = opts.hub ?? new TranscriptHub();
    this.ownsHub = !opts.hub;
    this.maxStreams = opts.maxStreams ?? MAX_STREAMS;
    this.initTailBytes = opts.initTailBytes ?? INIT_TAIL_BYTES;
    this.initEntries = opts.initEntries ?? INIT_ENTRIES;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.demoPollMs = opts.demoPollMs ?? DEMO_POLL_MS;
    this.sessionPollMs = opts.sessionPollMs ?? SESSION_POLL_MS;
    this.pingMs = opts.pingMs ?? PING_MS;
  }

  get size(): number {
    return this.streams.size;
  }

  stop(): void {
    for (const s of [...this.streams]) {
      this.drop(s);
      s.res.end();
    }
    if (this.ownsHub) this.hub.close();
  }

  /**
   * Abre o terminal de um agente: `init` com a conversa recente, depois `append` com as novidades.
   * Antes do stream, erros respondem JSON `{error}`: 404 (agente ou transcript desconhecido),
   * 429 (terminais abertos demais) ou 500 (transcript ilegível).
   */
  attach(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const source = this.sourceFor(agentId);
    if (typeof source === 'string') return sendJson(res, 404, { error: source });
    this.serve(req, res, agentId, source);
  }

  /**
   * Abre a conversa de uma sessão do histórico pelo transcript `path` (a rota já validou conta, id e caminho).
   * `streamId` vai no `init` (ex.: "session:<conta>:<sessionId>"); `createParser` é o da ferramenta da sessão
   * (HistorySession.createParser; padrão: o do Claude Code). Mesmos erros de attach (429/500).
   */
  attachSession(req: IncomingMessage, res: ServerResponse, streamId: string, path: string, createParser?: () => TerminalParser): void {
    const o = { transcriptPathOf: () => undefined, createParser: createParser ?? this.createParser, initTailBytes: this.initTailBytes, initEntries: this.initEntries, hub: this.hub };
    this.serve(req, res, streamId, new TranscriptSource(streamId, path, o, this.sessionPollMs));
  }

  /** Limite de terminais, `init` e o stream SSE de uma fonte já escolhida. */
  private serve(req: IncomingMessage, res: ServerResponse, id: string, source: ConversationSource): void {
    if (this.streams.size >= this.maxStreams) {
      return sendJson(res, 429, { error: `terminais abertos demais (máximo de ${this.maxStreams}); feche algum e tente de novo` });
    }
    let init: TerminalInit;
    try {
      init = source.load();
    } catch (err) {
      log.warnOnce(`terminal-load:${id}:${errMsg(err)}`, `Terminal de ${id}: não foi possível ler o transcript (${errMsg(err)}).`);
      return sendJson(res, 500, { error: 'não foi possível ler o transcript' });
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const s: Stream = { res, timer: null, source };
    this.streams.add(s);
    this.write(s, frame('init', init));
    s.timer = setInterval(() => this.pump(s, source, id), source.intervalMs);
    s.timer.unref?.();
    const drop = () => this.drop(s);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    if (!this.pinger) {
      this.pinger = setInterval(() => {
        for (const c of [...this.streams]) this.write(c, ': ping\n\n');
      }, this.pingMs);
      this.pinger.unref?.();
    }
  }

  /** Fonte da conversa do agente, ou a mensagem do 404. */
  private sourceFor(agentId: string): ConversationSource | string {
    const office = this.opts.office;
    if (office.has(agentId)) {
      const path = this.opts.transcriptPathOf(agentId);
      if (!path) return 'transcript do agente não encontrado';
      const parserFor = this.opts.parserFor;
      const createParser = parserFor ? () => parserFor(agentId) ?? this.createParser() : this.createParser;
      const o = { transcriptPathOf: this.opts.transcriptPathOf, createParser, initTailBytes: this.initTailBytes, initEntries: this.initEntries, hub: this.hub };
      return new TranscriptSource(agentId, path, o, this.pollMs);
    }
    // Os agentes do demo não estão entre os reais do Office, mas office.detail os encontra.
    if (agentId.startsWith(DEMO_PREFIX) && office.detail(agentId)) {
      return new DemoSource(agentId, { office, demoEntries: this.demoEntries, initEntries: this.initEntries }, this.demoPollMs);
    }
    return 'agente não encontrado';
  }

  private pump(s: Stream, source: ConversationSource, agentId: string): void {
    let r: PollResult;
    try {
      r = source.poll();
    } catch (err) {
      // Ex.: transcript sem permissão de leitura. Tenta de novo no próximo ciclo.
      log.warnOnce(`terminal:${agentId}:${errMsg(err)}`, `Terminal de ${agentId}: ${errMsg(err)}`);
      return;
    }
    if (r.init) this.write(s, frame('init', r.init));
    if (r.append?.length) this.write(s, frame('append', r.append));
    // O agente sumiu (demo desligado ou sessão simulada encerrada): o stream fica aberto só com pings.
    if (r.stop && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }

  private write(s: Stream, chunk: string): void {
    const res = s.res;
    if (res.destroyed || res.writableEnded) return this.drop(s);
    if (res.writableLength > MAX_BUFFERED) {
      this.drop(s);
      res.destroy();
      return;
    }
    res.write(chunk);
  }

  private drop(s: Stream): void {
    if (!this.streams.delete(s)) return;
    if (s.timer) clearInterval(s.timer);
    s.timer = null;
    s.source.dispose?.();
    if (!this.streams.size && this.pinger) {
      clearInterval(this.pinger);
      this.pinger = null;
    }
  }
}
