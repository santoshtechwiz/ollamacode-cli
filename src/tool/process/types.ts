export interface ShellRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sandboxMode?: 'none' | 'read-only' | 'workspace-write';
  env?: NodeJS.ProcessEnv;
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
}

export type CommandCategory =
  | 'test'
  | 'lint'
  | 'build'
  | 'typecheck'
  | 'check'
  | 'server'
  | 'script'
  | 'query'
  | 'mutation'
  | 'unknown';

export interface CommandClassification {
  category: CommandCategory;
  confidence: 'high' | 'medium' | 'low';
  ecosystem?: 'npm' | 'dotnet' | 'cargo' | 'go' | 'maven' | 'gradle' | 'python' | 'generic';
  subcommand?: string;
  targets?: string[];
}

import type { Diagnostic as CoreDiagnostic } from '../../types';

export type Diagnostic = CoreDiagnostic;

export interface VerificationMetadata {
  intent: 'test' | 'lint' | 'build' | 'typecheck' | 'check' | 'none';
  passed: boolean;
  exitCode: number | null;
  diagnostics: Diagnostic[];
  primaryDiagnostic?: Diagnostic;
  classification: CommandClassification;
  infraFailure?: 'file-lock' | 'port-in-use' | 'none';
  recoveryAttempted?: boolean;
  recoverySucceeded?: boolean | null;
}

export interface CommandHint {
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface RecoveryResult {
  kind: 'file-lock' | 'port-in-use' | 'none';
  attempted: boolean;
  succeeded: boolean | null;
  detail: string;
  killedPids: number[];
  requiresApproval: boolean;
  approvalPid?: number;
}

export interface ShellResult {
  request: ShellRequest;
  execution: ShellExecutionResult;
  classification: CommandClassification;
  verification: VerificationMetadata;
  diagnostics: Diagnostic[];
  hints: CommandHint[];
  recovery: RecoveryResult;
  presentation: string;
  truncated: boolean;
}