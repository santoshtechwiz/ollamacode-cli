import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, clamp } from '../core/tool-result';
import { lookupSymbol } from './_symbols';

const MAX_DISPLAY = 20_000;

export default defineTool({
  name: 'symbol_references',
  profiles: ['core', 'planning'],
  category: 'search',
  activity: 'Finding references',
  label: 'Symbol References',
  brief: 'Find where a symbol is defined and which files import its module.',
  description: `Find where a symbol (function, class, type, or module name) is defined in the workspace and which files import its module.
Uses the workspace index; definitions are file-level, not line-accurate.`,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol or module name to look up' },
    },
    required: ['name'],
  },

  preview(args) {
    return `symbol ${args?.name}`;
  },

  async execute(args, ctx) {
    const name = String(args.name ?? '').trim();
    if (!name) {
      return fail('name is required', { code: TOOL_ERROR_CODE.EINVAL });
    }

    const index = (ctx as any)?.state?.index as import('../../context/workspace-index/_shared.ts').IndexHandle | null;
    if (!index?.db) {
      return fail('The workspace index is not available for this session.', {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Use grep_content to locate the symbol instead.',
      });
    }

    try {
      const { definitions, importers } = lookupSymbol(index, name, (abs) => ctx.ws.rel(abs));

      const defLines = [...definitions.values()].map((d) => `  ${d.file} (${d.kind})`);
      const impLines = [...importers.entries()].map(([file, items]) => `  ${file} -> ${items.join(', ')}`);
      const body = [
        `symbol: ${name}`,
        defLines.length ? `definitions:\n${defLines.join('\n')}` : null,
        impLines.length ? `importers:\n${impLines.join('\n')}` : null,
      ]
        .filter((l): l is string => Boolean(l))
        .join('\n\n');
      const { text, truncated } = clamp(body || 'no matches in the index', MAX_DISPLAY);

      return ok({
        kind: 'matches',
        display: text + (truncated ? '\n…[truncated]' : ''),
        data: {
          name,
          definitions: [...definitions.values()],
          importers: [...importers.entries()].map(([file, items]) => ({ file, imports: items })),
          count: definitions.size + importers.size,
        },
      });
    } catch (err) {
      return fail((err as Error)?.message ?? String(err), { code: TOOL_ERROR_CODE.EUNKNOWN });
    }
  },
});