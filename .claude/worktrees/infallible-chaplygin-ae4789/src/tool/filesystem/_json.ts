export function isJsonPath(relOrAbs: string): boolean {
  return String(relOrAbs ?? '').toLowerCase().endsWith('.json');
}

export function stripBom(text: string): { text: string; hadBom: boolean; } {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return { text: text.slice(1), hadBom: true };
  }
  return { text, hadBom: false };
}

export function validateJson(text: string, rel: string): { ok: true; value: unknown; } | { ok: false; error: string; hint: string; position?: number; } {
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch (err) {
    const msg = (err as Error).message || 'invalid JSON';
    const m = /at position (\d+)/.exec(msg);
    const position = m ? Number(m[1]) : undefined;
    let snippet = '';
    if (position !== undefined) {
      const from = Math.max(0, position - 60);
      const to = Math.min(text.length, position + 60);
      snippet = `\nNear byte ${position}: …${JSON.stringify(text.slice(from, to))}…`;
    } else if (text.trim() === '') {
      snippet = '\nThe file is empty — valid JSON needs at least `{}` or `[]`.';
    }
    return {
      ok: false,
      error: `Refusing to write ${rel}: invalid JSON (${msg}).${snippet}\nNothing was written.`,
      hint: 'Fix the JSON (no trailing commas, no comments, escape newlines inside strings as \\n) or use json_patch to change one key.',
      position,
    };
  }
}

export function detectJsonIndent(text: string): string {
  const m = /^([ \t]+)"[^"\n]*":/m.exec(text);
  if (!m) return '';
  const unit = m[1];
  if (unit.startsWith('\t')) return '\t';
  if (unit.length >= 4 && unit.length % 4 === 0) return '    ';
  return '  ';
}

