// Leitura única de transcript por path, com fan-out: um só `FileTail` por arquivo serve N assinantes
// (os terminais e a fonte do agente). Sem isso, cada conexão abria o próprio `FileTail` e relia o arquivo
// (ver http/terminal.ts e sources/cursor/source.ts). O hub posiciona no fim na criação e entrega a cada
// ciclo um `TailRead` compartilhado, respeitando um orçamento de leitura; a janela do `init` continua sendo
// leitura pontual por assinante (não é responsabilidade do hub). O `fs.watch` acelera o ciclo (ver T2);
// sem ele, o timer de polling cobre.
import { watch } from 'node:fs';
import { log } from '../log';
import { FileTail, type TailRead } from './tail';

/** Handle mínimo de observador (testes injetam uma fábrica). */
export interface WatcherHandle {
  close(): void;
}

/** `fs.watch` no arquivo; sem suporte/arquivo ausente devolve `null` e o polling cobre (SC-04). */
function defaultWatcher(path: string, onChange: () => void): WatcherHandle | null {
  try {
    const w = watch(path, { persistent: false }, () => onChange());
    w.on('error', () => w.close());
    return w;
  } catch {
    return null;
  }
}

export interface HubConsumer {
  /** Recebe as linhas novas (mesmo objeto para todos os assinantes), ou `reset`/`missing`. */
  onRead(read: TailRead): void;
}

export interface HubSubscription {
  unsubscribe(): void;
}

export interface TranscriptHubOptions {
  /** Intervalo do ciclo de leitura por path (padrão: HUB_POLL_MS). */
  intervalMs?: number;
  /** Leituras por ciclo antes de deixar o restante para o próximo (orçamento; padrão: HUB_READS_PER_CYCLE). */
  readsPerCycle?: number;
  /** Fábrica do tail (testes); padrão: um `FileTail` novo. */
  createTail?: (path: string) => FileTail;
  /** Timer automático (padrão: ligado). Desligado, o dono chama `tick()` (testes deterministas). */
  auto?: boolean;
  /** `fs.watch` como acelerador (padrão: ligado). Desligado/indisponível, só o polling cobre (SC-04). */
  useWatch?: boolean;
  /** Fábrica do observador (testes); padrão: `fs.watch` no arquivo. */
  watchFactory?: (path: string, onChange: () => void) => WatcherHandle | null;
  /** Atraso máximo do agrupamento de eventos do watch (padrão: HUB_WATCH_DEBOUNCE_MS). */
  watchDelayMs?: number;
  /** Relógio injetável (testes). */
  now?: () => number;
}

interface SharedPath {
  path: string;
  tail: FileTail;
  consumers: Set<HubConsumer>;
  timer: ReturnType<typeof setInterval> | null;
  watcher: WatcherHandle | null;
  /** Tick agendado por evento do watch (anti-trovão); some quando dispara. */
  kick: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  /** Momento do último ciclo (entrada do cálculo de agrupamento). */
  lastTickAt: number;
  /** Última leitura indicou arquivo ausente (para entregar a transição só uma vez). */
  wasMissing: boolean;
}

export const HUB_POLL_MS = 400;
/** Leituras de até o chunk do `FileTail` por ciclo: o resto fica para o próximo. */
export const HUB_READS_PER_CYCLE = 4;
/** Espera mínima de um evento do watch antes do ciclo (deixa o escritor terminar). */
export const HUB_WATCH_MIN_MS = 40;
/** Janela do agrupamento: eventos próximos viram um só ciclo (~imediato depois da última escrita). */
export const HUB_WATCH_DEBOUNCE_MS = 120;

export class TranscriptHub {
  private readonly paths = new Map<string, SharedPath>();
  private readonly defaultIntervalMs: number;
  private readonly readsPerCycle: number;
  private readonly createTail: (path: string) => FileTail;
  private readonly auto: boolean;
  private readonly useWatch: boolean;
  private readonly watchFactory: (path: string, onChange: () => void) => WatcherHandle | null;
  private readonly watchDelayMs: number;
  private readonly now: () => number;

  constructor(opts: TranscriptHubOptions = {}) {
    this.defaultIntervalMs = opts.intervalMs ?? HUB_POLL_MS;
    this.readsPerCycle = opts.readsPerCycle ?? HUB_READS_PER_CYCLE;
    this.createTail = opts.createTail ?? ((path) => new FileTail(path));
    this.auto = opts.auto ?? true;
    this.useWatch = opts.useWatch ?? true;
    this.watchFactory = opts.watchFactory ?? defaultWatcher;
    this.watchDelayMs = opts.watchDelayMs ?? HUB_WATCH_DEBOUNCE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Quantos paths têm assinantes agora (testes/diagnóstico). */
  get size(): number {
    return this.paths.size;
  }

  /**
   * Assina o transcript de `path`: cria (ou reaproveita) o leitor único e entrega o mesmo `TailRead` a
   * todos os assinantes. O primeiro assinante posiciona no fim do arquivo; sem arquivo, começa do começo.
   */
  subscribe(path: string, consumer: HubConsumer, opts: { intervalMs?: number } = {}): HubSubscription {
    const intervalMs = Math.max(1, opts.intervalMs ?? this.defaultIntervalMs);
    let shared = this.paths.get(path);
    if (!shared) {
      const tail = this.createTail(path);
      // SPEC_DEVIATION: o edge case de SC-01 pede `seekEnd` quando o arquivo *surge*; aqui o hub posiciona no
      // fim na criação e, se o arquivo ainda não existe, `FileTail.seekEnd` deixa offset 0 (lê o arquivo novo
      // inteiro). Reason: o contrato existente de http/terminal.test.ts entrega o conteúdo gravado num arquivo
      // recém-criado; forçar offset no fim ao surgir quebraria o terminal atual.
      tail.seekEnd();
      const created: SharedPath = { path, tail, consumers: new Set(), timer: null, watcher: null, kick: null, intervalMs, lastTickAt: this.now(), wasMissing: false };
      this.paths.set(path, created);
      if (this.auto) {
        created.timer = setInterval(() => this.tick(path), created.intervalMs);
        created.timer.unref?.();
        // Acelerador: o evento antecipa o próximo ciclo; sem watch, o timer acima cobre (SC-04).
        if (this.useWatch) created.watcher = this.watchFactory(path, () => this.schedule(created));
      }
      shared = created;
    } else if (intervalMs < shared.intervalMs) {
      // O menor intervalo manda: todos os assinantes do path passam a ler nesse ritmo.
      shared.intervalMs = intervalMs;
      if (shared.timer) {
        clearInterval(shared.timer);
        shared.timer = setInterval(() => this.tick(path), intervalMs);
        shared.timer.unref?.();
      }
    }
    shared.consumers.add(consumer);
    return { unsubscribe: () => this.remove(path, consumer) };
  }

  /** Um ciclo de leitura de todos os paths (o timer chama; testes podem chamar à mão). */
  tick(path?: string): void {
    if (path !== undefined) {
      const shared = this.paths.get(path);
      if (shared) this.readOnce(shared);
      return;
    }
    for (const shared of [...this.paths.values()]) this.readOnce(shared);
  }

  /**
   * Acelerador: um evento do watch antecipa o próximo ciclo, agrupando eventos próximos (anti-trovão,
   * como em watcher.ts). Um ciclo já agendado absorve os eventos seguintes.
   */
  private schedule(shared: SharedPath): void {
    if (!this.auto || shared.kick) return;
    const wait = Math.max(HUB_WATCH_MIN_MS, this.watchDelayMs - (this.now() - shared.lastTickAt));
    shared.kick = setTimeout(() => {
      shared.kick = null;
      this.tick(shared.path);
    }, wait);
    shared.kick.unref?.();
  }

  /** Libera todos os paths (fim do processo/teste). */
  close(): void {
    for (const shared of [...this.paths.values()]) this.release(shared);
  }

  /** Lê uma vez (respeitando o orçamento) e entrega o `TailRead` resultante a todos os assinantes. */
  private readOnce(shared: SharedPath): void {
    shared.lastTickAt = this.now();
    const lines: string[] = [];
    let reset = false;
    let missing = false;
    let more = false;
    for (let i = 0; i < this.readsPerCycle; i++) {
      let r: TailRead;
      try {
        r = shared.tail.read();
      } catch (err) {
        // Arquivo ilegível (permissão, I/O): degrada; tenta de novo no próximo ciclo.
        log.warnOnce(`transcript-hub:${shared.path}:${String(err).slice(0, 80)}`, `Transcript ${shared.path}: leitura falhou (${String(err).slice(0, 120)}).`);
        return;
      }
      if (r.lines.length) lines.push(...r.lines);
      reset = reset || r.reset;
      missing = r.missing;
      more = r.more;
      if (!r.more) break;
    }
    const changed = lines.length > 0 || reset || more || missing !== shared.wasMissing;
    shared.wasMissing = missing;
    if (!changed) return;
    const read: TailRead = { lines, reset, missing, more };
    for (const consumer of [...shared.consumers]) {
      try {
        consumer.onRead(read);
      } catch (err) {
        log.warnOnce(`transcript-hub-consumer:${String(err).slice(0, 80)}`, `Transcript ${shared.path}: assinante falhou (${String(err).slice(0, 120)}).`);
      }
    }
  }

  private remove(path: string, consumer: HubConsumer): void {
    const shared = this.paths.get(path);
    if (!shared) return;
    shared.consumers.delete(consumer);
    if (!shared.consumers.size) this.release(shared);
  }

  /** Sem assinantes, o path some: o leitor único (e o timer/observador) é fechado. */
  private release(shared: SharedPath): void {
    this.paths.delete(shared.path);
    if (shared.timer) clearInterval(shared.timer);
    shared.timer = null;
    if (shared.kick) clearTimeout(shared.kick);
    shared.kick = null;
    shared.watcher?.close();
    shared.watcher = null;
    shared.consumers.clear();
  }
}
