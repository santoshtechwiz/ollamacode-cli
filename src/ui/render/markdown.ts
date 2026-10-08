import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { bold, dim, italic, gray, cyan, green, blue, underline, colorEnabled, visibleWidth } from '../ansi';
import { renderMath, renderBareLatex, isMath } from '../latex';
import { icons } from './icons';

const DEFAULT_WIDTH = 80;
const TAB = 2;

function decodeEntities(s: string): string {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// An indented code block whose whole body is itself a fence.
const WRAPPED_FENCE = /^(`{3,}|~{3,})[ \t]*([^\n`]*)\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/;

function unwrapFence(token: any): void {
  if (token?.type !== 'code' || String(token.lang ?? '').trim()) return;
  const m = WRAPPED_FENCE.exec(String(token.text ?? '').trim());
  if (!m) return;
  token.lang = m[2].trim();
  token.text = m[3];
}

function codeBlock(code: string, lang: string): string {
  const body = String(code ?? '').replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
  if (!colorEnabled()) return body.join('\n');
  const label = lang
    ? gray(`── ${lang} · ${body.length} line${body.length === 1 ? '' : 's'} · /copy`)
    : gray(`── ${body.length} line${body.length === 1 ? '' : 's'} · /copy`);
  return [label, ...body.map((line) => `${blue(icons.gutter)} ${line}`)].join('\n');
}

function headingText(text: string, depth: number): string {
  if (depth === 1) return bold(underline(cyan(text)));
  if (depth === 2) return bold(cyan(text));
  if (depth === 3) return bold(text);
  return dim(bold(text));
}

function styleOptions(width: number) {
  return {
    width,
    // Ink owns wrapping, and the streaming block model needs stable lines.
    reflowText: false,
    showSectionPrefix: false,
    tab: TAB,
    emoji: false,
    unescape: true,
    code: (s: string) => s,
    // marked-terminal hands the quote body over already indented by `tab`.
    blockquote: (s: string) =>
      s
        .split('\n')
        .map((l) => l.replace(/^ {1,2}/, ''))
        .filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1 && all[i - 1].trim()))
        .map((l) => (l.trim() ? `${dim(icons.gutter)} ${gray(l)}` : dim(icons.gutter)))
        .join('\n'),
    html: (s: string) => dim(s),
    heading: (s: string) => s,
    firstHeading: (s: string) => s,
    hr: () => dim(icons.rule.repeat(24)),
    listitem: (s: string) => s,
    paragraph: (s: string) => s,
    strong: (s: string) => bold(s),
    em: (s: string) => italic(s),
    del: (s: string) => dim(s),
    codespan: (s: string) => cyan(decodeEntities(s)),
    link: (s: string) => cyan(s),
    href: (s: string) => cyan(underline(s)),
    text: (s: string) => s,
    tableOptions: {
      // cli-table3 colours through chalk, which does not consult setColorMode().
      style: { head: [] as string[], border: [] as string[], 'padding-left': 1, 'padding-right': 1 },
      chars: { 'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    },
  };
}

/**
 * Math is parsed as math, before markdown reads the text: every way a model writes it — `$…$` and `\(…\)` inline,
 * `$$…$$` and `\[…\]` on their own lines — becomes one token and goes through one converter. Left to the markdown
 * parser, `\(` lost its backslash and `_` became italics, so the result depended on which style the model used.
 */
const INLINE_MATH: Array<{ pattern: RegExp; delimited: boolean }> = [
  { pattern: /^\$\$(?!\s)([^$]+?)\$\$/, delimited: true },
  { pattern: /^\\\(([\s\S]+?)\\\)/, delimited: true },
  // A `$` pair is math only when it hugs its content, the closing one is not a price, and the body reads as math:
  // `$5 and $10` stays text.
  { pattern: /^\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/, delimited: false },
];
const BLOCK_MATH = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/;

const mathExtension = {
  extensions: [
    {
      name: 'mathBlock',
      level: 'block' as const,
      start: (src: string) => src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
      tokenizer(src: string) {
        const m = BLOCK_MATH.exec(src);
        return m ? { type: 'mathBlock', raw: m[0], text: String(m[1] ?? m[2]) } : undefined;
      },
      renderer: (token: any) =>
        `\n${String(token.text).trim().split('\n').map((line: string) => `  ${renderMath(line)}`).join('\n')}\n\n`,
    },
    {
      name: 'mathInline',
      level: 'inline' as const,
      start: (src: string) => {
        const at = src.search(/\$|\\\(/);
        return at < 0 ? undefined : at;
      },
      tokenizer(src: string) {
        for (const { pattern, delimited } of INLINE_MATH) {
          const m = pattern.exec(src);
          if (m && (delimited || isMath(m[1]))) return { type: 'mathInline', raw: m[0], text: m[1] };
        }
        return undefined;
      },
      renderer: (token: any) => renderMath(token.text),
    },
  ],
};

/** A table never wider than the terminal; below this a column is too narrow to read, and the rows are listed instead. */
const MIN_COLUMN = 8;

/**
 * Column widths (padding included) that fit `width`: a column that fits its widest cell keeps it, and the rest share
 * what is left. Null when even the narrowest readable grid cannot fit.
 */
function fitColumns(rows: string[][], width: number): number[] | null {
  const count = rows[0]?.length ?? 0;
  if (!count) return null;
  const natural = Array.from({ length: count }, (_, i) =>
    Math.max(...rows.map((row) => Math.max(...String(row[i] ?? '').split('\n').map(visibleWidth)))) + 2);
  const room = width - (count + 1);
  if (natural.reduce((a, b) => a + b, 0) <= room) return natural;
  if (room < count * MIN_COLUMN) return null;
  const widths = new Array<number>(count);
  let left = room;
  const order = natural.map((_, i) => i).sort((a, b) => natural[a] - natural[b]);
  order.forEach((col, k) => {
    const share = Math.floor(left / (count - k));
    widths[col] = Math.max(MIN_COLUMN, Math.min(natural[col], share));
    left -= widths[col];
  });
  return widths;
}

function buildMarked(width: number): Marked {
  const style = styleOptions(width);
  const ext: any = markedTerminal(style as any, { ignoreIllegals: true });
  const renderer = ext.renderer;

  // marked-terminal's text renderer never parses inline tokens, so list items would show raw markup.
  const baseText = renderer.text;
  renderer.text = function (token: any) {
    if (token && typeof token === 'object') {
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return baseText.call(this, { ...token, text: this.parser.parseInline(token.tokens) });
      }
      return baseText.call(this, { ...token, text: renderBareLatex(decodeEntities(token.text ?? '')) });
    }
    return baseText.call(this, renderBareLatex(decodeEntities(String(token ?? ''))));
  };

  // Restore per-level heading styling; marked-terminal only distinguishes h1.
  const baseHeading = renderer.heading;
  renderer.heading = function (token: any) {
    const depth = Number(typeof token === 'object' ? token.depth : 1) || 1;
    const out = baseHeading.call(this, token);
    return out
      .split('\n')
      .map((l: string) => (l.trim() ? headingText(l, depth) : l))
      .join('\n');
  };

  // Keep the CLI's own fence look (language label + gutter) over cli-highlight's highlighted body, instead of marked-terminal's flat indent.
  const baseCode = renderer.code;
  renderer.code = function (token: any) {
    const lang = String((typeof token === 'object' ? token.lang : '') ?? '').trim();
    const out = String(baseCode.call(this, token)).replace(/^\n+|\n+$/g, '');
    // Undo exactly the indent the library added, never the code's own.
    const dedented = out.replace(new RegExp(`^ {${TAB}}`, 'gm'), '');
    return `\n${codeBlock(dedented, lang)}\n\n`;
  };

  const baseBlockquote = renderer.blockquote;
  renderer.blockquote = function (token: any) {
    return String(baseBlockquote.call(this, token))
      .split('\n')
      .map((line) => line.replace(/^>\s?/, `${dim(icons.gutter)} `))
      .join('\n');
  };

  // marked-terminal reads listToken.start but never applies it, so every ordered list restarts at 1 — visible whenever a list is split across blocks.
  let depth = 0;
  const baseList = renderer.list;
  renderer.list = function (token: any) {
    depth += 1;
    let out: string;
    try {
      out = String(baseList.call(this, token));
    } finally {
      depth -= 1;
    }
    if (depth > 0) return out;
    // list() calls listitem/checkbox directly, so task markers can only be fixed here, right after the bullet.
    out = out.replace(TASK_MARKER, (_m: string, pad: string, marker: string, c: string) =>
      `${pad}${marker}${c === ' ' ? `${dim(icons.pending)} ` : `${green(icons.success)} `}`
    );
    const ordered = typeof token === 'object' ? Boolean(token.ordered) : false;
    const start = Number((typeof token === 'object' ? token.start : 1) ?? 1) || 1;
    const bulleted = out.replace(/^(\s*)\* /gm, `$1${icons.bullet} `);
    return ordered ? renumber(bulleted, start - 1) : bulleted;
  };

  // The table is laid out for the terminal it is drawn in: long cells wrap inside their column instead of the
  // terminal wrapping the whole row, which broke the grid. A terminal too narrow for any grid gets the rows listed.
  const baseTable = renderer.table;
  renderer.table = function (token: any) {
    if (typeof token !== 'object' || !Array.isArray(token.header)) return baseTable.call(this, token);
    const cell = (c: any) => String(this.parser.parseInline(c.tokens ?? []));
    const head = token.header.map(cell);
    const rows = token.rows.map((row: any[]) => row.map(cell));
    const colWidths = fitColumns([head, ...rows], width);
    if (!colWidths) {
      const listed = rows.map((row: string[]) => row.map((value, i) => `${bold(head[i])}: ${value}`).join('\n'));
      return `\n${listed.join('\n\n')}\n\n`;
    }
    // marked-terminal's own renderer holds this very options object, so the widths apply to this table only.
    const options: Record<string, unknown> = style.tableOptions;
    Object.assign(options, { colWidths, wordWrap: true, wrapOnWordBoundary: true });
    try {
      return baseTable.call(this, token);
    } finally {
      delete options.colWidths;
      delete options.wordWrap;
      delete options.wrapOnWordBoundary;
    }
  };

  const marked = new Marked({ async: false, gfm: true });
  marked.use(mathExtension as any);
  marked.use(ext);
  marked.use({ walkTokens: unwrapFence });
  return marked;
}

const NUMBERED = /^(\s*)(\d+)\.(\s)/;
const TASK_MARKER = /^(\s*)((?:[-*]|\d+\.) )\[([ Xx])\] */gm;

/**
 * marked-terminal numbers every item it meets inside an ordered list, nested ones included, so a step's
 * sub-bullets read as steps 2, 3, 4… The list's own items (the shallowest) are numbered in order from `offset + 1`;
 * deeper numbered lines go back to being bullets.
 */
function renumber(body: string, offset: number): string {
  const lines = body.split('\n');
  const indents = lines
    .map((l) => NUMBERED.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => m[1].length);
  if (indents.length === 0) return body;
  const top = Math.min(...indents);
  let n = offset;
  return lines
    .map((line) => {
      const m = NUMBERED.exec(line);
      if (!m) return line;
      if (m[1].length !== top) return `${m[1]}${icons.bullet}${m[3]}${line.slice(m[0].length)}`;
      n += 1;
      return `${m[1]}${n}.${m[3]}${line.slice(m[0].length)}`;
    })
    .join('\n');
}

let cached: { marked: Marked; width: number; color: boolean; } | null = null;

function instance(requestedWidth?: number): Marked {
  const width = Math.max(20, Number(requestedWidth) || Number(process.stdout.columns) || DEFAULT_WIDTH);
  const color = colorEnabled();
  if (!cached || cached.width !== width || cached.color !== color) {
    cached = { marked: buildMarked(width), width, color };
  }
  return cached.marked;
}

function toLines(out: string): string[] {
  const lines = String(out ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));

  // marked-terminal pads every section with blank lines; collapse to one.
  const packed: string[] = [];
  for (const line of lines) {
    if (!line.trim() && (packed.length === 0 || !packed[packed.length - 1].trim())) continue;
    packed.push(line);
  }
  while (packed.length > 0 && !packed[packed.length - 1].trim()) packed.pop();
  return packed;
}

export function renderMarkdown(source: string, width?: number): string[] {
  const raw = String(source ?? '');
  if (!raw.trim()) return [];
  try {
    return toLines(instance(width).parse(raw) as string);
  } catch {
    return raw.replace(/\n$/, '').split('\n');
  }
}

const OPEN_FENCE = /^\s{0,3}(`{3,}|~{3,})/gm;

export function renderPartial(source: string, width?: number): string[] {
  const raw = String(source ?? '');
  if (!raw.trim()) return [];
  const fences = raw.match(OPEN_FENCE) ?? [];
  if (fences.length % 2 === 0) return renderMarkdown(raw, width);
  const marker = fences[fences.length - 1].trim()[0] === '~' ? '~~~' : '```';
  return renderMarkdown(`${raw}\n${marker}`, width);
}

