/** Reasoning tags, matched by shape rather than enumerated. */
const REASONING_WORD = '(?:think(?:ing)?|thought|reasoning|analysis)';

export const REASONING_OPEN_RE = new RegExp(
  `<\\|?\\s*(?:begin_of_|start_of_)?${REASONING_WORD}\\b[^>]*>`,
  'i'
);

export const REASONING_CLOSE_RE = new RegExp(
  `<\\|?\\s*(?:/|end_of_)\\s*${REASONING_WORD}\\b[^>]*>`,
  'i'
);

/** How much of a trailing fragment could still become a reasoning tag. */
const MAX_TAG_RUN = 24;
const TAG_FRAGMENT = /^<\|?\/?(?:begin_of_|start_of_|end_of_)?[a-z_]*$/i;

export function danglingTagPrefix(text: string): number {
  const open = text.lastIndexOf('<');
  if (open === -1) return 0;
  const fragment = text.slice(open);
  if (fragment.length > MAX_TAG_RUN) return 0;
  if (fragment.includes('>')) return 0;
  return TAG_FRAGMENT.test(fragment) ? fragment.length : 0;
}

/** The first match of `re`, in the shape `findFirst` returns. */
export function findFirstMatch(text: string, re: RegExp): { index: number; length: number; } | null {
  const m = re.exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

export const CALL_TAGS = [
  { open: '<tool_call>', close: '</tool_call>' },
  { open: '<function_call>', close: '</function_call>' },
  { open: '<|tool_call|>', close: '<|/tool_call|>' },
  { open: '<tool_use>', close: '</tool_use>' },
];

export const RESULT_TAGS = [
  { open: '<tool_response>', close: '</tool_response>' },
  { open: '<tool_result>', close: '</tool_result>' },
  { open: '<|tool_response|>', close: '<|/tool_response|>' },
];

function findFirst(text: string, tags: string[]): { index: number; length: number; } | null {
  let best: any = null;
  for (const tag of tags) {
    const index = text.indexOf(tag);
    if (index !== -1 && (best === null || index < best.index)) {
      best = { index, length: tag.length };
    }
  }
  return best;
}

export function extractTagged(text: string, pairs: { open: string; close: string; }[]): { bodies: string[]; remainder: string; found: boolean; } {
  const bodies: any[] = [];
  let remainder = '';
  let rest = String(text ?? '');
  let found = false;

  for (;;) {
    const open = findFirst(rest, pairs.map((p) => p.open));
    if (!open) {
      remainder += rest;
      break;
    }

    const opener = rest.slice(open.index, open.index + open.length);
    const pair = pairs.find((p) => p.open === opener);
    remainder += rest.slice(0, open.index);
    rest = rest.slice(open.index + open.length);
    found = true;

    const closeIndex = pair ? rest.indexOf(pair.close) : -1;
    if (closeIndex === -1) {
      bodies.push(rest);
      rest = '';
      break;
    }
    bodies.push(rest.slice(0, closeIndex));
    rest = rest.slice(closeIndex + (pair?.close.length ?? 0));
  }

  return { bodies, remainder, found };
}

