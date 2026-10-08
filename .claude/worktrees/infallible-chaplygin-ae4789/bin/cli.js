#!/usr/bin/env node
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli/index.ts');

// A last-resort net for a synchronous throw or a rejected promise nothing
// downstream caught. Without this, Node's default behavior is a bare crash —
// worst case while the renderer holds the cursor hidden and the agent core is
// `await`-blocked on a tool-approval or plan-approval promise that will now
// never resolve, which looks exactly like a permanent hang right up until
// the process is simply gone. This is a backstop, not a substitute for
// fixing the actual throw site.
function crashSafety(label) {
  return (err) => {
    // Best-effort terminal restore: show the cursor again (the renderer
    // hides it while a turn is live) and leave alt-screen mode in case any
    // child process entered it. Harmless no-op escape codes otherwise.
    try {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    } catch { /* stdout itself may be the thing that is broken */ }
    process.stderr.write(`\n  ✗ ${label}: ${err?.stack ?? err?.message ?? err}\n`);
    process.exitCode = 1;
    process.exit(1);
  };
}
process.on('uncaughtException', crashSafety('uncaught exception'));
process.on('unhandledRejection', crashSafety('unhandled rejection'));

main(process.argv.slice(2)).catch((err) => {
  // TcError-style errors carry a machine code and sometimes a hint; print them
  // so users can grep docs or report issues precisely, without a stack trace
  // for what is usually an ordinary usage error.
  const lines = [`\n  ✗ ${err.message}`];
  if (err.code && err.code !== 'EUNKNOWN') lines.push(`    code: ${err.code}`);
  if (err.hint) lines.push(`    hint: ${err.hint}`);
  lines.push('');
  process.stderr.write(lines.join('\n'));
  if (process.env.TC_DEBUG_STACK === '1') {
    process.stderr.write(`${err.stack ?? ''}\n`);
  }
  process.exit(1);
});
