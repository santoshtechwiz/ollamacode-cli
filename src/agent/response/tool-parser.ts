type ToolCallShape = {
  name: string;
  args: Record<string, unknown>;
};

type JsonSpan = {
  start: number;
  end: number;
  value: string;
};

const TOOL_NAME_KEYS = ['name', 'tool', 'tool_name', 'action'] as const;
const ARG_KEYS = ['arguments', 'parameters', 'args', 'input', 'params', 'tool_input'] as const;

const TOOL_WRAPPER_TAG =
  /^<\/?\s*tool[_-]?(call|calls|request|use|invoke)s?\s*\/?>$/i;

/** Extract balanced JSON objects from text. */
function extractJsonObjectSpans(text: string): JsonSpan[] {
  const source = String(text ?? '');
  const spans: JsonSpan[] = [];

  let i = 0;

  while (i < source.length) {
    if (source.charCodeAt(i) !== 123) {
      i += 1;
      continue;
    }

    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;

    for (; i < source.length; i += 1) {
      const ch = source[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === '\\') {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = false;
        }

        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        depth += 1;
        continue;
      }

      if (ch === '}') {
        depth -= 1;

        if (depth === 0) {
          const end = i + 1;

          spans.push({
            start,
            end,
            value: source.slice(start, end),
          });

          i = end;
          closed = true;
          break;
        }
      }
    }

    // An unterminated object should not cause the scanner to repeatedly rescan the remainder of the response.
    if (!closed) {
      break;
    }
  }

  return spans;
}

export function extractJsonObjects(text: string): string[] {
  return extractJsonObjectSpans(String(text ?? '')).map((span) => span.value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value),
  );
}

function coerceArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === 'string') {
    const raw = value.trim();

    if (!raw) {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(raw);

      if (isRecord(parsed)) {
        return parsed;
      }

      return { _raw: value };
    } catch {
      return { _raw: value };
    }
  }

  if (isRecord(value)) {
    return value;
  }

  return {};
}

function getArgumentValue(
  object: Record<string, unknown>,
): unknown {
  for (const key of ARG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      return object[key];
    }
  }

  return undefined;
}

function getFunctionShape(
  value: unknown,
): ToolCallShape | null {
  if (!isRecord(value)) {
    return null;
  }

  const name =
    typeof value.name === 'string'
      ? value.name.trim()
      : '';

  if (!name) {
    return null;
  }

  return {
    name,
    args: coerceArgs(
      value.arguments ??
        value.parameters ??
        value.input,
    ),
  };
}

function asToolCallShape(
  obj: unknown,
): ToolCallShape | null {
  if (!isRecord(obj)) {
    return null;
  }

  // OpenAI-style: { "function": { "name": "...", "arguments": {...} } }
  if (Object.prototype.hasOwnProperty.call(obj, 'function')) {
    const functionShape = getFunctionShape(obj.function);

    if (functionShape) {
      return functionShape;
    }
  }

  // Direct tool shape: { "name": "read_file", "arguments": {...} }
  let name = '';

  for (const key of TOOL_NAME_KEYS) {
    const value = obj[key];

    if (typeof value === 'string' && value.trim()) {
      name = value.trim();
      break;
    }
  }

  // "type" is intentionally NOT treated as a generic tool name.
  if (!name) {
    return null;
  }

  return {
    name,
    args: coerceArgs(getArgumentValue(obj)),
  };
}

function parseJson(
  text: string,
): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Text that opens a tool call written out as text, whole or cut off part way: a wrapper tag, a function tag, or a
 * call object. A reply like that is a call that never arrived, not an answer.
 */
export function startsToolCall(text: string): boolean {
  const head = String(text ?? '').trimStart();
  const first = head.split('\n', 1)[0].trim();
  return TOOL_WRAPPER_TAG.test(first)
    || /^<function[=\s>]/i.test(first)
    || /^(?:```(?:json)?\s*)?\{\s*"(?:name|tool_calls|function)"\s*:/.test(head);
}

export function isToolCallLine(
  line: string,
): boolean {
  const trimmed = String(line ?? '').trim();

  if (!trimmed) {
    return false;
  }

  if (TOOL_WRAPPER_TAG.test(trimmed)) {
    return true;
  }

  // A line must contain exactly one JSON document.
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }

  const parsed = parseJson(trimmed);

  if (parsed === null) {
    return false;
  }

  return isToolCallObject(parsed);
}

function isToolCallObject(
  obj: unknown,
): boolean {
  if (asToolCallShape(obj) !== null) {
    return true;
  }

  if (isRecord(obj) && Array.isArray(obj.tool_calls)) {
    return obj.tool_calls.length > 0 &&
      obj.tool_calls.every(
        (entry) => asToolCallShape(entry) !== null,
      );
  }

  return false;
}

export function isToolCallBlock(
  block: string,
): boolean {
  const raw = String(block ?? '').trim();

  if (!raw) {
    return false;
  }

  const fenceMatch =
    /^```([a-zA-Z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)```$/.exec(raw);

  const inner = fenceMatch
    ? fenceMatch[2].trim()
    : raw;

  if (!inner) {
    return false;
  }

  // A complete tool-call block can be: {"name":"...","arguments":{...}} or: {"tool_calls":[...]}
  const parsed = parseJson(inner);

  if (parsed !== null) {
    return isToolCallObject(parsed);
  }

  // Also support multiple JSON tool-call objects inside a block.
  const spans = extractJsonObjectSpans(inner);

  if (spans.length === 0) {
    return false;
  }

  let cursor = 0;

  for (const span of spans) {
    const between = inner.slice(
      cursor,
      span.start,
    );

    if (between.trim()) {
      return false;
    }

    const object = parseJson(span.value);

    if (
      object === null ||
      !isToolCallObject(object)
    ) {
      return false;
    }

    cursor = span.end;
  }

  return !inner.slice(cursor).trim();
}
