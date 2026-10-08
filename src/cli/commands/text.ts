import { cyan, dim } from '../../ui/ansi';

const SHORTCUTS = [
  ['Ctrl+O', 'reveal the last file the agent read (again to close)'],
  ['Ctrl+T', 'reveal the last tool output (again to close)'],
  ['Esc', 'dismiss a question, close the reveal, or stop the current turn'],
  ['Ctrl+L', 'clear the screen, keeping what you have typed'],
  ['Ctrl+C', 'stop the current turn (twice at the prompt to exit)'],
  ['Enter', 'send — typing during a turn queues the message for when it ends'],
  ['Ctrl+J', 'newline inside this message (\\ + Enter also continues)'],
  ['Ctrl+E', 'compose in $EDITOR (/editor)'],
  ['Ctrl+D', 'exit'],
  ['Shift+Tab / Ctrl+G', 'switch mode — Agent → Plan → Ask'],
  ['↑ / ↓', 'previous and next input'],
];

export const INPUT_FOOTER = [
  `  ${cyan('@path'.padEnd(16))} ${dim('attach a file to your message')}`,
  `  ${cyan('!<command>'.padEnd(16))} ${dim('run a shell command here (same as /shell)')}`,
  `  ${cyan('/editor'.padEnd(16))} ${dim('long message in $EDITOR · Ctrl+J newline at the prompt')}`,
  `  ${cyan('/copy 2'.padEnd(16))} ${dim('copy code block 2 of the last answer (OSC52 works over SSH)')}`,
];

export const SHORTCUT_FOOTER = SHORTCUTS.map(
  ([key, what]) => `  ${cyan(key.padEnd(16))} ${dim(what)}`
);
