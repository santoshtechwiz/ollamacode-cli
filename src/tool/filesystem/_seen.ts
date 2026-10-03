// Which version of each file the model last saw whole, so line numbers it quotes can be checked against it.
// Line numbers are only an address in the file the model read: once lines were added or removed since, "line 8" names
// another line, and an edit by number would change it without a word.
import crypto from 'node:crypto';

type SeenState = { seenText?: Map<string, string> } | null | undefined;

function fingerprint(content: string): string {
  return crypto.createHash('sha1').update(String(content ?? '').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** The model has now seen this version of the file: its line numbers are this version's. */
export function noteSeen(state: SeenState, rel: string, content: string): void {
  if (!state) return;
  state.seenText ??= new Map();
  state.seenText.set(rel, fingerprint(content));
}

/** Whether line numbers the model holds for `rel` may name other lines now: it saw a different version last. */
export function linesMayHaveMoved(state: SeenState, rel: string, content: string): boolean {
  const seen = state?.seenText?.get(rel);
  return seen !== undefined && seen !== fingerprint(content);
}
