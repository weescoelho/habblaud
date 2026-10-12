// Catálogo de skills (server/skills/catalog.ts): as raízes conhecidas com nome/descrição, o `SKILL.md` malformado
// (indisponível, sem derrubar o painel) e o ausente (fora do catálogo). Puro: só lê uma pasta temporária.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillInfo } from '../../shared/types';
import { tempDir } from '../test/fixtures';
import { listSkills, parseFrontmatter, skillRoots, SKILL_FILE } from './catalog';

let tmp: ReturnType<typeof tempDir>;
let cwd: string;
let home: string;

beforeEach(() => {
  tmp = tempDir();
  cwd = join(tmp.dir, 'projeto');
  home = join(tmp.dir, 'home');
});
afterEach(() => tmp.cleanup());

/** Cria um `SKILL.md` em `<raiz>/<nome>/` (conteúdo cru) e devolve o diretório da skill. */
function skill(root: string, name: string, content: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE), content);
  return dir;
}

/** Indexa por nome para não depender da ordem do diretório. */
const byName = (list: SkillInfo[]) => new Map(list.map((s) => [s.name, s]));

describe('catálogo de skills', () => {
  it('lista as raízes conhecidas (projeto, agents, usuário) com nome e descrição (SC-32)', () => {
    const p = skill(join(cwd, '.cursor', 'skills'), 'revisar-pr', '---\nname: revisar-pr\ndescription: Revisa um PR de ponta a ponta\n---\n\nCorpo.');
    const a = skill(join(cwd, '.agents', 'skills'), 'testar', '---\nname: testar\ndescription: Roda a suíte\n---\n');
    const u = skill(join(home, '.cursor', 'skills'), 'deploy', '---\nname: deploy\ndescription: "Faz o deploy"\n---\n');
    const list = listSkills(skillRoots(cwd, home));
    const map = byName(list);
    expect([...map.keys()].sort()).toEqual(['deploy', 'revisar-pr', 'testar']);
    expect(map.get('revisar-pr')).toEqual({ name: 'revisar-pr', description: 'Revisa um PR de ponta a ponta', source: 'project', path: p, available: true });
    expect(map.get('testar')).toMatchObject({ description: 'Roda a suíte', source: 'agents', path: a, available: true });
    // Aspas do frontmatter são desencapadas.
    expect(map.get('deploy')).toMatchObject({ description: 'Faz o deploy', source: 'user', path: u, available: true });
  });

  it('SKILL.md malformado ou sem frontmatter fica indisponível, sem lançar (SC-34)', () => {
    skill(join(cwd, '.cursor', 'skills'), 'sem-frontmatter', '# Só um título\nsem frontmatter\n');
    skill(join(cwd, '.cursor', 'skills'), 'sem-nome', '---\ndescription: sem o name\n---\n');
    const list = listSkills(skillRoots(cwd, home));
    const map = byName(list);
    expect(map.get('sem-frontmatter')).toMatchObject({ name: 'sem-frontmatter', available: false });
    expect(map.get('sem-nome')).toMatchObject({ name: 'sem-nome', description: 'sem o name', available: false });
    expect(list.every((s) => s.name)).toBe(true);
  });

  it('diretório sem SKILL.md, raiz ausente e arquivo solto ficam fora do catálogo', () => {
    const root = join(cwd, '.cursor', 'skills');
    mkdirSync(join(root, 'vazia'), { recursive: true });
    writeFileSync(join(root, 'leiame.txt'), 'não é uma skill');
    // A raiz do usuário nem existe; a do projeto só tem lixo: catálogo vazio.
    expect(listSkills(skillRoots(cwd, home))).toEqual([]);
  });

  it('parseFrontmatter: aceita name/description (com aspas) e ignora o resto; sem bloco devolve undefined', () => {
    expect(parseFrontmatter('---\nname: x\ndescription: y\n---\ncorpo')).toEqual({ name: 'x', description: 'y' });
    expect(parseFrontmatter("---\ntitle: t\nname: 'x'\ndescription: \"a: b\"\n---\n")).toEqual({ name: 'x', description: 'a: b' });
    expect(parseFrontmatter('# sem frontmatter')).toBeUndefined();
    expect(parseFrontmatter('---\nnome: sem fechamento\n')).toBeUndefined();
    expect(parseFrontmatter('')).toBeUndefined();
  });
});
