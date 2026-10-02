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
        if (!fits) return `${key}[${index}] must be a ${itemType}`;
        continue;
      }

      if (!isObject(item)) {
        return `${key}[${index}] must be an object`;
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

function exampleValue(spec: JsonSchemaProperty | undefined): unknown {
  if (!spec || typeof spec !== 'object') {
    return '...';
  }

  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    return spec.enum[0];
  }

  const props = spec.properties ?? {};
  const keys = spec.required ?? Object.keys(props).slice(0, 2);

  if (keys.length > 0) {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const field = props[key];
      if (Array.isArray(field?.enum) && field.enum.length > 0) out[key] = field.enum[0];
      else if (field?.type === 'number' || field?.type === 'integer') out[key] = 1;
      else if (field?.type === 'boolean') out[key] = true;
      else if (field?.type === 'array') out[key] = [];
      else if (field?.type === 'object') out[key] = exampleValue(field);
      else out[key] = '...';
    }
    return out;
  }

  if (spec.type === 'number' || spec.type === 'integer') return 1;
  if (spec.type === 'boolean') return true;
  if (spec.type === 'array') return [];
  if (spec.type === 'object') return {};

  return '...';
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
    // The shape alone leaves the model guessing; naming the keys it did send turns a blind retry
    // into an informed one.
    return `${prefix}: Missing required argument(s): ${describeGroups(groups)}${describeUnmetGroup(groups, value)}`;
  }

  const properties = spec.properties ?? {};
  const objectShape =
    spec.type === 'object' && Array.isArray(spec.required) && spec.required.length > 0
      ? `{ ${spec.required.join(', ')} }`
      : '';

  // Required items are checked with `defined`, so values like replace: "" (an explicit delete) satisfy the requirement.
  for (const key of spec.required ?? []) {
    if (!defined(value[key])) {
      if (objectShape) {
        const example = /\[\d+\]$/.test(prefix) ? ` — e.g. ${JSON.stringify(exampleValue(spec))}` : '';
        return `${prefix} needs ${objectShape}${example}`;
      }
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

/**
 * What the caller actually sent, when none of the accepted groups matched.
 *
 * A model that wrote `old_string` instead of `search` is one rename away from a working call; a
 * message that only restates the required shape leaves it trying the same guess.
 */
/** Longer strings are shown as "…" in a suggested call: repeating the model's text back costs tokens and teaches nothing. */
const SUGGEST_MAX_STRING = 60;

function fitsType(spec: JsonSchemaProperty | undefined, value: unknown): boolean {
  const type = spec?.type;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  return typeof type === 'string' && typeof value === type;
}

/**
 * For a call missing what the schema requires: the keys it sent that the tool does not know, and the call
 * rebuilt from its own arguments — the required group closest to what it sent, filled from its values where
 * exactly one unknown key holds the right type. A suggestion for the model; nothing is rewritten or run.
 */
export function suggestCall(def: ToolDef, args: Record<string, unknown>): string | null {
  const top = suggestFor(def.name, def.parameters ?? {}, args);
  if (top) return top;
  // The call itself is whole; the first array item missing what its schema requires gets the same treatment.
  for (const [key, spec] of Object.entries(def.parameters?.properties ?? {})) {
    const items = spec?.items as JsonSchemaProperty | undefined;
    if (!Array.isArray(args[key]) || items?.type !== 'object') continue;
    const list = args[key] as unknown[];
    for (let i = 0; i < list.length; i++) {
      if (!isObject(list[i])) continue;
      const found = suggestFor(`${key}[${i}]`, items, list[i] as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}

type ObjectShape = { properties?: Record<string, JsonSchemaProperty>; required?: string[]; requiredOneOf?: string[][] };

function suggestFor(name: string, shape: ObjectShape, args: Record<string, unknown>): string | null {
  const properties = shape.properties ?? {};
  const sent = Object.keys(args).filter((key) => !key.startsWith('_') && defined(args[key]));
  const unknown = sent.filter((key) => !(key in properties));

  const missingRequired = (shape.required ?? []).filter((key) => !defined(args[key]));
  const groups = shape.requiredOneOf ?? [];
  const groupMet = groups.length === 0 || groups.some((group) => group.every((key) => defined(args[key])));
  let groupMissing: string[] = [];
  let choice = '';
  if (!groupMet) {
    // The group sharing the most keys with the call is the form it was reaching for. When it shares none,
    // nothing says which form was meant, so the forms are listed rather than one picked for it.
    const score = (group: string[]) => group.filter((key) => defined(args[key])).length;
    const closest = groups.reduce((best, group) => (score(group) > score(best) ? group : best), groups[0]);
    if (score(closest) > 0) groupMissing = closest.filter((key) => !defined(args[key]));
    else choice = `one of ${groups.map((group) => group.join(' + ')).join(', ')}`;
  }
  const missing = [...new Set([...missingRequired, ...groupMissing])];
  if (missing.length === 0 && !choice) return null;

  const call: Record<string, unknown> = {};
  for (const key of sent) if (key in properties) call[key] = args[key];
  const moved: string[] = [];
  const stillMissing: string[] = [];
  const taken = new Set<string>();
  for (const key of missing) {
    const candidates = unknown.filter((u) => !taken.has(u) && fitsType(properties[key], args[u]));
    if (candidates.length === 1) {
      call[key] = args[candidates[0]];
      taken.add(candidates[0]);
      moved.push(`${key} takes what you sent as ${candidates[0]}`);
    } else {
      // Nothing of its own fits: say what the key wants, never a stand-in value the model might send back as is.
      stillMissing.push(describeKey(key, properties[key]));
    }
  }

  const parts = [
    unknown.length > 0 ? `${name} has no parameter ${unknown.join(', ')}.` : '',
    stillMissing.length > 0 || choice ? `Missing: ${[...stillMissing, choice].filter(Boolean).join('; ')}.` : '',
  ];
  if (moved.length > 0) {
    let shortened = false;
    const shown = JSON.stringify(call, (_key, value) => {
      if (typeof value === 'string' && value.length > SUGGEST_MAX_STRING) {
        shortened = true;
        return '…';
      }
      return value;
    });
    parts.push(`Resend as ${shown}${stillMissing.length > 0 ? ' plus the missing values' : ''} — ${moved.join('; ')}${shortened ? ' ("…" stands for your full text)' : ''}.`);
  }
  return parts.filter(Boolean).join(' ');
}

/** A key as the schema describes it: its choices, or the first sentence of its description. */
function describeKey(key: string, spec: JsonSchemaProperty | undefined): string {
  if (Array.isArray(spec?.enum) && spec.enum.length > 0) return `${key} (one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')})`;
  const about = String(spec?.description ?? '').split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  return about ? `${key} (${spec?.type ?? 'value'}: ${about})` : key;
}

function describeUnmetGroup(groups: string[][], value: Args): string {
  const sent = Object.keys(value).filter((key) => defined(value[key]));
  if (sent.length === 0) {
    return '';
  }
  const unwanted = new Set(groups.flat());
  const unused = sent.filter((key) => !unwanted.has(key));
  return unused.length > 0 ? ` It sent ${unused.join(', ')}.` : '';
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

function typeWord(type: string | undefined): string {
  if (type === 'array' || type === 'object' || type === 'integer') {
    return `an ${type}`;
  }

  return `a ${type ?? 'value'}`;
}
