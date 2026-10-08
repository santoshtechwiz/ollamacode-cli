import { AGENT_PHASE } from '../../protocol';
import { CALL_TAGS, RESULT_TAGS } from '../../agent/response/tags';
import { narrateStatus, previewLine } from '../status-narrator';
import { splitBlocks, finishBlocks } from './blocks';
import { toolIcon } from './icons';
import { toolLabel } from './labels';

const CONTRABAND_TAGS = [...CALL_TAGS, ...RESULT_TAGS];

const MAX_REPETITIONS = 4;

const MAX_REASONING_REPETITIONS = 3;

const LIVE_LINES = 8;

const REASONING_TAIL_LINES = 16;

const REASONING_LINE_CHARS = 2_400;

const MAX_RUNNING = 4;

const CMD_TAIL_LINES = 200;

const CMD_LINE_CHARS = 500;

function findOpenTag(text: string): { open: string; close: string; } | null {
  for (const pair of CONTRABAND_TAGS) if (text.includes(pair.open)) return pair;
  return null;
}

export type ItemType = 'markdown' | 'tool' | 'command' | 'thinking' | 'note' | 'raw' | 'plan' | 'tasks';

type ChecklistItem = import('../../agent/planning/plan.ts').ChecklistItem;

export interface Item {
  id: number;
  type: ItemType;
  text?: string;
  kind?: string;
  name?: string;
  icon?: string;
  ok?: boolean;
  neutral?: boolean;
  partial?: boolean;
  title?: string;
  detail?: string[];
  hidden?: number;
  bulk?: boolean;
  command?: boolean;
  expand?: boolean;
  hint?: string;
  tone?: 'info' | 'warn' | 'error' | 'success' | 'dim';
  seconds?: number;
  lines?: number;
  tasks?: ChecklistItem[];
}

export interface RenderState {
  version: number;
  items: Item[];
  live: { text: string; kind: string; lines: number; } | null;
  reasoning: { active: boolean; tailLines: string[]; tail: string; seconds: number; lines: number; } | null;
  status: { head: string; why: string | null; hint: string; elapsedMs: number; tail: string; } | null;
  running: { name: string; icon: string; label: string; startedAt: number; }[];
  cmd: { lines: string[]; active: boolean; label: string; } | null;
  tasks: ChecklistItem[] | null;
  stats: { model: string; folder: string; usage: { session: import('../../core/usage.ts').UsageTotals; turn: import('../../core/usage.ts').UsageCount | null; } | null; context: { used: number; window: number; } | null; ok: number; failed: number; elapsedMs: number; };
  phase: 'idle' | 'thinking' | 'streaming' | 'tools' | 'done' | 'cancelled';
  done: boolean;
}

function tailOf(line: string): string {
  if (line.length <= REASONING_LINE_CHARS) return line;
  const cut = line.slice(-REASONING_LINE_CHARS);
  const space = cut.indexOf(' ');
  return `… ${(space >= 0 ? cut.slice(space + 1) : cut).trimStart()}`;
}

export function createRenderSession({
  showReasoning = false,
  shellKind,
  expandTools = false,
  suppressLine = () => false,
  suppressBlock = () => false,
  facts = () => ({}),
  onRepetition,
  onChange,
  now = Date.now,
}: any = {}) {
  let detailed = showReasoning === 'detailed';
  let reasoningVisible = Boolean(showReasoning);

  let items: any[] = [];
  let nextId = 1;
  let version = 0;

  let text = '';
  let produced = '';
  let consumed = 0;
  let pending = '';
  let carry = '';
  let open: any = null;
  let checkedLines = 0;
  let lastLine: any = null;
  let repeatCount = 0;
  let tagSpan: any = null;
  let segmentStartedAt = 0;
  let lastDeltaAt = 0;

  let reasoningText = '';
  let reasoningActive = false;
  let reasoningStartedAt = 0;
  let lastReasoningLine: any = null;
  let reasoningRepeat = 0;
  let reasoningCollapsed = false;
  let reasoningChecked = 0;

  let statusLabel = '';
  let statusStartedAt = 0;
  let liveTail = '';
  const cmdLines: string[] = [];
  // Output arrives in chunks that can end mid-line; hold the unfinished line until the rest of it comes.
  let cmdPartial = '';
  let cmdActive = false;
  let cmdLabel = '';
  let running: any[] = [];
  // The plan's checklist, pinned above the status line while a turn runs.
  let taskList: ChecklistItem[] | null = null;
  let okCount = 0;
  let failedCount = 0;
  let startedAt = now();

  let phase = 'idle';
  let done = false;
  let stopped = false;

  let snapshot: any = null;
  let snapshotAt = -1;

  function changed() {
    version += 1;
    snapshot = null;
    onChange?.();
  }

  function push(item: Omit<Item, 'id'>) {
    items = [...items, { id: nextId++, ...item }];
    changed();
  }

  function scrub(block: string): string | null {
    const keep: any[] = [];
    for (const line of block.split('\n')) {
      if (tagSpan) {
        if (line.includes(tagSpan.close)) tagSpan = null;
        continue;
      }
      const opener = findOpenTag(line);
      if (opener) {
        const after = line.slice(line.indexOf(opener.open) + opener.open.length);
        if (!after.includes(opener.close)) tagSpan = opener;
        continue;
      }
      if (suppressLine(line)) continue;
      keep.push(line);
    }
    const out = keep.join('\n');
    return out.trim() ? out : null;
  }

  function pendingSuppressed() {
    if (!pending.trim()) return false;
    if (tagSpan || findOpenTag(pending)) return true;
    if (open?.kind === 'code') return true;
    if (/^\s*[{[]/.test(pending)) return true;
    return suppressLine(pending);
  }

  function checkRepetition() {
    const parts = text.split('\n');
    const completed = parts.length - 1;
    for (let i = checkedLines; i < completed; i++) {
      const line = parts[i];
      checkedLines = i + 1;
      if (line.trim().length <= 8) {
        lastLine = null;
        repeatCount = 0;
        continue;
      }
      if (line === lastLine) {
        repeatCount += 1;
        if (repeatCount >= MAX_REPETITIONS) {
          stopped = true;
          text = `${parts.slice(0, Math.max(0, i - repeatCount + 1)).join('\n')}\n`;
          commitClosedBlocks();
          push({ type: 'note', tone: 'warn', text: 'repetition detected — stopped' });
          onRepetition?.();
          return;
        }
      } else {
        lastLine = line;
        repeatCount = 0;
      }
    }
  }

  function commitClosedBlocks() {
    const tail = carry + text.slice(consumed);
    const seg = splitBlocks(tail);
    for (const block of seg.blocks) {
      if (block.kind === 'code' && suppressBlock(block.text)) continue;
      const kept = scrub(block.text);
      if (kept) push({ type: 'markdown', kind: block.kind, text: kept });
    }
    // `carry` is a synthetic reopening of the fence the previous segment ended inside.
    const eaten = tail.length - seg.rest.length;
    if (eaten >= carry.length) {
      consumed += eaten - carry.length;
      carry = '';
    }
    pending = seg.rest;
    open = seg.open;
    changed();
  }

  function onDelta(delta: string, full?: string) {
    if (done || stopped) return;
    closeReasoning();
    if (typeof full === 'string' && !full.startsWith(text)) endSegment();
    const t = now();
    lastDeltaAt = t;
    if (segmentStartedAt === 0) segmentStartedAt = t;
    phase = 'streaming';
    text = typeof full === 'string' ? full : text + (delta ?? '');
    checkRepetition();
    if (stopped) return;
    commitClosedBlocks();
  }

  function onReasoning(delta: string, full?: string) {
    if (done || stopped) return;
    if (!reasoningActive) {
      reasoningActive = true;
      reasoningStartedAt = now();
      phase = 'thinking';
    }
    reasoningText = typeof full === 'string' ? full : reasoningText + (delta ?? '');

    const lines = reasoningText.split('\n');
    for (; reasoningChecked < lines.length - 1; reasoningChecked++) {
      const line = lines[reasoningChecked];
      if (line.trim().length <= 8) continue;
      if (line === lastReasoningLine) {
        reasoningRepeat += 1;
        if (reasoningRepeat >= MAX_REASONING_REPETITIONS) reasoningCollapsed = true;
      } else {
        lastReasoningLine = line;
        reasoningRepeat = 0;
      }
    }
    changed();
  }

  function closeReasoning() {
    if (!reasoningActive) return;
    reasoningActive = false;
    // A closed thought leaves no row unless the user asked to see thinking.
    if (reasoningVisible) {
      const seconds = Math.max(1, Math.round((now() - reasoningStartedAt) / 1000));
      const lineCount = reasoningText.split('\n').filter((l) => l.trim()).length;
      push({ type: 'thinking', seconds, lines: lineCount, text: reasoningText });
    }
    reasoningText = '';
    lastReasoningLine = null;
    reasoningRepeat = 0;
    reasoningChecked = 0;
    reasoningCollapsed = false;
  }

  function setStatus(label: string) {
    const next = String(label ?? '').trim();
    if (next === statusLabel) return;
    statusLabel = next;
    statusStartedAt = now();
    liveTail = '';
    if (statusLabel.toLowerCase() === AGENT_PHASE.THINKING && phase === 'idle') phase = 'thinking';
    changed();
  }

  function setLiveTail(out: string) {
    // Live command window: keep a ring buffer of recent output lines so the view can draw a small tail window.
    const parts = (cmdPartial + String(out ?? '')).split('\n');
    cmdPartial = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\s+$/g, '');
      if (!line.trim()) continue;
      cmdLines.push(line.length > CMD_LINE_CHARS ? `${line.slice(0, CMD_LINE_CHARS - 1)}…` : line);
      if (cmdLines.length > CMD_TAIL_LINES) cmdLines.splice(0, cmdLines.length - CMD_TAIL_LINES);
    }
    if (cmdLines.length > 0) cmdActive = true;
    const lines = String(out ?? '').split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const tail = lines.slice(-2).join(' ').replace(/\s+/g, ' ').trim();
    if (!tail) return;
    liveTail = tail.slice(-160);
    changed();
  }

  function toolStart(name: string, args?: any, origin?: string) {
    phase = 'tools';
    const label = origin ? `${origin} › ${describeCall(name, args)}` : describeCall(name, args);
    if (name === 'exec_shell') {
      const cmd = String(args?.command ?? '').trim().split('\n')[0] ?? '';
      if (cmd) cmdLabel = cmd.length > 60 ? `${cmd.slice(0, 59)}…` : cmd;
      // Each command gets its own live window; the previous command's output already sits in its committed row.
      cmdLines.length = 0;
      cmdPartial = '';
      cmdActive = false;
    }
    running = [...running, { name, icon: toolIcon(name), label, startedAt: now() }];
    changed();
  }

  function toolResult(name: string, view: { ok: boolean; neutral?: boolean; partial?: boolean; title: string; detail?: string[]; hidden?: number; hint?: string; bulk?: boolean; command?: boolean; expand?: boolean; }) {
    const at = running.findIndex((r) => r.name === name);
    // A call that never started (refused for its arguments) has no matching toolStart — do not invent a removal from `running`, which used to drop an unrelated in-flight tool.
    if (at !== -1) {
      running = [...running.slice(0, at), ...running.slice(at + 1)];
    }
    if (view.ok) okCount += 1;
    else if (!view.neutral && !view.partial) failedCount += 1;
    liveTail = '';
    // The finished output lives in the committed tool row; the live window closes.
    if (name === 'exec_shell') cmdActive = false;
    push({
      type: 'tool',
      name,
      icon: toolIcon(name),
      ok: view.ok,
      neutral: view.neutral,
      partial: view.partial,
      title: view.title,
      detail: view.detail ?? [],
      hidden: view.hidden ?? 0,
      bulk: view.bulk,
      command: view.command,
      expand: view.expand,
      hint: view.hint,
    });
  }

  function describeCall(name: string, args?: any) {
    return toolLabel(name, args, shellKind);
  }

  function endSegment({ resumes = false }: { resumes?: boolean; } = {}) {
    if (done) return;
    closeReasoning();
    produced += text;

    // The unfinished tail.
    const tail = pending || carry;

    if (resumes) {
      // A segment that will be resumed has not finished its last block — the model was cut off inside it.
      carry = tail;
    } else {
      for (const block of finishBlocks(tail)) {
        if (block.kind === 'code' && suppressBlock(block.text)) continue;
        const kept = scrub(block.text);
        if (kept) push({ type: 'markdown', kind: block.kind, text: kept });
      }
      carry = '';
    }
    text = '';
    consumed = 0;
    pending = '';
    open = null;
    checkedLines = 0;
    lastLine = null;
    repeatCount = 0;
    stopped = false;
    segmentStartedAt = 0;
    lastDeltaAt = 0;
    liveTail = '';
    changed();
  }

  function finish(): string {
    if (done) return produced;
    endSegment();
    const answered = produced;
    done = true;
    phase = phase === 'cancelled' ? 'cancelled' : 'done';
    statusLabel = '';
    running = [];
    changed();
    return answered;
  }

  /** Reopens the session for a new turn: `items`/`nextId`/cumulative stats carry over, only the per-turn fields `finish()`/`interrupt()` closed are reset. */
  function startTurn() {
    done = false;
    stopped = false;
    phase = 'idle';
    running = [];
    cmdActive = false;
    cmdLines.length = 0;
    cmdPartial = '';
    statusLabel = '';
    liveTail = '';
    // `produced` accumulates one answer's full text for the `text` getter (what `pendingAnswerText` diffs against) — it must not carry into the next turn.
    produced = '';
    // Elapsed time and tool ok/fail counts are this turn's; token figures come from the usage meter, which splits turn from session itself.
    okCount = 0;
    failedCount = 0;
    startedAt = now();
    changed();
  }

  function interrupt(reason?: string) {
    if (done) return;
    phase = 'cancelled';
    endSegment();
    if (reason) push({ type: 'note', tone: 'warn', text: reason });
    done = true;
    statusLabel = '';
    running = [];
    changed();
  }

  function note(body: string, tone: 'info' | 'warn' | 'error' | 'success' | 'dim' = 'info') {
    if (!String(body ?? '').trim()) return;
    // End the open segment first so a note never lands ahead of buffered answer text.
    endSegment();
    push({ type: 'note', tone, text: String(body) });
  }

  function raw(body: string) {
    if (body === undefined || body === null) return;
    push({ type: 'raw', text: String(body) });
  }

  function plan(body: string) {
    if (body === undefined || body === null) return;
    if (!String(body).trim()) return;
    push({ type: 'plan', text: String(body) });
  }

  function tasks(list: ChecklistItem[] | null) {
    taskList = list && list.length ? list : null;
    changed();
  }

  /** Writes the checklist into the transcript, where it outlives the turn, and unpins it. */
  function commitTasks(list: ChecklistItem[]) {
    taskList = null;
    if (!list?.length) return changed();
    endSegment();
    push({ type: 'tasks', tasks: list });
  }

  function markdown(body: string) {
    const text = String(body ?? '');
    if (!text.trim()) return;
    endSegment();
    push({ type: 'markdown', text });
  }

  function command(cmd: string, where?: string) {
    push({ type: 'command', text: String(cmd), title: where });
  }

  // A model call finished: the meter moved, so the bar redraws.
  function onTelemetry() {
    changed();
  }

  function state(): RenderState {
    const t = now();
    if (snapshot && snapshotAt === t) return snapshot;
    snapshotAt = t;
    const f = facts();

    let reasoning: any = null;
    if (reasoningActive) {
      const lines = reasoningText.split('\n').filter((l) => l.trim());
      const tailLines = reasoningCollapsed
        ? ['thinking in circles…']
        : lines.slice(-REASONING_TAIL_LINES).map((l) => tailOf(l.replace(/\s+/g, ' ').trim()));
      reasoning = {
        active: true,
        tailLines,
        tail: tailLines[tailLines.length - 1] ?? '',
        seconds: Math.round((t - reasoningStartedAt) / 1000),
        lines: lines.length,
      };
    }

    let status: any = null;
    if (!done) {
      const preview =
        segmentStartedAt > 0 && !reasoningActive
          ? previewLine({
              pending,
              elapsedMs: t - segmentStartedAt,
              sinceDeltaMs: t - lastDeltaAt,
              inFence: open?.kind === 'code',
              fenceLines: open?.lines ?? 0,
              suppressed: pendingSuppressed(),
            })
          : null;

      if (preview) {
        status = { head: preview.body, why: null, hint: '', elapsedMs: t - segmentStartedAt, tail: '' };
      } else if (liveTail) {
        const label = statusLabel && !isIdle(statusLabel) ? statusLabel : 'running';
        status = { head: label, why: null, hint: '', elapsedMs: t - statusStartedAt, tail: liveTail };
      } else if (statusLabel) {
        const narrated = narrateStatus({
          label: statusLabel,
          elapsedMs: t - statusStartedAt,
          facts: f,
          sawOutput: text.length > 0,
        });
        status = { ...narrated, elapsedMs: t - statusStartedAt, tail: '' };
      }
    }

    const liveLines = pending.split('\n');
    snapshot = {
      version,
      items,
      live:
        !done && pending.trim() && !pendingSuppressed()
          ? {
              text: liveLines.slice(-LIVE_LINES).join('\n'),
              kind: open?.kind ?? 'paragraph',
              lines: liveLines.length,
            }
          : null,
      reasoning,
      status,
      running: running.slice(-MAX_RUNNING),
      tasks: !done ? taskList : null,
      cmd: !done && cmdActive && cmdLines.length > 0 ? { lines: [...cmdLines], active: true, label: cmdLabel } : null,
      stats: {
        model: String(f.model ?? ''),
        folder: String(f.folder ?? ''),
        usage: f.usage ?? null,
        context: f.context
          // The window, not the soft history target: the active turn may exceed the target by design, which read as an overflow.
          ? { used: f.context.inputTokens, window: f.context.contextLimit }
          : null,
        ok: okCount,
        failed: failedCount,
        elapsedMs: t - startedAt,
      },
      phase,
      done,
    };
    return snapshot;
  }

  return {
    onDelta,
    onReasoning,
    setStatus,
    setLiveTail,
    toolStart,
    toolResult,
    endSegment,
    finish,
    startTurn,
    interrupt,
    note,
    raw,
    plan,
    tasks,
    commitTasks,
    markdown,
    command,
    onTelemetry,
    state,
    get expandTools() {
      return expandTools;
    },
    set expandTools(v) {
      expandTools = Boolean(v);
      changed();
    },
    get showReasoning() {
      return detailed ? 'detailed' : reasoningVisible;
    },
    set showReasoning(v: boolean | string) {
      detailed = v === 'detailed';
      reasoningVisible = Boolean(v);
      changed();
    },
    get text() {
      return produced + text;
    },
    get done() {
      return done;
    },
  };
}

function isIdle(label: string) {
  return Object.values(AGENT_PHASE).some((p) => String(label).toLowerCase().startsWith(p));
}
