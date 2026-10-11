// Instala (ou remove) os hooks REAIS do Habblaud no Cursor (mod/habblaud-cursor/hook.mjs) e mostra o estado:
//
//   npm run cursor:install        # acrescenta o hook em ~/.cursor/hooks.json (backup antes)
//   npm run cursor:install -- --project <dir>   # em <dir>/.cursor/hooks.json (dir padrão = atual)
//   npm run cursor:uninstall      # remove só o hook do Habblaud (os outros hooks ficam)
//   npm run cursor:status         # informa se o hook está instalado em cada evento
//   (qualquer comando aceita --dry-run: mostra o que mudaria, sem gravar nada)
//
// O hook (mod/habblaud-cursor/hook.mjs) observa os eventos da IDE no escritório e, nos eventos de decisão
// (por padrão beforeShellExecution e beforeMCPExecution; a política local pode reativar outros com
// "decisionEvents"), segura a sessão esperando a decisão do escritório (padrão 25 s; sem decisão, a IDE segue
// normal). A porta e a espera ficam em ~/.habblaud/cursor-hook.json ({port, decisionTimeoutS}), que o hook lê se
// existir (HABBLAUD_PORT vale como reserva; padrões: 4747 e 25 s) — nada de opções no comando do hook. As regras
// locais ("sempre permitir") também moram nesse arquivo ("rules"); `npm run cursor:status` mostra os eventos, o nº
// de regras e o nº de decisões locais.
//
// Destino: o formato PLANO do Cursor, {"version":1,"hooks":{<evento>:[entradas]}}, em ~/.cursor/hooks.json (ou
// <projeto>/.cursor/hooks.json com --project). Cada entrada é {command, ...} (flat, sem grupos); o instalador só muda
// as listas dos eventos do Habblaud (EVENTS): entra, no FIM de cada uma, a entrada com o hook; na atualização (outro
// caminho do repositório) a entrada do Habblaud é trocada NO MESMO lugar. O resto do arquivo fica como está. Antes de
// gravar, uma cópia vai para hooks.json.habblaud-backup-<data>.
//
// Regras: idempotente (rodar de novo não duplica nem cria backup novo); hooks.json ausente é criado; arquivo quebrado
// não é destruído (erro e saída ≠ 0). Node puro, sem dependências.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quotePath, readSettings, tildify, writeSettings, type Settings } from './statusline-install';
import { countLocalDecisions, DEFAULT_DECISION_EVENTS, readCursorConfig } from '../server/permissions/cursor-rules';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** O hook real do Cursor (o mesmo que o harness P1 usa é o poc-hook, de observação; aqui é o de decisão/observação). */
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-cursor', 'hook.mjs');
/** O hook do Habblaud é reconhecido pelo caminho do script no comando (em qualquer pasta do repositório). */
const HOOK_MARK = /habblaud-cursor[\\/]+hook\.mjs/;
/** Eventos do Cursor em que o hook entra (o mesmo conjunto que ele observa). */
export const EVENTS = [
  'sessionStart',
  'sessionEnd',
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
  'stop',
] as const;

const USAGE = `Uso: npm run cursor:<install|uninstall|status> [-- opções]

  install [--project [dir]]   acrescenta o hook do Habblaud em ~/.cursor/hooks.json (backup antes;
                              com --project, em <dir>/.cursor/hooks.json; dir padrão = diretório atual)
  uninstall [--project [dir]] remove só o hook do Habblaud (os outros hooks ficam)
  status  [--project [dir]]   informa se o hook está instalado em cada evento

Opções:
  --dry-run        mostra o que mudaria, sem gravar nada
  -h, --help       mostra esta ajuda

O hook decide pelos eventos de decisão (por padrão beforeShellExecution/beforeMCPExecution; o
~/.habblaud/cursor-hook.json pode reativar outros com "decisionEvents") quando há página aberta;
sem decisão (tempo esgotado ou Habblaud parado), a IDE segue normal.
Porta e espera: ~/.habblaud/cursor-hook.json ({port, decisionTimeoutS}); padrões: 4747 e 25 s.
As regras locais ("sempre permitir") também ficam nesse arquivo ("rules"); o comando cursor:status
mostra os eventos, o nº de regras e o nº de decisões locais.
Para desfazer: npm run cursor:uninstall`;

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/cursor-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** `node "<hook>"`: o comando entra no hooks.json como o Cursor o roda. */
export function hookCommand(hookPath: string): string {
  return `node ${quotePath(hookPath)}`;
}

/** Uma entrada é do Habblaud? (o comando aponta para o hook.mjs). */
function isOurEntry(entry: unknown): entry is { command: string } {
  return isObject(entry) && typeof entry.command === 'string' && HOOK_MARK.test(entry.command);
}

/** JSON com as chaves em ordem (para comparar entradas sem depender da ordem em que foram gravadas). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const r = isObject(v) ? v : undefined;
  if (!r) return JSON.stringify(v) ?? 'null';
  return `{${Object.keys(r)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
    .join(',')}}`;
}

/** Caminho do script num comando instalado (entre aspas duplas ou simples, ou sem aspas). */
export function scriptPathOf(command: string): string | undefined {
  const m = /("[^"]*habblaud-cursor[\\/]+hook\.mjs"|'(?:[^']|'\\'')*habblaud-cursor[\\/]+hook\.mjs'|\S*habblaud-cursor[\\/]+hook\.mjs)/.exec(command);
  if (!m) return undefined;
  const q = m[1];
  if (q.startsWith('"')) return q.slice(1, -1);
  if (q.startsWith("'")) return q.slice(1, -1).replace(/'\\''/g, "'");
  return q;
}

export type PlanAction =
  | { action: 'install'; settings: Settings; message: string }
  | { action: 'uninstall'; settings: Settings; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

/** `hooks` num formato que dá para editar (ou o motivo para não mexer). */
function hooksOf(settings: Settings): Rec | string {
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return '"hooks" em formato desconhecido; nada foi alterado';
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) return `"hooks.${event}" em formato desconhecido; nada foi alterado`;
  }
  return hooks;
}

/**
 * Plano de instalação no formato PLANO do Cursor: acrescenta a entrada do hook no FIM de cada evento, preservando as
 * entradas alheias na posição delas. Já instalado (entradas iguais, sem duplicatas): nada muda. Atualização (caminho
 * do repositório mudou): a entrada é trocada NO MESMO lugar.
 */
export function planInstall(settings: Settings, command: string, events: readonly string[]): PlanAction {
  const parsed = hooksOf(settings);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = { ...parsed };
  const added: string[] = [];
  const updated: string[] = [];
  const deduped: string[] = [];
  for (const event of events) {
    const cur = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : undefined;
    const list = cur ? [...cur] : [];
    const ours = list.map((e, i) => [i, e] as const).filter(([, e]) => isOurEntry(e));
    let changed = false;
    if (!ours.length) {
      list.push({ command });
      added.push(event);
      changed = true;
    } else {
      const [idx] = ours[0];
      if (canonical(list[idx]) !== canonical({ command })) {
        list[idx] = { command };
        changed = true;
        updated.push(event);
      }
      // Cópias repetidas (editadas à mão): o hook rodaria uma vez para cada entrada.
      if (ours.length > 1) {
        for (const [i] of ours.slice(1).reverse()) list.splice(i, 1);
        if (!changed) deduped.push(event);
        changed = true;
      } else if (!changed) {
        continue; // nada a escrever neste evento
      }
    }
    hooks[event] = list;
  }
  if (!added.length && !updated.length && !deduped.length) return { action: 'none', message: 'já instalado' };
  const parts = [
    added.length ? (updated.length ? `instalado em ${added.join(', ')}` : `instalado (${added.length} eventos)`) : '',
    updated.length ? `atualizado em ${updated.join(', ')}` : '',
    deduped.length ? `duplicatas do Habblaud removidas em ${deduped.join(', ')}` : '',
  ].filter(Boolean);
  const out: Settings = { ...settings, hooks };
  if (out.version === undefined) out.version = 1;
  return { action: 'install', settings: out, message: parts.join('; ') };
}

/**
 * Plano de remoção: tira SÓ as entradas do Habblaud; as alheias ficam na posição delas (a lista de um evento que
 * esvaziar sai). Sem entradas nossas: nada a fazer.
 */
export function planUninstall(settings: Settings): PlanAction {
  const parsed = hooksOf(settings);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = {};
  let removed = 0;
  for (const [event, raw] of Object.entries(parsed)) {
    const list = raw as unknown[];
    const kept = list.filter((e) => !isOurEntry(e));
    removed += list.length - kept.length;
    if (kept.length) hooks[event] = kept;
  }
  if (!removed) return { action: 'none', message: 'não estava instalado' };
  return { action: 'uninstall', settings: { ...settings, hooks }, message: `hooks do Habblaud removidos (${removed} eventos)` };
}

export interface InstallState {
  /** Eventos com a entrada do Habblaud igual à esperada (e sem duplicatas). */
  ok: string[];
  /** Eventos com a entrada diferente do esperado (outro caminho) ou duplicada. */
  outdated: string[];
  missing: string[];
  /** Caminhos do script nas entradas instaladas. */
  paths: string[];
}

/** O que está instalado num hooks.json (para o status). */
export function installState(settings: Settings, command: string, events: readonly string[]): InstallState {
  const parsed = hooksOf(settings);
  const hooks = typeof parsed === 'string' ? {} : parsed;
  const state: InstallState = { ok: [], outdated: [], missing: [], paths: [] };
  for (const event of events) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = list.filter(isOurEntry);
    if (!ours.length) {
      state.missing.push(event);
      continue;
    }
    const first = ours[0];
    const path = scriptPathOf(first.command);
    if (path && !state.paths.includes(path)) state.paths.push(path);
    (canonical(first) === canonical({ command }) && ours.length === 1 ? state.ok : state.outdated).push(event);
  }
  return state;
}

// ---------------------------------------------------------------------------------------------
// Efeitos (arquivos)
// ---------------------------------------------------------------------------------------------

export type RunOptions =
  | { command: 'install' | 'uninstall'; dryRun: boolean; project: string | boolean }
  | { command: 'status'; project: string | boolean };

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  now: Date;
  hookPath: string;
  out: (line: string) => void;
}

class FatalError extends Error {}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) return 'help';
  const [command, ...rest] = argv;
  if (command !== 'install' && command !== 'uninstall' && command !== 'status') throw new FatalError(`subcomando desconhecido: ${command}\n\n${USAGE}`);
  let project: string | boolean = false;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--project') {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        project = resolve(next);
        i++;
      } else {
        project = true;
      }
    } else {
      throw new FatalError(`opção desconhecida: ${a}\n\n${USAGE}`);
    }
  }
  return { command, dryRun, project } as RunOptions;
}

/** hooks.json do destino: ~/.cursor, ou <projeto>/.cursor com --project (dir padrão = atual). */
export function hooksFileOf(ctx: RunContext, project: string | boolean): string {
  if (project === false) return join(ctx.home, '.cursor', 'hooks.json');
  const dir = typeof project === 'string' ? project : ctx.cwd;
  return join(dir, '.cursor', 'hooks.json');
}

/** Aplica o plano: 'none' e simulação não gravam; grava com backup e devolve o código de saída. */
function applyPlan(ctx: RunContext, file: string, read: { settings: Settings; raw?: string }, plan: PlanAction, dryRun: boolean): number {
  const label = tildify(file, ctx.home);
  if (plan.action === 'none') {
    ctx.out(`= ${label}: ${plan.message}`);
    return 0;
  }
  if (plan.action === 'skip') {
    ctx.out(`✗ ${label}: ${plan.message}`);
    return 1;
  }
  if (dryRun) {
    ctx.out(`~ ${label}: ${plan.message} (simulação: nada gravado)`);
    ctx.out(`    hooks.json → ${JSON.stringify(plan.settings.hooks ?? null)}`);
    return 0;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const backup = writeSettings(file, plan.settings, read.raw, ctx.now);
    ctx.out(`✓ ${label}: ${plan.message}${backup ? ` · backup em ${tildify(backup, ctx.home)}` : ''}`);
    return 0;
  } catch (err) {
    ctx.out(`✗ ${label}: não consegui gravar (${(err as Error).message})`);
    return 1;
  }
}

/** Executa o comando sobre o destino. Devolve o código de saída (0 = sucesso). */
export function run(opts: RunOptions, ctx: RunContext): number {
  const file = hooksFileOf(ctx, opts.project);
  const label = tildify(file, ctx.home);
  const read = readSettings(file);
  if ('error' in read) {
    ctx.out(`✗ ${label}: ${read.error}`);
    return 1;
  }
  const command = hookCommand(ctx.hookPath);
  if (opts.command === 'status') {
    const st = installState(read.settings, command, EVENTS);
    if (!st.ok.length && !st.outdated.length) {
      ctx.out(`• ${label}: não instalado`);
    } else {
      for (const p of st.paths) {
        if (resolve(p) === resolve(ctx.hookPath)) continue;
        ctx.out(`! ${label}: os hooks apontam para ${p}; rode npm run cursor:install para atualizar`);
      }
      if (st.outdated.length) ctx.out(`! ${label}: diferente do esperado em ${st.outdated.join(', ')}; rode npm run cursor:install para atualizar`);
      if (st.missing.length) ctx.out(`! ${label}: faltando em ${st.missing.join(', ')}; rode npm run cursor:install`);
      ctx.out(`• ${label}: instalado em ${st.ok.length + st.outdated.length} de ${EVENTS.length} eventos`);
    }
    const cfg = readCursorConfig(ctx.home);
    const events = cfg.decisionEvents ?? DEFAULT_DECISION_EVENTS;
    ctx.out(
      `Configuração do hook: ${tildify(join(ctx.home, '.habblaud', 'cursor-hook.json'), ctx.home)} → eventos de decisão: ${events.join(', ')}${cfg.decisionEvents ? '' : ' (padrão)'}; regras locais: ${cfg.rules.length}; decisões locais: ${countLocalDecisions(ctx.home)}; porta 4747 e espera 25 s por padrão.`,
    );
    return 0;
  }
  const plan = opts.command === 'install' ? planInstall(read.settings, command, EVENTS) : planUninstall(read.settings);
  return applyPlan(ctx, file, read, plan, opts.dryRun);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  process.exitCode = run(parsed, {
    env: process.env,
    home: process.env.HOME || homedir(),
    cwd: process.cwd(),
    now: new Date(),
    hookPath: HOOK_SCRIPT,
    out: (l) => console.log(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[cursor-install] Erro: ${err.message}` : `[cursor-install] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}