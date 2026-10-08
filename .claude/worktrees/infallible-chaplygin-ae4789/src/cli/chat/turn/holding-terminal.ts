import type { ChatTurnContext } from './context';

/** Prompts take the terminal one at a time: subagents running side by side may each ask, and two questions open at once would share one keyboard. */
let queue: Promise<unknown> = Promise.resolve();

/** Runs a nested prompt with the renderer paused, so prompt output and input are not interleaved with live TUI output. */
export function holdingTerminal<T>(host: ChatTurnContext, fn: () => Promise<T>): Promise<T> {
  const turn = queue.then(() => hold(host, fn));
  queue = turn.catch(() => undefined);
  return turn;
}

async function hold<T>(host: ChatTurnContext, fn: () => Promise<T>): Promise<T> {
  host.onPromptOwnership?.(true);
  host.render.pause();
  try {
    // The paused frame drops the input box; Ink lets go of stdin in an effect React runs on the next tick. A prompt
    // that starts before then reads nothing: Ink's handler still takes the keys, and its cleanup then unrefs stdin.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return await fn();
  } finally {
    host.onPromptOwnership?.(false);
    host.render.resume();
  }
}
