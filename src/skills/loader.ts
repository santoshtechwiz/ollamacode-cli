import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { makeGlobMatcher } from '../tool/search/_glob';
import { logger } from '../core/logger';

// A skill is a folder holding a SKILL.md: a short header (name, description, the files it covers) and the instructions
// a model follows for that kind of work. Skills are data: one more folder is one more skill, and no code changes.
//
//   ---
//   name: ui-ux
//   description: one line saying when it applies
//   paths: ["**/*.css", "**/*.html"]      # optional: files whose use points the model at this skill
//   ---
//   the instructions
//
// Other files in the folder (a starter stylesheet, a checklist) are the skill's to hand out through use_skill.

export interface Skill {
  name: string;
  description: string;
  /** Globs, workspace-relative; a call that touches a matching file is told this skill applies. */
  paths: string[];
  instructions: string;
  /** The skill's folder, for its other files. */
  dir: string;
  matches(relPath: string): boolean;
}

const SKILL_FILE = 'SKILL.md';
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION = 200;

/** Where skills come from, lowest priority first: a later folder's skill replaces an earlier one of the same name. */
export function skillDirs(root: string): string[] {
  return [
    fileURLToPath(new URL('../../skills/', import.meta.url)),
    path.join(os.homedir(), '.ollamacode', 'skills'),
    path.join(root, '.ocode', 'skills'),
  ];
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** One SKILL.md read into a skill; a reason instead when it cannot be one. */
export function parseSkill(text: string, dir: string): Skill | string {
  const m = FRONT_MATTER.exec(text);
  if (!m) return 'no header: it must start with a --- block holding name and description';
  let head: any;
  try {
    head = parseYaml(m[1]);
  } catch (err) {
    return `its header is not valid YAML: ${(err as Error).message}`;
  }
  const name = String(head?.name ?? '');
  if (!NAME.test(name)) return `its name "${name}" must be lowercase letters, digits and dashes`;
  const description = String(head?.description ?? '').trim();
  if (!description) return 'it has no description';
  const paths = head?.paths === undefined ? [] : Array.isArray(head.paths) ? head.paths.map(String).filter(Boolean) : null;
  if (!paths) return 'its paths must be a list of globs';
  const instructions = m[2].trim();
  if (!instructions) return 'it has no instructions after the header';
  const matchers = paths.map((glob: string) => makeGlobMatcher(glob));
  return {
    name,
    description: description.slice(0, MAX_DESCRIPTION),
    paths,
    instructions,
    dir,
    matches: (rel) => matchers.some((match: (p: string) => boolean) => match(rel)),
  };
}

export function loadSkills(dirs: string[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const base of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(base, entry.name);
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, SKILL_FILE), 'utf8');
      } catch {
        continue;
      }
      const skill = parseSkill(text, dir);
      if (typeof skill === 'string') {
        logger.warn(`skipping skill ${path.join(dir, SKILL_FILE)}: ${skill}`);
        continue;
      }
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

let loaded: Skill[] | undefined;

/** The skills for the workspace ocode started in, read once: a skill added or changed takes effect on the next start. */
export function skills(): Skill[] {
  return (loaded ??= loadSkills(skillDirs(process.cwd())));
}

export function findSkill(name: string): Skill | undefined {
  return skills().find((s) => s.name === name);
}

/** The skills whose paths cover a workspace-relative file. */
export function skillsFor(relPath: string): Skill[] {
  const rel = relPath.split(path.sep).join('/');
  return skills().filter((s) => s.matches(rel));
}

/** The other files in a skill's folder, relative to it. */
export function skillFiles(skill: Skill): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (abs !== path.join(skill.dir, SKILL_FILE)) out.push(path.relative(skill.dir, abs).split(path.sep).join('/'));
    }
  };
  try {
    walk(skill.dir);
  } catch {
    return [];
  }
  return out.sort();
}
