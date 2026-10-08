import { TOOL_ERROR_CODE, TOOL_NAME, TOOL_RESULT_STATUS } from '../../protocol';
import { isCancel } from '../../core/errors';
import { defineTool } from '../../tool/core/defineTool';
import { ok, fail } from '../../tool/core/tool-result';
import { allRoles } from './roles';
import type { SubagentResult } from './runner';

// Read once, when the tool is defined: roles added in agent.subagentRoles take effect on the next start.
const roles = Object.values(allRoles());

/** The line under the child's answer that says what it touched, so the parent does not do it again. */
function footer(r: SubagentResult): string {
  const files = r.filesChanged.length ? `changed ${r.filesChanged.join(', ')}` : 'changed no files';
  const tools = r.toolsUsed.length ? `used ${r.toolsUsed.join(', ')}` : 'used no tools';
  return `[${r.role} subagent · ${r.steps} step${r.steps === 1 ? '' : 's'} · ${files} · ${tools}]`;
}

export default defineTool({
  name: TOOL_NAME.DELEGATE_TASK,
  profiles: ['core'],
  category: 'agent',
  activity: 'Delegating to a subagent',
  label: 'Delegate',
  brief: `Hand a self-contained task to a subagent and get its report back. Roles: ${roles.map((r) => r.id).join(', ')}.`,
  description:
    'Hand a self-contained task to a subagent, which works on it in its own conversation and returns a report. ' +
    'Use it for work that would fill your context or that stands alone; it cannot see this conversation, so put ' +
    'everything it needs in task and context. Roles: ' +
    roles.map((r) => `${r.id} — ${r.summary}`).join('; ') +
    '. A subagent cannot ask the user or start subagents of its own. Its file changes are real: do not redo them. ' +
    'Its report comes back to you, not to the user, who sees only its first line: to show the user what it found, ' +
    'say it in your answer — the findings themselves, not only that it ran. ' +
    'Independent read-only tasks (research, review) sent together in one reply run at the same time; tasks that change files run one at a time.',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: roles.map((r) => r.id), description: 'Which kind of subagent' },
      task: { type: 'string', description: 'What it should do, complete enough to act on without this conversation' },
      context: { type: 'string', description: 'Optional: what you already know that it needs (findings, file names, constraints)' },
    },
    required: ['role', 'task'],
  },

  preview(args) {
    return `${String(args?.role ?? 'subagent')}: ${String(args?.task ?? '').slice(0, 80)}`;
  },

  // A read-only child changes nothing another child reads, so several run together; one that edits files waits its turn.
  concurrent(args) {
    return allRoles()[String(args?.role ?? '')]?.readOnly === true;
  },

  async execute(args, ctx) {
    if (typeof ctx.delegate !== 'function') {
      return fail('Subagents are not available in this turn.', {
        code: TOOL_ERROR_CODE.ENOTSUPPORTED,
        hint: 'Do the task yourself with the tools you have.',
      });
    }
    let r: SubagentResult;
    try {
      r = await ctx.delegate({ role: String(args.role ?? ''), task: String(args.task ?? ''), context: args.context ? String(args.context) : undefined }, ctx.signal, ctx.approve);
    } catch (err) {
      // The person stopping the turn is not the subagent failing: the runtime records it as a cancel.
      if (isCancel(err)) throw err;
      return fail(`The subagent failed: ${err instanceof Error ? err.message : String(err)}`, { code: TOOL_ERROR_CODE.EUNKNOWN });
    }
    if (!r.ok) {
      // Unfinished work still carries what it found and what it changed; the parent decides what to do with it.
      const partial = r.answer
        ? `\nWhat it reported before it stopped:\n${r.answer}`
        : r.lookedAt?.length
          ? `\nIt wrote no report. It had looked at: ${r.lookedAt.join(', ')}`
          : '';
      const refused = r.refusal;
      return fail(refused ? `The subagent was not started: ${r.error}.` : `The ${r.role} subagent stopped before finishing: ${r.error ?? r.stopReason}.`, {
        code: refused ? refused.code : TOOL_ERROR_CODE.EUNKNOWN,
        // What it got done before it stopped is real (its reads, its file changes): partial work, not a failed call.
        status: refused ? undefined : TOOL_RESULT_STATUS.PARTIAL,
        hint: refused
          ? refused.hint
          : 'Check its changes before relying on them, then finish the task yourself or delegate a smaller part of it.',
        display: refused ? undefined : `${footer(r)}${partial}`,
        data: r,
      });
    }
    return ok({ kind: 'text', display: `${r.answer}\n\n${footer(r)}`, data: r });
  },
});
