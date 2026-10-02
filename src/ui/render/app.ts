import { createElement as h } from 'react';
import { Box, Text, Static } from 'ink';

import { bold, cyan, dim, green, italic, magenta, red, yellow } from '../ansi';
import { renderMarkdown, renderPartial } from './markdown';
import { icons, SPINNER_FRAMES } from './icons';
import { todoRows } from '../tool-preview';
import { formatTokens } from '../../core/usage';

const CHECK_MARK = { done: 'x', active: '~', open: ' ' } as const;

/** The plan's checklist drawn exactly like a todo_write list, so both read as the same thing. */
function checklistRows(tasks: import('../../agent/planning/plan.ts').ChecklistItem[]): string[] {
  return todoRows(tasks.map((t) => `[${CHECK_MARK[t.status]}] ${t.title}`).join('\n')).map((row) => `  ${row}`);
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

const FAILURE_DETAIL_LINES = 8;

const THINKING_BORDER = ({
  flexDirection: 'column',
  borderStyle: 'round',
  borderLeft: true,
  borderTop: false,
  borderBottom: false,
  borderRight: false,
  borderColor: 'magenta',
  borderDimColor: true,
  paddingLeft: 1,
} as const);

const toolBorder = (ok: boolean) => ({
  flexDirection: 'column',
  borderStyle: 'round',
  borderLeft: true,
  borderTop: false,
  borderBottom: false,
  borderRight: false,
  borderColor: ok ? 'green' : 'red',
  borderDimColor: true,
  paddingLeft: 1,
} as const);

const COMMAND_DETAIL_LINES = 20;

/** A proposal awaiting a decision is yellow, the needs-you color, distinct from live output, thinking and results. */
const PLAN_BORDER = ({
  flexDirection: 'column',
  borderStyle: 'round',
  borderLeft: true,
  borderTop: true,
  borderBottom: true,
  borderRight: true,
  borderColor: 'yellow',
  borderDimColor: false,
  paddingLeft: 1,
  paddingRight: 1,
} as const);

/** Plans are longer than command tails: roomier clamp, same idea — the approval prompt below must never be shoved off-screen. */
function planWindowLines(termRows: number = 24): number {
  const rows = Number.isFinite(termRows) && termRows > 0 ? termRows : 24;
  return Math.max(8, Math.min(40, Math.floor(rows * 0.6)));
}

function planHead(): string {
  return yellow(`  ${icons.plan} Proposed plan — awaiting approval`);
}

/** Distinct chrome for live command output: cyan so it cannot be mistaken for thinking (magenta), tool success/failure (green/red) or hints (dim). */
const CMD_BORDER = ({
  flexDirection: 'column',
  borderStyle: 'round',
  borderLeft: true,
  borderTop: true,
  borderBottom: true,
  borderRight: true,
  borderColor: 'cyan',
  borderDimColor: false,
  paddingLeft: 1,
  paddingRight: 1,
} as const);

/** Auto height: small on short terminals, roomier on tall ones. */
function commandWindowLines(termRows: number = 24): number {
  const rows = Number.isFinite(termRows) && termRows > 0 ? termRows : 24;
  return Math.max(3, Math.min(10, Math.floor(rows / 4)));
}

function CommandWindow({ lines, rows, label }: { lines: string[]; rows: number; label?: string; }) {
  const height = commandWindowLines(rows);
  const shown = lines.length > height ? lines.slice(-height) : lines;
  const hidden = lines.length - shown.length;
  const what = label ? ` — ${label}` : '';
  const head = cyan(`  ⌁ live${what}${hidden > 0 ? dim(` · ${hidden} earlier line${hidden === 1 ? '' : 's'} above — full output lands in the tool row`) : ''}`);
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { key: 'cmd-head' }, head),
    h(
      Box,
      { key: 'cmd-box', ...CMD_BORDER, marginLeft: 2 },
      h(Text, { wrap: 'truncate-end' }, shown.map((l) => cyan(l)).join('\n'))
    )
  );
}

function toolRows(item: import('./session.ts').Item, expandTools: boolean): string[] {
  const mark = item.ok ? green(icons.success) : item.neutral ? dim(icons.bullet) : red(icons.error);
  const rows = [`  ${mark} ${item.title}`];
  const detail = item.detail ?? [];
  const budget =
    expandTools || detail.length === 0 || item.expand
      ? detail.length
      : item.command
        ? COMMAND_DETAIL_LINES
        : item.ok || item.bulk
          ? 1
          : FAILURE_DETAIL_LINES;
  for (const line of detail.slice(0, budget)) rows.push(`    ${line}`);
  const hidden = detail.length - budget + (item.hidden ?? 0);
  if (hidden > 0) {
    rows.push(dim(`    ${icons.branch} ${hidden} more line${hidden === 1 ? '' : 's'} — /verbose or Ctrl+T`));
  }
  if (item.hint) rows.push(dim(`    ${icons.branch} ${item.hint}`));
  return rows;
}

/** Thinking's own color, shared by the Ink and plain renderers so they cannot drift. */
/** A note's rows: the icon on the first line, and any further lines indented under its text. */
function noteRows(glyph: string, item: import('./session.ts').Item): string[] {
  const paint = item.tone === 'dim' ? dim : (text: string) => text;
  const [first = '', ...rest] = String(item.text ?? '').split('\n');
  return [`  ${glyph} ${paint(first)}`, ...rest.map((line) => `    ${paint(line)}`)];
}

function thinkingHead(text: string): string {
  return dim(magenta(text));
}
function thinkingLine(text: string): string {
  return magenta(italic(text));
}

function committedReasoningLines(text: string, showReasoning: boolean | string): { lines: string[]; hiddenAbove: number; } {
  if (!text || !showReasoning) return { lines: [], hiddenAbove: 0 };
  const nonEmpty = String(text).split('\n').filter((l) => l.trim());
  if (showReasoning === 'detailed') return { lines: nonEmpty, hiddenAbove: 0 };
  // The default view is a ticker: the caller renders the "thought for Xs · N lines" head and nothing else.
  return { lines: [], hiddenAbove: 0 };
}

function Item({ item, expandTools, showReasoning, termRows = 24, columns = 80 }: any) {
  switch (item.type) {
    case 'markdown':
      return h(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        h(Text, null, renderMarkdown(item.text ?? '', columns).join('\n'))
      );

    case 'command':
      return h(
        Box,
        null,
        h(Text, null, `  ${dim(icons.command)} ${item.text}${item.title ? dim(` in ${item.title}`) : ''}`)
      );

    case 'tool': {
      const [head, ...rest] = toolRows(item, expandTools);
      if (rest.length === 0) return h(Box, null, h(Text, null, head));
      const body = rest.map((r) => r.replace(/^ {4}/, '')).join('\n');
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, null, head),
        h(Box, { ...toolBorder(Boolean(item.ok)), marginLeft: 2 }, h(Text, null, body))
      );
    }

    case 'thinking': {
      const head = thinkingHead(`  ${icons.thinking} thought for ${item.seconds}s${item.lines ? ` · ${item.lines} lines` : ''}`);
      const { lines: bodyLines, hiddenAbove } = committedReasoningLines(item.text ?? '', showReasoning);
      if (bodyLines.length === 0) return h(Box, null, h(Text, null, head));
      // Wrapped here like the live block: Ink's wrapper reopens only the innermost style, so its rows would lose the magenta.
      const body = [
        ...(hiddenAbove > 0 ? [dim(`${hiddenAbove} earlier line${hiddenAbove === 1 ? '' : 's'} — /think detailed`)] : []),
        ...reasoningRows(bodyLines, columns, Number.POSITIVE_INFINITY).map((row) => thinkingLine(row)),
      ].join('\n');
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, null, head),
        h(Box, { ...THINKING_BORDER, marginLeft: 2 }, h(Text, null, body))
      );
    }

    case 'note': {
      const glyph =
        item.tone === 'error'
          ? red(icons.error)
          : item.tone === 'warn'
            ? yellow(icons.warning)
            : item.tone === 'success'
              ? green(icons.success)
              : dim(icons.info);
      return h(Box, null, h(Text, null, noteRows(glyph, item).join('\n')));
    }

    case 'plan':
      return h(PlanBlock, { text: item.text ?? '', rows: termRows });

    case 'tasks':
      return h(Box, { marginTop: 1 }, h(Text, null, checklistRows(item.tasks ?? []).join('\n')));

    case 'raw':
    default:
      return h(Box, { flexDirection: 'column' }, h(Text, null, item.text ?? ''));
  }
}

/** The whole plan, as markdown: the person approves what they can read in full. */
function planRows(text: string, _termRows: number): { head: string; body: string; hidden: number; } {
  return { head: planHead(), body: renderMarkdown(String(text ?? '')).join('\n'), hidden: 0 };
}

/** A Ctrl+T/Ctrl+O reveal: drawn in the live area so a second press or Esc takes it away again, and clamped so the prompt stays on screen. */
/** `lines` is split once by the caller: the panel re-renders every frame and the text can be a whole file. */
export function RevealPanel({ label, lines: all, rows: termRows = 24 }: { label: string; lines: string[]; rows?: number; }) {
  const shown = all.slice(0, planWindowLines(termRows));
  const hidden = all.length - shown.length;
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { key: 'reveal-head', wrap: 'truncate-end' }, `  ${cyan(`── ${label}`)} ${dim(`(${all.length} line${all.length === 1 ? '' : 's'} · same key or Esc closes)`)}`),
    h(
      Box,
      { key: 'reveal-box', ...CMD_BORDER, marginLeft: 2 },
      ...shown.map((line, i) => h(Text, { key: `reveal-${i}`, wrap: 'truncate-end' }, line || ' '))
    ),
    hidden > 0 ? h(Text, { key: 'reveal-more' }, dim(`    ${icons.branch} ${hidden} more line${hidden === 1 ? '' : 's'} — /show prints it all`)) : null
  );
}

function PlanBlock({ text, rows: termRows = 24 }: { text: string; rows?: number; }) {
  const { head, body, hidden } = planRows(text, termRows);
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { key: 'plan-head' }, head),
    h(
      Box,
      { key: 'plan-box', ...PLAN_BORDER, marginLeft: 2 },
      h(Text, { wrap: 'wrap' }, body)
    ),
    hidden > 0 ? h(Text, { key: 'plan-more' }, dim(`    ${icons.branch} ${hidden} more line${hidden === 1 ? '' : 's'} below — full plan in the record`)) : null
  );
}

function Live({ live, rows, columns }: any) {
  const lines = renderPartial(live.text, columns);
  if (lines.length === 0) return null;
  const room = Math.max(3, Math.floor(rows / 3));
  const shown = lines.length > room ? lines.slice(-room) : lines;
  return h(Box, { flexDirection: 'column', marginTop: 1 }, h(Text, null, shown.join('\n')));
}

function reasoningRows(lines: string[], columns: number, max: number): string[] {
  const width = Math.max(20, columns - 6);
  const rows: any[] = [];
  // Overlong words wrap across rows instead of slicing: full width, nothing lost.
  const wordsOf = function* (word: string): Generator<string> {
    let rest = String(word);
    while (rest.length > width) {
      yield rest.slice(0, width);
      rest = rest.slice(width);
    }
    yield rest;
  };
  for (const line of lines) {
    let row = '';
    for (const word of String(line).split(' ')) {
      for (const piece of wordsOf(word)) {
        if (!row) {
          row = piece;
        } else if (row.length + 1 + piece.length <= width) {
          row += ` ${piece}`;
        } else {
          rows.push(row);
          row = piece;
        }
      }
    }
    if (row) rows.push(row);
  }
  return rows.length > max ? rows.slice(-max) : rows;
}

function reasoningRoom(rows: number, hasLive: boolean = false, detailed: boolean = false) {
  if (hasLive) return Math.max(2, Math.min(4, Math.floor(rows / 8)));
  const cap = detailed ? 12 : 8;
  return Math.max(2, Math.min(cap, Math.floor(rows / (detailed ? 3 : 4))));
}

/** Folder, model, live context use against the model's window, and tokens: this turn's while it runs, the session's at the prompt. */
function statsLine(s: import('./session.ts').RenderState['stats'], idle: boolean): string {
  const bar: string[] = [];
  if (s.folder) bar.push(`${icons.dir} ${s.folder}`);
  if (s.model) bar.push(bold(s.model));
  if (s.context) bar.push(`ctx ${formatTokens(s.context.used)}/${formatTokens(s.context.window)}`);
  // sent/received, compact like ctx: this turn's while it runs, the session's at the prompt.
  const usage = idle ? s.usage?.session : s.usage?.turn;
  if (usage && usage.calls > 0) {
    const approx = usage.estimated > 0;
    bar.push(`${idle ? 'session ' : ''}${formatTokens(usage.sent, approx)}/${formatTokens(usage.received)} tok`);
    if (!idle && usage.calls > 1) bar.push(`${usage.calls} calls`);
  }
  if (s.ok || s.failed) bar.push(`${icons.success}${s.ok}${s.failed ? ` ${icons.error}${s.failed}` : ''}`);
  if (!idle) bar.push(duration(s.elapsedMs));
  return bar.join(' · ');
}

function StatusArea({ state, frame, columns, rows: termRows = 24, showReasoning = false }: { state: import('./session.ts').RenderState; frame: number; columns: number; rows?: number; showReasoning?: boolean | 'detailed'; }) {
  // Idle (between turns) keeps the stats line so context and token use stay visible at the prompt.
  if (state.done) return h(Box, { marginTop: 1 }, h(Text, { wrap: 'truncate-end' }, dim(`  ${statsLine(state.stats, true)}`)));
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];

  const rows: any[] = [];

  if (state.tasks?.length) rows.push(h(Text, { key: 'tasks' }, checklistRows(state.tasks).join('\n')));

  if (state.reasoning?.active) {
    rows.push(
      h(
        Text,
        { key: 'think', wrap: 'truncate-end' },
        `${magenta(spinner)} ${magenta(italic('Thinking'))} ${dim(`${state.reasoning.seconds}s`)}` +
          `${state.reasoning.lines ? dim(` · ${state.reasoning.lines} line${state.reasoning.lines === 1 ? '' : 's'}`) : ''}`
      )
    );
    if (showReasoning === 'detailed') {
      const wrapped = reasoningRows(
        state.reasoning.tailLines ?? [],
        columns,
        reasoningRoom(termRows, Boolean(state.live), true)
      );
      if (wrapped.length) {
        rows.push(
          h(
            Box,
            { key: 'think-body', ...THINKING_BORDER, marginLeft: 2 },
            h(Text, { wrap: 'wrap' }, wrapped.map((row) => thinkingLine(row)).join('\n'))
          )
        );
      }
    }
  } else if (state.status) {
    const { head, why, hint, tail } = state.status;
    const parts = [head, why, tail ? dim(tail) : '', hint].filter(Boolean);
    const glyph = cyan(spinner);
    rows.push(h(Text, { key: 'status', wrap: 'truncate-end' }, `${glyph} ${dim(parts.join(' · '))}`));
  }

  if (state.running.length) {
    const now = Date.now();
    const label = state.running
      .map((r) => `${r.icon} ${r.label}${now - r.startedAt > 2000 ? dim(` ${duration(now - r.startedAt)}`) : ''}`)
      .join(dim('  ·  '));
    rows.push(h(Text, { key: 'running', wrap: 'truncate-end' }, `  ${dim(label)}`));
  }

  if ((state as any).cmd?.lines?.length) {
    const cmd = (state as any).cmd;
    rows.push(h(CommandWindow, { key: 'cmd', lines: cmd.lines, rows: termRows, label: cmd.label }));
  }

  rows.push(h(Text, { key: 'bar', wrap: 'truncate-end' }, dim(`  ${statsLine(state.stats, false)}`)));

  if (rows.length === 0) return null;
  const rule = dim(icons.rule.repeat(Math.max(8, Math.min(columns - 2, 60))));
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { key: 'rule' }, `  ${rule}`),
    ...rows
  );
}

export function App({ state, frame, expandTools, showReasoning, columns, rows = 24, paused = false }: { state: import('./session.ts').RenderState; frame: number; expandTools?: boolean; showReasoning?: boolean | 'detailed'; columns: number; rows?: number; paused?: boolean; }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, ({
      key: 'transcript',
      items: state.items,
       children: (item: import('./session.ts').Item) =>
         h(Item, { key: item.id, item, expandTools, showReasoning, termRows: rows, columns }),
    } as any)),
    !paused && state.live ? h(Live, { live: state.live, rows, columns, key: 'live' }) : null,
    paused ? null : h(StatusArea, { state, frame, columns, rows, showReasoning, key: 'status' })
  );
}

export function itemLines(item: import('./session.ts').Item, expandTools: boolean, showReasoning: boolean | string): string[] {
  switch (item.type) {
    case 'markdown':
      return ['', ...renderMarkdown(item.text ?? '')];
    case 'command':
      return [`  ${dim(icons.command)} ${item.text}${item.title ? dim(` in ${item.title}`) : ''}`];
    case 'tool':
      return toolRows(item, expandTools);
    case 'plan': {
      const rule = `  ${dim(`── ${icons.plan} Proposed plan — awaiting approval ──`)}`;
      return [rule, ...renderMarkdown(String(item.text ?? '')).map((l) => `  ${l}`)];
    }
    case 'tasks':
      return checklistRows(item.tasks ?? []);
    case 'thinking': {
      const rows = [thinkingHead(`  ${icons.thinking} thought for ${item.seconds}s${item.lines ? ` · ${item.lines} lines` : ''}`)];
      const { lines: bodyLines, hiddenAbove } = committedReasoningLines(item.text ?? '', showReasoning);
      if (hiddenAbove > 0) {
        rows.push(dim(`  ${icons.branch} ${hiddenAbove} earlier line${hiddenAbove === 1 ? '' : 's'} — /think detailed`));
      }
      for (const l of bodyLines) rows.push(`  ${dim(icons.gutter)} ${thinkingLine(l)}`);
      return rows;
    }
    case 'note': {
      const glyph =
        item.tone === 'error'
          ? red(icons.error)
          : item.tone === 'warn'
            ? yellow(icons.warning)
            : item.tone === 'success'
              ? green(icons.success)
              : dim(icons.info);
      return noteRows(glyph, item);
    }
    case 'raw':
    default:
      return String(item.text ?? '').split('\n');
  }
}
