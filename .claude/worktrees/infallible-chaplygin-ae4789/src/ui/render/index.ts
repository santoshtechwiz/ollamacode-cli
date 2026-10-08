import { createRenderSession } from './session';
import { createInkView } from './ink-view';
import { createPlainView } from './plain-view';
import { renderMarkdown } from './markdown';
import { describeToolResult } from '../tool-preview';

export type Renderer = ReturnType<typeof createRenderer>;

export function createRenderer({
  out = process.stdout,
  showReasoning = false,
  shellKind,
  expandTools = false,
  suppressLine,
  suppressBlock,
  facts,
  onRepetition,
  onWrite,
  interactive,
  renderExtra,
}: any = {}) {
  let view: any = null;

  const session = createRenderSession({
    showReasoning,
    shellKind,
    expandTools,
    suppressLine,
    suppressBlock,
    facts,
    onRepetition,
    onChange: () => view?.notify(),
  });

  const live = interactive ?? Boolean(out.isTTY);
  // Output made while a nested prompt owns the screen waits for resume(): one redraw that both added transcript and re-armed the input left the prompt deaf.
  let paused = false;
  const held: Array<() => void> = [];
  const whenLive = (fn: () => void) => (paused ? held.push(fn) : fn());
  view = live
    ? createInkView({ session, out, expandTools, showReasoning, onWrite, renderExtra })
    : createPlainView({ session, out, expandTools, showReasoning, onWrite });
  view.start();

  // The tool whose change was just shown in an approval preview: its result names the change without drawing it again.
  let previewedTool: string | null = null;

  return {
    onDelta: (d: string, f?: string) => session.onDelta(d, f),
    onReasoning: (d: string, f?: string) => session.onReasoning(d, f),
    onStatus: (s: string) => session.setStatus(s),
    onCommandOutput: (t: string) => session.setLiveTail(t),
    onTelemetry: () => session.onTelemetry(),

    onToolStart(name: string, args?: any, where?: string, origin?: string) {
      session.toolStart(name, args, origin);
      if (name === 'exec_shell') {
        const cmd = String( (args ?? {} as any).command ?? '').trim();
        if (cmd) session.command(cmd, where);
      }
    },

    onToolResult(name: string, _args: any, result: import('../../types.ts').ToolResult, origin?: string) {
      // A exec_shell already committed its own `command` line on toolStart, so the finished row must not restate the command — otherwise it prints twice.
      // A call repeated three times is one wasted step, not three lines: the first notice says so.
      const view = describeToolResult(name, result, shellKind, name === 'exec_shell');
      const alreadyShown = previewedTool === name && result.ok;
      previewedTool = null;
      // A subagent's line carries its name, so lines from children running side by side stay apart.
      const titled = origin ? { ...view, title: `${origin} › ${view.title}` } : view;
      session.toolResult(name, alreadyShown ? { ...titled, detail: [], hidden: 0 } : titled);
    },

    /** An approval preview: drawn now, and remembered so the call's result does not draw the same change twice. */
    preview(name: string, block: string) {
      previewedTool = name;
      whenLive(() => session.raw(block));
    },

    onMentions(mentions: string[]) {
      if (mentions?.length) session.note(`attached ${mentions.map((m) => `@${m}`).join(', ')}`, 'dim');
    },

    note: (text: string, tone?: 'info' | 'warn' | 'error' | 'success' | 'dim') => whenLive(() => session.note(text, tone)),

    raw: (text: string) => whenLive(() => session.raw(text)),
    plan: (text: string) => session.plan(text),
    tasks: (list: import('../../agent/planning/plan.ts').ChecklistItem[] | null) => session.tasks(list),
    commitTasks: (list: import('../../agent/planning/plan.ts').ChecklistItem[]) => whenLive(() => session.commitTasks(list)),
markdown(text: string) {
      session.markdown(text);
      // After `finish()` the Ink view is stopped and will never draw a post-done markdown item, so it has to be written directly.
      if (session.done && live) {
        const lines = renderMarkdown(String(text ?? ''));
        if (lines.length) out.write(`${lines.join('\n')}\n`);
      }
    },

    pause: () => { paused = true; view.pause(); },
    resume: () => {
      paused = false;
      view.resume();
      for (const fn of held.splice(0)) fn();
    },
    notify: () => view.notify(),
    flush: () => view.flush?.(),
    clear: () => view.clear?.(),
    stop: () => view.stop(),

    finish(): string {
      const text = session.finish();
      view.stop();
      return text;
    },

    /** Like `finish()`, but for a multi-turn session: ends this turn without unmounting the view. Pair with `startTurn()` for the next one. */
    turnDone(): string {
      return session.finish();
    },

    startTurn: () => session.startTurn(),

    interrupt(reason?: string) {
      session.interrupt(reason);
      view.stop();
    },

    get showReasoning() {
      return session.showReasoning;
    },
    set showReasoning(v) {
      session.showReasoning = v;
    },

    get expandTools() {
      return session.expandTools;
    },
    set expandTools(v) {
      session.expandTools = v;
    },

    get text() {
      return session.text;
    },

    state: () => session.state(),
  };
}
