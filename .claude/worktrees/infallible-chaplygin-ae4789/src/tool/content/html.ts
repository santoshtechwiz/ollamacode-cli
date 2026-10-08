import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

const DROP_ELEMENTS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form'];

const BLOCK_ELEMENTS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'br',
  'blockquote', 'pre', 'hr', 'dl', 'dt', 'dd', 'figure', 'figcaption',
]);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(text: string): string {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
}

function safeFromCodePoint(code: number): string {
  try {
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

export function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (og) return decodeEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? decodeEntities(title[1]).replace(/\s+/g, ' ').trim() : '';
}

function narrowToMain(html: string): string {
  const main =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  return main && main[1].length > 500 ? main[1] : html;
}

export function htmlToText(html: string): string {
  let doc = String(html);

  doc = doc.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP_ELEMENTS) {
    doc = doc.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    doc = doc.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }

  doc = narrowToMain(doc);

  doc = doc.replace(/<li\b[^>]*>/gi, '\n- ');
  doc = doc.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
  doc = doc.replace(/<\/h[1-6]>/gi, '\n');

  doc = doc.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_, tag) =>
    BLOCK_ELEMENTS.has(String(tag).toLowerCase()) ? '\n' : ' '
  );

  return decodeEntities(doc)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let markdownService: TurndownService | null = null;

function getMarkdownService(): TurndownService {
  if (markdownService) return markdownService;
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', hr: '---' });
  service.remove(DROP_ELEMENTS as TurndownService.TagName[]);
  service.use(gfm);
  // In-page anchors (footnotes, "back to top") cost tokens and lead nowhere a fetch can follow.
  service.addRule('in-page-link', {
    filter: (node) => node.nodeName === 'A' && /^#/.test(node.getAttribute('href') ?? ''),
    replacement: (content) => content,
  });
  markdownService = service;
  return service;
}

const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MENU_LINK_DENSITY = 0.8;
const MENU_LINK_WORDS = 4;

// A block that is nearly all links, and short ones, is a menu or share bar; a list of headlines has long link text and stays.
function isMenu(block: string): boolean {
  const labels = [...block.matchAll(LINK)].map((m) => m[1].trim()).filter(Boolean);
  if (labels.length === 0) return false;
  const visible = block.replace(LINK, '$1').replace(/^[\s*+\-\d.]+/gm, '').replace(/\s+/g, ' ').trim();
  const linked = labels.join(' ').length;
  const words = labels.reduce((n, l) => n + l.split(/\s+/).length, 0) / labels.length;
  return linked / Math.max(1, visible.length) >= MENU_LINK_DENSITY && words < MENU_LINK_WORDS;
}

/** Images, empty links and menus cost the reader's budget before the content starts; pages without a main/article tag are full of them. */
function dropBoilerplate(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/^[ \t]*(?:[*+-]|\d+\.)[ \t]*$/gm, '')
    .split(/\n\s*\n/)
    .filter((block) => block.trim() && !isMenu(block))
    .join('\n\n');
}

export function htmlToMarkdown(html: string): string {
  const narrowed = narrowToMain(String(html).replace(/<!--[\s\S]*?-->/g, ' '));
  let body: string;
  try {
    body = getMarkdownService().turndown(narrowed);
  } catch {
    return htmlToText(html); // malformed markup turndown's parser can't walk
  }
  return dropBoilerplate(body).replace(/\n{3,}/g, '\n\n').trim();
}

