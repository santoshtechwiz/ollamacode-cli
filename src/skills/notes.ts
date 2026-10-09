import { skillsFor, type Skill } from './loader';

/**
 * The note a call's result carries when it touched a file a skill covers: one line naming the skill, once per skill
 * per turn. A pointer, not the instructions: a file a skill covers is not always that kind of work (a .tsx file can be
 * plain logic), so loading it is the model's call. `noted` is the turn's record of skills already pointed at.
 */
export function skillNote(relPaths: string[], noted: Set<string>, find: (rel: string) => Skill[] = skillsFor): string | undefined {
  const lines: string[] = [];
  for (const rel of relPaths) {
    for (const skill of find(rel)) {
      if (noted.has(skill.name)) continue;
      noted.add(skill.name);
      lines.push(`The ${skill.name} skill covers ${rel} (${skill.description}). If this is that kind of work and you have not loaded it yet, call use_skill with name "${skill.name}" first.`);
    }
  }
  return lines.length ? lines.join('\n') : undefined;
}
