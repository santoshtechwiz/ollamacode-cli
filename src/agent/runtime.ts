import { STOP_REASONS, isIncompleteStop, EPHEMERAL_SESSION } from '../protocol';
import { createCheckpointStore, emptyCheckpoint, describeCompletedWork, describeStepTarget } from './checkpoint';
import { createModelGateway } from '../model/gateway';
import { createExecutor } from '../tool/execution/executor';
import { isCancel } from '../core/errors';
import { fileTargetArg } from '../tool/index';
import { defaultRegistry } from '../tool/execution/registry';
import { logger } from '../core/logger';
import { newTaskId } from '../core/ids';
import { executeTurn } from './turn/index';

/** A call goes on the resumable step ledger when it can change something: its definition says so, or it names a file. */
function isRecordedTool(name: string, args: Record<string, unknown>): boolean {
  const def = defaultRegistry.find(name);
  return Boolean(def?.risky || def?.runsCode) || fileTargetArg(name, args) !== null;
}

export class AgentRuntime {
  provider: any;
  model: any;
  config: any;
  workspace: any;
  history: any;
  agentState: any;
  gateway: any;
  store: any;
  checkpoint: any;

  constructor({ provider, model, config, workspace, history, agentState, checkpoints = true }: any) {
    this.provider = provider;
    this.model = model;
    this.config = config;
    this.workspace = workspace;
    this.history = history;
    this.agentState = agentState;
    this.gateway = createModelGateway({
      provider,
      model,
      config,
      tunnel: Boolean(workspace?.tunnel),
    });
    const root = workspace?.state?.root ?? workspace?.cwd;
    const sessionId = workspace?.state?.sessionId;
    this.store = checkpoints && root && sessionId && sessionId !== EPHEMERAL_SESSION
      ? createCheckpointStore({ root, sessionId })
      : null;
    this.checkpoint = this.store?.load() ?? null;
    if (this.checkpoint?.resumable && this.checkpoint.pendingOutputContinuation && workspace?.state) {
      workspace.state.pendingOutputContinuation = true;
    }
  }

  useModel({ provider, model }: any) {
    if (provider) this.provider = provider;
    if (model) this.model = model;
    this.gateway = createModelGateway({
      provider: this.provider,
      model: this.model,
      config: this.config,
      tunnel: Boolean(this.workspace?.tunnel),
    });
  }

  resumable(): import('./checkpoint.ts').Checkpoint | null {
    return this.checkpoint?.resumable ? this.checkpoint : null;
  }

  resumeNote(): string {
    return describeCompletedWork(this.resumable());
  }

  clearCheckpoint() {
    this.checkpoint = null;
    this.store?.clear();
  }

  async execute(params: any): Promise<import('../protocol.ts').TurnResult> {
    const { input, signal, systemExtra = [], resume = true, continuing = false, ...rest } = params;

    if ((rest.provider && rest.provider !== this.provider) || (rest.model && rest.model !== this.model)) {
      this.useModel({ provider: rest.provider, model: rest.model });
    }

    const resuming = resume && Boolean(this.resumable()?.task);
    const sameTask = Boolean(this.agentState?.taskId) && (continuing || resuming);
    const taskId = sameTask ? String(this.agentState.taskId) : newTaskId();
    if (this.agentState) this.agentState.taskId = taskId;
    if (this.workspace?.state) this.workspace.state.taskId = taskId;
    // Per-turn allowances (the question ask_user may put to the person) start over with each turn.
    this.workspace?.state?.startTurn?.();
    params.onTaskStart?.();
    logger.debug(`turn: session=${this.workspace?.state?.sessionId ?? '-'} task=${taskId}`);

    const carriedSteps = this.checkpoint?.resumable ? [...(this.checkpoint.completed ?? [])] : [];
    const steps: any[] = [];
    const onStepComplete = ({ name, args, result }: any) => {
      // Only a step that can change something goes on the resume ledger; every step reaches the caller (the task list
      // redraws when todo_write or an approved plan sets it).
      if (isRecordedTool(name, args)) {
        steps.push({ tool: name, target: describeStepTarget(args), ok: Boolean(result?.ok), at: Date.now() });
        this.#persist({ input, taskId, carriedSteps, steps, stopReason: '', resumable: true, partialAnswer: '' });
      }
      params.onStepComplete?.({ name, args, result });
    };

    // The steps an interrupted turn completed are told to the model only when the person asks to continue it;
    // any other message is a request of its own, and calling it a resume misleads the model.
    const carried = resume && continuing ? this.resumeNote() : '';
    const system = carried ? [...systemExtra, { role: ('system' as const), content: carried }] : systemExtra;

    let turnInput = input;
    const pending = resume ? this.resumable() : null;
    if (pending?.task && continuing && this.history.messages.length === 0) {
      turnInput = `Continue this task, which was interrupted before it finished: ${pending.task}`;
    }

    try {
      const result = await executeTurn({
        ...rest,
        input: turnInput,
        continuing,
        signal,
        systemExtra: system,
        resumeAvailable: Boolean(carried),
        provider: this.provider,
        model: this.model,
        config: this.config,
        workspace: this.workspace,
        history: this.history,
        agentState: this.agentState,
        gateway: this.gateway,
        toolRunner: rest.toolRunner ?? this.#toolRunner(rest),
        onStepComplete,
      });

      const resumable = isIncompleteStop(result.stopReason);
      if (resumable) {
        this.#persist({
          input,
          taskId,
          carriedSteps,
          steps,
          stopReason: result.stopReason,
          resumable: true,
          partialAnswer: result.stopReason === STOP_REASONS.OUTPUT_TRUNCATED ? (result.content ?? '') : '',
        });
      } else {
        this.clearCheckpoint();
      }
      return result;
    } catch (err) {
      if (isCancel(err)) {
        this.#persist({ input, taskId, carriedSteps, steps, stopReason: STOP_REASONS.CANCELLED, resumable: false, partialAnswer: '' });
      } else {
        logger.debug(`turn failed: ${ (err as Error)?.message ?? err}`);
        this.#persist({ input, taskId, carriedSteps, steps, stopReason: 'error', resumable: steps.length > 0, partialAnswer: '' });
      }
      throw err;
    }
  }

  #toolRunner(rest: any) {
    return createExecutor({
      root: this.workspace.cwd,
      state: this.workspace.state,
      timeoutMs: this.config.toolTimeoutMs,
      approve: rest.approve,
      ask: rest.ask,
      onCommandOutput: rest.onCommandOutput,
    });
  }


  #persist({ input, taskId, carriedSteps, steps, stopReason, resumable, partialAnswer }: any) {
    if (!this.store) return;
    const base = this.checkpoint ?? emptyCheckpoint(this.store.root, this.store.sessionId);
    const next = {
      ...base,
      sessionId: this.store.sessionId,
      taskId: taskId ?? base.taskId ?? '',
      task: input || base.task,
      stopReason,
      resumable,
      completed: [...carriedSteps, ...steps],
      partialAnswer,
      pendingOutputContinuation: stopReason === STOP_REASONS.OUTPUT_TRUNCATED,
      provider: this.provider?.id ?? null,
      model: this.model ?? null,
      updatedAt: Date.now(),
    };
    this.store.save(next);
    this.checkpoint = next;
  }
}

export function createAgentRuntime(p: ConstructorParameters<typeof AgentRuntime>[0]): AgentRuntime {
  return new AgentRuntime(p);
}
