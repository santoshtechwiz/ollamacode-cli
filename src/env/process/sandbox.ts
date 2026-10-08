import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SandboxMode = 'read-only' | 'workspace-write';

const require = createRequire(import.meta.url);

let runnerPath: string | null | undefined;

/** Resolved lazily so a missing/uninstalled sandbox package doesn't break every other tool. */
function resolveRunner(): string | null {
  if (runnerPath !== undefined) return runnerPath;
  try {
    runnerPath = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner');
  } catch {
    runnerPath = null;
  }
  return runnerPath;
}

export function isSandboxSupported(): boolean {
  return process.platform === 'win32' && resolveRunner() !== null;
}

interface SandboxSpawnPlan {
  file: string;
  args: string[];
  cleanup: () => void;
}

/** Wrap a spawn so it runs under a restricted, ACL-confined child; the caller's piping and cancellation are unchanged. */
export function planSandboxedSpawn(
  file: string,
  args: string[],
  { mode, workspace }: { mode: SandboxMode; workspace: string }
): SandboxSpawnPlan {
  const runner = resolveRunner();
  if (!runner) throw new Error('Sandbox runner is not installed (@deepseek-ai/dsh-sandbox-windows-acl)');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sandbox-'));
  return {
    file: process.execPath,
    args: [runner, '--workspace', workspace, '--temp', tempDir, '--mode', mode, '--', file, ...args],
    cleanup: () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    },
  };
}
