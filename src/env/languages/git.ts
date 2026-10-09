import { parseGitConflicts } from '../parsers/git';
import type { Language } from './types';

// Git is a tool rather than a language, but its runtime is detected and its output parsed the same way.
export const GIT: Language = {
  id: 'git',
  label: 'Git',
  runtimes: [{ name: 'git', commands: ['git'] }],
  commandPattern: /\bgit\b/,
  parse: parseGitConflicts,
};
