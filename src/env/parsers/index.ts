import type { Diagnostic } from '../../types';
import { dedupe } from './shared';
import { parseJest, parseMocha, parseNodeRuntime, parseNodeTest, parseTypeScript, parseVitest } from './javascript';
import { parsePytest } from './python';
import { parseDotnet } from './dotnet';
import { parseCargo } from './cargo';
import { parseGo } from './go';
import { parseTerraform } from './terraform';
import { parseGitConflicts } from './git';

/** One tool's output turned into file/line diagnostics. */
export interface OutputParser {
  id: string;
  /** Stack ids whose commands produce this output. */
  stacks: readonly string[];
  /** Commands whose output it reads, whatever the stack. */
  commandPattern: RegExp;
  parse: (output: string) => Diagnostic[];
}

const NODE_COMMANDS = /\b(?:node|npm|npx|pnpm|yarn|tsc|jest|vitest|mocha)\b/;

// Every tool whose output ocode reads. A new test runner or compiler is one parser file and one entry here.
export const OUTPUT_PARSERS: readonly OutputParser[] = [
  { id: 'tsc', stacks: ['node'], commandPattern: NODE_COMMANDS, parse: parseTypeScript },
  { id: 'node-test', stacks: ['node'], commandPattern: NODE_COMMANDS, parse: parseNodeTest },
  { id: 'jest', stacks: ['node'], commandPattern: NODE_COMMANDS, parse: parseJest },
  { id: 'vitest', stacks: ['node'], commandPattern: NODE_COMMANDS, parse: parseVitest },
  { id: 'mocha', stacks: ['node'], commandPattern: NODE_COMMANDS, parse: parseMocha },
  { id: 'node-runtime', stacks: ['node'], commandPattern: NODE_COMMANDS, parse: parseNodeRuntime },
  { id: 'pytest', stacks: ['python'], commandPattern: /pytest|python/, parse: parsePytest },
  { id: 'dotnet', stacks: ['dotnet'], commandPattern: /dotnet\b/, parse: parseDotnet },
  { id: 'cargo', stacks: ['rust'], commandPattern: /\b(?:cargo|rustc)\b/, parse: parseCargo },
  { id: 'go', stacks: ['go'], commandPattern: /\bgo\s+(?:test|build|vet|run)\b/, parse: parseGo },
  { id: 'terraform', stacks: ['terraform'], commandPattern: /terraform\b/, parse: parseTerraform },
  { id: 'git-conflicts', stacks: ['git'], commandPattern: /\bgit\b/, parse: parseGitConflicts },
];

/** Diagnostics from tool output, from every parser that belongs to the stack or recognises the command. */
export function parseForStack(text: string, stack: string | undefined, command: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const parser of OUTPUT_PARSERS) {
    if (!stack || parser.stacks.includes(stack) || parser.commandPattern.test(command)) out.push(...parser.parse(text));
  }
  return dedupe(out);
}
