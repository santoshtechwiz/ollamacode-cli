export type StopTarget = { kind: 'pid'; pid: number } | { kind: 'port'; port: number };

export interface TargetError {
  message: string;
  hint?: string;
}

/** Pure validation: exactly one of pid or port, both integers in range. */
export function validateStopTarget(args: { pid?: unknown; port?: unknown }): StopTarget | { error: TargetError } {
  const hasPid = args?.pid !== undefined && args.pid !== null && String(args.pid) !== '';
  const hasPort = args?.port !== undefined && args.port !== null && String(args.port) !== '';
  if ((hasPid ? 1 : 0) + (hasPort ? 1 : 0) !== 1) {
    return {
      error: {
        message: 'Give exactly one of pid or port',
        hint: 'pid stops one process; port stops whoever is listening on it.',
      },
    };
  }
  if (hasPort) {
    const port = Math.floor(Number(args.port));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: { message: `Port must be 1-65535, received ${JSON.stringify(args.port)}` } };
    }
    return { kind: 'port', port };
  }
  const pid = Math.floor(Number(args.pid));
  if (!Number.isInteger(pid) || pid <= 0) {
    return { error: { message: `Pid must be a positive integer, received ${JSON.stringify(args.pid)}` } };
  }
  return { kind: 'pid', pid };
}
