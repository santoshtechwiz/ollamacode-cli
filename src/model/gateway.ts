import { AGENT_STATUS, PROVIDER_ERROR_CODE, REASONING_MIN_PREDICT, REASONING_RESERVE_FRACTION, REASONING_SECONDS_BUDGET } from '../protocol';
import { CancelError, ProviderError, isCancel } from '../core/errors';
import { validateProvider } from './providers/base';
import { sleep, backoffDelay } from './providers/http';
import { createChannelParser } from '../agent/response/channel-parser';
import { logger } from '../core/logger';
import { observePromptTokens, promptChars, charsPerToken, estimateTokens } from '../context/tokens';
import { recordUsage } from '../core/usage';

class ModelTimeoutError extends ProviderError {
  waitedMs: any;
  beforeFirstToken: any;

  constructor(waitedMs: number, { beforeFirstToken = false, cause }: any = {}) {
    super(
      `No response for ${Math.round(waitedMs / 1000)}s — the model may be stuck or the daemon unreachable`,
      { code: PROVIDER_ERROR_CODE.ETIMEDOUT, retryable: true, cause }
    );
    this.waitedMs = waitedMs;
    this.beforeFirstToken = beforeFirstToken;
  }
}

export class ContextOverflowError extends ProviderError {
  constructor(message: string, { cause }: any = {}) {
    super(message, { code: PROVIDER_ERROR_CODE.ECONTEXT_OVERFLOW, retryable: false, cause });
  }
}

class ToolsUnsupportedError extends ProviderError {
  constructor(message: string, { cause }: any = {}) {
    super(message, { code: PROVIDER_ERROR_CODE.ETOOLS_UNSUPPORTED, retryable: false, cause });
  }
}

export function isContextLengthError(err: unknown): boolean {
  if (err instanceof ContextOverflowError) return true;
  const message = String( (err as { message?: string; })?.message ?? '');
  return /context[_ ]?length|context window|maximum context|too many tokens|input is too long|prompt is too long|exceeds? the (?:model'?s? )?context/i.test(
    message
  );
}

/** What the trace log last showed of a request: each step resends the whole conversation and every tool schema. */
let lastTraced: { messages: string[]; tools: string } = { messages: [], tools: '' };

/** The request's messages and tools for the trace log, with what the previous request already showed left out. */
export function traceRequestBody(messages: readonly unknown[], tools: readonly unknown[]): void {
  const now = messages.map((m) => JSON.stringify(m));
  const shown: unknown[] = [];
  let runFrom = -1;
  const closeRun = (end: number) => {
    if (runFrom >= 0) shown.push(`<messages ${runFrom}-${end - 1}: same as the previous request>`);
    runFrom = -1;
  };
  now.forEach((json, i) => {
    if (json === lastTraced.messages[i]) {
      if (runFrom < 0) runFrom = i;
    } else {
      closeRun(i);
      shown.push(messages[i]);
    }
  });
  closeRun(now.length);
  logger.traceBlock('request.messages', JSON.stringify(shown, null, 2));
  const toolsJson = JSON.stringify(tools);
  if (tools.length) {
    logger.traceBlock(
      'request.tools',
      toolsJson === lastTraced.tools ? `<same ${tools.length} tool(s) as the previous request>` : JSON.stringify(tools, null, 2),
    );
  }
  lastTraced = { messages: now, tools: toolsJson };
}

class IdleTimer {
  idleMs: any;
  firstTokenMs: any;
  onIdle: any;
  timer: any;
  fired: any;
  sawFirstToken: any;

  constructor(idleMs: number, onIdle: () => void, firstTokenMs: number = idleMs) {
    this.idleMs = idleMs;
    this.firstTokenMs = Math.max(firstTokenMs, idleMs);
    this.onIdle = onIdle;
    this.timer = null;
    this.fired = false;
    this.sawFirstToken = false;
  }

  start() {
    this.stop();
    const wait = this.sawFirstToken ? this.idleMs : this.firstTokenMs;
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.fired = true;
        this.onIdle();
      }, wait);
    }
    return this;
  }

  kick() {
    if (this.fired) return;
    this.sawFirstToken = true;
    this.start();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface GatewayCallResult {
  result: import('../types.ts').StreamChatResult;
  attempt: number;
  retries: number;
  startedAt: number;
}

export class ModelGateway {
  provider: any;
  model: any;
  config: any;
  tunnel: any;

  constructor({ provider, model, config, tunnel = false }: any) {
    this.provider = validateProvider(provider);
    this.model = model;
    this.config = config;
    this.tunnel = Boolean(tunnel);
  }

  describe(): { providerId: string; label: string; model: string; } {
    return { providerId: this.provider.id, label: this.provider.label, model: this.model };
  }

  withModel(model: string): ModelGateway {
    return new ModelGateway({ provider: this.provider, model, config: this.config, tunnel: this.tunnel });
  }

  listModels(): Promise<{ name: string; size?: number; }[]> {
    return this.provider.listModels();
  }

  detect(): Promise<import('../types.ts').ProviderDetect> {
    return this.provider.detect();
  }

  timeouts(): { idleMs: number; firstTokenMs: number; } {
    const { idleTimeoutMs, firstTokenTimeoutMs } = this.config;
    return this.tunnel
      ? { idleMs: Math.min(idleTimeoutMs, 60_000), firstTokenMs: Math.min(firstTokenTimeoutMs, 90_000) }
      : { idleMs: idleTimeoutMs, firstTokenMs: firstTokenTimeoutMs };
  }

  async stream({ messages, tools = [], signal, onDelta, onReasoning, onStatus, think, replyBudget, toolsInPrompt = false, reasoningCarry = false }: any): Promise<GatewayCallResult> {
    const { config } = this;
    const { idleMs, firstTokenMs } = this.timeouts();
    const startedAt = Date.now();
    let lastError;
    let attempts = 0;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      attempts += 1;
      const controller = new AbortController();
      const idle = new IdleTimer(idleMs, () => controller.abort(), firstTokenMs);

      const onOuterAbort = () => controller.abort();
      if (signal?.aborted) throw new CancelError();
      signal?.addEventListener('abort', onOuterAbort, { once: true });

      // Cut off mid-<think>: the parser must open inside it too, or the tail streams as answer.
      const parser = createChannelParser(Boolean(reasoningCarry));
      let answerSoFar = '';
      // Two distinct sources, tracked separately so the final merge never adds the same text twice:
      // tagged reasoning the parser lifts out of the answer channel, and the provider's own native
      // reasoning channel (which the provider also accumulates itself into `result.reasoning`).
      let taggedReasoningSoFar = '';
      let nativeReasoningSoFar = '';
      const reasoningSoFar = () => taggedReasoningSoFar + nativeReasoningSoFar;

      const flushTail = () => {
        const tail = parser.flush();
        if (tail.reasoning) {
          taggedReasoningSoFar += tail.reasoning;
          onReasoning?.(tail.reasoning, reasoningSoFar());
        }
        if (tail.answer) onDelta?.(tail.answer, answerSoFar + tail.answer);
      };

      const traceSplit = (wire: string, split: { answer: string; reasoning: string; }) => {
        // One line per chunk is thousands per reply: only when stream debugging asks for it.
        if (process.env.OCODE_STREAM_DEBUG !== '1' || (!split.reasoning && !wire)) return;
        logger.trace(
          `[stream:gateway] assistant-wire +${wire.length}ch → answer +${split.answer.length}ch reasoning +${split.reasoning.length}ch`,
          { component: 'stream', stream: 'gateway' }
        );
      };

      try {
        idle.start();
        // Force the thinking channel only for models seen leaking tagged reasoning; untagged prose is the answer.
        const needsThinkingChannel =
          (Boolean(tools?.length) || Boolean(toolsInPrompt)) &&
          config.supportsThinking !== false &&
          config.reasoningLeaks === true;
        // Also bounded by what the backend can generate in REASONING_SECONDS_BUDGET: 2048 tokens at a measured 6 tok/s authorises five minutes for one reply.
        const byWindow =
          config.contextWindow > 0
            ? Math.min(REASONING_MIN_PREDICT, Math.floor(config.contextWindow * REASONING_RESERVE_FRACTION))
            : REASONING_MIN_PREDICT;
        const byRate =
          config.tokensPerSec && config.tokensPerSec > 0
            ? Math.max(256, Math.floor(config.tokensPerSec * REASONING_SECONDS_BUDGET))
            : byWindow;
        const reasoningCeiling = Math.min(byWindow, byRate);
        // One call may ask for more room than the session reserve.
        const askedBudget = Number(replyBudget) || 0;
        const boosted =
          askedBudget > 0
            ? Math.max(config.maxTokens ?? 0, askedBudget)
            : config.maxTokens;
        // Thinking is resolved per session; think overrides it for one call, which is how a reasoning-starved reply is retried.
        const willThink = needsThinkingChannel || Boolean(think ?? config.thinkingEnabled ?? false);
        const sampling = {
          temperature: config.temperature,
          // Any call that will think gets reasoning-sized room, whatever made it think.
          maxTokens: willThink ? Math.max(boosted ?? 0, reasoningCeiling) : boosted,
          contextWindow: config.contextWindow,
          keepAlive: config.keepAlive,
          think: needsThinkingChannel ? true : (think ?? config.thinkingEnabled ?? false),
        };

        // What the model is about to receive, in full.
        if (logger.enabled('trace')) {
          logger.traceBlock(
            `request ${this.provider.id}/${this.model} attempt ${attempts}`,
            JSON.stringify({ sampling, toolNames: tools.map((t: any) => t?.function?.name), messageCount: messages.length }, null, 2)
          );
          traceRequestBody(messages, tools);
        }

        const result = await this.provider.streamChat({
          model: this.model,
          messages,
          tools: tools.length ? tools : undefined,
          signal: controller.signal,
          sampling,
          onDelta: (delta: string) => {
            idle.kick(); // progress resets the idle clock
            // Assistant-channel text; the parser only lifts tagged reasoning out. Reasoning events never enter here.
            const split = parser.push(delta);
            traceSplit(delta, split);
            if (split.reasoning) {
              taggedReasoningSoFar += split.reasoning;
              onReasoning?.(split.reasoning, reasoningSoFar());
            }
            if (split.answer) {
              answerSoFar += split.answer;
              onDelta?.(split.answer, answerSoFar);
            }
          },
          onReasoning: (delta: string) => {
            idle.kick();
            nativeReasoningSoFar += delta;
            onReasoning?.(delta, reasoningSoFar());
          },
        });

        flushTail();
        // The provider echoes its own native channel back as `result.reasoning` — that is the same
        // text `nativeReasoningSoFar` already collected, so only the tag-lifted half is new here.
        // The answer kept is the one shown: the provider's raw content still carries reasoning tags, and history must not get them back.
        const whole = createChannelParser(Boolean(reasoningCarry));
        const split = [whole.push(String(result.content ?? '')), whole.flush()];
        const taggedReasoning = taggedReasoningSoFar || split.map((p) => p.reasoning).join('');
        const mergedReasoning = [result.reasoning || nativeReasoningSoFar, taggedReasoning].filter(Boolean).join('\n');
        const merged = { ...result, content: split.map((p) => p.answer).join(''), reasoning: mergedReasoning };

        // The only place a real token count is ever seen.
        const chars = promptChars(messages, tools);
        observePromptTokens(this.model, chars, merged.usage?.promptTokens);
        const reportedIn = merged.usage?.promptTokens;
        const reportedOut = merged.usage?.completionTokens;
        recordUsage(this.model, {
          sent: reportedIn ?? Math.ceil(chars / charsPerToken()),
          received: reportedOut ?? estimateTokens(`${merged.content ?? ''}${merged.reasoning ?? ''}${merged.toolCalls?.length ? JSON.stringify(merged.toolCalls) : ''}`),
          estimated: reportedIn == null || reportedOut == null,
        });
        if (logger.enabled('trace')) {
          logger.traceBlock(
            `response ${this.provider.id}/${this.model} in ${Date.now() - startedAt}ms`,
            JSON.stringify(
              {
                finishReason: merged.finishReason,
                usage: merged.usage,
                toolCalls: merged.toolCalls,
                reasoning: merged.reasoning,
                content: merged.content,
              },
              null,
              2
            )
          );
        }
        return {
          result: merged,
          attempt: attempts,
          retries: attempts - 1,
          startedAt,
        };
      } catch (err) {
        flushTail();

        if (signal?.aborted) throw new CancelError();

        lastError = this.classifyError(err, { idle, idleMs, firstTokenMs });

        const retryable = lastError instanceof ProviderError && lastError.retryable;
        if (!retryable || attempt >= config.maxRetries) throw lastError;

        const delay = backoffDelay(attempt);
        logger.debug(
          `provider call failed (${(lastError as Error).message}); retry ${attempt + 2}/${config.maxRetries + 1} in ${Math.round(delay)}ms`
        );
        onStatus?.(AGENT_STATUS.RECONNECTING);
        await sleep(delay);
      } finally {
        idle.stop();
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }

    throw lastError;
  }

  classifyError(err: unknown, { idle, idleMs, firstTokenMs }: any): Error {
    if (idle.fired) {
      const beforeFirstToken = !idle.sawFirstToken;
      return new ModelTimeoutError(beforeFirstToken ? firstTokenMs : idleMs, {
        beforeFirstToken,
        cause: err,
      });
    }
    if (isCancel(err)) return new CancelError();
    const code = (err as { code?: string; })?.code;
    if (code === 'ETOOLS_UNSUPPORTED') {
      return err instanceof ToolsUnsupportedError
        ? err
        : new ToolsUnsupportedError(String( (err as Error)?.message ?? err), { cause: err });
    }
    if (isContextLengthError(err)) {
      return err instanceof ContextOverflowError
        ? err
        : new ContextOverflowError(String( (err as Error)?.message ?? err), { cause: err });
    }
    return (err as Error);
  }
}

export function createModelGateway(p: ConstructorParameters<typeof ModelGateway>[0]): ModelGateway {
  return new ModelGateway(p);
}

