import { bold, cyan, dim, green, yellow, red, strikethrough, icons } from '../../ui/ansi';
import { colorizeDiffLine, renderDiff } from '../../ui/diff';
import { langFromPath } from '../../ui/highlight';
import { describeAction, isPreviewable, previewQuestion } from '../action-preview';
import { logger } from '../../core/logger';

type ToolResult = import('../../types.ts').ToolResult;

const PAGE_LINES = 300;

const QUEUE_ECHO_CHARS = 72;
const PAUSED_PLAN_TODO_LIMIT = 8;

function planTaskLine(task: { index: number; text: string; status: string }, isNext: boolean): string {
  const n = Math.max(0, Math.floor(Number(task.index) || 0)) + 1;
  const text = clampLine(task.text) || `task ${n}`;
  const status = String(task.status ?? '').trim().toUpperCase();
  if (status === 'DONE') return `${n}. ${text}`;
  if (status === 'FAILED') return `${n}. ${text} — failed`;
  if (status === 'BLOCKED') return `${n}. ${text} — blocked`;
  if (isNext) return `${n}. ${text} — next`;
  return `${n}. ${text}`;
}

/** Used internally by the paused-plan todo rows below. */
function clampLine(value: string): string {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > QUEUE_ECHO_CHARS ? `${flat.slice(0, QUEUE_ECHO_CHARS - 1)}…` : flat;
}

/** A model's coding fitness as one line: quiet when ready, yellow when limited, red when unsuited. */
export function formatModelFit(verdict: import('../../agent/workspace/model-fit.ts').ModelVerdict): string {
  if (verdict.fit === 'unsuited') return red(`${icons.error} ${verdict.message}`);
  if (verdict.fit === 'limited') return yellow(`${icons.warn} ${verdict.message}`);
  return dim(`${icons.ok} ${verdict.message}`);
}

/** Boxed launch banner — one glance: product, backend, workspace, session. */
export function renderBanner({
  providerLabel,
  model,
  cwd,
  stacks,
  modes,
  sessionLine,
  planResumeLine,
  bannerNotes,
  modelFit,
  compact = false,
}: {
  providerLabel: string;
  model: string;
  cwd: string;
  stacks?: string;
  modes: string[];
  sessionLine: string;
  planResumeLine?: string;
  bannerNotes: string[];
  /** The model's coding fitness, shown on new and resumed sessions alike. */
  modelFit?: string;
  /** Compact (resume) form: session line plus plan only — no help/shortcut footers. */
  compact?: boolean;
}): string {
  const rule = dim('─'.repeat(Math.max(24, Math.min(60, (process.stdout.columns || 80) - 4))));
  const head = `${bold('  ◆ ocode')}  ${dim(`${providerLabel} · ${model}`)}`;
  const where = `  ${dim(cwd)}${stacks ? dim(` · ${stacks}`) : ''}`;
  const modeLine = modes.length ? `  ${modes.join(dim(' · '))}\n` : '';
  // Help and keyboard shortcuts are TUI-only presentation: they are written to the terminal here and never enter the model context.
  const footers = compact
    ? '\n'
    : `\n${dim('  /help commands · @file attach · !cmd shell · /editor long message · /copy 2 code block')}\n` +
      `${dim('  Enter send · Ctrl+J newline · \\ + Enter continue · Esc stop · Ctrl+C twice exits')}\n` +
      `${dim('  Ctrl+O file · Ctrl+T output · Ctrl+E editor · paste lands editable, Enter sends')}\n\n`;
  return (
    `\n${head}\n` +
    `${where}\n` +
    modeLine +
    `  ${rule}\n` +
    `  ${sessionLine}\n` +
    (modelFit ? `  ${modelFit}\n` : '') +
    (planResumeLine ?? '') +
    bannerNotes.map((n) => `  ${dim(`· ${n}`)}\n`).join('') +
    footers
  );
}

interface PlanTodoDetail {
  title: string;
  done: number;
  total: number;
  tasks: Array<{ index: number; text: string; status: string }>;
  next: { index: number } | null;
}

// The paused-plan todo list: finished work struck through, next step named, rest queued, capped so the banner never floods.
function planTodoRows(
  detail: PlanTodoDetail,
  markDone: (text: string) => string,
  forceDone: boolean,
): string[] {
  const tasks = detail?.tasks ?? [];
  const rows: string[] = [];
  const shown = tasks.slice(0, PAUSED_PLAN_TODO_LIMIT);
  for (const task of shown) {
    const status = forceDone
      ? 'done'
      : String(task?.status ?? '').trim().toLowerCase();
    const line = planTaskLine({ index: task?.index ?? 0, text: String(task?.text ?? ''), status: String(task?.status ?? '') }, detail?.next?.index === task?.index);
    const text = clampLine(line);
    if (status === 'done') rows.push(`    ${green('✓')} ${dim(markDone(text))}`);
    else if (status === 'failed') rows.push(`    ${red('✗')} ${text}`);
    else if (status === 'blocked') rows.push(`    ${yellow('!')} ${text}`);
    else if (detail?.next?.index === task?.index) rows.push(`    ${cyan('→')} ${text}`);
    else rows.push(`    ${dim('·')} ${dim(text)}`);
  }
  if (tasks.length > shown.length) {
    rows.push(`    ${dim(`… +${tasks.length - shown.length} more (see /plans)`)}`);
  }
  return rows;
}

export function renderPausedPlanTodo(
  detail: PlanTodoDetail,
  markDone: (text: string) => string = strikethrough,
  willAsk = false,
): string {
  const rows: string[] = [
    `  ${yellow(`${icons.warn} Paused plan "${detail?.title ?? 'plan'}" — ${detail?.done ?? 0}/${detail?.total ?? 0} done`)}`,
  ];
  rows.push(...planTodoRows(detail, markDone, false));
  // The checklist ends by saying how to continue, so the reader never has to guess what typing does next.
  const remaining = Math.max(0, (detail?.total ?? 0) - (detail?.done ?? 0));
  const hint = remaining > 0
    ? `${remaining} task${remaining === 1 ? '' : 's'} left — ${willAsk ? 'choose below to carry on, or run /continue' : 'run /continue to resume this plan'}`
    : '';
  if (hint) rows.push(`  ${dim(`→ ${hint}`)}`);
  return rows.join('\n');
}

/** Renders a labeled, line-numbered slice of `content` with a "more" hint when it's truncated — used by /show, /open, and the pager. */
function formatRevealBlock({ label, content, limit, offset = 1, hint }: { label: string; content: string; limit: number; offset?: number; hint?: string; }): string {
  const lines = String(content ?? '').split('\n');
  const start = Math.max(0, offset - 1);
  const slice = lines.slice(start, start + Math.max(1, limit));
  const shown = start + slice.length;
  const out = [
    `${cyan(`── ${label}`)} ${dim(`(${lines.length} line${lines.length === 1 ? '' : 's'}${start > 0 ? `, from ${start + 1}` : ''})`)}`,
    ...slice.map((l, i) => `${dim(`${String(start + i + 1).padStart(4)} │`)} ${l}`),
  ];
  if (shown < lines.length) out.push(dim(`  … ${lines.length - shown} more — /show ${shown + 1}`));
  if (hint) out.push(dim(`  ${hint}`));
  return out.join('\n');
}

export function printPaged(write: (text: string) => void, label: string, content: string, offset: number = 1) {
  write(
    `${formatRevealBlock({
      label,
      content,
      limit: PAGE_LINES,
      offset,
      hint: '/copy puts this on the clipboard',
    })}\n`
  );
}

export async function previewCall(workspace: any, call: { name: string; args: Record<string, any> } | undefined): Promise<{ block: string | null; question: string } | null> {
  if (!call?.name || !isPreviewable(call.name)) return null;
  let action;
  try {
    action = await describeAction(call.name, call.args ?? {}, {
      cwd: workspace.cwd,
      root: workspace.state?.root,
      sessionId: workspace.state?.sessionId,
    });
  } catch (err) {
    logger.debug('action preview failed:', err);
    return null;
  }
  if (!action) return null;
  const head = `  ${cyan(icons.arrow)} ${dim('preview')} ${bold(action.verb)} ${cyan(action.target)}`;
  const body = action.lines.map((l) => `  ${colorizeDiffLine(l, { red, green, dim, bold, cyan })}`);
  const note = action.note ? [`  ${dim(action.note)}`] : [];
  if (body.length === 0) return { block: null, question: previewQuestion(action) };
  return { block: [head, ...body, ...note].join('\n'), question: previewQuestion(action) };
}

// What still has to be written after the answer streamed: nothing if `content` matches what streamed, the remainder if it extends it, or the whole thing if a bad turn replaced it outright.
export function pendingAnswerText(
  streamed: string,
  content: string | undefined,
  ok: boolean,
): string | null {
  const full = String(content ?? '');
  if (!full) return null;
  if (!String(streamed ?? '').trim()) return full;
  if (full.startsWith(streamed)) {
    const rest = full.slice(streamed.length);
    return rest.trim() ? rest : null;
  }
  // Already on screen somewhere in this turn's stream (a later answer after a nudge): printing it again only repeats it.
  if (String(streamed).includes(full.trim())) return null;
  if (!ok && full.trim() && full.trim() !== String(streamed ?? '').trim()) return full;
  return null;
}

/** Full-detail text for the last-output buffer (Ctrl+T / /show), derived from one finished tool call — null when there's nothing worth keeping (a harness notice, or empty). */
export function describeFullToolOutput(
  name: string,
  args: Record<string, unknown> | undefined,
  toolResult: ToolResult
): { label: string; text: string; command?: string; exitCode?: number; diagnostics?: unknown } | null {
  const data = (toolResult.data ?? {}) as Record<string, any>;
  const hasFullDiff = data.oldContent !== undefined && data.newContent !== undefined;
  const hasFullCommandOutput = data.stdout !== undefined || data.stderr !== undefined;
  const lang = hasFullDiff ? langFromPath(data.path ?? (args as any)?.path) : '';
  const full = hasFullDiff
    ? renderDiff(data.oldContent, data.newContent, { context: 2, maxLines: 2000 })
        .split('\n')
        .map((l) => colorizeDiffLine(l, { red, green, dim, bold, cyan }, lang))
        .join('\n')
    : hasFullCommandOutput
      ? [
          data.command && `$ ${data.command}`,
          data.stdout,
          data.stderr && `[stderr]\n${data.stderr}`,
          data.exitCode !== undefined && `[exit ${data.exitCode}]`,
        ].filter(Boolean).join('\n')
      : String(data.fullContent ?? toolResult.display ?? toolResult.error ?? '');

  const isHarnessNotice = toolResult.code === 'EBLOCKED' || toolResult.code === 'ESKIPPED';
  if (isHarnessNotice || !full.trim()) return null;
  const cmd = typeof data.command === 'string' ? data.command : undefined;
  return {
    label: `${name}${(args as any)?.path ? ` ${(args as any).path}` : ''}`,
    text: full,
    ...(cmd ? { command: cmd, exitCode: data.exitCode, diagnostics: data.diagnostics } : {}),
  };
}
