type TurnResult = import('../../protocol.ts').TurnResult;

export function stopResult(content: string, stopReason: unknown): TurnResult {
  return {
    content,
    toolResults: [],
    iterations: 0,
    stopReason: stopReason as TurnResult['stopReason'],
  };
}

/** A detected command (argv) as the line ocode runs and shows: words quoted only where a shell would split them. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}
