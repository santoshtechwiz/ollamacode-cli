import type { Message, SamplingOptions } from '../../types';
import { agentConfig } from '../../core/config';

export function ollamaChatBody({
  model,
  messages,
  tools,
  sampling,
  thinking,
  toMessages,
}: {
  model: string;
  messages: Message[];
  tools?: unknown[];
  sampling: SamplingOptions;
  thinking: boolean;
  toMessages: (messages: Message[]) => unknown;
}) {
  const options: {
    temperature?: number;
    num_predict?: number;
    num_ctx?: number;
  } = {};

  // Do not invent a temperature: unset, the model's own default (from its Modelfile) applies.
  if (sampling.temperature !== undefined) options.temperature = sampling.temperature;

  if (
    sampling.maxTokens !== undefined &&
    sampling.maxTokens > 0
  ) {
    options.num_predict = sampling.maxTokens;
  }

  // Do not invent a context size.
  if (
    sampling.contextWindow !== undefined &&
    sampling.contextWindow > 0
  ) {
    options.num_ctx = sampling.contextWindow;
  }

  return {
    model,
    messages: toMessages(messages),

    // Always stream.
    stream: true,

    options,

    // keep_alive controls model residency, not generation speed.
    keep_alive: sampling.keepAlive ?? agentConfig().keepAlive ?? '30m',

    // Explicitly control Qwen3 thinking.
    think: thinking,

    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}