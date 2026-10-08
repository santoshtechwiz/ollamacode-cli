import { FAILURE_KIND } from '../protocol';
import type { FailureKind } from '../protocol';

/** Recovery prompts never claim unproven tool runs, never count a no-op as progress, and never force a retry that needs inspection first. */

const MAX_TOOL_NAME_LENGTH = 120;
const MAX_PATH_LENGTH = 240;
const MAX_REASON_LENGTH = 500;

function clean(value: unknown, maxLength: number): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export const RESUME_TRUNCATED_ANSWER =
  'The previous response was truncated. Continue from the recorded conversation state; do not repeat text, repeat a completed tool call, or invent a missing tool result.';

export interface CompletedStep {
  tool: string;
  target?: string;
}

export function resumeNote(completedSteps: readonly CompletedStep[]): string {
  if (!Array.isArray(completedSteps) || completedSteps.length === 0) return '';

  const lines = completedSteps
    .map((step) => {
      const tool = clean(step?.tool, MAX_TOOL_NAME_LENGTH);
      const target = clean(step?.target, MAX_PATH_LENGTH);
      return tool ? `  - ${tool}${target ? ` ${target}` : ''}` : '';
    })
    .filter(Boolean);

  if (!lines.length) return '';

  return (
    'RESUMING AN INTERRUPTED TASK. The execution ledger records these steps as completed. ' +
    'Do not repeat them unless a later verification explicitly shows they did not take effect. Continue from the first uncompleted step:\n' +
    lines.join('\n')
  );
}

const FAILURE_IMPLICATIONS: Record<FailureKind, string> = {
  [FAILURE_KIND.NOT_FOUND]: 'target not found',
  [FAILURE_KIND.PERMISSION]: 'permission denied',
  [FAILURE_KIND.EXISTS]: 'target already exists',
  [FAILURE_KIND.IS_DIR]: 'target is a directory',
  [FAILURE_KIND.NOT_DIR]: 'target is a file where a directory was expected',
  [FAILURE_KIND.IS_DIR_INTENT]: 'directory operation required',
  [FAILURE_KIND.TIMEOUT]: 'operation timed out',
  [FAILURE_KIND.EXIT_FAILURE]: 'command exited unsuccessfully',
  [FAILURE_KIND.ARGUMENT]: 'invalid arguments',
  [FAILURE_KIND.BLOCKED]: 'operation blocked',
  [FAILURE_KIND.NOT_CHANGE]: 'no change',
  [FAILURE_KIND.TOO_LARGE]: 'input too large',
  [FAILURE_KIND.UNKNOWN]: 'unknown failure',
};

export function failureImplication(kind: FailureKind): string {
  return FAILURE_IMPLICATIONS[kind] ?? FAILURE_IMPLICATIONS[FAILURE_KIND.UNKNOWN];
}

/** Told to the model when the request names an MCP server that is not connected. */
export function mcpServerUnavailable(names: readonly string[]): string {
  const asked = names.map((n) => clean(n, MAX_REASON_LENGTH)).filter(Boolean);
  if (!asked.length) return '';
  const list = asked.map((n) => `"${n}"`).join(', ');
  return (
    `The request asks for the ${list} MCP server, which is not connected in this session — none of its tools exist here. ` +
    'Do not substitute a different tool and describe the result as though it came from that server. ' +
    'Either do the work with the tools that are actually listed and say plainly which server was unavailable and what you used instead, ' +
    'or report that the request cannot be carried out as asked.'
  );
}
