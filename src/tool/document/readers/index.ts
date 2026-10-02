import path from 'node:path';
import type { DocumentReader } from '../types';
import { pdfReader } from './pdf';
import { spreadsheetReader } from './spreadsheet';

/** Every document format read_document and web_fetch understand; a new format is one more entry. */
const READERS: readonly DocumentReader[] = [pdfReader, spreadsheetReader];

/** The reader for a file name or URL path, falling back to the content type when the name has no known extension. */
export function readerFor(name: string, contentType = ''): DocumentReader | undefined {
  const ext = path.extname(String(name ?? '').split(/[?#]/)[0]).toLowerCase();
  return READERS.find((r) => r.extensions.includes(ext)) ?? (contentType ? READERS.find((r) => r.mimeType.test(contentType)) : undefined);
}

export function supportedExtensions(): string[] {
  return READERS.flatMap((r) => r.extensions);
}
