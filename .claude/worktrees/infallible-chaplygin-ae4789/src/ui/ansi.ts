import { icons as glyphs } from './render/icons';

let enabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (process.stdout.isTTY ?? false);

export function setColorMode(mode?: 'auto' | 'on' | 'off'): boolean {
  if (mode === 'on') enabled = true;
  else if (mode === 'off') enabled = false;
  else enabled = !process.env.NO_COLOR && process.env.TERM !== 'dumb' && (process.stdout.isTTY ?? false);
  return enabled;
}

// Each style ends with its own off-code, never a full reset: a reset inside nested styles cancels the outer ones, and a wrapper can reopen only paired codes on a wrapped row.
const OFF: Record<string, string> = { '1': '22', '2': '22', '3': '23', '4': '24', '9': '29' };

function style(code: string): (text: string) => string {
  const open = `\x1b[${code}m`;
  const close = `\x1b[${OFF[code] ?? '39'}m`;
  // An inner style that shares this off-code turns this one off too, so it is reopened right after.
  return (text) => (enabled ? `${open}${String(text).split(close).join(close + open)}${close}` : String(text));
}

export function colorEnabled(): boolean {
  return enabled;
}

export const bold = style('1');
export const dim = style('2');
export const italic = style('3');
export const underline = style('4');
export const strikethrough = style('9');
export const red = style('31');
export const green = style('32');
export const yellow = style('33');
export const blue = style('34');
export const magenta = style('35');
export const cyan = style('36');
export const gray = style('90');

export const SHOW_CURSOR = '\x1b[?25h';

export const icons = {
  ...glyphs,
  ok: glyphs.success,
  fail: glyphs.error,
  warn: glyphs.warning,
  arrow: glyphs.branch,
};

// Glyphs that occupy two terminal columns while counting as one character — `.length` alone undercounts a row's real width.
const WIDE = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u{1F300}-\u{1FAFF}]/u;

/** Columns a string occupies on screen, ignoring the escapes that colour it. */
export function visibleWidth(text: string): number {
  let width = 0;
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    if (s[i] === "\u001b") {
      const end = s.indexOf('m', i);
      if (end !== -1) { i = end + 1; continue; }
    }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
    width += WIDE.test(ch) ? 2 : 1;
    i += ch.length;
  }
  return width;
}

/** Trim a styled row to a column budget, keeping its head and its colours. */
export function clampVisible(text: string, columns: number): string {
  const s = String(text ?? '');
  const budget = Math.max(1, columns);
  if (visibleWidth(s) <= budget) return s;

  let out = '';
  let width = 0;
  let i = 0;
  let styled = false;
  while (i < s.length) {
    if (s[i] === "\u001b") {
      const end = s.indexOf('m', i);
      if (end !== -1) { out += s.slice(i, end + 1); styled = true; i = end + 1; continue; }
    }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
    const w = WIDE.test(ch) ? 2 : 1;
    if (width + w > budget - 1) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  return `${out}…${styled ? "\u001b[0m" : ''}`;
}
