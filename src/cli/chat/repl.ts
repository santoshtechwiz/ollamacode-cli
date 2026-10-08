import { createElement as h, Fragment } from 'react';
import { basename } from 'node:path';
import readline from 'node:readline';

import type { TypedFlags } from '../flags';
import { createRenderer, type Renderer } from '../../ui/render/index';
import { Prompt, createHistory } from '../../ui/render/prompt';
import { RevealPanel } from '../../ui/render/app';
import { isToolCallLine, isToolCallBlock } from '../../agent/response/tool-parser';
import { findFabricatedResults } from '../../agent/response/demux';
import { resolveShell } from '../../tool/process/shell/runtime';
import { select } from '../../ui/prompts';
import { detectImagePaste, interruptAction, pinRawMode } from '../repl-input';
import { parseProviderMode } from '../../model/providers/mode';
import { isCancel } from '../../core/errors';
import { dim, cyan, yellow, gray, icons, SHOW_CURSOR } from '../../ui/ansi';
import { checklistOf } from '../../agent/todos';
import { STOP_REASONS } from '../../protocol';
import { createBackgroundHandoff } from './background-handoff';
import { logger } from '../../core/logger';
import { getCommand, CmdResult } from '../commands/registry';
import { createCommandAutocompleteProvider } from '../commands/autocomplete-provider';
import { createFileAutocompleteProvider } from './file-autocomplete-provider';
import { AutocompleteConfig } from '../../ui/render/autocomplete-config';
import { openSession, saveChat, startNewChat, switchToSession, guardProcess, closeSession, isKnownTool, type ChatSession } from './session';
import { modeOf, nextMode, setMode, modeLabel, modeNotice } from './mode';
import { printPaged as renderPaged, renderBanner, describeFullToolOutput, formatModelFit } from './render';
import { modelFitOnce } from '../../agent/workspace/profile';
import { usageTotals, usageSince, describeTurnUsage } from '../../core/usage';
import { runShellCommand as runShell } from './shell';
import { runChatTurn, reportChatTurn, type ChatTurnContext } from './turn/index';

/** The one entry point: `ocode`, `ocode chat`, piped chat and `ocode init` all start here. */
export async function run(flags: TypedFlags) {
  const s = await openSession(flags);
  if (!s) return;
  if (flags.prompt) return runHeadless(s, [flags.prompt]);
  if (!s.interactive || !process.stdout.isTTY) return runHeadless(s);
  return runLive(s);
}

/** What differs between front ends is only how they talk to the terminal. */
interface Frontend {
  render: Renderer;
  active: AbortController | null;
  select: <T>(label: string, items: { label: string; value: T; hint?: string }[], opts?: { initialIndex?: number }) => Promise<T | undefined>;
  confirm: (question: string, defaultYes: boolean) => Promise<boolean>;
  onPromptOwnership?: (owned: boolean) => void;
  /** Whether a person can answer a question on this front end. */
  canAsk: boolean;
  armed: boolean;
  /** Inputs waiting behind a running turn. */
  pending: string[];
  /** The last turn was stopped or failed; what it left is not picked up again on its own. */
  lastTurnUnfinished?: boolean;
  /** Live-prompt hooks some slash commands use (insert text, queue input…). */
  ui?: Record<string, unknown>;
}

function sessionRenderer(s: ChatSession, fe: () => Frontend | undefined, live: { renderExtra?: () => unknown } = {}): Renderer {
  return createRenderer({
    ...(live.renderExtra ? { interactive: true, renderExtra: live.renderExtra } : {}),
    shellKind: resolveShell().kind,
    showReasoning: s.showReasoning === 'detailed' ? 'detailed' : Boolean(s.showReasoning),
    expandTools: s.expandTools,
    suppressLine: (line: string) => isToolCallLine(line) || findFabricatedResults(line, isKnownTool).length > 0,
    suppressBlock: isToolCallBlock,
    facts: () => ({
      model: s.session.model,
      folder: basename(s.workspace.cwd),
      cpuOnly: s.workspace.cpuOnly,
      remote: s.workspace.remote,
      context: s.history.lastBudget,
      usage: { session: usageTotals(), turn: s.turnBaseline ? usageSince(s.turnBaseline) : null },
    }),
    onRepetition: () => fe()?.active?.abort(),
  });
}

async function runTurn(s: ChatSession, fe: Frontend, text: string, { continuing = false }: { continuing?: boolean } = {}): Promise<{ cancelled: boolean }> {
  const { render } = fe;
  const { workspace, agentState } = s;
  const controller = new AbortController();
  fe.active = controller;
  let cancelled = false;
  s.turnBaseline = usageTotals();
  render.startTurn();

  // Switching modes only moves the footer; the change is said once, when a message actually runs in it.
  const notice = modeNotice(s);
  if (notice) render.note(notice, 'info');

  const host: ChatTurnContext = {
    flags: s.flags,
    cfg: s.cfg,
    interactive: s.interactive,
    session: s.session,
    workspace,
    history: s.history,
    agentState,
    runtime: s.runtime,
    render,
    toolsEnabled: s.toolsEnabled,
    onPromptOwnership: fe.onPromptOwnership,
  };

  // The task list stays pinned above the status line and redraws as the model rewrites it; one it has not touched since
  // it was last shown stays in the transcript, not pinned again.
  const showTasks = () => {
    const state = workspace.state;
    if (!state || state.todos === state.todosShown) return;
    const items = checklistOf(state.todos);
    render.tasks(items.length ? items : null);
  };

  try {
    const result = await runChatTurn(host, text, {
      signal: controller.signal,
      planMode: s.planMode,
      reviewMode: s.reviewMode,
      askMode: s.askMode,
      continuing,
      onToolResult: (name, args, toolResult) => {
        const derived = describeFullToolOutput(name, args, toolResult);
        if (derived) s.lastOutput = derived;
        // Any result that is a file's full text, whatever tool produced it; a fetched page is kind "web" and stays out.
        const data = (toolResult as any).data ?? {};
        if (toolResult.ok && toolResult.kind === 'file' && typeof data.fullContent === 'string') {
          const full = data.fullContent;
          s.lastReadFile = { path: data.path ?? (args as any).path ?? 'unknown', lines: data.lines ?? full.split('\n').length, fullContent: full };
          if (toolResult.truncated) render.note(`${data.lines} lines — Ctrl+O or /open ${data.path} for the whole file`, 'dim');
        }
      },
      onStepComplete: showTasks,
      onModeSwitch: (next: string) => {
        if (next !== 'agent' && next !== 'plan') return;
        // The agent changed the mode, not the person: say so once, so it is never a surprise.
        setMode(s, next);
        const notice = modeNotice(s, next === 'plan' ? 'switched to plan before changing anything' : 'switched to carry out the approved plan');
        if (notice) render.note(notice, 'info');
        saveChat(s);
        if (next === 'agent') showTasks();
      },
    });
    s.sessionIterations += result.iterations ?? 0;
    if (result.content?.trim() && !s.lastOutput) s.lastOutput = { label: 'answer', text: String(result.content) };
    if (result.telemetry?.length) s.sessionTelemetry.push(...result.telemetry);
    cancelled = result.stopReason === STOP_REASONS.CANCELLED;
    fe.lastTurnUnfinished = cancelled;
    process.exitCode = await reportChatTurn(host, result);
  } catch (err) {
    cancelled = controller.signal.aborted || isCancel(err);
    fe.lastTurnUnfinished = true;
    // Never interrupt() the view here: it unmounts Ink and leaves a live prompt deaf.
    const msg = err && typeof err === 'object' && 'message' in err ? String((err as any).message) : String(err);
    // Whatever stopped the turn (Esc, Ctrl-C, the repetition guard, a dismissed prompt) already said so where it happened.
    if (!cancelled) render.note(`${icons.fail} ${msg}`, 'error');
    logger.debug('turn failed:', err);
    process.exitCode = cancelled ? 130 : 1;
  } finally {
    const used = usageSince(s.turnBaseline);
    s.turnBaseline = null;
    if (used.calls > 0) {
      // The live footer shows it; a run with no footer gets it as a line.
      if (!fe.canAsk) render.note(describeTurnUsage(used), 'dim');
      s.turnUsage.push({ ...used, request: text.replace(/\s+/g, ' ').trim().slice(0, 80) });
      if (s.turnUsage.length > MAX_TURN_USAGE) s.turnUsage.splice(0, s.turnUsage.length - MAX_TURN_USAGE);
    }
    render.turnDone();
    fe.active = null;
    saveChat(s);
  }
  // A command that runs a turn (/init, /continue) needs to know the person stopped it.
  return { cancelled };
}

/** Turns kept for /usage and in the session record. */
const MAX_TURN_USAGE = 100;

async function runShellInput(s: ChatSession, fe: Frontend, command: string) {
  fe.active = new AbortController();
  try {
    const out = await runShell({ write: (t: string) => fe.render.raw(t), confirm: fe.confirm, cwd: s.workspace.cwd, signal: fe.active.signal }, command);
    if (out) s.lastOutput = out;
  } finally {
    fe.active = null;
  }
}

/** Slash commands read and write the session itself, plus a few terminal hooks. */
function commandContext(s: ChatSession, fe: Frontend) {
  return Object.assign(s, {
    write: (text: string) => fe.render.raw(text),
    select: fe.select,
    confirm: fe.confirm,
    persist: () => saveChat(s),
    runOneTurn: (text: string, opts?: { continuing?: boolean }) => runTurn(s, fe, text, opts),
    runShellCommand: (command: string) => runShellInput(s, fe, command),
    printPaged: (label: string, content: string, offset: number = 1) => renderPaged((t: string) => fe.render.raw(t), label, content, offset),
    startNewSession: () => startNewChat(s),
    sessionsRoot: s.root,
    currentSessionId: () => s.sessionId,
    switchSession: (rec: any) => switchToSession(s, rec),
    ...(fe.ui ?? {}),
  });
}

/** Every input goes through here, whichever front end read it. */
async function routeInput(s: ChatSession, fe: Frontend, text: string): Promise<'exit' | void> {
  // Commit what was asked to the transcript before its effects appear.
  fe.render.raw(`\n${cyan('❯')} ${text}\n`);
  const pastedImage = detectImagePaste(text);
  if (pastedImage) {
    fe.render.note(`pasted an image (${pastedImage.kind}) — this agent only reads text. Describe it, or save it to a file and ask me to read the file.`, 'warn');
    return;
  }
  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (command) await runShellInput(s, fe, command);
    return;
  }
  // A command name has one leading slash; `/app/etc/xyz …` is a path the person is talking about, so it goes to the model.
  if (/^\/[^\s/]*(\s|$)/.test(text)) {
    const [name, ...rest] = text.split(/\s+/);
    const cmd = getCommand(name);
    if (!cmd) {
      fe.render.note(`unknown command ${name} — try /help`, 'dim');
      return;
    }
    const handled = await cmd.run(commandContext(s, fe), rest.join(' ').trim());
    fe.render.expandTools = s.expandTools;
    fe.render.showReasoning = s.showReasoning === 'detailed' ? 'detailed' : Boolean(s.showReasoning);
    if (handled === CmdResult.EXIT) return 'exit';
    return;
  }
  await runTurn(s, fe, text);
}

/** The banner, the same for every front end. */
async function greet(s: ChatSession, fe: Frontend) {
  const { workspace, session } = s;
  const ownsProviderMode = session.provider.id === 'ollama' || session.provider.id === 'ollama-cloud';
  const modes = [
    ownsProviderMode ? dim(`mode ${parseProviderMode(s.cfg.providerMode)}`) : null,
    s.toolsEnabled ? null : yellow('tools off'),
    workspace.thinkingEnabled && s.showReasoning === 'detailed' ? gray('thinking detailed') : null,
    workspace.supportsThinking && !workspace.thinkingEnabled ? dim('thinking off') : null,
    s.scope ? dim(`scope ${s.scope}`) : null,
    workspace.nativeTools === false ? yellow('text-mode tools') : null,
  ].filter(Boolean) as string[];

  const fit = modelFitOnce(workspace);
  fe.render.raw(
    renderBanner({
      providerLabel: session.provider.label,
      model: session.model,
      cwd: workspace.cwd,
      stacks: workspace.stacks.map((st: any) => st.label).join(', '),
      modes,
      sessionLine: s.resumable ? '↻ Continued last session' : dim('new session'),
      planResumeLine: '',
      bannerNotes: s.resumable ? s.resumeSafetyNotes : s.bannerNotes,
      modelFit: fit ? formatModelFit(fit) : undefined,
      // Keyboard shortcuts only make sense where someone is typing.
      compact: s.resumable || !fe.canAsk,
    })
  );
}

function cancelTurn(fe: Frontend): boolean {
  if (!fe.active || fe.active.signal.aborted) return false;
  fe.active.abort();
  const dropped = fe.pending.splice(0).length;
  fe.render.note(`Stopped — nothing more will run.${dropped ? ` Your ${dropped === 1 ? 'queued message was' : `${dropped} queued messages were`} dropped too.` : ''}`, 'info');
  return true;
}

/** Ctrl+C everywhere: cancel a running turn, otherwise arm, and exit on the second press. */
function watchInterrupts(s: ChatSession, fe: Frontend, shutdown: () => Promise<void>): () => void {
  const onSigint = () => {
    const next = interruptAction({ busy: Boolean(fe.active && !fe.active.signal.aborted), armed: fe.armed });
    fe.armed = next.armed;
    if (next.action === 'cancel') return void cancelTurn(fe);
    if (next.action === 'arm') return fe.render.note('press Ctrl-C again to exit, or type /exit', 'dim');
    void shutdown();
  };
  process.on('SIGINT', onSigint);
  guardProcess(s, () => { fe.active?.abort(); try { fe.render.stop(); } catch { /* ignore */ } });
  return () => process.off('SIGINT', onSigint);
}

async function endSession(s: ChatSession, fe: Frontend) {
  fe.active?.abort();
  await closeSession(s);
  const kept = s.history.serialize().length;
  fe.render.note(kept > 0 ? `session saved (${kept} messages) — ocode -c continues it` : 'bye', 'dim');
  fe.render.flush();
}

/** No live prompt: piped chat reads stdin's lines; `ocode init` passes its one input. */
async function runHeadless(s: ChatSession, inputs?: string[]) {
  const fe: Frontend = {
    render: sessionRenderer(s, () => fe),
    active: null,
    armed: false,
    pending: [],
    canAsk: false,
    select: async (): Promise<undefined> => undefined,
    confirm: async () => false,
  };
  const stop = watchInterrupts(s, fe, async () => { await endSession(s, fe); fe.render.stop(); process.exit(); });
  await greet(s, fe);

  // Each input is echoed by routeInput, so the reader prints no prompt marker of its own.
  const rl = inputs ? null : readline.createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of inputs ?? rl!) {
      const text = String(line ?? '').trim();
      if (!text) continue;
      fe.armed = false;
      if ((await routeInput(s, fe, text)) === 'exit') break;
    }
  } finally {
    stop();
    rl?.close();
    await endSession(s, fe);
    fe.render.stop();
  }
}

async function runLive(s: ChatSession) {
  const releaseRawMode = pinRawMode(process.stdin);
  let promptValue = '';
  let promptCursor = 0;
  let promptDisabled = false;
  let revealed: { kind: 'file' | 'output'; label: string; lines: string[] } | null = null;
  const cmdHistory = createHistory();

  const autocompleteConfig: AutocompleteConfig = {
    providers: [
      createCommandAutocompleteProvider(),
      createFileAutocompleteProvider({ cwd: s.workspace.cwd }),
    ],
  };

  async function executeAutocompleteCommand(command: string, args: string) {
    const cmd = getCommand(command);
    if (!cmd) {
      render.note(`unknown command ${command} — try /help`, 'dim');
      return;
    }
    const handled = await cmd.run(commandContext(s, fe), args);
    fe.render.expandTools = s.expandTools;
    fe.render.showReasoning = s.showReasoning === 'detailed' ? 'detailed' : Boolean(s.showReasoning);
    if (handled === CmdResult.EXIT) {
      await shutdown();
    }
  }

  const holding = async <T>(fn: () => Promise<T>): Promise<T> => {
    promptDisabled = true;
    render.pause();
    try {
      return await fn();
    } finally {
      promptDisabled = false;
      render.resume();
    }
  };

  const render: Renderer = sessionRenderer(s, () => fe, {
    renderExtra: () => h(Fragment, null,
      revealed ? h(RevealPanel, { label: revealed.label, lines: revealed.lines, rows: process.stdout.rows || 24, columns: process.stdout.columns || 80 }) : null,
      h(Prompt, {
        prefix: `${cyan('❯')} `,
        value: promptValue,
        cursor: promptCursor,
        disabled: promptDisabled,
        modeLabel: modeLabel(modeOf(s)),
        modeRestricted: modeOf(s) !== 'agent',
        onChange: (v: string, c: number) => {
          promptValue = v;
          promptCursor = c;
          render.flush();
        },
        onSubmit: (text: string) => { void onSubmit(text); },
        onHistoryUp: () => { const v = cmdHistory.up(promptValue); if (v !== null) { promptValue = v; promptCursor = v.length; render.flush(); } },
        onHistoryDown: () => { const v = cmdHistory.down(); if (v !== null) { promptValue = v; promptCursor = v.length; render.flush(); } },
        onCtrlC: () => { process.emit('SIGINT'); },
        onCtrlD: () => { if (fe.active && !fe.active.signal.aborted) return; void shutdown(); },
        onCycleMode: () => {
          setMode(s, nextMode(modeOf(s)));
          saveChat(s);
          // The footer label is the live mode; the chat says it once, when a message runs in it.
          render.flush();
        },
        onRevealFile: () => toggleReveal('file', s.lastReadFile && { label: s.lastReadFile.path, text: s.lastReadFile.fullContent }, 'read'),
        onRevealOutput: () => toggleReveal('output', s.lastOutput && { label: s.lastOutput.label, text: s.lastOutput.text }, 'run'),
        onClearScreen: () => render.clear(),
        onEscape: () => {
          if (revealed) return toggleReveal(revealed.kind, null, '');
          if (cancelTurn(fe)) return;
          promptValue = '';
          promptCursor = 0;
          render.flush();
        },
        onEditor: () => { void processInput('/editor'); },
        autocompleteConfig,
        onAutocompleteExecute: executeAutocompleteCommand,
      })),
  });

  const fe: Frontend = {
    render,
    active: null,
    armed: false,
    pending: [],
    canAsk: true,
    select: (label, items, opts) => holding(() => select(label, items, opts as any)),
    confirm: async (question, defaultYes) =>
      Boolean(await fe.select(question, [{ label: 'Yes', value: true }, { label: 'No', value: false }], { initialIndex: defaultYes ? 0 : 1 })),
    onPromptOwnership: (owned) => { promptDisabled = owned; },
    ui: {
      insertText: (t: string) => { promptValue += String(t ?? ''); promptCursor = promptValue.length; render.flush(); },
      queueText: (t: string) => { fe.pending.push(String(t ?? '')); return true; },
      draft: () => promptValue,
      suspendInput: () => { promptDisabled = true; },
      resumeInput: () => { promptDisabled = false; },
      pauseRender: () => render.pause(),
      resumeRender: () => render.resume(),
    },
  };

  // A background process the agent started ends: the person sees the result and the agent is handed it, untyped.
  const handoff = createBackgroundHandoff({
    background: s.workspace.state?.background,
    busy: () => Boolean(fe.active && !fe.active.signal.aborted),
    queued: () => fe.pending.length > 0,
    typing: () => Boolean(promptValue.trim()),
    lastTurnUnfinished: () => Boolean(fe.lastTurnUnfinished),
    note: (text, tone) => render.note(text, tone),
    echo: (text) => render.raw(`\n${cyan('❯')} ${dim(`(sent for you) ${text}`)}\n`),
    runTurn: async (text) => {
      await runTurn(s, fe, text);
      promptDisabled = false;
      render.resume();
    },
    afterTurn: async () => {
      const next = fe.pending.shift();
      if (next !== undefined) await processInput(next);
      else await handoff.handOff();
    },
  });

  // The same key closes its own reveal; the other key swaps it. Nothing enters the transcript, so toggling never appends.
  function toggleReveal(kind: 'file' | 'output', source: { label: string; text: string } | null, verb: string) {
    if (revealed?.kind === kind) {
      revealed = null;
    } else if (!source || !String(source.text ?? '').trim()) {
      render.note(`nothing ${verb} yet`, 'dim');
      return;
    } else {
      revealed = { kind, label: source.label, lines: String(source.text).replace(/\s+$/, '').split('\n') };
    }
    render.flush();
  }

  function restoreTerminal() {
    try { render.stop(); } catch { /* ignore */ }
    try { releaseRawMode(); } catch { /* ignore */ }
    try { if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR); } catch { /* ignore */ }
  }
  process.on('exit', restoreTerminal);

  const stop = watchInterrupts(s, fe, () => shutdown());
  async function shutdown() {
    stop();
    await endSession(s, fe);
    restoreTerminal();
    process.exit();
  }

  await greet(s, fe);

  async function onSubmit(raw: string) {
    const text = String(raw ?? '').trim();
    fe.armed = false;
    if (!text) return;
    // The person is back: background results may be handed to the agent again.
    handoff.personSpoke();
    fe.lastTurnUnfinished = false;
    cmdHistory.record(text);
    if (fe.active && !fe.active.signal.aborted) {
      fe.pending.push(text);
      render.note(`queued (${fe.pending.length}): ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`, 'info');
      return;
    }
    await processInput(text);
  }

  async function processInput(text: string): Promise<void> {
    try {
      if ((await routeInput(s, fe, text)) === 'exit') return void shutdown();
    } finally {
      // No prompt owns stdin between inputs: a stuck flag must never leave the input deaf.
      promptDisabled = false;
      render.resume();
      fe.armed = false;
    }
    const next = fe.pending.shift();
    if (next !== undefined) await processInput(next);
    // A background process that ended after the turn's last request is still waiting for the agent.
    else await handoff.handOff();
  }
}
