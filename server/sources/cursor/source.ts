// Fonte de agentes do Cursor (AgentSource 'cursor', ver sources/source.ts): o Cursor não tem registro local de
// sessões conhecido (lacuna C2), então a presença vem SÓ dos hooks. O script de hook manda o stdin do evento para
// POST /api/cursor/events e a rota repassa para applyHookEvent (CursorLive), que cria/atualiza o agente no Office.
//
// Presença: um tracker por conversation_id. Cada evento atualiza lastHookAt; um relógio de ~1 s (poll) remove o
// agente quando now - lastHookAt > STALE_PRESENCE_MS (o Cursor pode fechar sem sessionEnd, num crash). Um evento
// novo reabre a sessão. O `transcript_path` que os hooks trazem é guardado por conversa (só quando vem não
// vazio; nunca limpo por um evento sem ele) e vira o terminal via transcriptPathOf/terminalParser.
//
// Subagentes: `subagentStart`/`subagentStop` formam um par por `subagent_id`, ligado ao agente pai. O sub tem
// transcript próprio (`agent-transcripts/<pai>/subagents/<child>.jsonl`); o id da conversa dele
// (`child_conversation_id`) só chega no Stop, então o terminal do sub resolve no Stop e sobrevive à entrega.
//
// Status: aplicado por bordas (decide), a informação mais nova vence (statusAt): um evento atrasado não regride.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { githubEventKey } from '../../../shared/github';
import type { Activity, AgentStats, AgentStatus, SourceInfo } from '../../../shared/types';
import { ACCOUNT_COLORS, type DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail, type TailRead } from '../tail';
import type { TerminalParser } from '../terminal';
import { cursorGitHubCall, cursorGitHubEvent } from './github';
import type { CursorLive } from './live';
import { describeCursorTool, parseCursorEvent, statusBorder, type CursorEvent } from './rollout';
import { createCursorTerminalParser } from './terminal';
import { cursorToolUses } from './transcript';

/** Sem evento de hook por este tempo, a sessão é dada como encerrada (crash sem `sessionEnd`). */
export const STALE_PRESENCE_MS = 5 * 60_000;
/** Sala padrão quando o evento não diz o projeto (sem `workspace_roots` nem `cwd`). */
export const DEFAULT_ROOM = 'cursor';
const MAIN_ROLE = 'Agente principal (Cursor)';
const SUB_ROLE = 'Subagente (Cursor)';

/** Papel do subagente a partir do `subagent_type` (capitalizado; sem tipo, o padrão). */
function roleOf(raw: string | undefined): string {
  const r = raw?.trim();
  return r ? `${r[0].toUpperCase()}${r.slice(1)}` : SUB_ROLE;
}

/** Eventos do Cursor tratados pela fonte; qualquer outro faz `applyHookEvent` devolver false. */
const HOOK_EVENTS = new Set([
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'afterAgentResponse',
  'afterAgentThought',
  'subagentStart',
  'subagentStop',
  'stop',
  'sessionEnd',
]);

export interface CursorSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** HOME do usuário (a pasta do Cursor sai daqui, ou de `dir`). */
  home: string;
  /** Pasta do Cursor lida por este processo; padrão `<home>/.cursor`. */
  dir?: string;
  now?: () => number;
  pollMs?: number;
}

/** Estado interno de um agente Cursor (um por conversation_id ou subagent_id). */
interface CursorTracker {
  key: string;
  conversationId: string;
  account: string;
  /** 'main' pela conversa; 'sub' criado por `subagentStart`. */
  kind: 'main' | 'sub';
  /** Chave do agente pai (só em 'sub'): `<conta>:<parent_conversation_id>`. */
  parentId?: string;
  /** Sala (`workspace_roots[0]` ou `cwd`), quando o evento a diz. */
  cwd?: string;
  status: AgentStatus;
  /** Quando o status foi decidido: informação mais velha não o muda. */
  statusAt: number;
  waitingFor?: string;
  /** Último evento de hook (presença). */
  lastHookAt: number;
  startedAt: number;
  inOffice: boolean;
  /** O subagente já entregou (`done`). */
  subDone?: boolean;
  /** Arquivo do transcript da conversa (só gravado quando um evento traz caminho não vazio; nunca limpo). */
  transcriptPath?: string;
  /** Pump incremental do transcript (eventos do GitHub), um por conversa. */
  tail?: FileTail;
  /** Caminho do `tail` (troca = arquivo novo, refaz o `seekEnd`). */
  tailPath?: string;
  /** Tokens acumulados dos eventos de hook (refletidos no Office). */
  stats: AgentStats;
}

export class CursorSource implements AgentSource, CursorLive {
  readonly provider = 'cursor' as const;
  private entries: readonly AccountEntry[] = [];
  private readonly accountId = 'cursor';
  private readonly dir: string;
  private readonly trackers = new Map<string, CursorTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: CursorSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.dir = opts.dir ?? resolve(join(opts.home, '.cursor'));
    this.register();
  }

  /** Registra a conta única do Cursor (`id` 'cursor', short/color sem colidir com Claude/Codex). */
  private register(): void {
    const taken = this.opts.accounts.allEntries();
    const usedShorts = new Set(taken.map((e) => e.detected.short.toUpperCase()));
    const usedColors = new Set(taken.map((e) => e.detected.color));
    const short = ['C', 'U', 'R', 'S', 'O', 'Z'].find((l) => !usedShorts.has(l)) ?? 'C';
    const color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[0];
    const detected: DetectedAccount = { id: this.accountId, provider: 'cursor', configDir: this.dir, short, name: 'Cursor', color };
    this.entries = this.opts.accounts.setProviderAccounts('cursor', [{ dir: this.dir, detected }]);
  }

  /** A conta do Cursor (id final no AccountsService), para o wiring/log do servidor. */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.trackers.values()) if (t.inOffice) sessions++;
    return [{ label: this.accountId, provider: 'cursor', path: this.dir, sessions, ok: true }];
  }

  /** Arquivo do transcript da conversa, quando um evento de hook já trouxe um caminho. */
  transcriptPathOf(agentId: string): string | undefined {
    return this.trackers.get(agentId)?.transcriptPath;
  }

  /** Terminal do Cursor: um parser novo por leitura, sempre que o agente é conhecido. */
  terminalParser(agentId: string): TerminalParser | undefined {
    return this.trackers.has(agentId) ? createCursorTerminalParser() : undefined;
  }

  /** Relógio de presença: bombeia o transcript de cada agente e remove os trackers sem evento novo. */
  poll(): void {
    const now = this.now();
    for (const [key, t] of [...this.trackers]) {
      this.pumpGitHub(t, now);
      if (now - t.lastHookAt <= STALE_PRESENCE_MS) continue;
      this.leave(t);
      this.trackers.delete(key);
    }
  }

  /**
   * Pump incremental do transcript da conversa: no primeiro attach (ou troca de arquivo) posiciona no fim
   * (`seekEnd`, só o que for escrito depois vira evento) e, a cada `poll`, lê as linhas novas à procura de
   * `tool_use` `Shell` com `git`/`gh`, emitindo `office.githubEvent`. Transcript ausente/ilegível degrada (sem
   * lançar); truncado/rotacionado recomeça do fim sem reemitir o antigo. A presença/atividade por hook não muda.
   */
  private pumpGitHub(t: CursorTracker, at: number): void {
    const path = t.transcriptPath;
    if (!path || !t.inOffice) return;
    if (!t.tail || t.tailPath !== path) {
      t.tail = new FileTail(path);
      t.tailPath = path;
      t.tail.seekEnd();
    }
    let r: TailRead;
    try {
      r = t.tail.read();
    } catch {
      return; // arquivo ilegível: degrada (a presença por hook segue)
    }
    if (r.missing) return;
    if (r.reset) {
      // truncado/rotacionado: recomeça do fim, sem reemitir o antigo.
      t.tail.seekEnd();
      return;
    }
    for (const line of r.lines) {
      for (const use of cursorToolUses(line)) {
        const call = cursorGitHubCall(use.name, use.input);
        if (!call) continue;
        const ev = cursorGitHubEvent(call);
        if (!ev) continue;
        this.opts.office.githubEvent(t.key, ev, { key: githubEventKey(ev), at, live: true });
      }
    }
  }

  applyHookEvent(input: Record<string, unknown>): boolean {
    try {
      return this.hookEvent(input);
    } catch (err) {
      log.warnOnce(`cursor-hook:${String(err).slice(0, 80)}`, `Cursor: evento de hook ignorado (${String(err).slice(0, 120)}).`);
      return false;
    }
  }

  private hookEvent(input: Record<string, unknown>): boolean {
    const event = parseCursorEvent(input);
    if (!event || !HOOK_EVENTS.has(event.name)) return false;
    if (event.name === 'subagentStart' || event.name === 'subagentStop') return this.subagentEvent(event);
    const now = this.now();
    // Sem conversation_id (evento incompleto), a conta única usa a sala padrão como identidade: um só agente.
    const conversationId = event.conversationId ?? DEFAULT_ROOM;
    const key = `${this.accountId}:${conversationId}`;
    let t = this.trackers.get(key);

    if (event.name === 'sessionEnd') {
      if (!t) return false;
      this.leave(t);
      this.trackers.delete(key);
      // Os subagentes filhos saem junto (o closeMain já os encerra no Office).
      for (const [k, s] of [...this.trackers]) if (s.parentId === key) this.trackers.delete(k);
      return true;
    }

    if (t) {
      t.lastHookAt = now;
    } else {
      t = {
        key,
        conversationId,
        account: this.accountId,
        kind: 'main',
        status: 'idle',
        statusAt: 0,
        lastHookAt: now,
        startedAt: now,
        inOffice: false,
        stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      };
      this.trackers.set(key, t);
    }
    if (!t.cwd) t.cwd = event.workspaceRoot ?? event.cwd;
    // O caminho do transcript é estável por conversa: grava quando vem não vazio e nunca limpa (eventos
    // parciais como beforeReadFile trazem `null`, que não pode apagar um caminho bom).
    if (event.transcriptPath) t.transcriptPath = event.transcriptPath;
    // Tokens: soma o que o evento trouxer; nenhum campo ausente zera o acumulado.
    if (event.tokens) {
      t.stats.tokensIn += event.tokens.input + event.tokens.cacheRead + event.tokens.cacheWrite;
      t.stats.tokensOut += event.tokens.output;
    }
    this.reconcile(t);
    if (!t.inOffice) return true;

    // Reflete os tokens acumulados no Office (tarefas ficam vazias: o transcript não traz checklist).
    if (event.tokens) this.opts.office.applyTranscript(t.key, { tasks: [], stats: { ...t.stats } });

    const border = statusBorder(event.name);
    if (border) this.decide(t, border.status, now, border.waitingFor);
    const act = this.activityOf(t, event, now);
    if (act) this.opts.office.addActivity(t.key, act, true);
    return true;
  }

  /** Eventos de subagente (`subagentStart`/`subagentStop`): um par por `subagent_id`, ligado ao agente pai. */
  private subagentEvent(event: CursorEvent): boolean {
    const subagentId = event.subagentId;
    if (!subagentId) return false; // sem id não há par: degrada (não inventa parentesco)
    const key = `${this.accountId}:s:${subagentId}`;
    const now = this.now();

    if (event.name === 'subagentStop') {
      // Entrega o sub do par; um Stop sem Start visto antes é no-op. O Stop é quem traz a correlação
      // (`child_conversation_id`) e, às vezes, o `agent_transcript_path`: resolve o transcript do sub ANTES
      // de entregar. O tracker NÃO é apagado — o terminal do sub (agora `done`, na janela de graça do Office)
      // ainda precisa de `transcriptPathOf`. O relógio de presença o remove depois, como a qualquer agente.
      const t = this.trackers.get(key);
      if (t) {
        const path = this.subTranscriptPath(t, event.childConversationId, event.agentTranscriptPath);
        if (path) t.transcriptPath = path;
        this.leave(t);
      }
      return true;
    }

    // subagentStart: o pai é o `parent_conversation_id` (senão o `conversation_id`) já conhecido.
    const parentConversationId = event.parentConversationId ?? event.conversationId;
    if (!parentConversationId) return false;
    const parentId = `${this.accountId}:${parentConversationId}`;
    const parent = this.trackers.get(parentId);
    if (!parent) return false; // pai desconhecido: degrada
    this.reconcile(parent); // o addSub só cria com o pai no escritório

    let t = this.trackers.get(key);
    if (t) {
      t.lastHookAt = now;
    } else {
      t = {
        key,
        conversationId: subagentId,
        account: this.accountId,
        kind: 'sub',
        parentId,
        status: 'working',
        statusAt: now,
        lastHookAt: now,
        startedAt: now,
        inOffice: false,
        stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      };
      this.trackers.set(key, t);
    }
    this.opts.office.addSub({
      id: key,
      parentId,
      sessionId: subagentId,
      role: roleOf(event.subagentType),
      title: event.subagentTask,
      background: false,
      startedAt: t.startedAt,
    });
    t.inOffice = this.opts.office.has(key);
    return true;
  }

  /**
   * Transcript próprio do subagente. O `subagentStart` não traz o id da conversa do sub; só o `subagentStop`
   * traz `child_conversation_id` (e, quando a IDE manda, `agent_transcript_path`). Ordem de resolução:
   *   1. `agent_transcript_path`, quando presente (autoritativo);
   *   2. ao lado do transcript do pai: `<pai>/subagents/<child>.jsonl` (quando o pai já tem caminho conhecido);
   *   3. varredura do diretório do Cursor pelo `child` (o id é único): `<dir>/projects/<slug>/agent-transcripts/
   *      <conv>/subagents/<child>.jsonl`.
   * Sem nada disso, degrada (`undefined`): o terminal mostra vazio em vez de um caminho falso.
   */
  private subTranscriptPath(t: CursorTracker, childId?: string, hint?: string): string | undefined {
    if (hint) return hint;
    if (!childId) return undefined;
    const parent = t.parentId ? this.trackers.get(t.parentId) : undefined;
    if (parent?.transcriptPath) {
      const side = join(dirname(parent.transcriptPath), 'subagents', `${childId}.jsonl`);
      if (existsSync(side)) return side;
    }
    const projects = join(this.dir, 'projects');
    let slugs: string[];
    try {
      slugs = readdirSync(projects);
    } catch {
      return undefined; // sem a pasta do Cursor: degrada
    }
    for (const slug of slugs) {
      const transcripts = join(projects, slug, 'agent-transcripts');
      let conversations: string[];
      try {
        conversations = readdirSync(transcripts);
      } catch {
        continue;
      }
      for (const conversation of conversations) {
        const file = join(transcripts, conversation, 'subagents', `${childId}.jsonl`);
        if (existsSync(file)) return file;
      }
    }
    return undefined;
  }

  /** Traz o agente para o escritório (sala `workspace_roots[0]`/`cwd` ou a padrão) com o status atual. */
  private reconcile(t: CursorTracker): void {
    if (t.inOffice) return;
    const office = this.opts.office;
    office.addMain({
      id: t.key,
      provider: 'cursor',
      account: t.account,
      sessionId: t.conversationId,
      cwd: t.cwd ?? DEFAULT_ROOM,
      role: MAIN_ROLE,
      startedAt: t.startedAt,
      status: t.status,
      waitingFor: t.waitingFor,
    });
    t.inOffice = office.has(t.key);
    if (t.inOffice) office.setStatus(t.key, t.status, t.waitingFor);
  }

  /** Sai do escritório: o principal encerra (`closeMain`, em cascata); o subagente entrega (`completeSub`). */
  private leave(t: CursorTracker): void {
    if (!t.inOffice) return;
    if (t.kind === 'sub') {
      this.opts.office.completeSub(t.key);
      t.subDone = true;
    } else {
      this.opts.office.closeMain(t.key);
    }
    t.inOffice = false;
  }

  /** Borda de status: a informação mais nova vence (um evento atrasado não regride o estado). */
  private decide(t: CursorTracker, status: AgentStatus, at: number, waitingFor?: string): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (t.inOffice) this.opts.office.setStatus(t.key, status, t.waitingFor);
  }

  /** Activity traduzida do evento, quando ele traz uma ferramenta ou um comando. */
  private activityOf(t: CursorTracker, event: CursorEvent, now: number): Activity | undefined {
    const tool = event.toolName ?? (event.command ? 'Shell' : undefined);
    if (!tool) return undefined;
    const input = event.toolInput ?? (event.command ? { command: event.command } : {});
    const { desc, tool: norm } = describeCursorTool(tool, input);
    return { id: `${t.key}#${event.name}:${now.toString(36)}`, at: now, ...desc, tool: norm };
  }
}
