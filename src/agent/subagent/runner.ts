// A subagent is a turn run on its own conversation: plan mode's exploration, started by a tool call. It reuses the
// parent's model gateway, tool runner, approvals and workspace state; it gets its own history, its role's tools and
// step budget, and a time limit. What it answers is what the parent's delegate_task call returns.

import { ROLE, STOP_REASONS, TOOL_ERROR_CODE } from '../../protocol';
import { CancelError } from '../../core/errors';
import { ContextStore } from '../../context/store';
import { selectToolDefs, type ToolProfile } from '../../context/tool-surface';
import { fail } from '../../tool/core/tool-result';
import { CHILD_EXCLUDED_TOOLS, MAX_DELEGATIONS_PER_TURN, SUBAGENT_ROLES } from './roles';

type TurnResult = import('../../protocol.ts').TurnResult;
type Message = import('../../types.ts').Message;
type ToolExecutor = import('../../tool/execution/executor.ts').ToolExecutor;

export interface DelegateRequest {
  role: string;
  task: string;
  /** What the child needs to know that is not in the task: the parent's findings, constraints, file names. */
  context?: string;
}

export interface SubagentResult {
  ok: boolean;
  role: string;
  /** The child's own answer, its report to the parent; partial when it did not finish. */
  answer: string;
  stopReason: string;
  /** Files the child created, changed or deleted, as the session recorded them. */
  filesChanged: string[];
  /** Tools the child ran, each once, in the order first used. */
  toolsUsed: string[];
  steps: number;
  /** Why it did not finish, in words; set only when ok is false. */
  error?: string;
}

export type DelegateFn = (request: DelegateRequest, signal?: AbortSignal) => Promise<SubagentResult>;

/** What a child turn shares with its parent, taken from the parent's own runTurn parameters. */
export interface ParentTurn {
  provider?: any;
  model: string;
  systemMessages: Message[];
  budgetTokens?: number;
  toolProfile: ToolProfile;
  config: any;
  cwd: string;
  state: any;
  approve?: any;
  gateway?: any;
  toolRunner: ToolExecutor;
  callbacks?: Record<string, any>;
}

/** One child's conversation, kept on the session beside plan explorations so its calls can be diagnosed later. */
export interface SubagentRun {
  role: string;
  task: string;
  messages: Message[];
}

/**
 * The parent's delegate function. `runChild` is runTurn itself, passed in so this module never imports the turn
 * that imports it; a test passes its own.
 */
export function createSubagentRunner(parent: ParentTurn, runChild: (params: any) => Promise<TurnResult>): DelegateFn {
  let started = 0;

  return async (request, signal) => {
    const role = SUBAGENT_ROLES[String(request.role ?? '')];
    const refused = (error: string): SubagentResult => ({
      ok: false, role: String(request.role ?? ''), answer: '', stopReason: 'refused', filesChanged: [], toolsUsed: [], steps: 0, error,
    });
    if (!role) return refused(`there is no "${request.role}" subagent; the roles are ${Object.keys(SUBAGENT_ROLES).join(', ')}`);
    if (!String(request.task ?? '').trim()) return refused('the task is empty');
    if (started >= MAX_DELEGATIONS_PER_TURN) return refused(`this turn already started ${MAX_DELEGATIONS_PER_TURN} subagents, the most one turn may`);
    started += 1;

    // The role's tools, and only those: a call to anything else is refused at the child's own runner, so the limit
    // holds even where the model is sent no tool list to keep it to (text mode).
    const profile: ToolProfile = { ...parent.toolProfile, readOnly: role.readOnly, exclude: CHILD_EXCLUDED_TOOLS };
    const allowed = new Set(selectToolDefs(profile).map((def) => def.name));
    const toolRunner: ToolExecutor = {
      run: async (name, args, opts) => allowed.has(name)
        ? parent.toolRunner.run(name, args, opts)
        : { result: fail(`${name} is not available to a ${role.id} subagent`, { code: TOOL_ERROR_CODE.EPOLICY, hint: `Use only these tools: ${[...allowed].join(', ')}.` }), timedOut: false, durationMs: 0 },
    };

    // The parent stopping stops the child; the role's time limit stops only the child.
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    signal?.addEventListener('abort', onParentAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, role.timeoutMs);

    const history = new ContextStore({ budgetTokens: parent.budgetTokens });
    history.addUser(request.context ? `${request.task}\n\nContext from the agent that delegated this:\n${request.context}` : request.task);
    const changesBefore = (parent.state?.changes ?? []).length;
    const callbacks = parent.callbacks ?? {};

    let turn: TurnResult | undefined;
    try {
      turn = await runChild({
        provider: parent.provider,
        model: parent.model,
        history,
        systemMessages: [...parent.systemMessages, { role: ROLE.SYSTEM, content: role.instruction }],
        toolsEnabled: true,
        toolProfile: { ...profile, always: [...allowed] },
        config: { ...parent.config, maxIterations: role.maxIterations },
        cwd: parent.cwd,
        state: parent.state,
        signal: controller.signal,
        approve: parent.approve,
        gateway: parent.gateway,
        toolRunner,
        // The person sees what the child does; its answer is the parent's to read, so it is not streamed as one.
        callbacks: {
          onToolStart: callbacks.onToolStart,
          onToolResult: callbacks.onToolResult,
          onCommandOutput: callbacks.onCommandOutput,
          onTelemetry: callbacks.onTelemetry,
          onStatus: callbacks.onStatus && ((text: string) => callbacks.onStatus(`${role.id} subagent: ${text}`)),
        },
        subagentDepth: 1,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onParentAbort);
      if (parent.state) {
        const run: SubagentRun = { role: role.id, task: request.task, messages: history.messages };
        parent.state.subagentRuns = [...(parent.state.subagentRuns ?? []), run];
      }
    }
    if (signal?.aborted) throw new CancelError();

    const answer = String(turn?.content ?? '').trim();
    const stopReason = timedOut ? 'timed_out' : String(turn?.stopReason ?? STOP_REASONS.COMPLETE);
    const toolsUsed = [...new Set((turn?.toolResults ?? []).map((t) => t.name))];
    const filesChanged: string[] = [...new Set<string>((parent.state?.changes ?? []).slice(changesBefore).map((c: { path: string }) => String(c.path)))];
    const finished = !timedOut && stopReason === STOP_REASONS.COMPLETE && answer !== '';
    return {
      ok: finished,
      role: role.id,
      answer,
      stopReason,
      filesChanged,
      toolsUsed,
      steps: Number(turn?.iterations ?? 0),
      ...(finished ? {} : { error: unfinished(stopReason, role.timeoutMs, answer) }),
    };
  };
}

function unfinished(stopReason: string, timeoutMs: number, answer: string): string {
  if (stopReason === 'timed_out') return `it ran out of time after ${Math.round(timeoutMs / 1000)}s`;
  if (stopReason === STOP_REASONS.MAX_ITERATIONS) return 'it used all its steps without finishing';
  if (stopReason === STOP_REASONS.GUARD_STUCK) return 'it kept repeating the same step';
  if (!answer) return 'it ended without an answer';
  return `it stopped (${stopReason})`;
}
