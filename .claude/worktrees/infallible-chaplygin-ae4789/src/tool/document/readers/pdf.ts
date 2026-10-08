import type { DocumentReader, DocSection } from '../types';

const BLOCK_CHARS = 300;

// PDF text arrives as lines; group them into paragraph-sized blocks so a search hit carries its context.
function pageBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) {
      if (current) blocks.push(current);
      current = '';
      continue;
    }
    current = current ? `${current}\n${line}` : line;
    if (current.length >= BLOCK_CHARS) {
      blocks.push(current);
      current = '';
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

export const pdfReader: DocumentReader = {
  format: 'PDF',
  extensions: ['.pdf'],
  mimeType: /application\/pdf/i,
  async read(bytes) {
    const { getDocumentProxy, extractText, getMeta } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const { text } = await extractText(pdf, { mergePages: false });
      const info = (await getMeta(pdf).catch(() => null))?.info as Record<string, unknown> | undefined;
      const sections: DocSection[] = text.map((pageText, i) => ({ label: `Page ${i + 1}`, blocks: pageBlocks(pageText) }));
      const empty = sections.every((s) => s.blocks.length === 0);
      const title = typeof info?.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined;
      return {
        format: 'PDF',
        unit: 'page',
        ...(title ? { title } : {}),
        sections,
        ...(empty ? { note: 'No selectable text: this PDF looks like scanned images, which need OCR to read.' } : {}),
      };
    } finally {
      await pdf.loadingTask.destroy();
    }
  },
};
