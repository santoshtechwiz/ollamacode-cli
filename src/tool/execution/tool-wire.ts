/** How a `ToolDef` becomes the JSON Schema the model is shown. Shared by every wire path. */

import type { ToolDef, ToolSchema } from '../../types';

/** The types JSON Schema defines. */
const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

/** The declared type as JSON Schema will accept it, or undefined for "omit it". */
function wireType(type: unknown): string | string[] | undefined {
  if (Array.isArray(type)) {
    const kept = type.filter((t) => JSON_SCHEMA_TYPES.has(String(t)));
    return kept.length > 0 ? kept : undefined;
  }
  return JSON_SCHEMA_TYPES.has(String(type)) ? (type as string) : undefined;
}

/** Strip this process's own schema keys (pathArg, bulkArg, requiredOneOf) from a node and its children, and normalize its type. */
function wireNode(node: any): any {
  if (!node || typeof node !== 'object') return node;
  delete node.pathArg;
  delete node.bulkArg;
  delete node.requiredOneOf;
  const type = wireType(node.type);
  if (type === undefined) delete node.type;
  else node.type = type;
  for (const child of Object.values(node.properties ?? {})) wireNode(child);
  if (node.items) wireNode(node.items);
  return node;
}

function wireSchema(schema: import('../../types.ts').JsonSchema): import('../../types.ts').JsonSchema {
  return wireNode(structuredClone(schema));
}

/**
 * A schema node without its prose: types, choices and what is required. An array keeps its element type, and an object
 * element keeps its own fields, so a model never has to guess the shape of a list item (and usually guessed wrong).
 */
function compactNode(value: any): any {
  const type = wireType(value?.type);
  const node: any = {
    ...(type === undefined ? {} : { type }),
    ...(value?.enum ? { enum: value.enum } : {}),
  };
  if (type === 'array' && value.items?.type) node.items = compactNode(value.items);
  if (type === 'object' && value.properties) Object.assign(node, compactSchema(value));
  return node;
}

function compactSchema(schema: any) {
  const properties: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema.properties ?? {}) as [string, any][]) properties[key] = compactNode(value);
  return { type: 'object', properties, required: schema.required ?? [] };
}

/** One tool as the model sees it. `compact` trades argument detail for schema size. */
export function toToolSchema(def: ToolDef, { compact = false }: { compact?: boolean } = {}): ToolSchema {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: compact
        ? (def.brief ?? def.description)
        : def.risky
          ? `${def.description} (requires user approval)`
          : def.description,
      parameters: compact ? compactSchema(def.parameters) : wireSchema(def.parameters),
    },
  };
}
