// agent.afterEdit / agent.beforeDone "auto": which of a project's checks to run, decided from what changed, what the
// project is, and how long each check took here before. Nothing is guessed from what anyone wrote.

import path from 'node:path';
import { LANGUAGES, type Verb } from '../../env/languages';
import { FRAMEWORKS } from '../../env/frameworks';
import type { StackInfo } from '../../types';

export type CheckPhase = 'edit' | 'done';

/** A check that took longer than this last time waits for the end of the turn instead of running after each edit. */
export const FAST_CHECK_MS = 10_000;

/** Files no check reads: changing only these needs no check. */
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst']);

const extOf = (file: string) => path.extname(file).toLowerCase();

/**
 * The verbs to run in one project, in order, for the files it changed. `lastMs` is how long a verb took in this project
 * before (undefined: never run). After an edit, only checks known to be fast run; once before "done", every check the
 * change calls for:
 *   - a build, when the project uses a framework whose build verifies more than types (it prerenders pages or compiles
 *     templates) and something other than documentation changed; it includes the type check;
 *   - otherwise the type check, when the language's own files changed;
 *   - lint, on the changed files its linter reads.
 */
export function autoVerbs(phase: CheckPhase, stack: StackInfo, files: string[], lastMs: (verb: Verb) => number | undefined): Verb[] {
  const languageFiles = LANGUAGES.find((l) => l.id === stack.id)?.extensions ?? [];
  const touchesCode = files.some((f) => languageFiles.includes(extOf(f)));
  const touchesProject = files.some((f) => !DOC_EXTENSIONS.has(extOf(f)));
  const lintable = stack.fileScoped?.lint ? files.some((f) => stack.fileScoped!.lint!.extensions.includes(extOf(f))) : false;
  const buildVerifies = Boolean(stack.build) && (stack.frameworks ?? []).some((label) => FRAMEWORKS.find((f) => f.label === label)?.buildVerifies);

  const wanted: Verb[] = [];
  if (phase === 'done' && buildVerifies && touchesProject) {
    if (lintable) wanted.push('lint');
    wanted.push('build');
    return wanted;
  }
  if (touchesCode && stack.check) wanted.push('check');
  if (lintable) wanted.push('lint');
  if (phase === 'done') return wanted;
  return wanted.filter((verb) => {
    const ms = lastMs(verb);
    return ms !== undefined && ms < FAST_CHECK_MS;
  });
}
