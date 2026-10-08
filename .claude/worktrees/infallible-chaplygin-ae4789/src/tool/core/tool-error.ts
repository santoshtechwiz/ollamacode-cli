import { TcError } from '../../core/errors';

/** A tool-shaped failure, thrown by tooling internals and converted to a `ToolResult` by `fromError` in `tool-result.ts`. */
export class ToolError extends TcError {
  constructor(message: string, { code = 'EUNKNOWN', cause, hint }: any = {}) {
    super(message, { code, cause });
    this.hint = hint;
  }
}

/** node errno → `ToolErrorCode`. */
export function codeFromErrno(err: unknown): import('../../protocol.ts').ToolErrorCode {
  const c = (err as { code?: string; })?.code;
  switch (c) {
    case 'ENOENT':
      return 'ENOENT';
    case 'EACCES':
    case 'EPERM':
      return 'EACCES';
    case 'EISDIR':
      return 'EISDIR';
    case 'ENOTDIR':
      return 'ENOTDIR';
    case 'ETIMEDOUT':
      return 'ETIMEDOUT';
    case 'ABORT_ERR':
      return 'ECANCELLED';
    default:
      return 'EUNKNOWN';
  }
}