import { cyan, icons } from '../../../ui/ansi';
import { select, text as askText } from '../../../ui/prompts';
import { holdingTerminal } from './holding-terminal';
import type { ChatTurnContext } from './context';
import type { AskOptions } from '../../../types';

type AskFn = (question: string, options?: string[], askOpts?: AskOptions) => Promise<string>;

export function createAskFn(host: ChatTurnContext, signal: AbortSignal): AskFn | undefined {
  const { render, interactive } = host;
  if (!interactive) return undefined;
  return async (question: string, options?: string[], askOpts?: AskOptions) => {
    // The asker can withdraw its question (the thing it asked about finished); the turn ending withdraws it too.
    const stop = askOpts?.signal ? AbortSignal.any([signal, askOpts.signal]) : signal;
    if (askOpts?.detail?.trim()) render.markdown(askOpts.detail);
    render.raw(`${cyan(icons.arrow)} ${question}`);
    return holdingTerminal(host, async () => {
      if (options?.length) {
        const picked = await select('Choose:', options.map((o) => ({ label: o, value: o })), { signal: stop });
        return String(picked ?? '');
      }
      return askText('answer', '', { ...(askOpts ?? {}), signal: stop });
    });
  };
}
