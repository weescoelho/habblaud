// TranscriptHub: um leitor por path com fan-out. Cobre os ACs de T1 — o mesmo TailRead para N assinantes
// (SC-05), uma leitura por ciclo com dois assinantes, ordem preservada numa rajada com orçamento (SC-03),
// `missing`/`reset` e a liberação do path quando o último assinante sai. Fixtures SINTÉTICAS.
import { truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLines, tempDir, writeLines } from '../test/fixtures';
import type { TailRead } from './tail';
import { FileTail } from './tail';
import { TranscriptHub } from './transcript-hub';

/** Tail que conta as leituras, para provar "uma leitura por ciclo" (SC-05). */
class CountingTail extends FileTail {
  reads = 0;
  override read(): TailRead {
    this.reads++;
    return super.read();
  }
}

/** Assinante que guarda cada leitura (por referência) que recebe. */
function collector(): { reads: TailRead[]; lines: string[]; onRead: (r: TailRead) => void } {
  const reads: TailRead[] = [];
  return {
    reads,
    lines: [],
    onRead(r: TailRead) {
      reads.push(r);
    },
  };
}

describe('TranscriptHub', () => {
  let tmp: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(() => {
    tmp = tempDir();
    file = join(tmp.dir, 't.jsonl');
  });
  afterEach(() => tmp.cleanup());

  it('fan-out: dois assinantes no mesmo path recebem as mesmas linhas novas', () => {
    writeLines(file, ['antiga']);
    const hub = new TranscriptHub({ auto: false });
    const a = collector();
    const b = collector();
    hub.subscribe(file, a);
    hub.subscribe(file, b);
    appendLines(file, ['nova-1', 'nova-2']);
    hub.tick();
    expect(a.reads.at(-1)?.lines).toEqual(['nova-1', 'nova-2']);
    expect(b.reads.at(-1)?.lines).toEqual(['nova-1', 'nova-2']);
    hub.close();
  });

  it('entrega o MESMO TailRead (a mesma referência) a todos os assinantes', () => {
    writeLines(file, ['x']);
    const hub = new TranscriptHub({ auto: false });
    const a = collector();
    const b = collector();
    hub.subscribe(file, a);
    hub.subscribe(file, b);
    appendLines(file, ['y']);
    hub.tick();
    expect(a.reads).toHaveLength(1);
    expect(b.reads[0]).toBe(a.reads[0]);
    hub.close();
  });

  it('um leitor por path: dois assinantes ⇒ uma leitura por ciclo (SC-05)', () => {
    writeLines(file, ['x']);
    const tails: CountingTail[] = [];
    const hub = new TranscriptHub({ auto: false, createTail: (p) => (tails.push(new CountingTail(p)), tails.at(-1)!) });
    const a = collector();
    const b = collector();
    hub.subscribe(file, a);
    hub.subscribe(file, b);
    expect(tails).toHaveLength(1); // um só FileTail para o path
    appendLines(file, ['y']);
    hub.tick();
    expect(tails[0].reads).toBe(1);
    expect(a.reads.at(-1)?.lines).toEqual(['y']);
    expect(b.reads.at(-1)?.lines).toEqual(['y']);
    hub.close();
  });

  it('rajada: entrega todas as linhas em ordem, sem perda (SC-03)', () => {
    writeLines(file, []);
    const hub = new TranscriptHub({ auto: false });
    const c = collector();
    hub.subscribe(file, c);
    const burst = Array.from({ length: 50 }, (_, i) => `linha-${String(i).padStart(2, '0')}`);
    appendLines(file, burst);
    hub.tick();
    const got = c.reads.flatMap((r) => r.lines);
    expect(got).toEqual(burst);
    hub.close();
  });

  it('orçamento: com 1 leitura por ciclo, o restante sai nos próximos ciclos, em ordem', () => {
    writeLines(file, []);
    const hub = new TranscriptHub({ auto: false, readsPerCycle: 1, createTail: (p) => new FileTail(p, { maxChunk: 12 }) });
    const c = collector();
    hub.subscribe(file, c);
    const burst = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'];
    appendLines(file, burst);
    for (let i = 0; i < 12 && c.reads.flatMap((r) => r.lines).length < burst.length; i++) hub.tick();
    expect(c.reads.flatMap((r) => r.lines)).toEqual(burst);
    hub.close();
  });

  it('path ausente: entrega `missing` sem lançar e retoma quando o arquivo surge', () => {
    const missing = join(tmp.dir, 'depois', 't.jsonl');
    const hub = new TranscriptHub({ auto: false });
    const c = collector();
    hub.subscribe(missing, c);
    hub.tick();
    expect(c.reads.at(-1)).toMatchObject({ missing: true, lines: [] });
    writeLines(missing, ['nova']);
    hub.tick();
    expect(c.reads.at(-1)?.lines).toEqual(['nova']);
    hub.close();
  });

  it('reset: arquivo truncado sinaliza `reset` com o novo conteúdo', () => {
    writeLines(file, ['um', 'dois']);
    const hub = new TranscriptHub({ auto: false });
    const c = collector();
    hub.subscribe(file, c);
    truncateSync(file, 0);
    writeFileSync(file, 'x\n');
    hub.tick();
    const last = c.reads.at(-1);
    expect(last?.reset).toBe(true);
    expect(last?.lines).toEqual(['x']);
    hub.close();
  });

  it('unsubscribe libera o path quando o último assinante sai', () => {
    writeLines(file, ['x']);
    const tails: CountingTail[] = [];
    const hub = new TranscriptHub({ auto: false, createTail: (p) => (tails.push(new CountingTail(p)), tails.at(-1)!) });
    const subA = hub.subscribe(file, collector());
    const subB = hub.subscribe(file, collector());
    expect(hub.size).toBe(1);
    subA.unsubscribe();
    expect(hub.size).toBe(1);
    subB.unsubscribe();
    expect(hub.size).toBe(0);
    // Um novo assinante cria outro leitor (o anterior foi liberado).
    hub.subscribe(file, collector());
    expect(tails).toHaveLength(2);
    hub.close();
    expect(hub.size).toBe(0);
  });

  it('watch: um evento antecipa o ciclo e os próximos são agrupados (anti-trovão)', () => {
    vi.useFakeTimers();
    try {
      writeLines(file, ['x']);
      const triggers: Array<() => void> = [];
      const hub = new TranscriptHub({
        intervalMs: 10_000,
        watchDelayMs: 100,
        watchFactory: (_path, cb) => {
          triggers.push(cb);
          return { close() {} };
        },
      });
      const c = collector();
      hub.subscribe(file, c);
      appendLines(file, ['nova']);
      expect(triggers).toHaveLength(1); // o observador foi armado no path
      triggers[0]();
      triggers[0]();
      triggers[0]();
      expect(c.reads).toHaveLength(0); // ainda dentro da janela de agrupamento
      vi.advanceTimersByTime(100);
      expect(c.reads).toHaveLength(1); // três eventos ⇒ um só ciclo
      expect(c.reads[0].lines).toEqual(['nova']);
      hub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sem watch (desligado ou indisponível) o polling entrega (SC-04)', async () => {
    writeLines(file, []);
    for (const opts of [{ useWatch: false }, { watchFactory: () => null }] as const) {
      const hub = new TranscriptHub({ intervalMs: 20, ...opts });
      const got = new Promise<string[]>((resolve) => {
        hub.subscribe(file, {
          onRead: (r) => {
            if (r.lines.length) resolve(r.lines);
          },
        });
      });
      appendLines(file, ['via-polling']);
      await expect(got).resolves.toEqual(['via-polling']);
      hub.close();
    }
  });

  it('watch ativo: linha gravada é entregue em ≤300 ms (p95) (SC-01)', async () => {
    writeLines(file, []);
    // Intervalo de polling alto: o que entregar dentro do limite só pode vir do watch.
    const hub = new TranscriptHub({ intervalMs: 2_000, watchDelayMs: 60 });
    let pending: ((at: number) => void) | null = null;
    hub.subscribe(file, {
      onRead: (r) => {
        if (!r.lines.length || !pending) return;
        const done = pending;
        pending = null;
        done(Date.now());
      },
    });
    const lat: number[] = [];
    for (let i = 0; i < 10; i++) {
      const delivered = new Promise<number>((resolve) => {
        pending = resolve;
      });
      const at = Date.now();
      appendLines(file, [`linha-${i}`]);
      lat.push((await delivered) - at);
    }
    hub.close();
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.ceil(0.95 * lat.length) - 1];
    expect(p95).toBeLessThanOrEqual(300);
  });
});
