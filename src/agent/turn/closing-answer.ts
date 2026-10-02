// The way out of the stuck-loop guard: one last tool-free request for a plain account of the turn.

import { ROLE } from '../../protocol';
import type { ModelGateway } from '../../model/gateway';
import type { ContextStore } from '../../context/contracts';
import type { Message } from '../../types';
import { buildModelRequest } from '../../context/builder';
import { isCancel } from '../../core/errors';
import { logger } from '../../core/logger';
import type { TurnCallbacks } from './turn';

/** The door out of the stuck-loop guard. */
const CLOSING_INSTRUCTION = `TOOLS
No further tool can run for this task, so do not request another one.

Using only the results already above, reply in plain prose: what you did, what the outcome was,
and anything still outstanding. If the task did not finish, say plainly what remains.`;

/** Plain prose still needs a whole paragraph of room, so a closing reply never asks for less. */
const CLOSING_REPLY_BUDGET = 4096;

interface ClosingAnswerParams {
  history: ContextStore;
  systemMessages: Message[];
  workspaceState: any;
  toolProfile: { core?: boolean; readOnly?: boolean };
  config: any;
  capacityTokens?: number;
  signal?: AbortSignal;
  callbacks: TurnCallbacks;
}

/** The model's own summary of the turn, or undefined when it cannot be had. A cancel ends the turn, as on every other model call. */
export async function closingAnswer(
  gateway: ModelGateway,
  { history, systemMessages, workspaceState, toolProfile, config, capacityTokens, signal, callbacks }: ClosingAnswerParams,
): Promise<string | undefined> {
  // The gateway asks for max(config.maxTokens, replyBudget), so the request below has to be
  // sized against that same number. Sizing it against the bare config value leaves the reply
  // asking for tokens the prompt never kept room for, and a tight window rejects the call.
  const replyBudget = Math.max(Number(config.maxTokens) || 0, CLOSING_REPLY_BUDGET);

  try {
    const request = await buildModelRequest({
      systemMessages: [...systemMessages, { role: ROLE.SYSTEM, content: CLOSING_INSTRUCTION }],
      store: history,
      tools: [],
      modelLimits: {
        contextWindow: Number(config.contextWindow) || undefined,
        maxOutputTokens: replyBudget,
      },
      capacityTokens,
      state: workspaceState,
      textMode: false,
      core: toolProfile.core,
      readOnly: toolProfile.readOnly,
      includeWorkspaceSnapshot: false,
      meta: { model: gateway.model, provider: gateway.provider?.id },
    });

    // The turn's own record goes as it is. Every rewrite of it into prose (`Called X`, `- X — worked`,
    // results indented under each step) was copied back as the answer by some model; the real exchange
    // is what every model already reads as context. A model that calls a tool anyway leaves no text,
    // and the turn ends with its own report instead.
    const called = await gateway.stream({
      messages: request.messages,
      tools: [],
      signal,
      think: false,
      replyBudget,
      onDelta: callbacks.onDelta,
      onStatus: callbacks.onStatus,
      toolsInPrompt: false,
    });

    return String(called.result?.content ?? '').trim() || undefined;
  } catch (err) {
    // The same rule as the turn's own model call: a cancelled request is the person stopping the turn, not a missing summary.
    if (signal?.aborted || isCancel(err)) throw err;
    logger.debug('closing answer unavailable — the turn ends without one', { error: (err as Error)?.message ?? err });
    return undefined;
  }
}
