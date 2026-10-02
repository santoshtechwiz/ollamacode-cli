// The discovery call: the model reads the tool index and asks for the schemas a step needs.

import { TOOL_ERROR_CODE, TOOL_NAME } from '../../protocol';
import { fail, ok } from '../core/tool-result';
import { defineTool } from '../core/defineTool';
import { ToolResolver, isResolved, type UnresolvedTool } from '../execution/tool-resolver';
import { toToolSchema } from '../execution/tool-wire';
import type { ToolResult, ToolSchema } from '../../types';

const MAX_NAMES = 12;

/** The names a load_tools call asked for, deduplicated and capped. */
function requestedNames(args: any): string[] {
  const raw = args?.tools ?? args?.names;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const names = [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))];
  return names.slice(0, MAX_NAMES);
}

/** Resolve a load_tools call against the turn's resolver and say truthfully what is now loaded. */
export function answerLoadTools(args: any, resolver: ToolResolver): ToolResult {
  const names = requestedNames(args);
  if (names.length === 0) {
    return fail('Name at least one tool from the index to load', {
      code: TOOL_ERROR_CODE.EINVAL,
      hint: 'Call load_tools with {"tools": ["read_file"]}, listing every tool the next step needs.',
    });
  }

  const outcomes = resolver.loadAll(names);
  const loaded = outcomes.filter(isResolved).map((o) => o.name);
  const refused = outcomes.filter((o): o is UnresolvedTool => !isResolved(o)).map((o) => o.reason);

  if (loaded.length === 0) {
    return fail(refused.join(' '), {
      code: TOOL_ERROR_CODE.EINVAL,
      hint: 'Use a name exactly as the tool index spells it.',
    });
  }

  const lines = [
    `Loaded: ${loaded.join(', ')}.`,
    'Their full argument schemas are in your next request — call them directly from now on.',
    ...(refused.length ? [`Not loaded: ${refused.join(' ')}`] : []),
  ];

  return ok({
    kind: 'text',
    display: lines.join('\n'),
    data: { loaded: loaded.length, names: loaded },
  });
}

const loadTools = defineTool({
  name: TOOL_NAME.LOAD_TOOLS,
  label: 'Load Tools',
  activity: 'Loading tools',
  category: 'agent',
  brief: 'Load the full argument schema for tools you are about to use.',
  description:
    'Load the full argument schema for one or more tools before calling them. The tool index below lists what exists ' +
    "and what it is for; this call is what puts a tool's arguments in front of you. Ask for every tool the step needs " +
    'in one call — they stay loaded, so asking twice costs nothing.',
  parameters: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        description: 'Names from the tool index, as many as this step needs.',
        items: { type: 'string' },
      },
    },
    required: ['tools'],
  },
  // The turn answers with its own resolver; this path only runs outside a turn, against the whole registry.
  async execute(args) {
    return answerLoadTools(args, new ToolResolver());
  },
});

export default loadTools;

/** The wire schema with the turn's index appended; built per request because the index depends on the profile. */
export function loadToolsSchema(indexText: string): ToolSchema {
  const schema = toToolSchema(loadTools);
  return {
    ...schema,
    function: { ...schema.function, description: `${schema.function.description}\n\nTool index:\n${indexText}` },
  };
}
