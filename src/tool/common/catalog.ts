import { defaultRegistry } from '../execution/registry';

export function buildToolCatalog({ only = null, exclude = [] }: { only?: Iterable<string> | null; exclude?: readonly string[] } = {}): string {
  const names = only ? new Set(only) : null;
  return defaultRegistry.defs.filter((t) => (!names || names.has(t.name)) && defaultRegistry.isOffered(t.name) && !exclude.includes(t.name)).map((t) => {
    const required = t.parameters.required ?? [];
    const params = Object.entries(t.parameters.properties ?? {})
      .map(([k, v]) => `${k}${required.includes(k) ? '' : '?'}: ${(v as { type?: string }).type}`)
      .join(', ');
    return `- ${t.name}(${params})${t.risky ? ' [needs approval]' : ''}\n    ${t.description}`;
  }).join('\n');
}
