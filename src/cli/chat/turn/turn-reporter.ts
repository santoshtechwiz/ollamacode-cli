import { liveChecklist } from '../../../agent/planning/plan';
import { STOP_REASONS } from '../../../protocol';
import { toolTally } from '../../../ui/tool-preview';
import { toolLabel } from '../../../ui/render/labels';
import { pendingAnswerText } from '../render';
import type { ChatTurnContext, TurnResult } from './context';

/** What actually ran, so a silent model still leaves a factual record above the scrolled tool lines. */
function ranTools(result: TurnResult): string[] {
  return [...new Set((result.toolResults ?? [])
    .filter((t) => !(t.result as { data?: { reused?: boolean } })?.data?.reused)
    .map((t) => toolLabel(t.name))
    .filter(Boolean))];
}

function ranList(result: TurnResult): string {
  const did = ranTools(result);
  if (!did.length) return '';
  return ` It ran: ${did.slice(0, 6).join(', ')}${did.length > 6 ? `, and ${did.length - 6} more` : ''}.`;
}

/** The answer: whatever the model said that is not already on screen, plus the accounting for a turn where it said nothing. */
function reportAnswer(host: ChatTurnContext, result: TurnResult): void {
  const { render } = host;
  const pending = pendingAnswerText(render.text, result.content, result.stopReason === STOP_REASONS.COMPLETE);
  if (pending) render.markdown(pending);

  if (!result.content && result.toolResults.length === 0) {
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

  const { ran, ok, failed, refused, reused, skipped } = toolTally(result.toolResults);
  // Every attempt counts: a refused call next to "9/9 succeeded" read as a lie.
  const total = ran + refused + skipped;
  const list = ranList(result);
  // Calls that succeeded are not a finished task: the checklist below says what is still open.
  if ((result.planRemaining ?? 0) > 0) return;
  // Calls that succeeded are what ran, not proof the task is done; only the model's answer can say that.
  const extra = [
    failed > 0 ? `${failed} failed` : '',
    refused > 0 ? `${refused} not allowed` : '',
    skipped > 0 ? `${skipped} skipped` : '',
    reused > 0 ? `${reused} repeated` : '',
  ].filter(Boolean).join(', ');
  render.note(`The model finished without saying what it did.${list} ${ok} of ${total} step${total === 1 ? '' : 's'} worked${extra ? ` (${extra})` : ''}.`, 'dim');
}

// The tally is already in the answer report; asking a question at the end of a turn only blocks the prompt.
function reportMaxIterations(host: ChatTurnContext): void {
  host.render.note("Stopped here — this task took more steps than one turn allows. Run /continue to keep going.", 'info');
}

function reportOutputTruncated(host: ChatTurnContext): void {
  const changes = host.workspace?.state?.changes?.length ?? 0;
  host.render.note(
    changes > 0
      ? `Output limit reached — ${changes} file change${changes === 1 ? '' : 's'} already landed`
      : 'Output limit reached — the model could not finish; ask for the rest of the work.',
    'warn'
  );
}

/** The guard stops a turn that only repeats itself; naming what repeated tells the person what went round in circles. */
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
  // A paused plan already says where it stopped and why; a second line would only repeat it.
  if ((result.planRemaining ?? 0) > 0) return;
  const repeated = [...new Set((result.toolResults ?? []).filter((t) => (t.result?.data as any)?.reused).map((t) => toolLabel(t.name)))];
  // Not an error: the model went round in circles and needs a word from the person to move on.
  host.render.note(
    repeated.length > 0
      ? `Paused — the model kept asking for the same ${repeated.join(', ')} result. Tell it what to do next, or type /continue.`
      : 'Paused — the model repeated the same steps without getting further. Tell it what to do next, or type /continue.',
    'info'
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

/** The plan's checklist as it ended, kept in the transcript, and how to pick up what is left. */
function reportPlan(host: ChatTurnContext, result: TurnResult): void {
  const { render } = host;
  const summary = result.planSummary;
  if (summary) {
    // The plan ended: one summary of what it did and what it left, then it is gone.
    const short = (text: string) => {
      const plain = text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
      return plain.length > 40 ? `${plain.slice(0, 39)}…` : plain;
    };
    const steps = `${summary.done}/${summary.total} step${summary.total === 1 ? '' : 's'}`;
    if (summary.done === 0) {
      render.note('Nothing from the plan was done. /continue to start it, or /plan close to drop it.', 'warn');
      return;
    }
    const parts = [steps];
    if (summary.files.length) parts.push(`${summary.files.length} file${summary.files.length === 1 ? '' : 's'} changed`);
    if (summary.ran.length) parts.push(summary.ran.slice(0, 3).map(short).join(', ') + (summary.ran.length > 3 ? ` +${summary.ran.length - 3}` : ''));
    const all = summary.done === summary.total;
    render.note(`Plan finished${all ? ' 🎉' : ''}  ${parts.join(' · ')}`, all ? 'success' : 'info');
    if (!all) {
      const left = summary.notDone.slice(0, 3).map(short).join(', ') + (summary.notDone.length > 3 ? ` +${summary.notDone.length - 3} more` : '');
      render.note(`left: ${left}`, 'dim');
    }
    return;
  }
  if (!result.planChecklist?.length) {
    // No plan, but the model kept a task list this turn: its final state goes in the transcript once.
    const lists = (result.toolResults ?? []).map((t: any) => t.result?.data?.todos).filter(Array.isArray);
    const last = lists[lists.length - 1] as Array<{ content?: unknown; status?: unknown }> | undefined;
    if (last?.length) render.commitTasks(liveChecklist(null, { todos: last }));
    return;
  }
  render.commitTasks(result.planChecklist);
  const left = result.planRemaining ?? 0;
  if (left > 0) {
    const total = result.planChecklist.length;
    const failure = result.stopReason === STOP_REASONS.GUARD_STUCK ? lastFailure(result) : null;
    const next = failure
      ? `Stopped at ${failure}. Fix that, then type /continue, or /plan close to drop it.`
      : result.stopReason === STOP_REASONS.GUARD_STUCK
        ? 'The model repeated the same step — tell it what to do next, type /continue to retry, or /plan close to drop it.'
        : 'Type /continue to finish it, or /plan close to drop it.';
    render.note(`Plan paused — ${total - left} of ${total} steps done. ${next}`, 'info');
  }
}

/**
 * The last call this turn that ran and failed, in its own words: what it was and the first line it reported.
 * A stuck plan stopped because something kept failing; the person needs that, not "the model repeated a step".
 */
function lastFailure(result: TurnResult): string | null {
  const ran = (t: any) => !t.result?.ok && !t.result?.data?.notRunRepeat && t.result?.code !== 'EINVAL' && t.result?.code !== 'ESKIPPED';
  const failed: any = [...(result.toolResults ?? [])].reverse().find(ran);
  if (!failed) return null;
  const what = typeof failed.args?.command === 'string' && failed.args.command.trim()
    ? `\`${failed.args.command.trim()}\``
    : toolLabel(failed.name, failed.args);
  const said = [failed.result?.data?.execution?.stderr, failed.result?.error]
    .map((text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean))
    .find(Boolean);
  const line = said && said.length > 120 ? `${said.slice(0, 119)}…` : said;
  return line ? `${what}: ${line}` : what;
}

export async function reportChatTurn(host: ChatTurnContext, result: TurnResult): Promise<number> {
  reportAnswer(host, result);
  reportPlan(host, result);
  await reportStop(host, result);
  return reportSummary(result);
}
