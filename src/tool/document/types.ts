/** One addressable part of a document: a PDF page or a spreadsheet sheet. */
export interface DocSection {
  label: string;
  /** Searchable units in order: paragraphs for a page, rows for a sheet. */
  blocks: string[];
  /** Shown above any rows picked from this section, e.g. a sheet's column names. */
  header?: string;
  /** One-line size note for the outline, e.g. "120 rows × 6 columns". */
  summary?: string;
}

export interface ParsedDocument {
  /** Human name of the format, e.g. "PDF". */
  format: string;
  /** What a section is called when the model asks for a range, e.g. "page". */
  unit: 'page' | 'sheet';
  title?: string;
  sections: DocSection[];
  /** Anything the reader had to leave out or could not do. */
  note?: string;
}

/** A file-format reader; add a format by writing one and listing it in readers/index.ts. */
export interface DocumentReader {
  format: string;
  extensions: readonly string[];
  mimeType: RegExp;
  read(bytes: Uint8Array): Promise<ParsedDocument>;
}
