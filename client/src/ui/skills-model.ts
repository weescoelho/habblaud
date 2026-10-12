// Painel de skills (ui/skills.ts), parte pura e testada em ui/skills-model.test.ts: formata a lista de skills e marca
// as indisponíveis (SC-34). A execução (POST /api/skills/run) fica no componente.
import type { SkillInfo } from '../../../shared/types';

export interface SkillItem {
  name: string;
  description?: string;
  source: SkillInfo['source'];
  available: boolean;
}

/** Converte o catálogo do servidor (SkillInfo[]) no formato do painel (SkillItem[]). */
export function skillsView(skills: SkillInfo[]): SkillItem[] {
  return skills.map((s) => ({
    name: s.name,
    ...(s.description ? { description: s.description } : {}),
    source: s.source,
    available: s.available,
  }));
}

/** Rótulo da origem em PT-BR para a dica no painel. */
export function sourceLabel(source: SkillInfo['source']): string {
  switch (source) {
    case 'project':
      return 'Projeto (.cursor/skills)';
    case 'agents':
      return 'Projeto (.agents/skills)';
    case 'user':
      return 'Usuário (~/.cursor/skills)';
  }
}

/** Texto de erro padronizado para skill indisponível (SC-34). */
export const UNAVAILABLE_SKILL_ERROR = 'A skill está indisponível: o SKILL.md está malformado';

/** Texto de erro padronizado para skill não encontrada. */
export const NOT_FOUND_SKILL_ERROR = 'Skill não encontrada';