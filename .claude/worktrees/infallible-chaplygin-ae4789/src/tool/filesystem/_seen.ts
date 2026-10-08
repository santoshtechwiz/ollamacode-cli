// Which files the model has read (or written) this session, so an edit is made against text it has seen.
import crypto from 'node:crypto';

type SeenState = { seenText?: Map<string, string> } | null | undefined;

function fingerprint(content: string): string {
  return crypto.createHash('sha1').update(String(content ?? '').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** The model has now seen this version of the file. */
export function noteSeen(state: SeenState, rel: string, content: string): void {
  if (!state) return;
  state.seenText ??= new Map();
  state.seenText.set(rel, fingerprint(content));
}

/** Whether the model has read (or written) this file in the session. Without a session state there is nothing to check. */
export function hasSeen(state: SeenState, rel: string): boolean {
  if (!state) return true;
  return state.seenText?.has(rel) ?? false;
}
