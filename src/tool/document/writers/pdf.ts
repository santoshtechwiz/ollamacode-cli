import type { PDFFont, PDFPage } from 'pdf-lib';
import { parseBlocks } from './markdown';

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 50;
const BODY = 11;
const LEADING = 1.35;
const HEADING_SIZE: Record<number, number> = { 1: 18, 2: 15, 3: 13 };
const CELL_PAD = 4;

interface PdfOutcome {
  bytes: Uint8Array;
  pages: number;
  /** Characters the built-in PDF fonts cannot show (emoji, most non-Latin scripts), which were left out. */
  dropped: number;
}

/** Render markdown to an A4 PDF: headings, paragraphs, lists, tables and code, flowing across pages. */
export async function writePdf(markdown: string, title?: string): Promise<PdfOutcome> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  if (title) doc.setTitle(title);

  // The standard fonts only encode WinAnsi; anything else is dropped and counted rather than failing the whole document.
  let dropped = 0;
  const encodable = new Map<string, boolean>();
  const clean = (text: string, font: PDFFont, count = true): string => {
    let out = '';
    for (const ch of text.replace(/\t/g, '    ').replace(/\r/g, '')) {
      if (ch === '\n') { out += ch; continue; }
      let fits = encodable.get(ch);
      if (fits === undefined) {
        try { font.encodeText(ch); fits = true; } catch { fits = false; }
        encodable.set(ch, fits);
      }
      if (fits) out += ch;
      else if (count) dropped++;
    }
    return out;
  };

  const width = PAGE_W - 2 * MARGIN;
  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const ensure = (height: number) => {
    if (y - height < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  // Greedy word wrap; a word wider than the line is broken by characters.
  const wrap = (text: string, font: PDFFont, size: number, max: number): string[] => {
    const lines: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/ +/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= max) { line = next; continue; }
        if (line) lines.push(line);
        line = '';
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > max && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > max) cut--;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  };

  const text = (raw: string, font: PDFFont, size: number, indent = 0, gapAfter = size * 0.6) => {
    const lineH = size * LEADING;
    for (const line of wrap(clean(raw, font), font, size, width - indent)) {
      ensure(lineH);
      y -= lineH;
      page.drawText(line, { x: MARGIN + indent, y: y + (lineH - size) / 2, size, font });
    }
    y -= gapAfter;
  };

  const table = (header: string[], rows: string[][]) => {
    const cols = Math.max(header.length, ...rows.map((r) => r.length));
    const size = cols > 5 ? 8 : cols > 3 ? 9 : 10;
    const lineH = size * LEADING;
    // Columns share the width by how much text they hold, never narrower than their longest word so a word is not split.
    const all = [header, ...rows];
    const longest = Array.from({ length: cols }, (_, c) => Math.max(3, ...all.map((r) => Math.min(60, String(r[c] ?? '').length))));
    const widestWord = Array.from({ length: cols }, (_, c) => Math.max(...all.map((r) =>
      Math.max(0, ...clean(String(r[c] ?? ''), bold, false).split(/\s+/).map((w) => bold.widthOfTextAtSize(w, size))))));
    const floor = widestWord.map((w) => Math.max(40, Math.min(width / 3, w + 2 * CELL_PAD + 1)));
    const floorSum = floor.reduce((a, b) => a + b, 0);
    const total = longest.reduce((a, b) => a + b, 0);
    // Each column first gets its floor; what is left goes to the columns whose text wants more than that.
    const want = longest.map((n, c) => Math.max(0, (n / total) * width - floor[c]));
    const wantSum = want.reduce((a, b) => a + b, 0);
    const spare = Math.max(0, width - floorSum);
    const colW = floorSum >= width
      ? floor.map((f) => (f * width) / floorSum)
      : floor.map((f, c) => f + (wantSum > 0 ? (want[c] / wantSum) * spare : spare / cols));

    const drawRow = (cells: string[], font: PDFFont, shaded: boolean) => {
      const wrapped = colW.map((w, c) => wrap(clean(String(cells[c] ?? ''), font), font, size, w - 2 * CELL_PAD));
      const height = Math.max(...wrapped.map((l) => l.length)) * lineH + 2 * CELL_PAD;
      ensure(height);
      let x = MARGIN;
      wrapped.forEach((lines, c) => {
        page.drawRectangle({ x, y: y - height, width: colW[c], height, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5, ...(shaded ? { color: rgb(0.92, 0.92, 0.92) } : {}) });
        lines.forEach((line, i) => page.drawText(line, { x: x + CELL_PAD, y: y - CELL_PAD - (i + 1) * lineH + (lineH - size) / 2, size, font }));
        x += colW[c];
      });
      y -= height;
    };

    if (header.some((h) => h.trim())) drawRow(header, bold, true);
    for (const row of rows) drawRow(row, regular, false);
    y -= BODY * 0.8;
  };

  const blocks = parseBlocks(markdown);
  // A content heading that repeats the title would print it twice.
  const first = blocks[0];
  if (title && first?.kind === 'heading' && first.text.trim().toLowerCase() === title.toLowerCase()) blocks.shift();
  if (title) text(title, bold, 20, 0, 10);
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const size = HEADING_SIZE[block.depth] ?? 12;
        ensure(size * 3);
        y -= size * 0.4;
        text(block.text, bold, size, 0, size * 0.4);
        break;
      }
      case 'paragraph': text(block.text, regular, BODY); break;
      case 'list':
        block.items.forEach((item, i) => text(`${block.ordered ? `${block.start + i}.` : '•'} ${item}`, regular, BODY, 12, 2));
        y -= BODY * 0.5;
        break;
      case 'table': table(block.header, block.rows); break;
      case 'code': text(block.text, mono, 9, 8); break;
      case 'rule':
        ensure(12);
        y -= 6;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
        y -= 6;
        break;
    }
  }

  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `${i + 1} / ${pages.length}`;
      p.drawText(label, { x: PAGE_W / 2 - regular.widthOfTextAtSize(label, 8) / 2, y: MARGIN / 2, size: 8, font: regular, color: rgb(0.5, 0.5, 0.5) });
    });
  }
  return { bytes: await doc.save(), pages: pages.length, dropped };
}
