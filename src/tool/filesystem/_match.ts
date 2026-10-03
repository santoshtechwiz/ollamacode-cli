import { escapeRegExp } from '../../core/text-utils';
import { match as fuzzyLocate } from '@sanity/diff-match-patch';

export interface MatchRange {
  start: number;
  end: number;
}

function normalizeWithMap(text: string): { normalized: string; map: number[]; } {
  let normalized = '';
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (normalized.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      map.push(i);
      pendingSpace = false;
    }
    normalized += ch;
    map.push(i);
  }
  return { normalized, map };
}

function findExact(content: string, search: string): MatchRange[] {
  const out: MatchRange[] = [];
  if (!search) return out;
  let index = content.indexOf(search);
  while (index !== -1) {
    out.push({ start: index, end: index + search.length });
    index = content.indexOf(search, index + search.length);
  }
  return out;
}

function findFlexible(content: string, search: string): MatchRange[] {
  const haystack = normalizeWithMap(content);
  const needle = normalizeWithMap(search);
  const out: MatchRange[] = [];
  if (!needle.normalized) return out;

  let index = haystack.normalized.indexOf(needle.normalized);
  while (index !== -1) {
    const startNorm = index;
    const endNorm = index + needle.normalized.length - 1;
    const start = haystack.map[startNorm];
    const end = haystack.map[endNorm] + 1;
    if (start !== undefined && end !== undefined) out.push(withSearchEdges(content, search, { start, end }));
    index = haystack.normalized.indexOf(needle.normalized, index + needle.normalized.length);
  }
  return out;
}

// A loose match covers only the non-space text; widen it over the indentation and line breaks the search itself begins and ends with, so the replacement lands in the same shape.
function withSearchEdges(content: string, search: string, range: MatchRange): MatchRange {
  let { start, end } = range;
  const lead = /^\s*/.exec(search)?.[0] ?? '';
  const trail = /\s*$/.exec(search)?.[0] ?? '';
  if (lead) {
    while (start > 0 && /[ \t]/.test(content[start - 1])) start--;
    if (lead.includes('\n') && content[start - 1] === '\n') start -= content[start - 2] === '\r' ? 2 : 1;
  }
  if (trail) {
    while (end < content.length && /[ \t]/.test(content[end])) end++;
    if (trail.includes('\n')) {
      if (content[end] === '\r' && content[end + 1] === '\n') end += 2;
      else if (content[end] === '\n') end += 1;
    }
  }
  return { start, end };
}

function locate(content: string, search: string): { ranges: MatchRange[]; exact: boolean; } {
  const exact = findExact(content, search);
  if (exact.length > 0) return { ranges: exact, exact: true };
  // Same text, only the line endings differ from the file's: still an exact match.
  const sameEndings = normalizeReplacement(content, search);
  if (sameEndings !== search) {
    const retried = findExact(content, sameEndings);
    if (retried.length > 0) return { ranges: retried, exact: true };
  }
  return { ranges: findFlexible(content, search), exact: false };
}

function coerceLineRange(edit: { line_start?: unknown; line_end?: unknown; } | null | undefined): { hasLine: boolean; start: number; end: number; } {
  const hasLine = edit?.line_start !== undefined && edit?.line_start !== null;
  if (!hasLine) return { hasLine: false, start: NaN, end: NaN };
  const start = Math.floor(Number(edit.line_start));
  const end = edit?.line_end !== undefined && edit?.line_end !== null ? Math.floor(Number(edit.line_end)) : start;
  return { hasLine: true, start, end };
}

function collapseWhitespace(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function bestMatchLine(content: string, search: string): number | null {
  const tokens = [
    ...new Set(
      collapseWhitespace(search)
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1)
    ),
  ];
  if (tokens.length === 0) return null;
  const lines = String(content ?? '').split('\n');
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    let score = 0;
    for (const t of tokens) if (low.includes(t)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore > 0 ? best + 1 : null;
}

// Bitap caps patterns at 32 chars (it throws above that); shorter than this is noise.
const FUZZY_MIN_PATTERN = 8;
const FUZZY_MAX_PATTERN = 32;
// Strict on purpose: a wrong suggestion is worse than none. The distance
// penalty is near zero when the search starts at the token-best line, so this
// mostly bounds the error rate (~30% of the pattern may differ).
const FUZZY_THRESHOLD = 0.3;
// Failure-path only, but don't run Bitap over megabytes.
const FUZZY_MAX_CONTENT = 500_000;

/**
 * Last resort when exact and whitespace matching fail: the line span whose
 * opening line sits closest to the search's, or null. Suggestion only —
 * never applied, only quoted in the failure hint.
 */
export function fuzzyLines(
  content: string,
  search: string,
  nearLine: number | null,
): { line: number; lineEnd: number } | null {
  const first = String(search ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  if (first.length < FUZZY_MIN_PATTERN || content.length > FUZZY_MAX_CONTENT) return null;
  const pattern = first.slice(0, FUZZY_MAX_PATTERN);
  // Bias the search at the token-best line: far from it, the distance
  // penalty alone would exceed the threshold and hide real matches.
  const loc =
    nearLine !== null ? (offsetOfLines(content, nearLine, nearLine)?.start ?? 0) : 0;
  let at: number;
  try {
    at = fuzzyLocate(content, pattern, loc, { threshold: FUZZY_THRESHOLD, distance: content.length });
  } catch {
    return null;
  }
  if (at < 0) return null;
  const line = lineAt(content, at);
  const want = String(search ?? '').split('\n').length;
  return { line, lineEnd: Math.min(countLines(content), line + Math.max(0, want - 1)) };
}

function locateJson(content: string, search: string): MatchRange[] {
  if (!search || !search.trim()) return [];
  const escaped = escapeRegExp(search);
  let source = escaped.replace(/\s+/g, '\\s*');
  source = source.replace(/:/g, '\\s*:\\s*').replace(/,/g, '\\s*,\\s*');
  source = source.replace(/(?:\\s\*)+/g, '\\s*');
  const out: MatchRange[] = [];
  try {
    const re = new RegExp(source, 'g');
    let m;
    let guard = 0;
    while ((m = re.exec(content)) !== null && guard < 100) {
      guard += 1;
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length });
      if (m.index + m[0].length === re.lastIndex && m[0].length === 0) break;
    }
  } catch {
    return [];
  }
  return out;
}

function reindentReplacement(fileIndent: string, replacement: string): string {
  if (!fileIndent || !replacement.includes('\n')) return replacement;
  const lines = replacement.split('\n');
  let own: string | null = null;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const m = /^[ \t]+/.exec(line);
    const cur = m ? m[0] : '';
    if (cur && (own === null || cur.length < own.length)) own = cur;
  }
  if (!own || own === fileIndent) return replacement;
  return lines
    .map((line, i) => {
      if (i === 0 || !line.trim()) return line;
      let depth = 0;
      let rest = line;
      while (rest.startsWith(own)) {
        depth += 1;
        rest = rest.slice(own.length);
      }
      return fileIndent.repeat(depth) + rest;
    })
    .join('\n');
}

export function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

export function offsetOfLines(content: string, startLine: number, endLine: number): MatchRange | null {
  const lines = content.split('\n');
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  const start = lines.slice(0, startLine - 1).join('\n').length + (startLine > 1 ? 1 : 0);
  let end = start + lines.slice(startLine - 1, endLine).join('\n').length;
  if (content[end - 1] === '\r') end -= 1;
  return { start, end };
}

export function countLines(content: string): number {
  if (content === '') return 0;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

export function detectLineEnding(content: string): 'crlf' | 'lf' | 'mixed' | 'none' {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  const loneCr = /(\r(?!\n))/.test(content);
  if (crlf > 0 && lf === 0 && !loneCr) return 'crlf';
  if (lf > 0 && crlf === 0 && !loneCr) return 'lf';
  if (crlf === 0 && lf === 0 && !loneCr) return 'none';
  return 'mixed';
}

function normalizeReplacement(content: string, replacement: string): string {
  const style = detectLineEnding(content);
  if (style === 'crlf') {
    return replacement.replace(/(?<!\r)\n/g, '\r\n');
  }
  if (style === 'lf') {
    return replacement.replace(/\r\n/g, '\n');
  }
  return replacement;
}


// The one verdict

/** `line 95` or `lines 95-97`. */
export function lineSpanLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

/** The first non-blank line of a search string, clipped for a message. */
function quoteSearchText(search: unknown, maxLen = 60): string {
  const line = String(search ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
  const trimmed = line.trim();
  if (!trimmed) return '(empty search)';
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
}

/** Where a multi-line search stops matching: the search's opening lines are in the file, then one line differs. */
function firstDivergence(content: string, search: string): { start: number; line: number; file: string; search: string } | null {
  const want = search.split(/\r?\n/).map((l) => l.trim());
  while (want.length && want[want.length - 1] === '') want.pop();
  if (want.length < 2) return null;
  const have = content.split(/\r?\n/).map((l) => l.trim());
  let best: { start: number; matched: number } | null = null;
  for (let i = 0; i < have.length; i++) {
    if (have[i] !== want[0]) continue;
    let k = 1;
    while (k < want.length && i + k < have.length && have[i + k] === want[k]) k++;
    if (k < want.length && (!best || k > best.matched)) best = { start: i, matched: k };
  }
  if (!best) return null;
  const at = best.start + best.matched;
  return { start: best.start + 1, line: at + 1, file: have[at] ?? '(end of file)', search: want[best.matched] };
}

const shown = (line: string) => (line === '' ? 'a blank line' : `“${line.length > 60 ? `${line.slice(0, 59)}…` : line}”`);

/** Why a search did not match, naming the first differing line when the search starts matching and then parts ways. */
function notFoundWhy(content: string, search: string, rel: string, d = firstDivergence(content, search)): string {
  if (!d) return `“${quoteSearchText(search)}” is not in ${rel}`;
  return `the search matches ${rel} from line ${d.start} but differs at line ${d.line}: the file has ${shown(d.file)} where the search has ${shown(d.search)}`;
}

export type EditFailCode = 'EINVAL' | 'ENOMATCH' | 'EAMBIGUOUS';

export interface EditPlan {
  ok: boolean;
  code?: EditFailCode;
  /** One sentence naming the outcome, printed *verbatim* by both the tool and the approval preview. */
  why: string;
  /** Every place the search text was found, in file order. */
  ranges: MatchRange[];
  /** Where to point a numbered window, when there is anywhere to point. */
  focus?: { line: number; lineEnd: number };
  /** Ranges to rewrite in the original content (non-overlapping). */
  targets: MatchRange[];
  replacement: string;
  replacements: number;
  exact: boolean;
  via: 'exact' | 'whitespace' | 'json';
  /** Set when a line range chose between several matches. */
  disambiguatedBy?: { line: number; lineEnd: number };
  /** A search that matched for some lines and then parted ways: the file line where it did. `focus` points there. */
  divergedAt?: number;
}

export interface EditArgError {
  code: EditFailCode;
  why: string;
  hint: string;
}

type EditLocator = { search?: unknown; replace?: unknown; line_start?: unknown; line_end?: unknown; insert_at_line?: unknown; };

/** An edit places text by search, or, when it quotes nothing, by line numbers: a range to replace or a line to insert before. */
function hasSearchText(spec: EditLocator): boolean {
  return typeof spec.search === 'string' && spec.search !== '';
}

function hasInsertLine(spec: EditLocator): boolean {
  return spec.insert_at_line !== undefined && spec.insert_at_line !== null;
}

/** What is wrong with this edit's *arguments*, before any file is read. */
export function editArgError(edit: EditLocator | null | undefined, rel: string): EditArgError | null {
  const spec = edit ?? {};
  const hasSearch = hasSearchText(spec);
  const { hasLine, start, end } = coerceLineRange(spec);
  const insert = hasInsertLine(spec);

  if (!hasSearch && !hasLine && !insert) {
    return {
      code: 'EINVAL',
      why: `nothing says where the edit goes in ${rel}`,
      hint:
        'Pass search (text copied verbatim from the file), or line_start/line_end to replace those whole lines, ' +
        'or insert_at_line to insert before that line.',
    };
  }

  if (insert && (hasSearch || hasLine)) {
    return {
      code: 'EINVAL',
      why: 'insert_at_line places new text on its own — it cannot be combined with search or line_start',
      hint: 'Send insert_at_line with replace to insert, or search / line_start with replace to change existing text.',
    };
  }

  if (insert) {
    const at = Number(spec.insert_at_line);
    if (!Number.isInteger(at) || at < 1) {
      return {
        code: 'EINVAL',
        why: `insert_at_line ${JSON.stringify(spec.insert_at_line)} is not a 1-based line number`,
        hint: 'Use the line numbers read_file shows, counting from 1. One past the last line appends.',
      };
    }
  }

  if (hasLine && (!Number.isInteger(start) || start < 1)) {
    return {
      code: 'EINVAL',
      why: `line_start ${JSON.stringify(spec.line_start)} is not a 1-based line number`,
      hint: 'Use the line numbers read_file shows, counting from 1. Omit it when the search is already unique.',
    };
  }

  if (hasLine && spec.line_end !== undefined && spec.line_end !== null && end < start) {
    return {
      code: 'EINVAL',
      why: `line_end ${end} is before line_start ${start}`,
      hint: 'line_end is inclusive and must be >= line_start; omit it to point at a single line.',
    };
  }

  if (spec.replace === undefined || spec.replace === null) {
    return {
      code: 'EINVAL',
      why: `replace is required — it is the text that goes in place of the match in ${rel}`,
      hint:
        'Nothing was written. To delete the matched text rather than change it, pass replace: "" ' +
        'explicitly — include the surrounding newline in search to remove whole lines.',
    };
  }

  return null;
}

/** The file's line break, as the file already writes it. */
function lineBreakOf(content: string): string {
  return detectLineEnding(content) === 'crlf' ? '\r\n' : '\n';
}

/** Where line `n` begins; one past the last line is the end of the file. */
function offsetOfLineStart(content: string, n: number): number | null {
  const total = countLines(content);
  if (n === total + 1) return content.length;
  if (n < 1 || n > total) return null;
  let offset = 0;
  for (let line = 1; line < n; line++) offset = content.indexOf('\n', offset) + 1;
  return offset;
}

/** An edit located by line numbers: whole lines replaced, or new lines inserted before one. */
function planLineEdit(content: string, spec: EditLocator, opts: { rel: string; fileIndent?: string; }): EditPlan {
  const total = countLines(content);
  const eol = lineBreakOf(content);
  const failed = (why: string): EditPlan => ({
    ok: false, code: 'EINVAL', ranges: [], why, targets: [], replacement: '', replacements: 0, exact: true, via: 'exact',
  });
  const asLines = (text: string) => {
    const body = reindentReplacement(opts.fileIndent ?? '', normalizeReplacement(content, text));
    return body === '' || body.endsWith('\n') ? body : body + eol;
  };

  if (hasInsertLine(spec)) {
    const at = Number(spec.insert_at_line);
    const offset = at <= total + 1 ? offsetOfLineStart(content, at) : null;
    if (offset === null) {
      return failed(`insert_at_line ${at} is past the end of ${opts.rel}, which has ${total} line${total === 1 ? '' : 's'} (use ${total + 1} to append)`);
    }
    // Appending to a file whose last line has no break needs one first, or the new text joins that line.
    const lead = offset === content.length && content !== '' && !content.endsWith('\n') ? eol : '';
    const replacement = lead + asLines(String(spec.replace));
    const target = { start: offset, end: offset };
    return {
      ok: true, ranges: [target], targets: [target], replacement, replacements: 1, exact: true, via: 'exact',
      why: `inserted before line ${at}`, focus: { line: at, lineEnd: at },
    };
  }

  const { start, end } = coerceLineRange(spec);
  if (end > total) {
    return failed(`${lineSpanLabel(start, end)} is past the end of ${opts.rel}, which has ${total} line${total === 1 ? '' : 's'}`);
  }
  const from = offsetOfLineStart(content, start);
  const to = end === total ? content.length : offsetOfLineStart(content, end + 1);
  if (from === null || to === null) return failed(`${lineSpanLabel(start, end)} is not in ${opts.rel}`);
  // The range ends where the file does: a replacement there keeps the file's own choice of a final line break.
  const fileEndsBare = to === content.length && !content.endsWith('\n');
  let replacement = asLines(String(spec.replace));
  if (fileEndsBare) replacement = replacement.replace(/\r?\n$/, '');
  const target = { start: from, end: to };
  return {
    ok: true, ranges: [target], targets: [target], replacement, replacements: 1, exact: true, via: 'exact',
    why: `replaced ${lineSpanLabel(start, end)}`, focus: { line: start, lineEnd: end },
  };
}

function rangeOverlapsLines(content: string, range: MatchRange, start: number, end: number): boolean {
  const span = offsetOfLines(content, start, end);
  if (!span) return false;
  return range.start < span.end && span.start < range.end;
}

/** Does this edit apply, and if not, why — asked once. */
export function planEdit(
  content: string,
  edit: (EditLocator & { replace_all?: unknown; }) | null | undefined,
  opts: { rel: string; isJson?: boolean; fileIndent?: string; }
): EditPlan {
  const spec = edit ?? {};
  const rel = opts.rel;
  const { hasLine, start, end } = coerceLineRange(spec);
  const at = hasLine && Number.isFinite(start) ? { focus: { line: start, lineEnd: end } } : {};

  const argError = editArgError(spec, rel);
  if (argError) {
    return {
      ok: false,
      code: argError.code,
      ranges: [],
      why: argError.why,
      targets: [],
      replacement: '',
      replacements: 0,
      exact: false,
      via: 'exact',
      ...at,
    };
  }

  if (!hasSearchText(spec)) return planLineEdit(content, spec, opts);

  const search = String(spec.search);
  const replace = String(spec.replace);

  const located = locate(content, search);
  let ranges = located.ranges;
  let via: 'exact' | 'whitespace' | 'json' = located.exact ? 'exact' : 'whitespace';
  if (ranges.length === 0 && opts.isJson === true) {
    const jsonRanges = locateJson(content, search);
    if (jsonRanges.length > 0) {
      ranges = jsonRanges;
      via = 'json';
    }
  }

  if (ranges.length === 0) {
    // One answer to "where did it go wrong", for the sentence and the listing alike: the line where a search that
    // started matching parts ways, else the line sharing most of its words.
    const diverged = firstDivergence(content, search);
    const near = diverged?.line ?? bestMatchLine(content, search);
    return {
      ok: false,
      code: 'ENOMATCH',
      ranges: [],
      why: notFoundWhy(content, search, rel, diverged),
      ...(diverged ? { divergedAt: diverged.line } : {}),
      targets: [],
      replacement: '',
      replacements: 0,
      exact: false,
      via: 'exact',
      ...(near ? { focus: { line: near, lineEnd: near } } : at),
    };
  }

  const replaceAll = spec.replace_all === true;

  // The one thing a line range is for: several places hold the search text and the numbers say which.
  let chosen = ranges;
  let disambiguatedBy: { line: number; lineEnd: number } | undefined;
  if (ranges.length > 1 && hasLine && !replaceAll) {
    const picked = ranges.filter((r) => rangeOverlapsLines(content, r, start, end));
    if (picked.length === 1) {
      chosen = picked;
      disambiguatedBy = { line: start, lineEnd: end };
    }
  }

  if (chosen.length > 1 && !replaceAll) {
    const lines = ranges.map((r) => lineAt(content, r.start));
    return {
      ok: false,
      code: 'EAMBIGUOUS',
      ranges,
      why:
        `“${quoteSearchText(search)}” appears ${ranges.length} times in ${rel} ` +
        `(lines ${lines.join(', ')}) and replace_all is not set`,
      targets: [],
      replacement: '',
      replacements: 0,
      exact: false,
      via: 'exact',
      focus: { line: lines[0], lineEnd: lines[0] },
    };
  }

  if (search === replace) {
    return {
      ok: true,
      ranges,
      targets: [],
      replacement: replace,
      replacements: 0,
      exact: via === 'exact',
      via,
      why: 'no change (search and replace are identical)',
    };
  }

  const replacement = reindentReplacement(opts.fileIndent ?? '', normalizeReplacement(content, replace));
  const targets = replaceAll ? [...ranges] : chosen.slice(0, 1);
  // How it matched, said once.
  const how =
    via === 'json'
      ? ' (matched ignoring JSON spacing)'
      : disambiguatedBy
        ? ` (${lineSpanLabel(disambiguatedBy.line, disambiguatedBy.lineEnd)} chose between ${ranges.length})`
        : '';
  return {
    ok: true,
    ranges,
    targets: targets.sort((a, b) => b.start - a.start),
    replacement,
    replacements: targets.length,
    exact: via === 'exact',
    via,
    why: `${targets.length} occurrence${targets.length === 1 ? '' : 's'}${how}`,
    ...(disambiguatedBy ? { disambiguatedBy } : {}),
  };
}
