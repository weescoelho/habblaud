// Leitura única de transcript por path, com fan-out: um só `FileTail` por arquivo serve N assinantes
// (os terminais e a fonte do agente). Sem isso, cada conexão abria o próprio `FileTail` e relia o arquivo
// (ver http/terminal.ts e sources/cursor/source.ts). O hub posiciona no fim na criação e entrega a cada
// ciclo um `TailRead` compartilhado, respeitando um orçamento de leitura; a janela do `init` continua sendo
// leitura pontual por assinante (não é responsabilidade do hub). O `fs.watch` acelera o ciclo (ver T2);
// sem ele, o timer de polling cobre.
import { log } from '../log';
import { FileTail, type TailRead } from './tail';

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
}

interface SharedPath {
  path: string;
  tail: FileTail;
  consumers: Set<HubConsumer>;
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number;
  /** Última leitura indicou arquivo ausente (para entregar a transição só uma vez). */
  wasMissing: boolean;
}

export const HUB_POLL_MS = 400;
/** Leituras de até o chunk do `FileTail` por ciclo: o resto fica para o próximo. */
export const HUB_READS_PER_CYCLE = 4;

export class TranscriptHub {
  private readonly paths = new Map<string, SharedPath>();
  private readonly defaultIntervalMs: number;
  private readonly readsPerCycle: number;
  private readonly createTail: (path: string) => FileTail;
  private readonly auto: boolean;

  constructor(opts: TranscriptHubOptions = {}) {
    this.defaultIntervalMs = opts.intervalMs ?? HUB_POLL_MS;
    this.readsPerCycle = opts.readsPerCycle ?? HUB_READS_PER_CYCLE;
    this.createTail = opts.createTail ?? ((path) => new FileTail(path));
    this.auto = opts.auto ?? true;
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
      shared = { path, tail, consumers: new Set(), timer: null, intervalMs, wasMissing: false };
      this.paths.set(path, shared);
      if (this.auto) {
        shared.timer = setInterval(() => this.tick(path), shared.intervalMs);
        shared.timer.unref?.();
      }
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

  /** Libera todos os paths (fim do processo/teste). */
  close(): void {
    for (const shared of [...this.paths.values()]) this.release(shared);
  }

  /** Lê uma vez (respeitando o orçamento) e entrega o `TailRead` resultante a todos os assinantes. */
  private readOnce(shared: SharedPath): void {
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
    shared.consumers.clear();
  }
}
