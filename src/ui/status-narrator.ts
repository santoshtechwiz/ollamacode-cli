import { AGENT_PHASE } from '../protocol';

const IDLE_LABELS = new RegExp(`^(${Object.values(AGENT_PHASE).join('|')})$`, 'i');

const IDLE_VERBS = [
  'Thinking',
  'Pondering',
  'Ruminating',
  'Deliberating',
  'Percolating',
  'Mulling it over',
  'Considering',
  'Cogitating',
  'Puzzling',
  'Turning it over',
];

const VERB_ROTATE_MS = 6000;

const EXPLAIN_AFTER_MS = 8000;
const COLD_LOAD_AFTER_MS = 25000;
const HINT_AFTER_MS = 25000;

const QUIET_AFTER_MS = 10000;

const PREVIEW_TAIL = 60;

interface StatusFacts {
  model?: string;
  cpuOnly?: boolean;
  remote?: boolean;
  nativeTools?: boolean;
}

function idleVerb(elapsedMs: number): string {
  const step = Math.floor(Math.max(0, elapsedMs) / VERB_ROTATE_MS);
  return IDLE_VERBS[step % IDLE_VERBS.length];
}

function explainWait(elapsedMs: number, facts: StatusFacts = {}, sawOutput: boolean = false): string | null {
  if (elapsedMs < EXPLAIN_AFTER_MS) return null;

  const { model, cpuOnly, remote } = facts;
  const named = model ? `${model} ` : '';

  if (sawOutput) {
    if (cpuOnly) return 'generating on CPU — no GPU offload, so this is slow by nature';
    return null;
  }

  if (elapsedMs >= COLD_LOAD_AFTER_MS) {
    const secs = Math.round(elapsedMs / 1000);
    if (remote) return `${named}likely queued on the host — ${secs}s so far`;
    if (cpuOnly) return `on CPU, no GPU offload — ${secs}s so far`;
    return `${named}likely loading — ${secs}s so far`;
  }

  if (remote) return 'waiting for the first token from the hosted backend';
  if (cpuOnly) return 'reading the prompt on CPU — no GPU offload';
  return 'reading the prompt';
}

export function narrateStatus({ label, elapsedMs, facts = {}, sawOutput = false }: any): { head: string; why: string | null; hint: string; } {
  const idle = IDLE_LABELS.test(label ?? '');
  const head = idle ? idleVerb(elapsedMs) : label;
  const why = idle ? explainWait(elapsedMs, facts, sawOutput) : null;
  const hint = elapsedMs >= HINT_AFTER_MS ? 'Ctrl-C to cancel' : '';
  return { head, why, hint };
}

export function previewLine({
  pending,
  elapsedMs,
  sinceDeltaMs,
  inFence = false,
  fenceLines = 0,
  suppressed = false,
}: any): { body: string; } | null {
  // A quiet stream is usually the model composing a tool call; the normal status says so, and a hung provider hits the idle timeout.
  if (sinceDeltaMs >= QUIET_AFTER_MS) return null;
  const secs = Math.round(Math.max(0, elapsedMs) / 1000);

  const counter = secs >= 1 ? ` ${secs}s` : '';

  if (inFence || suppressed) {
    const what = inFence ? 'code block' : 'output';
    const n = fenceLines > 0 ? ` ${fenceLines} line${fenceLines === 1 ? '' : 's'}` : '';
    return { body: `writing ${what}…${n}${counter}` };
  }

  const tail = stripInlineMarks(pending).replace(/\s+/g, ' ').trimStart();
  if (tail.length === 0) return null;
  const shown = tail.length > PREVIEW_TAIL ? `…${tail.slice(-PREVIEW_TAIL)}` : tail;
  return { body: `│ ${shown}${counter}` };
}

function stripInlineMarks(text: string): string {
  return String(text ?? '')
    .replace(/^\s{0,3}(#{1,6}\s+|```+\s*\w*|>\s?)/gm, '')
    .replace(/(?<!\w)(_{1,3})(?=\S)([^_]*?\s[^_]*?)\1(?!\w)/g, '$2')
    .replace(/(\*{1,3}|(?<!\w)_{1,3}(?!\w)|`{1,3}|~{2})/g, '')
    .replace(/^\s*[-+]\s+/gm, '');
}


