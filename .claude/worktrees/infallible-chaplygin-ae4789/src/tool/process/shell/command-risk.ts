import { unbackupableDeleteReason, shellConfirmReason } from '../../policy/mutation-policy';

/**
 * What a tool that runs a shell command in its `command` argument declares, whichever tool it is:
 * the permission policy reads the command for its refusals and danger checks, a delete nothing can
 * restore is asked about every time, and so are recoverable but consequential commands (deletes, git writes).
 */
export const shellCommandRisk = {
  shellCommand: 'command',
  dangerReason(args: any, where: { cwd: string; root: string }): string | null {
    return unbackupableDeleteReason(String(args?.command ?? ''), where.cwd) ?? null;
  },
  confirmReason(args: any): string | null {
    return shellConfirmReason(String(args?.command ?? ''));
  },
} as const;
