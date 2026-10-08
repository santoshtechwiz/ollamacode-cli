// A subagent is a turn run on its own conversation: plan mode's exploration, started by a tool call. It reuses the
// parent's model gateway, tool runner, approvals and workspace state; it gets its own history, its role's tools and
// step budget, and a time limit. What it answers is what the parent's delegate_task call returns.

import { ROLE, STOP_REASONS, TOOL_ERROR_CODE } from '../../protocol';
import { CancelError, isCancel } from '../../core/errors';
import { ContextStore } from '../../context/store';
import { changeMark, changedSince } from '../../context/workspace-state';
import { selectToolDefs, type ToolProfile } from '../../context/tool-surface';
import { fail } from '../../tool/core/tool-result';
import { CHILD_EXCLUDED_TOOLS, MAX_DELEGATIONS_PER_TURN, allRoles, type SubagentRole } from './roles';

type TurnResult = import('../../protocol.ts').TurnResult;
type Message = import('../../types.ts').Message;
type ToolResult = import('../../types.ts').ToolResult;
type ToolExecutor = import('../../tool/execution/executor.ts').ToolExecutor;
type ApproveFn = import('../../tool/policy/permission-policy.ts').ApproveFn;

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
  /** Paths its successful calls were about (files read, folders listed), each once, in order. */
  lookedAt: string[];
  steps: number;
  /** Why it did not finish, in words; set only when ok is false. */
  error?: string;
  /** Set when no child was started: how the delegate call reports it, and what the parent should do instead. */
  refusal?: { code: string; hint: string };
}

/** `approve` is the delegate call's own, which stops that call's clocks while the person answers; the parent's otherwise. */
export type DelegateFn = (request: DelegateRequest, signal?: AbortSignal, approve?: ApproveFn) => Promise<SubagentResult>;

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
 * that imports it; a test passes its own. `roles` defaults to the built-in ones.
 */
export function createSubagentRunner(
  parent: ParentTurn,
  runChild: (params: any) => Promise<TurnResult>,
  roles: Readonly<Record<string, SubagentRole>> = allRoles(),
): DelegateFn {
  let started = 0;

  return async (request, signal, approveCall) => {
    const role = roles[String(request.role ?? '')];
    const refused = (error: string, code: string, hint: string): SubagentResult => ({
      ok: false, role: String(request.role ?? ''), answer: '', stopReason: 'refused', filesChanged: [], toolsUsed: [], lookedAt: [], steps: 0, error,
      refusal: { code, hint },
    });
    // A request it could start with other arguments says how; one past the limit says the work is the parent's now.
    if (!role) return refused(`there is no "${request.role}" subagent; the roles are ${Object.keys(roles).join(', ')}`, TOOL_ERROR_CODE.EINVAL, `Use one of these roles: ${Object.keys(roles).join(', ')}.`);
    if (!String(request.task ?? '').trim()) return refused('the task is empty', TOOL_ERROR_CODE.EINVAL, 'Say what the subagent should do in task.');
    if (started >= MAX_DELEGATIONS_PER_TURN) {
      return refused(
        `this turn already started ${MAX_DELEGATIONS_PER_TURN} subagents, the most one turn may`,
        TOOL_ERROR_CODE.EBLOCKED,
        'Do this part yourself with your own tools, and use the reports you already have; no more subagents can start in this turn.',
      );
    }
    started += 1;
    // Read-only children can run side by side; a numbered name keeps each one's lines apart on screen.
    const label = `${role.id} ${started}`;

    // The role's tools, and only those: a call to anything else is refused at the child's own runner, so the limit
    // holds even where the model is sent no tool list to keep it to (text mode).
    const profile: ToolProfile = { ...parent.toolProfile, readOnly: role.readOnly, include: role.also ?? [], exclude: CHILD_EXCLUDED_TOOLS };
    const allowed = new Set(selectToolDefs(profile).map((def) => def.name));
    const toolRunner: ToolExecutor = {
      run: async (name, args, opts) => allowed.has(name)
        ? parent.toolRunner.run(name, args, opts)
        // Not run, so not a failure: a dim line for the person, and for the model what it can use instead.
        : {
          result: fail(`${name} is not available to a ${role.id} subagent — not run`, {
            code: TOOL_ERROR_CODE.EBLOCKED,
            hint: `This role cannot use ${name}. Do the task with these tools: ${[...allowed].join(', ')}; if it needs ${name}, say so in your report.`,
          }),
          timedOut: false,
          durationMs: 0,
        },
    };

    // The parent stopping stops the child; the role's time limit stops only the child.
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    signal?.addEventListener('abort', onParentAbort, { once: true });
    // The time limit counts the child's work, not the person reading an approval: its clock stands still while one is open.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let leftMs = role.timeoutMs;
    let runningSince = Date.now();
    const startClock = () => {
      runningSince = Date.now();
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, leftMs);
    };
    const stopClock = () => {
      leftMs = Math.max(0, leftMs - (Date.now() - runningSince));
      clearTimeout(timer);
    };
    const ask = approveCall ?? parent.approve;
    let asking = 0;
    const approve: ApproveFn | undefined = ask && (async (...a: Parameters<ApproveFn>) => {
      if (asking++ === 0) stopClock();
      try {
        return await ask(...a);
      } finally {
        if (--asking === 0 && !controller.signal.aborted) startClock();
      }
    });
    startClock();

    const history = new ContextStore({ budgetTokens: parent.budgetTokens });
    history.addUser(request.context ? `${request.task}\n\nContext from the agent that delegated this:\n${request.context}` : request.task);
    const changesBefore = changeMark(parent.state);
    const callbacks = parent.callbacks ?? {};
    // The child's tool lines carry its name, and two notes mark where its work starts and ends.
    const brief = request.task.replace(/\s+/g, ' ').trim();
    callbacks.note?.(`${label} started: ${brief.length > 90 ? `${brief.slice(0, 89)}…` : brief}`, 'dim');

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
        approve,
        gateway: parent.gateway,
        toolRunner,
        // The person sees what the child does; its answer is the parent's to read, so it is not streamed as one.
        callbacks: {
          onToolStart: callbacks.onToolStart && ((name: string, args: Record<string, unknown>) => callbacks.onToolStart(name, args, label)),
          onToolResult: callbacks.onToolResult && ((name: string, args: Record<string, unknown>, result: ToolResult) => callbacks.onToolResult(name, args, result, label)),
          onCommandOutput: callbacks.onCommandOutput,
          onTelemetry: callbacks.onTelemetry,
          onStatus: callbacks.onStatus && ((text: string) => callbacks.onStatus(`${label}: ${text}`)),
        },
        subagentDepth: 1,
      });
    } catch (err) {
      // The time limit can land mid model call, which throws a cancel; that is the child running out of time, not the
      // person stopping the turn, so it settles as a timed-out result below.
      if (!(timedOut && isCancel(err) && !signal?.aborted)) throw err;
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
    // A child that ends without a report still read what it read: the parent can start from there instead of from nothing.
    const lookedAt = [...new Set((turn?.toolResults ?? []).filter((t) => t.result?.ok && typeof t.result?.data?.path === 'string').map((t) => String(t.result.data.path)))];
    const filesChanged = changedSince(parent.state, changesBefore);
    const finished = !timedOut && stopReason === STOP_REASONS.COMPLETE && answer !== '';
    const steps = Number(turn?.iterations ?? 0);
    // An unfinished child is reported once, by the delegate call's own result line; a note here would say it twice.
    if (finished) {
      const touched = filesChanged.length ? `changed ${filesChanged.join(', ')}` : 'changed no files';
      callbacks.note?.(`${label} finished · ${steps} step${steps === 1 ? '' : 's'} · ${touched}`, 'success');
    }
    return {
      ok: finished,
      role: role.id,
      answer,
      stopReason,
      filesChanged,
      toolsUsed,
      lookedAt,
      steps,
      ...(finished ? {} : { error: unfinished(stopReason, role, answer) }),
    };
  };
}

function unfinished(stopReason: string, role: SubagentRole, answer: string): string {
  if (stopReason === 'timed_out') return `it ran out of time after ${Math.round(role.timeoutMs / 1000)}s`;
  if (stopReason === STOP_REASONS.MAX_ITERATIONS) return `it used all ${role.maxIterations} of its steps`;
  // A denied step and the same call three times in a row both end a turn this way: say what is true of both.
  if (stopReason === STOP_REASONS.GUARD_STUCK) return 'it stopped: a step was not allowed, or it made the same call three times in a row';
  if (!answer) return 'it ended without an answer';
  return `it stopped (${stopReason})`;
}
