#!/usr/bin/env node
// Hook "log tudo" do harness P1 do Cursor. NÃO fala com o servidor: só ANOTA o que a IDE manda, para
// depois medir a cobertura de eventos (`cursor:poc:report`). `npm run cursor:poc:install` instala este
// hook em ~/.cursor/hooks.json. A cada evento ele:
//
// 1. lê do stdin o JSON do evento;
// 2. anexa uma linha `{ts, dir, event}` em <captura>/events.jsonl (o `event` é o stdin inteiro);
// 3. se o evento traz `transcript_path`, anexa o caminho em <captura>/transcripts.txt e grava o dump
//    do stdin em <captura>/stdin/ (para caracterizar o transcript depois).
//
// Diretório de captura: HABBLAUD_CURSOR_POC_DIR ou ~/.habblaud/cursor-poc/.
// Regras: node puro (22+), só `node:*`, sem dependências; NUNCA lança e SEMPRE sai com 0 — um hook que
// quebra atrapalha a sessão da IDE. stdin inválido/não-JSON não escreve nada.
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Lê todo o stdin (undefined = sem entrada dentro do prazo, grande demais ou erro). */
function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Diretório de captura: HABBLAUD_CURSOR_POC_DIR (com `~` expandido) ou ~/.habblaud/cursor-poc/. */
export function captureDirOf(env = process.env) {
  const home = env.HOME || homedir();
  const custom = typeof env.HABBLAUD_CURSOR_POC_DIR === 'string' ? env.HABBLAUD_CURSOR_POC_DIR.trim() : '';
  if (custom) return resolve(custom.replace(/^~(?=[\\/]|$)/, home));
  return join(home, '.habblaud', 'cursor-poc');
}

/** Nome do dump do stdin, único por instante (mais um sufixo se colidir). */
function dumpName(dir, now) {
  const base = now.toISOString().replace(/[:.]/g, '-');
  let name = `${base}.json`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}.json`;
  return name;
}

/**
 * Anota um evento no diretório de captura. `raw` precisa ser um JSON de objeto; qualquer outra coisa
 * (não-JSON, array, primitivo) não escreve nada. Nunca lança.
 */
export function capture(env, raw, now = new Date()) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isObject(input)) return;
  const dir = captureDirOf(env);
  mkdirSync(dir, { recursive: true });
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : typeof roots[0] === 'string' ? roots[0] : process.cwd();
  appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ ts: now.toISOString(), dir: cwd, event: input })}\n`);
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path.trim() : '';
  if (transcript) {
    appendFileSync(join(dir, 'transcripts.txt'), `${now.toISOString()}\t${transcript}\n`);
    const dumpDir = join(dir, 'stdin');
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, dumpName(dumpDir, now)), raw);
  }
}

export async function main(env = process.env) {
  try {
    const raw = await readStdin();
    if (!raw) return;
    capture(env, raw);
  } catch {
    // Nunca quebra a sessão da IDE: qualquer erro vira saída silenciosa com 0.
  }
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().then(() => process.exit(0), () => process.exit(0));
