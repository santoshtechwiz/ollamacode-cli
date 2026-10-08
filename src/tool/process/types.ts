export interface ShellRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sandboxMode?: 'none' | 'read-only' | 'workspace-write';
  env?: NodeJS.ProcessEnv;
  /** See RunOptions.release. */
  release?: { when: (output: string) => boolean; quietMs: number };
  /** Output as it arrives, for the live command window; the result still carries all of it. */
  onOutput?: (text: string) => void;
}

export interface ShellExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
  timedOut: boolean;
  cancelled: boolean;
  discardedBytes: number;
  durationMs: number;
  /** The process, still running, handed back because it turned out to be serving. */
  released?: import('node:child_process').ChildProcess;
}

import type { Diagnostic as CoreDiagnostic } from '../../types';

export type Diagnostic = CoreDiagnostic;

export interface ShellResult {
  request: ShellRequest;
  execution: ShellExecutionResult;
  diagnostics: Diagnostic[];
  presentation: string;
  truncated: boolean;
}