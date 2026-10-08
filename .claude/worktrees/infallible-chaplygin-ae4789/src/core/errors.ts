export class TcError extends Error {
  name: any;
  code: any;
  hint: any;

  constructor(message: string, { code = 'EUNKNOWN', hint, cause }: any = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
  }
}

export class ProviderError extends TcError {
  status: any;
  retryable: any;

  constructor(message: string, { code = 'EPROVIDER', status, retryable = false, cause }: any = {}) {
    super(message, { code, cause });
    this.status = status;
    this.retryable = retryable;
  }
}

export class CancelError extends TcError {
  constructor(message: string = 'Cancelled') {
    super(message, { code: 'ECANCELLED' });
  }
}

export function isCancel(err: unknown) {
  const e = (err as { name?: string; code?: string; });
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || e instanceof CancelError;
}

