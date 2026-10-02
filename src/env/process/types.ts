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
}

export interface RunOptions {
  file: string;
  args: string[];
  options?: import('node:child_process').SpawnOptions;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxCaptureBytes?: number;
  onOutput?: (text: string) => void;
}

