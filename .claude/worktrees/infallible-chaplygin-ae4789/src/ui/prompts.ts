import readline from 'node:readline';

import { PLAN_DECISION } from '../protocol';
import { bold, clampVisible, cyan, dim, gray, red, yellow, icons } from './ansi';

/** Columns a string occupies, not characters it contains. */
const WIDE_GLYPH = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u{1F300}-\u{1FAFF}]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of String(text ?? '')) width += WIDE_GLYPH.test(ch) ? 2 : 1;
  return width;
}

/** Trim to a column budget, measuring in columns and keeping the useful tail. */
function clampRow(text: string, columns: number): string {
  const s = String(text ?? '');
  if (displayWidth(s) <= columns) return s;
  const chars = [...s];
  let width = 0;
  const kept: string[] = [];
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = WIDE_GLYPH.test(chars[i]) ? 2 : 1;
    if (width + w > columns - 1) break;
    width += w;
    kept.unshift(chars[i]);
  }
  return `…${kept.join('')}`;
}

/** Every notice this module prints, clamped to the terminal. */
function fitRows(text: string): string {
  const columns = Math.max(20, process.stdout.columns || 80);
  return String(text ?? '')
    .split('\n')
    .map((row) => (row ? clampVisible(row, columns - 1) : row))
    .join('\n');
}

function out(text: string): void {
  try {
    process.stdout.write(fitRows(text));
  } catch {
    // stdout may be closed in tests and pipes.
  }
}

const ESCAPE = Symbol('escape');

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

async function ask(
  query: string,
  { hidden = false, signal }: { hidden?: boolean; signal?: AbortSignal } = {}
): Promise<string | null | typeof ESCAPE> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  // A question waits for a person, so stdin must hold the process open while it does; whatever owned the
  // terminal before (the chat screen) may have unref'd it when it let go.
  process.stdin.ref();

  if (hidden) {
    const iface = (rl as any);
    if (typeof iface._writeToOutput === 'function') {
      let promptWritten = false;
      iface._writeToOutput = (chunk: string) => {
        if (!promptWritten && String(chunk).startsWith(query)) {
          promptWritten = true;
          iface.output.write(chunk);
          return;
        }
        iface.output.write(String(chunk).replace(/[^\r\n]/g, '*'));
      };
    }
  }

  try {
    const answer = await new Promise<string | null | typeof ESCAPE>((resolve) => {
      if (signal?.aborted) { resolve(ESCAPE); return; }
      const onAbort = () => resolve(ESCAPE);
      signal?.addEventListener('abort', onAbort, { once: true });
      rl.question(query, resolve);
      rl.once('close', () => { signal?.removeEventListener('abort', onAbort); resolve(null); });
      rl.once('SIGINT', () => { signal?.removeEventListener('abort', onAbort); resolve(ESCAPE); });
    });
    if (answer === null || answer === ESCAPE) return answer;
    return String(answer).trim();
  } finally {
    rl.close();
    if (hidden) out('\n');
  }
}

export async function text(
  message: string,
  defaultValue: string = '',
  _options: { accepts?: (answer: string) => boolean; signal?: AbortSignal } = {}
): Promise<string> {
  const suffix = defaultValue ? ` ${dim(`(${defaultValue})`)}` : '';
  const answer = await ask(`${cyan('?')} ${message}${suffix}: `, { signal: _options.signal });
  if (answer === ESCAPE) return defaultValue;
  return answer || defaultValue;
}

export async function passwordPrompt(message: string): Promise<string> {
  const answer = await ask(`${cyan('?')} ${message} `, { hidden: true });
  return typeof answer === 'string' ? answer : '';
}

const looksLikeMessage = (a: unknown) => String(a).trim().split(/\s+/).length >= 3;

export async function confirm(message: string, defaultYes: boolean = false, signal?: AbortSignal): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await ask(`${cyan('?')} ${message} ${dim(hint)}: `, { signal });

    // Ctrl-C / abort is an explicit "no".
    if (answer === ESCAPE) {
      out(dim('  cancelled\n'));
      return false;
    }

    // `null` means "not an answer": EOF or closed stdin.
    if (answer === null) return false;

    // Empty line = the user pressed Enter -> the default applies.
    if (!answer) return defaultYes;

    if (/^y(es)?$/i.test(answer)) return true;
    if (/^n(o)?$/i.test(answer)) return false;

    if (looksLikeMessage(answer)) {
      out(dim(`  "${String(answer).trim().slice(0, 40)}…" was not a y/n answer — treated as 'no'. Type it again at the prompt to send it.\n`));
      // Matches what we just printed. Never return `defaultYes` here.
      return false;
    }
    out(dim('  answer y or n\n'));
  }
  // Three failed answers are not consent either.
  return false;
}

export interface RiskyConfirmOptions {
  defaultYes?: boolean;
  /** Why this call is destructive, when it is. */
  danger?: string;
  /** Why this call is asked about every time; an "always" would not cover it, so none is offered. */
  confirm?: string;
  /** What "always" would stop asking about, in words, e.g. "editing a file". */
  alwaysScope?: string;
  signal?: AbortSignal;
}

/** What one keypress at the permission prompt means. */
export type RiskAnswer =
  | { kind: 'verdict'; verdict: 'yes' | 'no' | 'always' | 'cancelled' }
  | { kind: 'message'; text: string }
  | { kind: 'retry' };

/**
 * Read one answer at the permission prompt.
 *
 * Every key is named here, because this is the only place standing between a stray keystroke and
 * a destructive command running. Esc and Ctrl+C both arrive as ESCAPE and mean nobody answered;
 * EOF means the same. A dangerous call has no "always" — the option is not even offered, and
 * typing `a` grants that one call and nothing more, so no answer can make a destructive command
 * permanently pre-approved.
 */
function interpretRiskAnswer(
  answer: string | null | typeof ESCAPE,
  { dangerous = false, defaultYes = false }: { dangerous?: boolean; defaultYes?: boolean } = {},
): RiskAnswer {
  if (answer === ESCAPE) return { kind: 'verdict', verdict: 'cancelled' };
  // Same rule as `confirm`: EOF / closed stdin is never consent, and must never clear a risky default.
  if (answer === null) return { kind: 'verdict', verdict: 'cancelled' };
  // A stray space is a typo, not a different answer; the patterns stay anchored either way.
  const value = String(answer).trim();
  if (!value) return { kind: 'verdict', verdict: defaultYes ? 'yes' : 'no' };
  if (/^y(es)?$/i.test(value)) return { kind: 'verdict', verdict: 'yes' };
  if (/^n(o)?$/i.test(value)) return { kind: 'verdict', verdict: 'no' };
  // Accepted even when not offered: a person typing `a` means "allow", and reading that as a refusal is exactly the bug this replaced.
  if (/^a(lways)?$/i.test(value)) {
    return { kind: 'verdict', verdict: dangerous ? 'yes' : 'always' };
  }
  if (looksLikeMessage(value)) return { kind: 'message', text: value };
  return { kind: 'retry' };
}

/** The action as a heading: capitalised, no trailing punctuation; the key row makes it a question. */
function asHeading(line: string): string {
  const t = line.trim().replace(/[.:?]$/, '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Allow this action';
}

/** The permission prompt: the question, why it is being asked, the keys, then the caret. */
export async function confirmRisky(
  message: string,
  options: RiskyConfirmOptions | boolean = {}
): Promise<'yes' | 'no' | 'always' | 'cancelled'> {
  const { defaultYes = false, danger, confirm, alwaysScope, signal } =
    typeof options === 'boolean' ? { defaultYes: options } as RiskyConfirmOptions : options;
  const dangerous = Boolean(danger);
  const offerAlways = !dangerous && !confirm;
  const paint = dangerous ? red : yellow;

  const cols = Math.max(24, process.stdout.columns || 80);
  const width = Math.max(20, cols - 5);
  const [first = '', ...rest] = String(message ?? '').split('\n').filter((line) => line.trim());

  const rows = [`  ${paint(bold(clampRow(`${icons.warn} ${asHeading(first)}`, width)))}`];
  for (const line of rest) rows.push(`    ${dim(clampVisible(line.trim(), width))}`);
  if (danger) rows.push(`    ${red(bold('This cannot be undone.'))}`, `    ${dim(clampVisible(danger, width))}`);
  else if (confirm) rows.push(`    ${dim(clampVisible(`Asked every time because it ${confirm}.`, width))}`);

  const keys = [
    `${bold('y')} yes`,
    `${bold('n')} no`,
    ...(offerAlways ? [`${bold('a')} always allow ${alwaysScope || 'this tool'}`] : []),
  ];
  rows.push(`    ${gray(keys.join('   '))}   ${dim(`(Enter = ${defaultYes ? 'yes' : 'no'})`)}`);

  // readline owns only the one-row caret: it redraws its whole prompt on a resize or an edit, and a multi-row prompt redrawn
  // after the terminal reflowed or wrote under it printed the question twice. The rows above are written once.
  const caret = `  ${paint(bold('›'))} `;

  for (let attempt = 0; attempt < 3; attempt++) {
    out(`\n${rows.join('\n')}\n`);
    const answer = await ask(caret, { signal });
    const read = interpretRiskAnswer(answer, { dangerous: !offerAlways, defaultYes });

    if (read.kind === 'message') {
      out(dim(`  "${read.text.slice(0, 40)}…" is not an answer — nothing ran. Type it again at the prompt to send it.\n`));
      return 'cancelled';
    }
    if (read.kind === 'verdict') {
      if (read.verdict === 'cancelled') out(dim('  dismissed — nothing ran\n'));
      return read.verdict;
    }
    out(`  ${yellow(`answer ${offerAlways ? 'y, n or a' : 'y or n'}`)}\n`);
  }
  return 'cancelled';
}

export async function confirmPlan(signal?: AbortSignal): Promise<{ decision: import('../protocol.ts').PlanDecision; feedback?: string; unavailable?: boolean; }> {
  for (;;) {
    const answer = await ask(
      `${cyan('?')} Proceed with this plan? ${dim('[y]es / [n]o / [m]odify / [r]egenerate')}: `,
      { signal }
    );
    if (answer === null) return { decision: PLAN_DECISION.REJECT, unavailable: true };
    if (answer === ESCAPE) return { decision: PLAN_DECISION.REJECT };
    if (/^y(es)?$/i.test(answer)) return { decision: PLAN_DECISION.APPROVE };
    if (/^n(o)?$/i.test(answer)) return { decision: PLAN_DECISION.REJECT };
    if (/^r(egenerate)?$/i.test(answer)) return { decision: PLAN_DECISION.REGENERATE };
    if (/^m(odify)?$/i.test(answer)) {
      const feedback = await text('What should change?');
      return { decision: PLAN_DECISION.REGENERATE, feedback };
    }
    if (looksLikeMessage(answer)) {
      out(dim(`  "${String(answer).trim().slice(0, 40)}…" was not a plan decision — treated as 'reject'. Type it again at the prompt to send it.\n`));
      return { decision: PLAN_DECISION.REJECT };
    }
    out(dim('  answer y (approve), n (reject), m (modify), or r (regenerate)\n'));
  }
}

export async function select<T>(message: string, items: { label: string; value: T; hint?: string; }[], { initialIndex = 0, signal }: any = {}): Promise<T | undefined> {
  if (!items || items.length === 0) return undefined; // used to throw
  if (items.length === 1) return items[0].value;

  const index = Math.min(Math.max(initialIndex, 0), items.length - 1);
  out(`${bold(message)}\n`);
  items.forEach((item, i) => {
    const marker = i === index ? cyan('>') : ' ';
    const hint = item.hint ? ` ${dim(item.hint)}` : '';
    out(`  ${marker} ${i + 1}. ${item.label}${hint}\n`);
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ask(`${cyan('?')} Choose [1-${items.length}] ${dim(`(enter = ${index + 1})`)}: `, { signal });
    if (raw === ESCAPE) {
      out(dim('  cancelled\n'));
      return undefined;
    }
    if (raw === null) return undefined;
    // Enter with no digits typed accepts the highlighted default.
    if (!raw) return items[index].value;
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].value;
    out(dim('  invalid choice\n'));
  }
  // Three failed answers are not consent either — same principle as the EOF rule above.
  return undefined;
}
