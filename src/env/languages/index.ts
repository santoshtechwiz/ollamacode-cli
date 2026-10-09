import { NODE } from './node';
import { PYTHON } from './python';
import { DOTNET } from './dotnet';
import { RUST } from './rust';
import { GO } from './go';
import { TERRAFORM } from './terraform';
import type { Language } from './types';

export type { Language, Command, Commands, Verb } from './types';
export { VERBS, CHECK_VERBS } from './types';

// Every language ocode knows, one file each in this folder: to support a new one, add its file and one entry here.
export const LANGUAGES: readonly Language[] = [NODE, PYTHON, DOTNET, RUST, GO, TERRAFORM];

/** Symbol and import patterns for a source file extension, or null when no language claims it. */
export function sourceRulesFor(ext: string): Language['source'] | null {
  const e = ext.toLowerCase();
  return LANGUAGES.find((l) => l.source && l.extensions?.includes(e))?.source ?? null;
}
