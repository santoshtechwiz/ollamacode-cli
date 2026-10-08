import { marked, type Token, type Tokens } from 'marked';

export type Block =
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
}

// Inline markdown as the words a reader sees: emphasis dropped, a link keeps its target when the label does not already say it.
function inlineText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens?.length) return decode(fallback);
  return tokens.map((t) => {
    switch (t.type) {
      case 'link': {
        const label = inlineText((t as Tokens.Link).tokens, (t as Tokens.Link).text);
        const href = (t as Tokens.Link).href;
        return label === href || !href ? label : `${label} (${href})`;
      }
      case 'br': return '\n';
      case 'html': return '';
      case 'image': return (t as Tokens.Image).text;
      default: return 'tokens' in t && t.tokens ? inlineText(t.tokens as Token[], (t as { text?: string }).text ?? '') : decode((t as { text?: string }).text ?? t.raw);
    }
  }).join('');
}

/** Markdown as a flat list of printable blocks; anything nested (quotes, list sub-blocks) is flattened into text. */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      switch (t.type) {
        case 'heading': blocks.push({ kind: 'heading', depth: (t as Tokens.Heading).depth, text: inlineText((t as Tokens.Heading).tokens, (t as Tokens.Heading).text) }); break;
        case 'paragraph': blocks.push({ kind: 'paragraph', text: inlineText((t as Tokens.Paragraph).tokens, (t as Tokens.Paragraph).text) }); break;
        case 'text': blocks.push({ kind: 'paragraph', text: inlineText((t as Tokens.Text).tokens, (t as Tokens.Text).text) }); break;
        case 'list': {
          const list = t as Tokens.List;
          blocks.push({ kind: 'list', ordered: list.ordered, start: Number(list.start) || 1, items: list.items.map((i) => inlineText(i.tokens, i.text).trim()) });
          break;
        }
        case 'table': {
          const table = t as Tokens.Table;
          blocks.push({ kind: 'table', header: table.header.map((c) => inlineText(c.tokens, c.text)), rows: table.rows.map((r) => r.map((c) => inlineText(c.tokens, c.text))) });
          break;
        }
        case 'code': blocks.push({ kind: 'code', text: (t as Tokens.Code).text }); break;
        case 'hr': blocks.push({ kind: 'rule' }); break;
        case 'blockquote': walk((t as Tokens.Blockquote).tokens); break;
        default: break;
      }
    }
  };
  walk(marked.lexer(String(markdown ?? '')));
  return blocks;
}
