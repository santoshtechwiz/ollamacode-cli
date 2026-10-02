import { isEditableSource } from './paths';
import { parseForStack } from '../languages';
import type { Diagnostic } from '../../types';

// ESC (0x1b) built without a literal so no control character sits in source.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');

export function parseDiagnostics(output: string, { stack, command = '', root }: { stack?: string; command?: string; root?: string; } = {}): Diagnostic[] {
  const text = String(output ?? '').replace(ANSI, '');
  if (!text.trim()) return [];

  const all = parseForStack(text, stack, command);
  return [
    ...all.filter((d) => isEditableSource(d.file, root)),
    ...all.filter((d) => !isEditableSource(d.file, root)),
  ].slice(0, 50);
}
