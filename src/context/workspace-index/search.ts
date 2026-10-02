import { MAX_SYMBOLS_PER_FILE, MAX_IMPORTS_PER_FILE } from './_shared';
import { sourceRulesFor } from '../../env/languages';

export { sourceRulesFor as rulesFor } from '../../env/languages';

export function scanSource(content: string, ext: string): { symbols: { kind: string; name: string; }[]; imports: string[]; exports: string[]; } {
  const rule = sourceRulesFor(ext);
  if (!rule) return { symbols: [], imports: [], exports: [] };

  const symbols: any[] = [];
  const seen = new Set();
  for (const re of rule.symbols) {
    for (const m of content.matchAll(re)) {
      const name = m[1] ?? m[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      symbols.push({ kind: 'symbol', name });
      if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
  }

  const imports: any[] = [];
  for (const re of rule.imports) {
    for (const m of content.matchAll(re)) {
      for (const g of m.slice(1)) {
        if (!g) continue;
        const t = String(g).trim().replace(/["']/g, '');
        if (t && !imports.includes(t)) {
          imports.push(t);
          if (imports.length >= MAX_IMPORTS_PER_FILE) break;
        }
      }
      if (imports.length >= MAX_IMPORTS_PER_FILE) break;
    }
    if (imports.length >= MAX_IMPORTS_PER_FILE) break;
  }

  const exports: any[] = [];
  if (rule.exportRe) {
    for (const m of content.matchAll(rule.exportRe)) {
      const name = m[1];
      if (name && !exports.includes(name)) exports.push(name);
    }
  }
  return { symbols, imports, exports };
}
