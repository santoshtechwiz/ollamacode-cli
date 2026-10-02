import type { ChatTurnContext } from './context';

/** Runs a nested prompt with the renderer paused, so prompt output and input are not interleaved with live TUI output. */
export async function holdingTerminal<T>(host: ChatTurnContext, fn: () => Promise<T>): Promise<T> {
  host.onPromptOwnership?.(true);
  host.render.pause();
  try {
    return await fn();
  } finally {
    host.onPromptOwnership?.(false);
    host.render.resume();
  }
}
