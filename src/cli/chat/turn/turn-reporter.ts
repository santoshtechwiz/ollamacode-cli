import { checklistOf } from '../../../agent/todos';
import { uncheckedChanges } from '../../../context/workspace-state';
import { STOP_REASONS } from '../../../protocol';
import { SAME_CALL_LIMIT } from '../../../agent/turn/turn-state';
import { toolTally } from '../../../ui/tool-preview';
import { toolLabel } from '../../../ui/render/labels';
import { pendingAnswerText } from '../render';
import type { ChatTurnContext, TurnResult } from './context';

/** What actually ran, so a silent model still leaves a factual record above the scrolled tool lines. */
function ranTools(result: TurnResult): string[] {
  return [...new Set((result.toolResults ?? [])
    .map((t) => toolLabel(t.name))
    .filter(Boolean))];
}

function ranList(result: TurnResult): string {
  const did = ranTools(result);
  if (!did.length) return '';
  return ` It ran: ${did.slice(0, 6).join(', ')}${did.length > 6 ? `, and ${did.length - 6} more` : ''}.`;
}

/** Background jobs this turn started that are still running: their result is still to come, on its own. */
function stillRunning(host: ChatTurnContext, result: TurnResult): string[] {
  const inbox = host.workspace?.state?.background;
  if (!inbox) return [];
  const ids = (result.toolResults ?? []).map((t) => (t.result?.data as { background?: boolean; id?: string } | undefined))
    .filter((d) => d?.background && d.id).map((d) => String(d!.id));
  return [...new Set(ids)].filter((id) => inbox.isRunning(id));
}

/** The answer: whatever the model said that is not already on screen, plus the accounting for a turn where it said nothing. */
function reportAnswer(host: ChatTurnContext, result: TurnResult): void {
  const { render } = host;
  const pending = pendingAnswerText(render.text, result.content, result.stopReason === STOP_REASONS.COMPLETE);
  if (pending) render.markdown(pending);

  // The person stopped it, and the stop already said so: the model did not finish, and its silence says nothing about the provider.
  if (result.stopReason === STOP_REASONS.CANCELLED) return;

  // A reply cut off before it said anything usable: the stop report says what happened and what to do.
  if (!result.content && result.toolResults.length === 0 && result.stopReason !== STOP_REASONS.OUTPUT_TRUNCATED) {
    const generated = (result.telemetry ?? []).reduce((n: number, r: { completionTokens?: number }) => n + (r.completionTokens ?? 0), 0);
    render.note(
      generated > 0
        ? 'The model replied, but nothing in the reply could be shown as an answer. Try again, or pick another model with /model.'
        : 'The model sent nothing back. Check that the provider is running, or run "ocode init".',
      'dim'
    );
    return;
  }

  if (String(result.content ?? '').trim()) return;

  // A job it started is still going: that, not the model's silence, is why there is no result yet.
  const waiting = stillRunning(host, result);
  if (waiting.length) {
    render.note(`Waiting for ${waiting.map((id) => `"${id}"`).join(', ')} — still running in the background; its result will show here when it ends, no need to type anything.`, 'dim');
    return;
  }

  // A stuck turn says what ran in its one "Paused" line; a second line here only repeated it.
  if (result.stopReason === STOP_REASONS.GUARD_STUCK) return;
  render.note(`The model finished without saying what it did.${ranRecord(result)}`, 'dim');
}

/** What ran, counted: calls that succeeded are what ran, not proof the task is done; only the model's answer can say that. */
function ranRecord(result: TurnResult): string {
  const { ran, ok, failed, refused, fixable, skipped } = toolTally(result.toolResults);
  // Every attempt counts: a refused call next to "9/9 succeeded" read as a lie.
  const total = ran + refused + fixable + skipped;
  const extra = [
    failed > 0 ? `${failed} failed` : '',
    fixable > 0 ? `${fixable} needed fixing` : '',
    refused > 0 ? `${refused} not allowed` : '',
    skipped > 0 ? `${skipped} skipped` : '',
  ].filter(Boolean).join(', ');
  return `${ranList(result)} ${ok} of ${total} step${total === 1 ? '' : 's'} worked${extra ? ` (${extra})` : ''}.`;
}

// The tally is already in the answer report; asking a question at the end of a turn only blocks the prompt.
function reportMaxIterations(host: ChatTurnContext): void {
  host.render.note("Stopped here — this task took more steps than one turn allows. Run /continue to keep going.", 'info');
}

/** The reply was cut off at its length limit: say which limit, what already landed, and how to carry on. */
function reportOutputTruncated(host: ChatTurnContext): void {
  const workspace = host.workspace as { maxTokens?: number; thinkingEnabled?: boolean; state?: { changes?: unknown[] } } | undefined;
  const changes = workspace?.state?.changes?.length ?? 0;
  const limit = Number(workspace?.maxTokens) || 0;
  const cut = limit > 0
    ? `The model's reply was cut off at its ${limit.toLocaleString('en-US')}-token limit${workspace?.thinkingEnabled ? ' (thinking counts toward it)' : ''}.`
    : "The model's reply was cut off at its length limit.";
  const landed = changes > 0 ? ` ${changes} file change${changes === 1 ? '' : 's'} already landed.` : '';
  host.render.note(`${cut}${landed} Type /continue to pick up where it stopped, or raise agent.maxTokens.`, 'warn');
}

/** The turn stopped on the same call made too many times in a row; naming it tells the person what went round in circles. */
function reportGuardStuck(host: ChatTurnContext, result: TurnResult): void {
  // The model wrote its account of the work and only repeated a step after it: the work is what to report,
  // not the repeat that was cut off.
  // A mistake the model then fixed is not a failure: only each tool's latest result counts.
  const latest = new Map<string, boolean>();
  for (const t of result.toolResults ?? []) latest.set(t.name, Boolean(t.result?.ok));
  const failed = [...latest.values()].some((ok) => !ok);
  if (String(result.content ?? '').trim() && !failed) {
    host.render.note('Done 🎉', 'success');
    return;
  }
  // Checking on a job that is still running is waiting, not going round in circles: the answer report said so.
  if (!String(result.content ?? '').trim() && stillRunning(host, result).length) return;
  // Two stops share this reason: a call that was denied (by the person or the policy) ends the turn at once, and the
  // same call made too many times in a row. Naming which one, and the call, tells the person what happened.
  const last = (result.toolResults ?? []).at(-1);
  const denied = last && !last.result?.ok && (last.result?.code === 'EDENIED' || last.result?.code === 'EPOLICY');
  if (denied) {
    host.render.note(`Stopped — ${toolLabel(last.name, last.args)} was not allowed, so the turn ended there.${ranRecord(result)} Tell it what to do instead, or type /continue.`, 'info');
    return;
  }
  const why = last
    ? `the model made the same ${toolLabel(last.name, last.args)} call ${SAME_CALL_LIMIT} times with nothing changed in between`
    : 'the model went round in circles';
  const silent = !String(result.content ?? '').trim();
  // With an answer above, the line says where that answer came from; without one, it carries what ran.
  host.render.note(
    silent
      ? `Paused — ${why} and gave no answer.${ranRecord(result)} Tell it what to do next, or type /continue.`
      : `Stopped because ${why}; the summary above is where it got to. Tell it what to do next, or type /continue.`,
    'info',
  );
}


/** The stop: why the turn ended, named in the terms the person watching can act on. */
async function reportStop(host: ChatTurnContext, result: TurnResult): Promise<void> {
  switch (result.stopReason) {
    case STOP_REASONS.CANCELLED:
      // Ctrl-C and a dismissed prompt each say so where they happen; a second line here only repeats it.
      return;
    case STOP_REASONS.MAX_ITERATIONS:
      return reportMaxIterations(host);
    case STOP_REASONS.OUTPUT_TRUNCATED:
      return reportOutputTruncated(host);
    case STOP_REASONS.GUARD_STUCK:
      return reportGuardStuck(host, result);
    default:
      return;
  }
}

/** The summary: the single number the process exits with. */
function reportSummary(result: TurnResult): number {
  if (result.stopReason === STOP_REASONS.CANCELLED) return 130;
  if (result.stopReason !== STOP_REASONS.COMPLETE) return 1;
  return !result.content && result.toolResults.length === 0 ? 1 : 0;
}

/**
 * The task list as the turn left it, kept in the transcript once each time the model rewrites it: a turn that left it
 * as it was shows nothing again. A list with every task done is finished, and goes.
 */
function reportTodos(host: ChatTurnContext, result: TurnResult): void {
  const state = (host.workspace as any)?.state;
  if (!state || state.todos === state.todosShown) return;
  const items = checklistOf(state.todos);
  host.render.commitTasks(items);
  const open = items.filter((item) => item.status !== 'done');
  // A task is done only on evidence, so an answer can say "all done" over a list that is not: the person reads which.
  if (open.length && result.stopReason === STOP_REASONS.COMPLETE) {
    host.render.note(`Not finished: ${open.length} of ${items.length} tasks are still open (${open.map((item) => item.title).slice(0, 3).join('; ')}${open.length > 3 ? '; …' : ''}).`, 'warn');
  }
  if (items.length && !open.length) state.todos = [];
  state.todosShown = state.todos;
}

export async function reportChatTurn(host: ChatTurnContext, result: TurnResult): Promise<number> {
  reportAnswer(host, result);
  reportTodos(host, result);
  await reportStop(host, result);
  reportUnchecked(host, result);
  reportContext(host);
  return reportSummary(result);
}

/**
 * A turn that changed files and ran no passing build, test, lint or type-check after the last change: said plainly, so
 * "done" in the answer is not mistaken for "checked". Not said for a cancelled turn, or one still waiting on a job.
 */
function reportUnchecked(host: ChatTurnContext, result: TurnResult): void {
  const state = (host.workspace as any)?.state;
  if (!state || result.stopReason === STOP_REASONS.CANCELLED || stillRunning(host, result).length) return;
  // This turn's changes that no passing check came after.
  const touched = [...new Set(uncheckedChanges(state, { thisTurn: true }).map((c: { path: string }) => c.path))];
  if (touched.length === 0) return;
  const what = touched.length ? `${touched.length} file${touched.length === 1 ? '' : 's'}` : 'files';
  host.render.note(`Changed ${what} — no build or test ran after the changes, so they are not checked yet.`, 'dim');
}

/** History this full (of the room it gets in a request) is about to be trimmed: say so before it happens. */
const NEAR_FULL = 0.8;
/** Below this the near-full notice is armed again, as after /compact. */
const REARM = 0.6;

/**
 * The context filling up, said once per stage: nearly full (before anything is trimmed), then trimmed, and again only
 * when trimming has doubled. Trimming happens on its own; /compact and /clear are the person's way to do more.
 */
function reportContext(host: ChatTurnContext): void {
  const history = host.history as { lastBudget?: { dropped: number; historyNeeded: number; historyRoom: number } | null; contextNotice?: { near: boolean; dropped: number } } | undefined;
  const budget = history?.lastBudget;
  if (!history || !budget) return;
  const seen = (history.contextNotice ??= { near: false, dropped: 0 });
  if (budget.dropped < seen.dropped) seen.dropped = budget.dropped;
  if (budget.dropped > 0) {
    if (seen.dropped === 0 || budget.dropped >= seen.dropped * 2) {
      host.render.note(
        `Context trimmed to fit: the ${budget.dropped} oldest message${budget.dropped === 1 ? ' is' : 's are'} no longer sent to the model (still kept in the session). Type /compact to keep only the latest exchanges, or /clear to start fresh.`,
        'info',
      );
      seen.dropped = budget.dropped;
    }
    return;
  }
  const full = budget.historyRoom > 0 ? budget.historyNeeded / budget.historyRoom : 0;
  if (full < REARM) seen.near = false;
  if (full >= NEAR_FULL && !seen.near) {
    host.render.note(
      `Context is ${Math.min(99, Math.round(full * 100))}% full. When it fills, the oldest messages are trimmed automatically; type /compact to do it now, or /clear to start fresh.`,
      'info',
    );
    seen.near = true;
  }
}
