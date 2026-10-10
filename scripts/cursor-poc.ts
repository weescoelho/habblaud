// Harness local das POCs do Cursor (P0–P3). Roda no HOST, com tsx:
//
//   npm run cursor:poc:transcript -- --path <arquivo>   # caracteriza o transcript (json/jsonl/sqlite/opaco)
//
// O transcript do Cursor ainda não tem schema confirmado (lacuna C1): este harness só OBSERVA. Tudo é
// feito pelo próprio Node (`node:fs`/`node:sqlite`), sem binário externo, e nunca lança para formato
// desconhecido — um arquivo "opaco" é reportado como tal.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectTranscript, type TranscriptInspection } from '../server/sources/cursor/transcript';

const USAGE = `Uso: npm run cursor:poc:<subcomando> -- [opções]

  transcript --path <arquivo>   caracteriza o transcript (json/jsonl/sqlite/opaco) e lista
                                as chaves/tabelas observadas com contagens

Opções:
  -h, --help                    mostra esta ajuda

O transcript do Cursor ainda não tem schema confirmado (lacuna C1): o inspetor reporta o que
observa e nunca lança para formato desconhecido.`;

/** Subcomandos do harness (cada um com as suas opções). */
export type RunOptions = { command: 'transcript'; path: string };

class FatalError extends Error {}

/** Lê os argumentos do harness. Sem subcomando (ou `--help`) devolve `'help'` (uso, saída 0). */
export function parseArgs(argv: string[]): RunOptions | 'help' {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) return 'help';
  const [command, ...rest] = argv;
  if (command === 'transcript') {
    let path: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--path') {
        path = rest[++i];
        if (!path) throw new FatalError('--path precisa de um arquivo.');
      } else {
        throw new FatalError(`opção desconhecida: ${a}`);
      }
    }
    if (!path) throw new FatalError('transcript precisa de --path <arquivo>.');
    return { command: 'transcript', path };
  }
  throw new FatalError(`subcomando desconhecido: ${command}\n\n${USAGE}`);
}

/** Linhas do relatório de um transcript (classificação + chaves/tabelas observadas). */
export function formatInspection(info: TranscriptInspection): string[] {
  const lines = [`Formato: ${info.format}`];
  if (info.format === 'opaco') {
    if (info.note) lines.push(`Nota: ${info.note}`);
    return lines;
  }
  if (info.format === 'jsonl') {
    lines.push(`Linhas: ${info.lines ?? 0}`);
    lines.push(`Papéis: ${info.roles.length ? info.roles.join(', ') : '(nenhum)'}`);
    lines.push(`Tool-calls: ${info.hasToolCalls ? 'sim' : 'não'}`);
  } else if (info.format === 'json') {
    lines.push(`Tool-calls: ${info.hasToolCalls ? 'sim' : 'não'}`);
  }
  if (info.tables.length) {
    lines.push('Tabelas:');
    for (const t of info.tables) lines.push(`  ${t.name}  ${t.count}`);
  }
  if (info.keys.length) {
    lines.push('Chaves:');
    for (const k of info.keys) lines.push(`  ${k.key}  ${k.count}`);
  }
  return lines;
}

export interface RunContext {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Executa o subcomando. Devolve o código de saída (0 = sucesso). */
export function run(opts: RunOptions, ctx: RunContext): number {
  if (!existsSync(opts.path)) {
    ctx.err(`Arquivo não encontrado: ${opts.path}`);
    return 1;
  }
  // `inspectTranscript` nunca lança para formato desconhecido; erros de leitura do arquivo (permissão,
  // corrida) ainda podem subir — o chamador os transforma em saída ≠ 0.
  const info = inspectTranscript(opts.path);
  for (const line of formatInspection(info)) ctx.out(line);
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  process.exitCode = run(parsed, { out: (l) => console.log(l), err: (l) => console.error(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[cursor-poc] Erro: ${err.message}` : `[cursor-poc] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
