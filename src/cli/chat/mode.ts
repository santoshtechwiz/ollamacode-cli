/** The agent mode, one value at a time. */
export type AgentMode = 'agent' | 'plan' | 'ask' | 'review';

type ModeFlags = { planMode: boolean; reviewMode: boolean; askMode: boolean; };

/** Shift+Tab / Ctrl+G cycles in this exact order: Agent → Plan → Ask → Agent. Review is explicit via /review. */
const MODE_ORDER: readonly AgentMode[] = ['agent', 'plan', 'ask'];

/** The single mode a flag triple means. Review dominates, then Ask, then Plan. */
export function modeOf({ planMode, reviewMode, askMode }: { planMode: boolean; reviewMode: boolean; askMode?: boolean; }): AgentMode {
  if (reviewMode) return 'review';
  if (askMode) return 'ask';
  if (planMode) return 'plan';
  return 'agent';
}

/** The exclusive flag triple a mode maps to. A mode switch never leaves two modes lit. */
function toFlags(mode: AgentMode): ModeFlags {
  return {
    planMode: mode === 'plan',
    reviewMode: mode === 'review',
    askMode: mode === 'ask',
  };
}

export function nextMode(mode: AgentMode): AgentMode {
  // Review is explicit via /review and not in the cycle — Tab leaves it to Agent
  if (mode === 'review') return 'agent';
  const index = MODE_ORDER.indexOf(mode as AgentMode);
  return MODE_ORDER[(index + 1) % MODE_ORDER.length];
}

/** The one place the mode changes: whoever switches it (Shift+Tab, a command, /init, an approved plan) sets it here. */
export function setMode(holder: ModeFlags, mode: AgentMode): void {
  Object.assign(holder, toFlags(mode));
}

/** The mode with one of its own flags turned off: what `/ask off`, `/plan off` and `/review off` leave behind. */
export function withoutMode(holder: ModeFlags, mode: AgentMode): AgentMode {
  return modeOf({ ...holder, ...(mode === 'plan' ? { planMode: false } : mode === 'ask' ? { askMode: false } : { reviewMode: false }) });
}

/**
 * The line to show the first time the chat runs in a mode it has not mentioned yet, or null when it already has.
 * Switching only moves the footer; this is said once, when it matters, and it records that it was said.
 */
export function modeNotice(holder: ModeFlags & { announcedMode: AgentMode }, why = ''): string | null {
  const from = holder.announcedMode;
  const to = modeOf(holder);
  holder.announcedMode = to;
  return to === from ? null : `${modeLabel(to)} — was ${modeLabel(from)}${why ? ` · ${why}` : ''}`;
}

export function modeLabel(mode: AgentMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan · read-only';
    case 'ask':
      return 'Ask · read-only';
    case 'review':
      return 'Review · read-only';
    default:
      return 'Agent';
  }
}
