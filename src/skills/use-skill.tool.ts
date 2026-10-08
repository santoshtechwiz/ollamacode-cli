import fs from 'node:fs';
import path from 'node:path';
import { TOOL_ERROR_CODE } from '../protocol';
import { defineTool } from '../tool/core/defineTool';
import { ok, fail, fromError } from '../tool/core/tool-result';
import { findSkill, skillFiles, skills } from './loader';

// Read once, when the tool is defined: a skill added or changed takes effect on the next start.
const available = skills();

export default defineTool({
  name: 'use_skill',
  profiles: ['core', 'planning'],
  category: 'agent',
  readOnly: true,
  activity: 'Reading a skill',
  label: 'Use Skill',
  brief: `Load step-by-step instructions for a kind of work before doing it. Skills: ${available.map((s) => s.name).join(', ') || 'none'}.`.slice(0, 180),
  description:
    'Load a skill: step-by-step instructions for one kind of work. Call it before starting work a skill covers, and follow what it says. ' +
    'Pass file to read one of the skill\'s own files (templates, references) that its instructions name. Skills: ' +
    (available.map((s) => `${s.name} — ${s.description}`).join('; ') || 'none installed') +
    '.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', ...(available.length ? { enum: available.map((s) => s.name) } : {}), description: 'Which skill' },
      file: { type: 'string', description: "One of the skill's own files, as its instructions name it" },
    },
    required: ['name'],
  },
  preview(args) {
    return [args?.name, args?.file].filter(Boolean).join(' · ');
  },
  async execute(args) {
    const skill = findSkill(String(args.name ?? ''));
    if (!skill) {
      return fail(`There is no "${args.name}" skill`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: `Skills: ${skills().map((s) => s.name).join(', ') || 'none installed'}.`,
      });
    }
    const files = skillFiles(skill);
    if (args.file) {
      const rel = String(args.file).split('\\').join('/');
      if (!files.includes(rel)) {
        return fail(`The ${skill.name} skill has no file "${rel}"`, {
          code: TOOL_ERROR_CODE.ENOENT,
          hint: files.length ? `Its files: ${files.join(', ')}.` : 'It has no files besides its instructions.',
        });
      }
      try {
        const text = fs.readFileSync(path.join(skill.dir, rel), 'utf8');
        return ok({ kind: 'text', display: text, data: { skill: skill.name, file: rel } });
      } catch (err) {
        return fromError(err);
      }
    }
    const listing = files.length ? `\n\nFiles in this skill (read one with use_skill file): ${files.join(', ')}` : '';
    return ok({ kind: 'text', display: `${skill.instructions}${listing}`, data: { skill: skill.name, files } });
  },
});
