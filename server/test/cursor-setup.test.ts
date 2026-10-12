// `npm run cursor:setup` (scripts/cursor-install.ts setup): o caminho de OUTRA máquina num comando só — tira a POC
// (se estiver), instala o hook real e grava a camada base que faz o Cursor parar de perguntar:
// ~/.habblaud/cursor-hook.json (regras locais) e ~/.cursor/permissions.json (Run Mode Auto-review).
// Tudo sobre HOME FALSO (nunca toca no ~ real); idempotente, preservando escolhas do usuário.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVENTS, HOOK_SCRIPT, hookCommand, POC_HOOK_SCRIPT, SETUP_PERMISSIONS, SETUP_RULES } from '../../scripts/cursor-install';
import { tempDir } from './fixtures';

const SCRIPT = resolve(__dirname, '../../scripts/cursor-install.ts');
const ROOT = resolve(__dirname, '../..');
const CMD = hookCommand(HOOK_SCRIPT);
const POC_CMD = hookCommand(POC_HOOK_SCRIPT);

type Rec = Record<string, unknown>;
type Hooks = Record<string, Array<{ command: string }>>;

describe('cursor:setup (comando de verdade, HOME falso)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
  });
  afterEach(() => tmp.cleanup());

  /** O setup como o usuário rodaria: `node --import tsx scripts/cursor-install.ts setup`. */
  function cli(args: string[] = []) {
    return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, 'setup', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: ROOT,
      env: { ...process.env, HOME: home },
    });
  }
  const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Rec;
  const hooksFile = () => join(home, '.cursor', 'hooks.json');
  const permissionsFile = () => join(home, '.cursor', 'permissions.json');
  const configFile = () => join(home, '.habblaud', 'cursor-hook.json');
  const backups = (dir: string) => {
    try {
      return readdirSync(dir).filter((f) => f.includes('backup'));
    } catch {
      return [];
    }
  };

  it(`casa limpa: instala o hook nos ${EVENTS.length} eventos e grava as duas camadas de config`, () => {
    const r = cli();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`${EVENTS.length} eventos`));
    expect(r.stdout).toMatch(/Auto-review/);

    const saved = readJson(hooksFile()) as { version?: unknown; hooks?: Hooks };
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.hooks ?? {}).sort()).toEqual([...EVENTS].sort());
    for (const list of Object.values(saved.hooks ?? {})) expect(list).toEqual([{ command: CMD }]);

    const cfg = readJson(configFile()) as { rules?: Array<{ tool: string; pattern: string; effect: string }> };
    expect(cfg.rules).toHaveLength(SETUP_RULES.length);
    expect(cfg.rules?.map((x) => [x.tool, x.pattern, x.effect])).toEqual(SETUP_RULES.map((x) => [x.tool, x.pattern, x.effect]));
    expect(cfg.rules?.some((x) => x.effect === 'allow' && x.pattern === '.*')).toBe(true);

    const perm = readJson(permissionsFile()) as { autoRun?: { allow_instructions?: unknown[]; block_instructions?: unknown[] } };
    expect(perm.autoRun?.allow_instructions).toEqual(SETUP_PERMISSIONS.autoRun.allow_instructions);
    expect(perm.autoRun?.block_instructions).toEqual(SETUP_PERMISSIONS.autoRun.block_instructions);
    // Casa limpa: nada a fazer backup.
    expect(backups(join(home, '.cursor'))).toHaveLength(0);
  });

  it('é idempotente: a segunda execução não grava nem cria backup', () => {
    expect(cli().status).toBe(0);
    const before = readFileSync(hooksFile(), 'utf8');
    const r = cli();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/já instalado/);
    expect(r.stdout).toMatch(/já tem \d+ regras/);
    expect(r.stdout).toMatch(/já configurado/);
    expect(readFileSync(hooksFile(), 'utf8')).toBe(before);
    expect(backups(join(home, '.cursor'))).toHaveLength(0);
  });

  it('tira as entradas da POC (que só observa), preservando as alheias e pondo a nossa no fim', () => {
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const withPoc = {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: POC_CMD }, { command: 'outro-hook' }],
        stop: [{ command: POC_CMD }],
      },
    };
    writeFileSync(hooksFile(), `${JSON.stringify(withPoc, null, 2)}\n`);

    const r = cli();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/poc-hook removido \(2\)/);
    const saved = readJson(hooksFile()) as { hooks?: Hooks };
    expect(saved.hooks?.beforeShellExecution).toEqual([{ command: 'outro-hook' }, { command: CMD }]);
    expect(saved.hooks?.stop).toEqual([{ command: CMD }]);
    const all = Object.values(saved.hooks ?? {}).flat().map((e) => e.command);
    expect(all.some((c) => c.includes('poc-hook.mjs'))).toBe(false);
    // O backup guarda o estado antigo (com a POC), para poder voltar atrás.
    const [bak] = backups(dir);
    expect(JSON.parse(readFileSync(join(dir, bak), 'utf8'))).toEqual(withPoc);
  });

  it('mergeia a camada base sem apagar o que o usuário já tinha (e faz backup do original)', () => {
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    const existing = {
      meuCampo: 123,
      autoRun: { allow_instructions: ['Só esta.'], block_instructions: [], other: true },
    };
    writeFileSync(permissionsFile(), `${JSON.stringify(existing, null, 2)}\n`);

    expect(cli().status).toBe(0);
    const merged = readJson(permissionsFile()) as { meuCampo?: unknown; autoRun?: Rec };
    expect(merged.meuCampo).toBe(123);
    expect(merged.autoRun?.other).toBe(true);
    const allow = merged.autoRun?.allow_instructions as string[];
    expect(allow[0]).toBe('Só esta.'); // o que já havia continua na frente
    expect(allow).toHaveLength(1 + SETUP_PERMISSIONS.autoRun.allow_instructions.length); // ...e as nossas entram sem duplicar
    expect(merged.autoRun?.block_instructions).toEqual(SETUP_PERMISSIONS.autoRun.block_instructions);
    expect(backups(dir)).toHaveLength(1);
  });

  it('não sobrescreve regras locais já existentes (escolhas do usuário vencem)', () => {
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    const mine = { port: 4900, rules: [{ tool: 'Shell', pattern: '^npm test(\\s|$)', effect: 'allow', note: 'meu' }] };
    writeFileSync(configFile(), `${JSON.stringify(mine, null, 2)}\n`);

    const r = cli();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/já tem 1 regra local \(mantidas\)/);
    expect(readJson(configFile())).toEqual(mine);
  });

  it('--dry-run: mostra o que faria e não grava nada', () => {
    const r = cli(['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/simulação/);
    expect(existsSync(hooksFile())).toBe(false);
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(permissionsFile())).toBe(false);
  });

  it('hooks.json em formato desconhecido: erro com saída ≠ 0 e nada é gravado', () => {
    const dir = join(home, '.cursor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks: 'x' }));
    const r = cli();
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/formato desconhecido/);
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(permissionsFile())).toBe(false);
  });
});
