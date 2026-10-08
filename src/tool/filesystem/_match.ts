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

/** The indentation step a text uses: a tab, or the common width of its space indents; '' when it indents nothing. */
function indentUnit(text: string): string {
  let tabs = 0;
  let width = 0;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.startsWith('\t')) tabs += 1;
    else if (lead.length > 0) width = gcd(width, lead.length);
  }
  if (tabs > 0 && width === 0) return '\t';
  if (width > 0 && tabs === 0) return ' '.repeat(width);
  return '';
}

/**
 * A replacement written in the search's indentation, moved to the file's: a match made ignoring whitespace used to
 * write the model's tabs into a file indented with spaces. Only when both indent in one clear way and they differ.
 */
function matchIndentation(replacement: string, search: string, content: string): string {
  const from = indentUnit(search);
  const to = indentUnit(content);
  if (!from || !to || from === to) return replacement;
  return replacement
    .split('\n')
    .map((line) => {
      let depth = 0;
      let rest = line;
      while (rest.startsWith(from)) {
        depth += 1;
        rest = rest.slice(from.length);
      }
      return to.repeat(depth) + rest;
    })
    .join('\n');
}

/**
 * The lines that follow `range` in `content`, written again at the end of `replacement`: the file keeps them, so after
 * the edit they appear twice. Returns how many lines (`count`) and at which line of the replacement the copy starts (`at`), or
 * null. Lines holding no word (a lone `}`) do not count. A fact about this edit's text, the same for any language.
 */
export function linesRepeatedAfter(content: string, range: MatchRange, replacement: string): { count: number; at: number } | null {
  const rest = content.slice(range.end);
  // The match must end at a line's end, or take that line break with it.
  const endsLine = range.end === 0 || content[range.end - 1] === '\n';
  if (!endsLine && !/^\r?\n/.test(rest)) return null;
  const clean = (l: string) => l.replace(/\r$/, '').trimEnd();
  const after = (endsLine ? rest : rest.replace(/^\r?\n/, '')).split('\n').map(clean);
  const written = replacement.replace(/\r?\n$/, '').split('\n').map(clean);
  const wordy = (line: string) => /[\p{L}\p{N}]/u.test(line);
  if (!wordy(after[0] ?? '')) return null;
  // The replacement's first line is where the match was; a copy starts after it.
  for (let at = 1; at < written.length; at++) {
    let count = 0;
    while (at + count < written.length && count < after.length && written[at + count] === after[count]) count++;
    // The copy must run to the replacement's end (bar lines with no word): the old block's tail left behind the new
    // one. Lines like those that follow, with more written after them, are new code modelled on the code below.
    if (written.slice(at + count).some(wordy)) continue;
    // Report the span up to its last line with a word: a closing brace or blank line after it says nothing.
    while (count > 0 && !wordy(written[at + count - 1])) count--;
    if (count > 0) return { count, at };
  }
  return null;
}

export function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

export function countLines(content: string): number {
  if (content === '') return 0;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

function detectLineEnding(content: string): 'crlf' | 'lf' | 'mixed' | 'none' {
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

/** The search as a message names it: a one-line search quoted, a longer one by its size and first line, so a block is never read as its first line alone. */
function searchLabel(search: unknown): string {
  const lines = String(search ?? '').split('\n').filter((l) => l.trim() !== '').length;
  return lines > 1 ? `the ${lines}-line search (starting “${quoteSearchText(search)}”)` : `“${quoteSearchText(search)}”`;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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
  if (!d) return `${capitalize(searchLabel(search))} is not in ${rel}`;
  return `the search matches ${rel} from line ${d.start} but differs at line ${d.line}: the file has ${shown(d.file)} where the search has ${shown(d.search)}`;
}

type EditFailCode = 'EINVAL' | 'ENOMATCH' | 'EAMBIGUOUS';

interface EditPlan {
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
  via: 'exact' | 'whitespace';
  /** A search that matched for some lines and then parted ways: the file line where it did. `focus` points there. */
  divergedAt?: number;
}

interface EditArgError {
  code: EditFailCode;
  why: string;
  hint: string;
}

type EditLocator = { search?: unknown; replace?: unknown; };

/** An edit names the text it changes: search, copied from the file. */
function hasSearchText(spec: EditLocator): boolean {
  return typeof spec.search === 'string' && spec.search !== '';
}

/** What is wrong with this edit's *arguments*, before any file is read. */
function editArgError(edit: EditLocator | null | undefined, rel: string): EditArgError | null {
  const spec = edit ?? {};
  if (!hasSearchText(spec)) {
    return {
      code: 'EINVAL',
      why: `search is required — it is the text in ${rel} to replace, copied from the file`,
      hint: 'Pass search with the exact text to change, as read_file shows it (without the line-number gutter).',
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

/** Does this edit apply, and if not, why — asked once. */
export function planEdit(
  content: string,
  edit: (EditLocator & { replace_all?: unknown; }) | null | undefined,
  opts: { rel: string; }
): EditPlan {
  const spec = edit ?? {};
  const rel = opts.rel;

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
    };
  }

  const search = String(spec.search);
  const replace = String(spec.replace);

  const located = locate(content, search);
  const ranges = located.ranges;
  const via: 'exact' | 'whitespace' = located.exact ? 'exact' : 'whitespace';

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
      ...(near ? { focus: { line: near, lineEnd: near } } : {}),
    };
  }

  const replaceAll = spec.replace_all === true;

  if (ranges.length > 1 && !replaceAll) {
    const lines = ranges.map((r) => lineAt(content, r.start));
    return {
      ok: false,
      code: 'EAMBIGUOUS',
      ranges,
      why:
        `${capitalize(searchLabel(search))} matches ${ranges.length} places in ${rel} ` +
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

  const shaped = via === 'whitespace' ? matchIndentation(replace, search, content) : replace;
  const replacement = normalizeReplacement(content, shaped);
  const targets = replaceAll ? [...ranges] : ranges.slice(0, 1);
  return {
    ok: true,
    ranges,
    targets: targets.sort((a, b) => b.start - a.start),
    replacement,
    replacements: targets.length,
    exact: via === 'exact',
    via,
    why: `${targets.length} occurrence${targets.length === 1 ? '' : 's'}`,
  };
}
