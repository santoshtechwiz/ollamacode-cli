import { itemLines } from './app';

export function createPlainView({ session, out, expandTools = false, showReasoning = false, onWrite }: any) {
  let written = 0;
  let writtenCmd = 0;

  function drain() {
    const { items, cmd } = session.state();
    if (cmd?.lines?.length && cmd.lines.length > writtenCmd) {
      // No window possible without a TTY: the terminal's own scrollback is the scrollable surface, so append new command lines as they arrive.
      for (let i = writtenCmd; i < cmd.lines.length; i++) {
        out.write(`  │ ${cmd.lines[i]}\n`);
      }
      writtenCmd = cmd.lines.length;
      onWrite?.();
    }
    if (!cmd?.active) writtenCmd = 0;
    if (items.length === written) return;
    for (let i = written; i < items.length; i++) {
      const lines = itemLines(items[i], session.expandTools ?? expandTools, session.showReasoning ?? showReasoning);
      if (lines.length === 0) continue;
      out.write(`${lines.join('\n')}\n`);
    }
    written = items.length;
    onWrite?.();
  }

  return {
    start() {},
    notify() {
      drain();
    },
    flush() {
      drain();
    },
    pause() {
      drain();
    },
    resume() {},
    stop() {
      drain();
    },
  };
}

