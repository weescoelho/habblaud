// Instalador dos hooks reais do Cursor (scripts/cursor-install.ts): planos puros e o comando de verdade sobre
// hooks.json em HOME FALSO (nunca toca no ~ real). O hook de decisão/observação (hook.mjs, T14) entra num
// hooks.json PLANO {"version":1,"hooks":{<evento>:[entradas]}} — no FIM de cada evento, preservando hooks alheios;
// atualização troca a entrada NO MESMO lugar; idempotente; hooks.json ausente nasce; arquivo quebrado não morre.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EVENTS,
  HOOK_SCRIPT,
  hookCommand,
  hooksFileOf,
  installState,
  parseArgs,
  planInstall,
  planUninstall,
  scriptPathOf,
  type RunContext,
} from '../../scripts/cursor-install';
import { tempDir } from './fixtures';

const SCRIPT = resolve(__dirname, '../../scripts/cursor-install.ts');
const ROOT = resolve(__dirname, '../..');
const CMD = hookCommand(HOOK_SCRIPT);
const NEW = hookCommand(join('/novo/lugar/habblaud-cursor', 'hook.mjs'));

type Settings = Record<string, unknown>;
type Hooks = Record<string, Array<{ command: string }>>;

const asHooks = (s: Settings): Hooks => (s.hooks as Hooks) ?? {};

describe('cursor-install.ts (funções puras)', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  it('comando e alvos: `node "<hook>"`, decisões inclusas, HOOK_SCRIPT é o hook.mjs real', () => {
    expect(CMD).toBe(`node "${HOOK_SCRIPT}"`);
    expect(scriptPathOf(CMD)).toBe(HOOK_SCRIPT);
    expect(scriptPathOf('node "C:\\x\\habblaud-cursor\\hook.mjs"')).toBe('C:\\x\\habblaud-cursor\\hook.mjs');
    expect(scriptPathOf("node '/a/it'\\''s/habblaud-cursor/hook.mjs'")).toBe("/a/it's/habblaud-cursor/hook.mjs");
    for (const decision of ['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'preToolUse']) {
      expect(EVENTS, decision).toContain(decision);
    }
    expect(EVENTS).toContain('sessionStart');
    expect(EVENTS).toContain('sessionEnd');
    expect(EVENTS).toContain('stop');
    expect(HOOK_SCRIPT).toMatch(/habblaud-cursor[\\/]+hook\.mjs$/);
  });

  it('install em hooks.json inexistente: todos os eventos, a entrada do Habblaud no fim, version 1', () => {
    const p = planInstall({}, CMD, EVENTS);
    expect(p.action).toBe('install');
    if (p.action !== 'install') return;
    expect(p.message).toContain(`${EVENTS.length} eventos`);
    expect(Object.keys(asHooks(p.settings)).sort()).toEqual([...EVENTS].sort());
    for (const event of EVENTS) expect(asHooks(p.settings)[event], event).toEqual([{ command: CMD }]);
    expect(p.settings.version).toBe(1);
  });

  it('merge: entradas alheias ficam, a nossa entra no FIM; atualizar troca NO MESMO lugar; idempotente', () => {
    const withForeign: Settings = {
      version: 1,
      hooks: { beforeReadFile: [{ command: 'outro-hook' }], stop: [{ command: 'outro-stop' }] },
    };
    const p = planInstall(withForeign, CMD, EVENTS);
    expect(p.action).toBe('install');
    if (p.action !== 'install') return;
    const hooks = asHooks(p.settings);
    expect(hooks.beforeReadFile).toEqual([{ command: 'outro-hook' }, { command: CMD }]);
    expect(hooks.stop).toEqual([{ command: 'outro-stop' }, { command: CMD }]);
    expect(hooks.sessionStart).toEqual([{ command: CMD }]);
    expect(p.settings.version).toBe(1);
    expect(planInstall(p.settings, CMD, EVENTS)).toEqual({ action: 'none', message: 'já instalado' });

    // Outro app (ou o usuário) acrescenta uma entrada DEPOIS da nossa: a atualização não move a nossa.
    const later = JSON.parse(JSON.stringify(p.settings)) as Settings;
    asHooks(later).beforeReadFile.push({ command: 'depois' });
    const upd = planInstall(later, NEW, EVENTS);
    expect(upd.action).toBe('install');
    if (upd.action !== 'install') return;
    expect(upd.message).toContain('atualizado');
    expect(asHooks(upd.settings).beforeReadFile).toEqual([{ command: 'outro-hook' }, { command: NEW }, { command: 'depois' }]);
    expect(planInstall(upd.settings, NEW, EVENTS)).toEqual({ action: 'none', message: 'já instalado' });
  });

  it('cópias repetidas do Habblaud voltam a uma só — mesmo quando é a única mudança (e depois é idempotente)', () => {
    const p = planInstall({}, CMD, EVENTS);
    if (p.action !== 'install') throw new Error('esperado install');
    const dup = JSON.parse(JSON.stringify(p.settings)) as Settings;
    asHooks(dup).beforeReadFile = [{ command: CMD }, { command: CMD }];
    asHooks(dup).stop = [{ command: CMD }, { command: CMD }, { command: CMD }];
    const r = planInstall(dup, CMD, EVENTS);
    expect(r.action).toBe('install'); // não pode voltar "none": há o que limpar
    if (r.action !== 'install') return;
    expect(r.message).toMatch(/duplicat/);
    expect(asHooks(r.settings).beforeReadFile).toEqual([{ command: CMD }]);
    expect(asHooks(r.settings).stop).toEqual([{ command: CMD }]);
    expect(planInstall(r.settings, CMD, EVENTS)).toEqual({ action: 'none', message: 'já instalado' });
  });

  it('formatos desconhecidos: nada é tocado (skip)', () => {
    expect(planInstall({ hooks: 'x' }, CMD, EVENTS).action).toBe('skip');
    expect(planInstall({ hooks: [] }, CMD, EVENTS).action).toBe('skip');
    expect(planInstall({ hooks: { stop: {} } }, CMD, EVENTS).action).toBe('skip');
    expect(planUninstall({ hooks: 'x' }).action).toBe('skip');
  });

  it('uninstall: só as entradas do Habblaud saem; alheios na posição; evento esvaziado some', () => {
    const installed: Settings = {
      version: 1,
      hooks: { beforeReadFile: [{ command: 'outro-hook' }, { command: CMD }], stop: [{ command: 'outro-stop' }, { command: CMD }] },
    };
    const u = planUninstall(installed);
    expect(u.action).toBe('uninstall');
    if (u.action !== 'uninstall') return;
    expect(asHooks(u.settings).beforeReadFile).toEqual([{ command: 'outro-hook' }]);
    expect(asHooks(u.settings).stop).toEqual([{ command: 'outro-stop' }]);
    // Só tinha o Habblaud → hooks volta a {}.
    const only = planInstall({}, CMD, EVENTS);
    if (only.action !== 'install') throw new Error('esperado install');
    const emptied = planUninstall(only.settings);
    expect(emptied.action).toBe('uninstall');
    if (emptied.action !== 'uninstall') return;
    expect(asHooks(emptied.settings)).toEqual({});
    expect(planUninstall({ hooks: { beforeReadFile: [{ command: 'outro-hook' }] } })).toEqual({ action: 'none', message: 'não estava instalado' });
  });

  it('installState: ok / ausente / desatualizado e os caminhos instalados', () => {
    expect(installState({}, CMD, EVENTS)).toEqual({ ok: [], outdated: [], missing: [...EVENTS], paths: [] });
    const p = planInstall({}, CMD, EVENTS);
    if (p.action !== 'install') throw new Error('esperado install');
    expect(installState(p.settings, CMD, EVENTS)).toEqual({ ok: [...EVENTS], outdated: [], missing: [], paths: [HOOK_SCRIPT] });
    expect(installState(p.settings, NEW, EVENTS)).toEqual({ ok: [], outdated: [...EVENTS], missing: [], paths: [HOOK_SCRIPT] });
  });

  it('parseArgs: comandos e opções (--dry-run e --project com ou sem diretório)', () => {
    expect(parseArgs(['install'])).toEqual({ command: 'install', dryRun: false, project: false });
    expect(parseArgs(['status', '--project'])).toEqual({ command: 'status', dryRun: false, project: true });
    expect(parseArgs(['uninstall', '--dry-run'])).toEqual({ command: 'uninstall', dryRun: true, project: false });
    const proj = join(tmp.dir, 'projeto');
    expect(parseArgs(['install', '--project', proj])).toEqual({ command: 'install', dryRun: false, project: resolve(proj) });
    expect(parseArgs(['--help'])).toBe('help');
    expect(parseArgs([])).toBe('help');
    expect(() => parseArgs(['x'])).toThrow(/desconhecido/);
    expect(() => parseArgs(['install', '--nada'])).toThrow(/desconhecida/);
  });

  it('hooksFileOf: ~/.cursor por padrão; o projeto com --project (sozinho = diretório atual)', () => {
    const ctx: RunContext = { env: {}, home: '/home/x', cwd: '/proj/x', now: new Date(), hookPath: '/p/hook.mjs', out: () => {} };
    expect(hooksFileOf(ctx, false)).toBe(join('/home/x', '.cursor', 'hooks.json'));
    expect(hooksFileOf(ctx, true)).toBe(join('/proj/x', '.cursor', 'hooks.json'));
    expect(hooksFileOf(ctx, join(tmp.dir, 'outro'))).toBe(join(tmp.dir, 'outro', '.cursor', 'hooks.json'));
  });
});

describe('cursor-install.ts (comando de verdade, HOME falso)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
  });
  afterEach(() => tmp.cleanup());

  /** O instalador como o usuário rodaria: `node --import tsx scripts/cursor-install.ts <args>`. */
  function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
  }
  const file = () => join(home, '.cursor', 'hooks.json');
  const read = () => JSON.parse(readFileSync(file(), 'utf8')) as { version?: unknown; hooks?: Record<string, Array<{ command?: unknown }>> };

  it('install: hooks.json ausente → cria com version 1 e a entrada em cada evento', () => {
    const r = cli(['install'], { HOME: home });
    expect(r.status).toBe(0);
    const saved = read();
    expect(saved.version).toBe(1);
    const names = Object.keys(saved.hooks ?? {});
    expect(names).toHaveLength(EVENTS.length);
    expect([...names].sort()).toEqual([...EVENTS].sort());
    for (const list of Object.values(saved.hooks ?? {})) expect(list.every((e) => e.command === CMD)).toBe(true);
  });

  it('install: mergeia preservando hooks alheios (o nosso no FIM), faz backup e é idempotente', () => {
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const other = { version: 1, hooks: { beforeReadFile: [{ command: 'outro-hook' }] } };
    writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify(other, null, 2)}\n`);

    const r1 = cli(['install'], { HOME: home });
    expect(r1.status).toBe(0);
    const saved = read();
    expect(saved.hooks!.beforeReadFile).toEqual([{ command: 'outro-hook' }, { command: CMD }]);
    expect(saved.hooks!.beforeReadFile.every((e) => typeof e.command === 'string')).toBe(true);

    const backups = readdirSync(dir).filter((f) => f.includes('backup'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, backups[0]), 'utf8'))).toEqual(other);

    const before = readFileSync(file(), 'utf8');
    const r2 = cli(['install'], { HOME: home });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/já instalado/);
    expect(readFileSync(file(), 'utf8')).toBe(before); // nada muda...
    expect(readdirSync(dir).filter((f) => f.includes('backup'))).toHaveLength(1); // ...nem backup novo
  });

  it('install --project <dir>: grava em <dir>/.cursor/hooks.json (e não em ~/.cursor)', () => {
    const proj = join(tmp.dir, 'projeto');
    mkdirSync(proj, { recursive: true });
    const r = cli(['install', '--project', proj], { HOME: home });
    expect(r.status).toBe(0);
    const saved = JSON.parse(readFileSync(join(proj, '.cursor', 'hooks.json'), 'utf8')) as { hooks?: Record<string, unknown[]> };
    expect(Object.keys(saved.hooks ?? {})).toHaveLength(EVENTS.length);
    expect(existsSync(file())).toBe(false);
  });

  it('uninstall: remove só os hooks do Habblaud, preservando os demais', () => {
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const other = { version: 1, hooks: { beforeReadFile: [{ command: 'outro-hook' }], stop: [{ command: 'outro-stop' }] } };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(other));
    expect(cli(['install'], { HOME: home }).status).toBe(0);

    const r = cli(['uninstall'], { HOME: home });
    expect(r.status).toBe(0);
    const saved = read();
    expect(saved.hooks!.beforeReadFile).toEqual([{ command: 'outro-hook' }]);
    expect(saved.hooks!.stop).toEqual([{ command: 'outro-stop' }]);
    expect(Object.keys(saved.hooks ?? {}).sort()).toEqual(['beforeReadFile', 'stop']);
    expect(Object.values(saved.hooks ?? {}).flat().filter((e) => e.command === CMD)).toEqual([]);
  });

  it('status: não instalado numa casa limpa; instalado em todos os eventos depois do install', () => {
    const none = cli(['status'], { HOME: home });
    expect(none.status).toBe(0);
    expect(none.stdout).toMatch(/não instalado/);

    expect(cli(['install'], { HOME: home }).status).toBe(0);
    const r = cli(['status'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`instalado em ${EVENTS.length} de ${EVENTS.length} eventos`));
    expect(r.stdout).toContain('cursor-hook.json');
    expect(r.stdout).toContain('4747');
  });

  it('status: informa eventos de decisão (padrão/configurados), nº de regras locais e nº de decisões locais', () => {
    const clean = cli(['status'], { HOME: home });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('eventos de decisão: beforeShellExecution, beforeMCPExecution (padrão)');
    expect(clean.stdout).toContain('regras locais: 0');
    expect(clean.stdout).toContain('decisões locais: 0');

    // Política própria (eventos + regras, uma inválida) e decisões locais registradas pelo hook.
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(
      join(home, '.habblaud', 'cursor-hook.json'),
      JSON.stringify({
        port: 4900,
        decisionEvents: ['beforeShellExecution', 'beforeReadFile'],
        rules: [
          { tool: 'Shell', pattern: '^npm test(\\s|$)', effect: 'allow', note: 'npm test' },
          { tool: 'Shell', pattern: '^rm -rf', effect: 'deny', note: 'destrutivo' },
          { tool: '', pattern: '^x', effect: 'allow' },
        ],
      }),
    );
    writeFileSync(join(home, '.habblaud', 'cursor-decisions.jsonl'), '{"a":1}\n{"b":2}\n');
    const r = cli(['status'], { HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('eventos de decisão: beforeShellExecution, beforeReadFile;');
    expect(r.stdout).not.toContain('(padrão)');
    expect(r.stdout).toContain('regras locais: 2');
    expect(r.stdout).toContain('decisões locais: 2');
  });

  it('hooks.json quebrado: erro com saída ≠ 0 e o arquivo fica intacto', () => {
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.json'), '{ quebrado');
    const r = cli(['install'], { HOME: home });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/JSON inválido/i);
    expect(readFileSync(join(dir, 'hooks.json'), 'utf8')).toBe('{ quebrado');
  });
});