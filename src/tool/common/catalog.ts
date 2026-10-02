import { defaultRegistry } from '../execution/registry';
import { TOOL_NAME } from '../../protocol';

export function buildToolCatalog({ only = null }: { only?: Iterable<string> | null } = {}): string {
  const names = only ? new Set(only) : null;
  return defaultRegistry.defs.filter((t) => (!names || names.has(t.name)) && defaultRegistry.isOffered(t.name) && t.name !== TOOL_NAME.LOAD_TOOLS).map((t) => {
    const required = t.parameters.required ?? [];
    const params = Object.entries(t.parameters.properties ?? {})
      .map(([k, v]) => `${k}${required.includes(k) ? '' : '?'}: ${(v as { type?: string }).type}`)
      .join(', ');
    return `- ${t.name}(${params})${t.risky ? ' [needs approval]' : ''}\n    ${t.description}`;
  }).join('\n');
}
