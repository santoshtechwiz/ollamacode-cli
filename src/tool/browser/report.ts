import type { Finding } from './checks';

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

/** The widths a page is checked at unless the call names its own. */
export const DEFAULT_VIEWPORTS: readonly Viewport[] = Object.freeze([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
]);

export function viewportsFor(widths: unknown): Viewport[] {
  if (!Array.isArray(widths) || widths.length === 0) return [...DEFAULT_VIEWPORTS];
  return [...new Set(widths.map(Number).filter((w) => Number.isFinite(w) && w >= 200 && w <= 3840).map(Math.round))].map((width) => {
    const known = DEFAULT_VIEWPORTS.find((v) => v.width === width);
    return known ?? { name: `${width}px`, width, height: 900 };
  });
}

export interface ViewportFindings {
  viewport: Viewport;
  findings: Finding[];
}

export interface MergedFinding extends Finding {
  /** The viewports it was seen at, in the order they were checked. */
  seenAt: string[];
}

/** The same problem at several widths is one finding that names the widths, so the report stays short. */
export function mergeFindings(results: ViewportFindings[]): MergedFinding[] {
  const merged = new Map<string, MergedFinding>();
  for (const { viewport, findings } of results) {
    for (const f of findings) {
      const key = `${f.check}\u0000${f.message}\u0000${(f.where ?? []).join('\u0000')}`;
      const found = merged.get(key);
      if (found) found.seenAt.push(viewport.name);
      else merged.set(key, { ...f, seenAt: [viewport.name] });
    }
  }
  // Errors first; within a severity, the order the checks ran in.
  return [...merged.values()].sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning'));
}

export function formatReport(target: string, results: ViewportFindings[]): { text: string; findings: MergedFinding[] } {
  const checked = results.map((r) => `${r.viewport.name} ${r.viewport.width}px`).join(', ');
  const findings = mergeFindings(results);
  if (findings.length === 0) {
    return { text: `${target}: no problems found (checked at ${checked}).`, findings };
  }
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const counts = [errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(', ');
  const lines = [`${target}: ${counts} (checked at ${checked}).`];
  for (const f of findings) {
    const at = f.seenAt.length === results.length ? 'all widths' : f.seenAt.join(', ');
    lines.push(`${f.severity === 'error' ? '✗' : '!'} [${f.check}] ${f.message} — ${at}`);
    for (const w of f.where ?? []) lines.push(`    ${w}`);
  }
  return { text: lines.join('\n'), findings };
}
