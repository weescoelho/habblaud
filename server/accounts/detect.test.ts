// Aliases de shell por ferramenta: o Cursor não tem alias (a conta dele é única e não vem do shell), mas a chave
// precisa existir no mapa exaustivo `Record<Provider, …>`. Aqui garantimos que ela nunca casa e que claude/codex
// não regridem.
import { describe, expect, it } from 'vitest';
import { parseToolAliases } from './detect';

const HOME = '/Users/fulano';

describe('aliases de shell por ferramenta', () => {
  it('cursor não casa nenhum alias (nem linhas que citam cursor/claude/codex)', () => {
    const rc = [
      "alias c='claude'",
      "alias cx='codex'",
      "alias cur='CURSOR_HOME=/x cursor'",
      "alias cc='cursor --help'",
    ].join('\n');
    expect(parseToolAliases(rc, HOME, 'cursor')).toEqual([]);
  });

  it('claude e codex continuam funcionando (sem regressão)', () => {
    const rc = "alias c='claude'\nalias cx='codex'";
    expect(parseToolAliases(rc, HOME, 'claude')).toEqual([{ name: 'c' }]);
    expect(parseToolAliases(rc, HOME, 'codex')).toEqual([{ name: 'cx' }]);
  });
});
