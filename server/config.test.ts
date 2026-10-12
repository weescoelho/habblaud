// Configuração do servidor: a flag do Cursor (HABBLAUD_CURSOR) ligada por padrão, desligável como a do Codex.
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './test/fixtures';
import { loadConfig } from './config';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function cfg(env: NodeJS.ProcessEnv = {}) {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  return loadConfig({ HOME: tmp.dir, HABBLAUD_IN_DOCKER: '0', ...env }, []);
}

describe('flag do Cursor (ServerConfig.cursor)', () => {
  it('padrão: ligada', () => {
    expect(cfg().cursor).toBe(true);
  });

  it('HABBLAUD_CURSOR=0 (e off) desliga', () => {
    expect(cfg({ HABBLAUD_CURSOR: '0' }).cursor).toBe(false);
    expect(cfg({ HABBLAUD_CURSOR: 'off' }).cursor).toBe(false);
  });

  it('HABBLAUD_CURSOR=1 liga', () => {
    expect(cfg({ HABBLAUD_CURSOR: '1' }).cursor).toBe(true);
  });
});
