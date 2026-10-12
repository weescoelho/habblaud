// Catálogo de skills (P7 · SC-32/SC-34): lê o `SKILL.md` de cada skill nos diretórios conhecidos do Cursor
// (`<cwd>/.cursor/skills`, `<cwd>/.agents/skills` e `~/.cursor/skills`) e devolve nome/descrição. Arquivo ausente,
// ilegível ou sem frontmatter não derruba o painel: a skill sai com `available:false` (SC-34). Node puro (`node:fs`),
// sem dependências.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillInfo } from '../../shared/types';

/** Nome do arquivo de cada skill. */
export const SKILL_FILE = 'SKILL.md';

/** Raiz de skills com a sua origem (`SkillInfo.source`). */
export interface SkillRoot {
  dir: string;
  source: SkillInfo['source'];
}

/** Frontmatter de um `SKILL.md`: o mínimo que o catálogo usa. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Lê o frontmatter YAML do começo do `SKILL.md` (só `name`/`description`, sem biblioteca de YAML). Sem bloco
 * `---...---` (ou vazio) devolve `undefined`; valores entre aspas são desencapados. Nunca lança.
 */
export function parseFrontmatter(raw: string): SkillFrontmatter | undefined {
  const m = FRONTMATTER.exec(raw);
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return { name: fields.name, description: fields.description };
}

/**
 * Skills de cada raiz, na ordem das raízes (e, dentro de uma raiz, a ordem do diretório). Uma skill é um
 * subdiretório com `SKILL.md`; nome = `name` do frontmatter (ou o nome da pasta) e `available:false` quando o
 * arquivo não tem `name` (malformado/sem frontmatter). Nenhum erro de leitura derruba o catálogo.
 */
export function listSkills(roots: SkillRoot[]): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const root of roots) {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // raiz ausente/ilegível: sem skills
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root.dir, entry.name);
      let raw: string;
      try {
        raw = readFileSync(join(path, SKILL_FILE), 'utf8');
      } catch {
        continue; // sem SKILL.md: não é uma skill
      }
      const meta = parseFrontmatter(raw);
      const name = meta?.name?.trim() || entry.name;
      const description = meta?.description?.trim();
      out.push({ name, ...(description ? { description } : {}), source: root.source, path, available: !!meta?.name?.trim() });
    }
  }
  return out;
}

/** Diretórios conhecidos de skills de um projeto: os do projeto e o do usuário (SC-32). */
export function skillRoots(cwd: string, home: string): SkillRoot[] {
  return [
    { dir: join(cwd, '.cursor', 'skills'), source: 'project' },
    { dir: join(cwd, '.agents', 'skills'), source: 'agents' },
    { dir: join(home, '.cursor', 'skills'), source: 'user' },
  ];
}
