function renderOne(d: import('../../types.ts').Diagnostic): string {
  const where = d.line ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}` : d.file;
  const project = d.project ? ` (in ${d.project})` : '';
  const symbol = d.symbol ? ` (in \`${d.symbol}\`)` : '';
  return `${where}: ${d.severity}${d.code ? ` ${d.code}` : ''}: ${d.message}${symbol}${project}`;
}

/** Every diagnostic the run reported, in full — this is the compiler's own text and the model is expected to act on it, so nothing here is summarized away. */
export function renderDiagnostics(diagnostics: import('../../types.ts').Diagnostic[]): string {
  if (diagnostics.length === 0) return '';
  return diagnostics.map(renderOne).join('\n');
}
