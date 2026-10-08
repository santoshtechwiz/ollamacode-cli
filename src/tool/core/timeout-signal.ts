interface TimeoutSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

export function withTimeoutSignal(parentSignal: AbortSignal | undefined, ms: number): TimeoutSignal {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, ms);
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}
