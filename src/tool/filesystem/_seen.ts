// Which files the model has read (or written) this session, so an edit is made against text it has seen.

type SeenState = { seenText?: Set<string> } | null | undefined;

/** The model has now seen this file. */
export function noteSeen(state: SeenState, rel: string): void {
  if (!state) return;
  state.seenText ??= new Set();
  state.seenText.add(rel);
}

/** Whether the model has read (or written) this file in the session. Without a session state there is nothing to check. */
export function hasSeen(state: SeenState, rel: string): boolean {
  if (!state) return true;
  return state.seenText?.has(rel) ?? false;
}
