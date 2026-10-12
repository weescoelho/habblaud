import { describe, expect, it } from 'vitest';
import type { SkillInfo } from '../../../shared/types';
import { skillsView, sourceLabel, UNAVAILABLE_SKILL_ERROR, NOT_FOUND_SKILL_ERROR } from './skills-model';

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'teste',
    description: 'Descrição da skill',
    source: 'project',
    path: '/p/proj/.cursor/skills/teste',
    available: true,
    ...over,
  };
}

describe('painel de skills (peças puras)', () => {
  it('skillsView: converte o catálogo em itens do painel (SC-32)', () => {
    const list: SkillInfo[] = [
      skill({ name: 'revisar-pr', description: 'Revisa um PR' }),
      skill({ name: 'deploy', source: 'user', path: '/home/.cursor/skills/deploy', available: false }),
      skill({ name: 'testar', source: 'agents', path: '/p/proj/.agents/skills/testar' }),
    ];
    const view = skillsView(list);
    expect(view).toHaveLength(3);
    expect(view[0]).toEqual({ name: 'revisar-pr', description: 'Revisa um PR', source: 'project', available: true });
    expect(view[1]).toEqual({ name: 'deploy', description: 'Descrição da skill', source: 'user', available: false });
    expect(view[2]).toEqual({ name: 'testar', description: 'Descrição da skill', source: 'agents', available: true });
  });

  it('skillsView: description é opcional (omitida quando ausente)', () => {
    const list: SkillInfo[] = [skill({ name: 'sem-desc', description: undefined })];
    const view = skillsView(list);
    expect(view[0]).toEqual({ name: 'sem-desc', source: 'project', available: true });
    expect('description' in view[0]).toBe(false);
  });

  it('sourceLabel: rótulos em PT-BR (SC-32)', () => {
    expect(sourceLabel('project')).toBe('Projeto (.cursor/skills)');
    expect(sourceLabel('agents')).toBe('Projeto (.agents/skills)');
    expect(sourceLabel('user')).toBe('Usuário (~/.cursor/skills)');
  });

  it('constantes de erro padronizadas (SC-34)', () => {
    expect(UNAVAILABLE_SKILL_ERROR).toBe('A skill está indisponível: o SKILL.md está malformado');
    expect(NOT_FOUND_SKILL_ERROR).toBe('Skill não encontrada');
  });
});