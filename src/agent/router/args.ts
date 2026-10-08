import { normNameKey } from './names';
import { extractJsonObjects } from '../response/tool-parser';

type ToolDef = import('../../types.ts').ToolDef;
type JsonSchemaProperty = import('../../types.ts').JsonSchemaProperty;

type Args = Record<string, unknown>;
type AliasMap = Record<string, string>;

// Pipeline: parse -> normalize -> validate -> preflight.

/* -------------------------------------------------------------------------- */
/* Phase 1 — parse: recover structured arguments from raw model output        */
/* -------------------------------------------------------------------------- */

/** Turn the raw model output into a plain argument object. */
export function parseArgs(
  def: ToolDef | undefined,
  args: unknown,
): Args {
  const out: Args = isObject(args) ? { ...args } : {};

  recoverRawArgs(out, def);
  coerceSchemaArrays(out, def);

  return out;
}

/* -------------------------------------------------------------------------- */
/* Phase 2 — normalize: safe aliases and structural normalization             */
/* -------------------------------------------------------------------------- */

/** Parse and normalize model-generated tool arguments. */
export function normalizeArgs(
  args: Record<string, unknown>,
  def?: ToolDef,
): Record<string, unknown> {
  const out = parseArgs(def, args);

  // The tool's own other spellings of its arguments, declared on its definition.
  const aliases = def?.argAliases;
  if (aliases) {
    normalizeAliases(out, aliases);
    normalizeNestedAliases(out, aliases);
  }

  coerceArgvCommand(out, def);
  dropUnsetOptionals(out, def);

  return out;
}

/**
 * Values that say "not set" for an optional parameter, read from its schema, never from the model or tool:
 * `false` on a choice of strings, and `""` wherever an empty string cannot mean anything — a path, a choice,
 * a number or a flag. Many models fill every optional parameter with an empty default; the tool's own
 * default is what they meant. A string whose emptiness is a real value (replace: "" deletes) is untouched.
 */
function dropUnsetOptionals(args: Args, def?: ToolDef): void {
  const required = def?.parameters?.required ?? [];
  for (const [key, spec] of Object.entries(def?.parameters?.properties ?? {})) {
    if (required.includes(key)) continue;
    if (spec?.enum && args[key] === false) delete args[key];
    const emptyMeansNothing =
      spec?.pathArg === true || Array.isArray(spec?.enum) || spec?.type === 'number' || spec?.type === 'integer' || spec?.type === 'boolean';
    if (emptyMeansNothing && typeof args[key] === 'string' && (args[key] as string).trim() === '') delete args[key];
  }
}

const SHELL_SCRIPT_FLAG = /^(?:-[a-z]*c|\/c|-command)$/i;

/** An argv array for a string `command` (e.g. ["bash", "-lc", "cargo new x"]) is the same command; a `<shell> -c <script>` wrapper yields the script. */
function coerceArgvCommand(args: Args, def?: ToolDef): void {
  const value = args.command;
  if (def?.parameters?.properties?.command?.type !== 'string') return;
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) return;
  const argv = value as string[];
  if (argv.length >= 3 && SHELL_SCRIPT_FLAG.test(argv[1])) {
    args.command = argv.slice(2).join(' ');
    return;
  }
  args.command = argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Phase 3 — validate: reject malformed arguments before execution            */
/* -------------------------------------------------------------------------- */

export function validate(
  def: ToolDef,
  args: Record<string, unknown>,
): string | null {
  if (typeof args._raw === 'string') {
    return (
      `${def.name} arguments could not be read as a structured object. ` +
      `The model returned raw text instead of JSON arguments, so the call ` +
      `may have been malformed or truncated. Expected: ${shapeHint(def)}`
    );
  }

  const requiredError = validateRequired(def, args);
  if (requiredError) {
    return requiredError;
  }

  const requiredGroupError = validateRequiredGroups(def, args);
  if (requiredGroupError) {
    return requiredGroupError;
  }

  const itemError = validateArrayItems(def, args);
  if (itemError) {
    return itemError;
  }

  const propertyError = validateProperties(def, args);
  if (propertyError) {
    return propertyError;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function normalizeAliases(args: Args, aliases: AliasMap): boolean {
  const normalizedAliases = new Map(
    Object.entries(aliases).map(([from, to]) => [normNameKey(from), to]),
  );

  let changed = false;

  for (const key of Object.keys(args)) {
    const target = normalizedAliases.get(normNameKey(key));

    if (!target || target === key) {
      continue;
    }

    changed = true;

    // Never overwrite an explicitly supplied canonical value.
    if (args[target] !== undefined) {
      delete args[key];
      continue;
    }

    args[target] = args[key];
    delete args[key];
  }

  return changed;
}

function normalizeNestedAliases(args: Args, aliases: AliasMap): void {
  for (const [key, value] of Object.entries(args)) {
    if (!Array.isArray(value)) {
      continue;
    }

    let changed = false;

    const normalized = value.map((item) => {
      if (!isObject(item)) {
        return item;
      }

      const copy = { ...item };

      if (normalizeAliases(copy, aliases)) {
        changed = true;
      }

      return copy;
    });

    if (changed) {
      args[key] = normalized;
    }
  }
}


function coerceSchemaArrays(args: Args, def?: ToolDef): void {
  const properties = def?.parameters?.properties;
  if (!properties) {
    return;
  }

  for (const [key, spec] of Object.entries(properties)) {
    if (spec?.type !== 'array') {
      continue;
    }

    const value = args[key];

    if (value === undefined || value === null || Array.isArray(value)) {
      continue;
    }

    // Only parse explicit JSON arrays.
    if (typeof value !== 'string') {
      continue;
    }

    const text = value.trim();

    if (!text.startsWith('[')) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(text);

      if (Array.isArray(parsed)) {
        args[key] = parsed;
      }
    } catch {
      // Leave the original value untouched.
      // Validation will report the type mismatch.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Raw argument recovery                                                      */
/* -------------------------------------------------------------------------- */

function recoverRawArgs(args: Args, def?: ToolDef): void {
  const raw = args._raw;

  if (typeof raw !== 'string' || raw.trim() === '') {
    return;
  }

  const parsed = parseLooseJsonObject(raw);

  if (parsed) {
    delete args._raw;

    for (const [key, value] of Object.entries(parsed)) {
      if (args[key] === undefined) {
        args[key] = value;
      }
    }

    return;
  }

  // A bulk argument is an explicit schema contract.
  const bulkKey = bulkArgKey(def);

  if (bulkKey && isAbsentOrEmpty(args[bulkKey])) {
    args[bulkKey] = raw;
    delete args._raw;
  }
}

function parseLooseJsonObject(text: string): Args | null {
  let body = text.trim();

  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i.exec(body);

  if (fenced) {
    body = fenced[1].trim();
  }

  const candidates = [body, ...extractJsonObjects(body)];

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);

      if (isObject(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next complete JSON object.
    }
  }

  return null;
}

function bulkArgKey(def?: ToolDef): string | null {
  const properties = def?.parameters?.properties ?? {};

  for (const [key, spec] of Object.entries(properties)) {
    if (spec?.bulkArg === true && spec.type === 'string') {
      return key;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validateRequired(
  def: ToolDef,
  args: Args,
): string | null {
  const required = def.parameters?.required ?? [];

  const missing = required.filter((key) => !defined(args[key]));

  if (missing.length === 0) {
    return null;
  }

  for (const key of missing) {
    const nestedLocation = findNestedField(args, key);

    if (nestedLocation) {
      return (
        `Missing required argument(s): ${missing.join(', ')}. ` +
        `'${key}' was found inside '${nestedLocation}', but it must be ` +
        `provided at the top level.`
      );
    }
  }

  return `Missing required argument(s): ${missing.join(', ')}`;
}

function validateRequiredGroups(
  def: ToolDef,
  args: Args,
): string | null {
  const groups = def.parameters?.requiredOneOf ?? [];

  if (groups.length === 0) {
    return null;
  }

  const satisfied = groups.some((group) =>
    group.every((key) => defined(args[key])),
  );

  if (satisfied) {
    return null;
  }

  return `Missing required argument(s): ${describeGroups(groups)}`;
}

function validateArrayItems(
  def: ToolDef,
  args: Args,
): string | null {
  const properties = def.parameters?.properties ?? {};

  for (const [key, spec] of Object.entries(properties)) {
    if (!Array.isArray(args[key]) || !spec.items) {
      continue;
    }

    const items = args[key] as unknown[];

    for (let index = 0; index < items.length; index++) {
      const item = items[index];

      // An array of strings or numbers holds plain values; only an array of objects is checked field by field.
      const itemType = (spec.items as { type?: unknown }).type;
      if (typeof itemType === 'string' && itemType !== 'object') {
        const fits = itemType === 'integer' ? Number.isInteger(item) : typeof item === itemType;
        if (!fits) return `${key}[${index}] must be ${typeWord(itemType)}, received ${kindOf(item)}`;
        continue;
      }

      if (!isObject(item)) {
        // The fields an item carries, from the schema: what to send instead, not only what was wrong.
        const itemSpec = spec.items as { properties?: Record<string, unknown>; required?: string[] };
        const fields = itemSpec.required?.length ? itemSpec.required : Object.keys(itemSpec.properties ?? {});
        return `${key}[${index}] must be an object${fields.length ? ` {${fields.join(', ')}}` : ''}, received ${kindOf(item)}`;
      }

      const itemError = validateObjectSchema(
        def,
        `${key}[${index}]`,
        spec.items,
        item,
      );

      if (itemError) {
        return itemError;
      }
    }
  }

  return null;
}

function validateObjectSchema(
  def: ToolDef,
  prefix: string,
  spec: JsonSchemaProperty,
  value: Args,
): string | null {
  const groups = spec.requiredOneOf ?? [];

  if (
    groups.length > 0 &&
    !groups.some((group) =>
      group.every((key) => defined(value[key])),
    )
  ) {
    return `${prefix}: Missing required argument(s): ${describeGroups(groups)}`;
  }

  const properties = spec.properties ?? {};
  const objectShape =
    spec.type === 'object' && Array.isArray(spec.required) && spec.required.length > 0
      ? `{ ${spec.required.join(', ')} }`
      : '';

  // Required items are checked with `defined`, so values like replace: "" (an explicit delete) satisfy the requirement.
  for (const key of spec.required ?? []) {
    if (!defined(value[key])) {
      if (objectShape) return `${prefix} needs ${objectShape}`;
      const shape = properties[key];
      const itemShape =
        shape && shape.type === 'object' && Array.isArray(shape.required) && shape.required.length > 0
          ? ` — each item needs ${objectShape || `{ ${shape.required.join(', ')} }`}`
          : '';
      return `${prefix}.${key} must be provided${itemShape}`;
    }
  }

  for (const [key, fieldSpec] of Object.entries(properties)) {
    const fieldValue = value[key];

    if (fieldValue === undefined || fieldValue === null) {
      continue;
    }

    const error = validateValue(
      def,
      `${prefix}.${key}`,
      fieldSpec,
      fieldValue,
    );

    if (error) {
      return error;
    }
  }

  return null;
}

function validateProperties(
  def: ToolDef,
  args: Args,
): string | null {
  const properties = def.parameters?.properties ?? {};
  const problems: string[] = [];

  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];

    if (value === undefined || value === null) {
      continue;
    }

    const error = validateValue(def, key, spec, value);

    if (error) {
      problems.push(error);
    }
  }

  return problems.length > 0
    ? `Invalid argument(s): ${problems.join('; ')}`
    : null;
}

function validateValue(
  def: ToolDef,
  key: string,
  spec: JsonSchemaProperty,
  value: unknown,
): string | null {
  if (spec.enum && !spec.enum.includes(value as string)) {
    const optional = !(def.parameters.required ?? []).includes(key);
    return (
      `${key} must be one of: ${spec.enum.join(', ')} ` +
      `(got ${JSON.stringify(value)})${optional ? ` — or leave ${key} out` : ''}`
    );
  }

  if (spec.pathArg === true) {
    const pathError = validatePath(def, key, value);

    if (pathError) {
      return pathError;
    }
  }

  const mismatch = typeMismatch(spec.type, value);

  if (mismatch) {
    return `${key} must be ${typeWord(spec.type)}, received ${mismatch}`;
  }

  if (spec.pattern && typeof value === 'string') {
    let matches = false;
    try {
      matches = new RegExp(spec.pattern).test(value);
    } catch {
      matches = true;
    }
    if (!matches) return `${key} must match ${spec.pattern} (got ${JSON.stringify(value)})`;
  }

  return null;
}

function validatePath(
  def: ToolDef,
  key: string,
  value: unknown,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (value.trim() === '') {
    // An optional path has a default; saying so is the correction, since resending "" is refused again.
    const optional = !(def.parameters?.required ?? []).includes(key);
    return `${def.name} ${key} must name a file or directory — it was empty${optional ? `. Leave ${key} out entirely to use the default (the workspace root)` : ''}`;
  }

  // Validate the ORIGINAL value, not a trimmed copy: a path with stray leading or trailing whitespace would silently diverge from what validation accepted.
  if (value !== value.trim()) {
    return (
      `Invalid ${def.name} ${key}: ${JSON.stringify(value)}. ` +
      `The path has leading or trailing whitespace; no filesystem ` +
      `operation was attempted.`
    );
  }

  if (hasInvalidPathCharacters(value)) {
    return (
      `Invalid ${def.name} ${key}: ${JSON.stringify(value)}. ` +
      `A source path cannot contain control characters.`
    );
  }

  // Do not reject filenames merely because they contain dots.
  if (looksTruncated(value)) {
    return (
      `Invalid ${def.name} ${key}: ${JSON.stringify(value)}. ` +
      `The path appears incomplete. No filesystem operation was attempted.`
    );
  }

  return null;
}

function typeMismatch(
  expected: string | undefined,
  value: unknown,
): string | null {
  const actual = actualType(value);

  switch (expected) {
    case 'string':
      return typeof value === 'string' ? null : actual;

    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : actual;

    case 'integer':
      return typeof value === 'number' &&
        Number.isSafeInteger(value)
        ? null
        : actual;

    case 'boolean':
      return typeof value === 'boolean' ? null : actual;

    case 'array':
      return Array.isArray(value) ? null : actual;

    case undefined:
    case 'object':
      return null;

    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function findNestedField(
  args: Args,
  key: string,
): string | null {
  for (const [property, value] of Object.entries(args)) {
    if (!Array.isArray(value)) {
      continue;
    }

    const found = value.some(
      (item) => isObject(item) && defined(item[key]),
    );

    if (found) {
      return `${property}[i]`;
    }
  }

  return null;
}

function describeGroups(groups: string[][]): string {
  const parts = groups.map((group) => group.join(' and '));

  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `either ${parts.slice(0, -1).join(', ')}, or ${parts.at(-1)}`;
}

function shapeHint(def: ToolDef): string {
  const properties: Record<string, JsonSchemaProperty> =
    def.parameters?.properties ?? {};

  const keys = [
    ...(def.parameters?.required ?? []),
    ...(def.parameters?.requiredOneOf?.[0] ?? []),
  ];

  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of keys) {
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    // Real literals, not "<string>": an angle-bracket placeholder in an example gets stored or
    // passed on verbatim, which is how a memory ends up holding the text "<string>".
    const spec = properties[key];
    const literal = Array.isArray(spec?.enum) && spec.enum.length > 0
      ? JSON.stringify(spec.enum[0])
      : spec?.type === 'number' || spec?.type === 'integer'
        ? '1'
        : spec?.type === 'boolean'
          ? 'true'
          : spec?.type === 'array'
            ? '[]'
            : spec?.type === 'object'
              ? '{}'
              : "'the actual text'";

    parts.push(`"${key}": ${literal}`);
  }

  return `{${parts.join(', ')}}`;
}

function isObject(value: unknown): value is Args {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function defined(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isAbsentOrEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === 'string') {
    return value.trim() === '';
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return false;
}

function actualType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
}

function hasInvalidPathCharacters(path: string): boolean {
  // Do not reject Windows drive paths or normal separators.
  // eslint-disable-next-line no-control-regex -- rejecting control characters in a path is the point
  return /[\u0000-\u001F]/.test(path);
}

function looksTruncated(path: string): boolean {
  // A trailing slash is just a directory ("src/"); only an ellipsis or a dangling dot marks a cut-off name.
  if (path.endsWith('...')) {
    return true;
  }

  // A final segment that ends in a single dot is the classic signature of a model that concatenated or cut off a longer name.
  const start = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  const segment = path.slice(start);

  return (
    segment !== '.' &&
    segment !== '..' &&
    segment.length > 1 &&
    segment.endsWith('.')
  );
}

/** What a value is, in the words a schema error uses. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeWord(typeof value);
}

function typeWord(type: string | undefined): string {
  if (type === 'array' || type === 'object' || type === 'integer') {
    return `an ${type}`;
  }

  return `a ${type ?? 'value'}`;
}
