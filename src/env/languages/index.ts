import type { Diagnostic } from '../../types';
import { dedupe } from '../parsers/shared';
import { NODE } from './node';
import { PYTHON } from './python';
import { DOTNET } from './dotnet';
import { RUST } from './rust';
import { GO } from './go';
import { TERRAFORM } from './terraform';
import { GIT } from './git';
import type { Language } from './types';

export type { Language, Command, Commands, Verb } from './types';
export { VERBS, CHECK_VERBS } from './types';

// Every language ocode knows, one file each in this folder: to support a new one, add its file and one entry here.
export const LANGUAGES: readonly Language[] = [NODE, PYTHON, DOTNET, RUST, GO, TERRAFORM, GIT];

/** Symbol and import patterns for a source file extension, or null when no language claims it. */
export function sourceRulesFor(ext: string): Language['source'] | null {
  const e = ext.toLowerCase();
  return LANGUAGES.find((l) => l.source && l.extensions?.includes(e))?.source ?? null;
}

/** Diagnostics from tool output, from every language that owns the stack or recognises the command. */
export function parseForStack(text: string, stack: string | undefined, command: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const lang of LANGUAGES) {
    if (!lang.parse) continue;
    const owns = !stack || stack === lang.id || Boolean(lang.stackAliases?.includes(stack));
    if (owns || lang.commandPattern?.test(command)) out.push(...lang.parse(text));
  }
  return dedupe(out);
}

