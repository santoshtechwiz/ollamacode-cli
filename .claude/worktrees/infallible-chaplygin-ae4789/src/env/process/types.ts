export type ProcessState = 'starting' | 'running' | 'killing' | 'exited' | 'failed';

export interface ChildOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
  stdout: string;
  stderr: string;
  discardedBytes: number;
  timedOut: boolean;
  cancelled: boolean;
  pid: number | undefined;
  /** Set when the process was handed back still running (RunOptions.release): its new owner takes it from here. */
  released?: import('node:child_process').ChildProcess;
}

export interface RunOptions {
  file: string;
  args: string[];
  options?: import('node:child_process').SpawnOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxCaptureBytes?: number;
  onOutput?: (text: string) => void;
  /** Hand the process back still running once its output satisfies `when` and then stays quiet for `quietMs`. */
  release?: { when: (output: string) => boolean; quietMs: number };
}

