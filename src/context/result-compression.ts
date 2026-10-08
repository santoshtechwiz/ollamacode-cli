// Tool result compression: lossless noise removal, then a head/tail cut that says so in words.

import { dropLeadingSurrogate, dropTrailingSurrogate } from '../tool/core/tool-result';

/** Where the budget splits. The end is weighted higher: exit codes, diagnostics and hints live there. */
const HEAD_SHARE = 0.4;

/** Only a long line is safe to drop when it repeats: a short one like `}` is real content. */
const REPEATABLE_LINE_MIN_CHARS = 40;

/** Alignment padding after text; leading indentation is content and is never touched. */
const PADDING_RUN = /(?<=\S) {16,}/g;

const OSC_SEQUENCE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_SEQUENCE = /(?:\u001B|\u009B)\[[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE = /\u001B[@-Z\\-_]/g;

function stripAnsi(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(SINGLE_ESCAPE, '');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u000B\u000C]/g, '\n')
    .replace(PADDING_RUN, ' ')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function collapseRepeats(text: string): { text: string; removed: number } {
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;

  for (const line of text.split('\n')) {
    // Exact lines only: indentation distinguishes code, and short lines are never noise.
    if (line.length >= REPEATABLE_LINE_MIN_CHARS && seen.has(line)) {
      removed += 1;
      continue;
    }
    if (line.length >= REPEATABLE_LINE_MIN_CHARS) seen.add(line);
    kept.push(line);
  }

  return { text: kept.join('\n'), removed };
}

function truncationMarker(omitted: number): string {
  return `\n…[${omitted} chars omitted — start and end kept]…\n`;
}

function repeatMarker(count: number): string {
  return `\n…[${count} repeated line${count === 1 ? '' : 's'} removed]…\n`;
}

/** One tool result, cleaned and held to `maxChars`; under the budget nothing but noise is removed. */
export function compressToolOutput(text: string, maxChars: number): string {
  const budget = Math.floor(Number(maxChars));
  const { text: deduped, removed } = collapseRepeats(normalizeWhitespace(stripAnsi(String(text ?? ''))));
  const suffix = removed > 0 ? repeatMarker(removed) : '';

  if (!(budget > 0) || deduped.length + suffix.length <= budget) return deduped + suffix;

  // The marker is paid for out of the text it replaces; two passes because its digits change its length.
  let marker = truncationMarker(deduped.length - budget) + suffix;
  let keep = budget - marker.length;
  marker = truncationMarker(deduped.length - keep) + suffix;
  keep = budget - marker.length;

  if (keep <= 0) return dropTrailingSurrogate(deduped.slice(0, budget));

  const headLength = Math.floor(keep * HEAD_SHARE);
  return `${dropTrailingSurrogate(deduped.slice(0, headLength))}${marker}${dropLeadingSurrogate(deduped.slice(deduped.length - (keep - headLength)))}`;
}
