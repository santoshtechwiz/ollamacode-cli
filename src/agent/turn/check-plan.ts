// agent.afterEdit / agent.beforeDone "auto": which of a project's checks to run, decided from what changed, what the
// project is, and how long each check took here before. Nothing is guessed from what anyone wrote.

import path from 'node:path';
import { LANGUAGES, type Verb } from '../../env/languages';
import { FRAMEWORKS } from '../../env/frameworks';
import type { StackInfo } from '../../types';

export type CheckPhase = 'edit' | 'done';

/** Opening the project's page in a browser (check_page), the way a person would see the work: not a project command. */
export const PAGE = 'page';
export type Step = Verb | typeof PAGE;

/** Pages a browser opens straight from disk: a site with no dev server is checked through these files. */
const PAGE_EXTENSIONS = new Set(['.html', '.htm']);

/** A check that took longer than this last time waits for the end of the turn instead of running after each edit. */
export const FAST_CHECK_MS = 10_000;

/** Files no check reads: changing only these needs no check. */
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst']);

const extOf = (file: string) => path.extname(file).toLowerCase();

/**
 * The verbs to run in one project, in order, for the files it changed. `lastMs` is how long a verb took in this project
 * before (undefined: never run).
 *   - Before "done", what shows the work works: the build, when the project uses a framework whose build verifies more
 *     than types (it prerenders pages or compiles templates) and something other than documentation changed (it
 *     includes the type check); otherwise the type check, when the language's own files changed. Lint on the changed
 *     files goes first, unless it proved slow here: it reports style, and ESLint on a Next.js project, which loads the
 *     whole TypeScript project to read three files, held a finished answer for over a minute. Its first run is what
 *     says how long it takes, and that is remembered for the project.
 *   - After an edit, the type check and lint on the changed files, each only when it took under FAST_CHECK_MS here.
 */
export function autoVerbs(phase: CheckPhase, stack: StackInfo, files: string[], lastMs: (verb: Verb) => number | undefined): Verb[] {
  const languageFiles = LANGUAGES.find((l) => l.id === stack.id)?.extensions ?? [];
  const touchesCode = files.some((f) => languageFiles.includes(extOf(f)));
  const touchesProject = files.some((f) => !DOC_EXTENSIONS.has(extOf(f)));
  const lintable = stack.fileScoped?.lint ? files.some((f) => stack.fileScoped!.lint!.extensions.includes(extOf(f))) : false;
  const buildVerifies = Boolean(stack.build) && (stack.frameworks ?? []).some((label) => FRAMEWORKS.find((f) => f.label === label)?.buildVerifies);
  const fast = (verb: Verb) => {
    const ms = lastMs(verb);
    return ms !== undefined && ms < FAST_CHECK_MS;
  };

  if (phase === 'done') {
    const lint: Verb[] = lintable && (lastMs('lint') === undefined || fast('lint')) ? ['lint'] : [];
    if (buildVerifies && touchesProject) return [...lint, 'build'];
    return [...(touchesCode && stack.check ? (['check'] as Verb[]) : []), ...lint];
  }
  const wanted: Verb[] = [];
  if (touchesCode && stack.check) wanted.push('check');
  if (lintable) wanted.push('lint');
  return wanted.filter(fast);
}

/**
 * Everything auto runs in one project folder, in order: each stack's verbs, then, once before "done", its page when
 * the project is a web front end (a framework ocode knows and a dev script that serves it) or, with no project around
 * them, changed .html files. The page comes last: it is worth opening only once the build passes.
 */
export function autoSteps(phase: CheckPhase, stacks: StackInfo[], files: string[], lastMs: (verb: Verb) => number | undefined): Step[] {
  const steps: Step[] = [...new Set(stacks.flatMap((stack) => autoVerbs(phase, stack, files, lastMs)))];
  if (phase !== 'done') return steps;
  const touchesProject = files.some((f) => !DOC_EXTENSIONS.has(extOf(f)));
  const servesPages = stacks.some((stack) => stack.dev && stack.frameworks?.length);
  const staticPages = stacks.length === 0 && files.some((f) => PAGE_EXTENSIONS.has(extOf(f)));
  if ((servesPages && touchesProject) || staticPages) steps.push(PAGE);
  return steps;
}

/** The changed files a browser can open as they are, for a site with no dev server. */
export const pageFiles = (files: string[]): string[] => files.filter((f) => PAGE_EXTENSIONS.has(extOf(f)));
