/** One place for one-shot command output. */
function writeOut(text: string): void {
  process.stdout.write(text);
}

function writeErr(text: string): void {
  process.stderr.write(text);
}

export interface Output {
  write(text: string): void;
  error(text: string): void;
}

export const out: Output = {
  write: writeOut,
  error: writeErr,
};
