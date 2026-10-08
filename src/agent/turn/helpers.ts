type TurnResult = import('../../protocol.ts').TurnResult;

export function stopResult(content: string, stopReason: unknown): TurnResult {
  return {
    content,
    toolResults: [],
    iterations: 0,
    stopReason: stopReason as TurnResult['stopReason'],
  };
}
