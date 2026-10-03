import { buildToolCatalog } from '../tool/common/catalog';
import { coreToolNames, readOnlyToolNames } from '../context/tool-surface';

export function textModeInstructions({ core = false, readOnly = false, exclude = [] }: any = {}): string {
  const only = readOnly
    ? readOnlyToolNames()
    : core
      ? coreToolNames()
      : null;
  return `TOOLS
You do not have a structured tool channel, so request a tool by replying with a
single JSON object and nothing else:

{"name": "<tool>", "arguments": { ... }}

Wait for the result before continuing. Available tools:
${buildToolCatalog({ only, exclude })}`;
}

