// What ended in the background, kept until the agent has been shown it.
//
// The process layer records an exit, the request builder shows pending exits to the model in the session record,
// and the chat subscribes to tell the person. Each side knows only this inbox, never the others: a new source of
// background work records here, and a new place to be told (a desktop notification, a log) subscribes here.

import { readOutput } from './lifecycle/output-buffer';
import type { SubprocessRecord } from './subprocess-state';

export type ExitOutcome = 'finished' | 'failed' | 'crashed';

/** How one background process ended, in the terms the agent and the person are told. */
export interface BackgroundExit {
  id: string;
  command: string;
  outcome: ExitOutcome;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  durationMs: number;
  /** The last lines it printed: usually where the result or the reason it failed is. */
  tail: string;
  endedAt: number;
}

export type ExitListener = (exit: BackgroundExit) => void;

/** A process that went on running in the background; its end will be reported. */
export interface BackgroundJob {
  id: string;
  command: string;
}

export type StartListener = (job: BackgroundJob) => void;

const TAIL_LINES = 15;

export class BackgroundInbox {
  private exits: BackgroundExit[] = [];
  /** How many of the oldest exits went into the last request; exits only ever append, so they are the first ones. */
  private shownCount = 0;
  private readonly listeners = new Set<ExitListener>();
  private readonly startListeners = new Set<StartListener>();

  /** A process now runs in the background and its end will be recorded here: tell whoever listens. */
  watching(job: BackgroundJob): void {
    for (const listener of this.startListeners) {
      try {
        listener(job);
      } catch {
        // Telling the person is best-effort; the exit is still recorded.
      }
    }
  }

  /** Hear about every process that starts running in the background; returns the way to stop listening. */
  onStart(listener: StartListener): () => void {
    this.startListeners.add(listener);
    return () => this.startListeners.delete(listener);
  }

  /** Something ended in the background: keep it for the model, and tell whoever listens. */
  record(exit: BackgroundExit): void {
    this.exits.push(exit);
    for (const listener of this.listeners) {
      try {
        listener(exit);
      } catch {
        // A listener that fails (a closed terminal) must not lose the exit for the model.
      }
    }
  }

  /** Hear about every exit as it is recorded; returns the way to stop listening. */
  subscribe(listener: ExitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Exits the model has not yet been shown in a finished turn. */
  pending(): readonly BackgroundExit[] {
    return this.exits;
  }

  /** The pending exits were just put in a request to the model. */
  markShown(): void {
    this.shownCount = this.exits.length;
  }

  /** The model answered a request that showed the pending exits: drop those. One that came in after it waits for the next turn. */
  settle(): void {
    this.exits = this.exits.slice(this.shownCount);
    this.shownCount = 0;
  }

  /** A new conversation starts with nothing pending; whoever listens keeps listening. */
  clear(): void {
    this.exits = [];
    this.shownCount = 0;
  }
}

function outcomeOf(sub: SubprocessRecord): ExitOutcome {
  if (sub.error || sub.signal) return 'crashed';
  return sub.exitCode === 0 ? 'finished' : 'failed';
}

/** A subprocess that has ended, as an inbox entry. */
export function exitOf(sub: SubprocessRecord, endedAt: number = Date.now()): BackgroundExit {
  const output = `${readOutput(sub.stdout)}${readOutput(sub.stderr)}`.trimEnd();
  return {
    id: sub.id,
    command: sub.command,
    outcome: outcomeOf(sub),
    exitCode: sub.exitCode,
    signal: sub.signal,
    ...(sub.error ? { error: sub.error } : {}),
    durationMs: Math.max(0, endedAt - sub.startedAt),
    tail: output.split('\n').slice(-TAIL_LINES).join('\n'),
    endedAt,
  };
}

/**
 * Report the subprocess to the inbox when it ends on its own. A stop the agent or the person asked for is not news,
 * so it is not reported. Registered once the process is running in the background; one that already ended is
 * reported now.
 */
export function reportWhenEnded(sub: SubprocessRecord, inbox: BackgroundInbox): void {
  const report = () => {
    if (!sub.stopRequested) inbox.record(exitOf(sub));
  };
  if (sub.exited) {
    report();
    return;
  }
  inbox.watching({ id: sub.id, command: sub.command });
  sub.process.once('close', report);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function endedHow(exit: BackgroundExit): string {
  if (exit.outcome === 'finished') return 'finished (exit 0)';
  if (exit.error) return `failed to run: ${exit.error}`;
  if (exit.signal) return `was killed (${exit.signal})`;
  return `failed (exit ${exit.exitCode ?? 'unknown'})`;
}

/** The session-record lines that tell the model what ended since it last looked. */
export function describeExitsForModel(exits: readonly BackgroundExit[]): string[] {
  if (exits.length === 0) return [];
  const lines = ['Background processes that ended (you were not polling; this is how you are told — do not poll for them):'];
  for (const exit of exits) {
    lines.push(`- ${exit.id}: \`${exit.command}\` ${endedHow(exit)} after ${formatDuration(exit.durationMs)}`);
    if (exit.tail) lines.push(...exit.tail.split('\n').map((line) => `    ${line}`));
  }
  return lines;
}

/** The last lines the person sees under the notice; the model gets the whole tail. */
const PERSON_TAIL_LINES = 5;

/** One line saying which background process ended and how. */
export function exitHeadline(exit: BackgroundExit): string {
  return `background "${exit.id}" ${endedHow(exit)} after ${formatDuration(exit.durationMs)}`;
}

/**
 * What the person sees when a background process ends: how it ended, then the last lines it printed,
 * so the result is on screen without asking for it. The note's own icon says whether it went well.
 * `followUp` says what happens to it next; a front end that hands it to the agent itself says so.
 */
export function describeExitForPerson(exit: BackgroundExit, followUp = 'the agent will see it with your next message'): string {
  const lines = exit.tail ? exit.tail.split('\n').filter((line) => line.trim()).slice(-PERSON_TAIL_LINES) : [];
  const header = `${exitHeadline(exit)}${lines.length ? '' : ', printing nothing'} — ${followUp}`;
  return [header, ...lines].join('\n');
}
