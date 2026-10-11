#!/usr/bin/env node
// Probe de followup do harness P6 do Cursor. NÃO fala com o servidor: só responde ao evento `stop` com
// a forma que o Cursor espera para injetar uma mensagem — `{"followup_message": <texto>}` no stdout. É
// um EXPERIMENTO descartável: prova (localmente) a FORMA do contrato; a injeção real só o runbook
// confirma. Diferente do `poc-hook.mjs`, este hook PRODUZ efeito (injeta texto), então o harness NÃO o
// instala por padrão — o runbook instala à mão.
//
// 1. lê do stdin o JSON do evento;
// 2. se `hook_event_name === 'stop'`, imprime `{"followup_message": <texto>}` e sai com 0, onde o texto
//    vem de HABBLAUD_CURSOR_POC_FOLLOWUP (não-vazio) ou de um padrão;
// 3. para qualquer outro evento, stdin inválido/não-JSON ou erro, sai com 0 SEM imprimir nada.
//
// Regras: node puro (22+), só `node:*`, sem dependências; NUNCA lança e SEMPRE sai com 0 — um hook que
// quebra atrapalha a sessão da IDE.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Texto injetado quando HABBLAUD_CURSOR_POC_FOLLOWUP não está definido (nunca vazio). */
export const DEFAULT_FOLLOWUP = 'Continue a tarefa seguindo as instruções anteriores.';

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

/** Texto a injetar: HABBLAUD_CURSOR_POC_FOLLOWUP (não-vazio) ou o padrão. */
export function followupOf(env = process.env) {
  const custom = typeof env.HABBLAUD_CURSOR_POC_FOLLOWUP === 'string' ? env.HABBLAUD_CURSOR_POC_FOLLOWUP : '';
  return custom.trim() ? custom : DEFAULT_FOLLOWUP;
}

/**
 * Saída do hook para um evento cru: a linha JSON `{"followup_message": <texto>}` quando for um `stop`
 * válido, ou `undefined` para qualquer outro caso (outro evento, não-JSON, primitivo/array). Nunca lança.
 */
export function followupOutput(env, raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(input)) return undefined;
  if (input.hook_event_name !== 'stop') return undefined;
  return JSON.stringify({ followup_message: followupOf(env) });
}

export async function main(env = process.env) {
  try {
    const raw = await readStdin();
    if (!raw) return;
    const out = followupOutput(env, raw);
    if (out) process.stdout.write(`${out}\n`);
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
