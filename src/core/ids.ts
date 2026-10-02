import { TOOL_CALL_TYPE } from '../protocol';

let counter = 0;

function newToolCallId(): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `call_${counter.toString(36)}${rand}`;
}

/** Stable message identity for save merges. */
export function newId(): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `m_${counter.toString(36)}${rand}`;
}

// One user request id, preserved across retries and resumes.
export function newTaskId(): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `t_${counter.toString(36)}${rand}`;
}

const TEMPLATE_TOKEN = /<\|[a-z_]+\|>/i;
/** Harmony (gpt-oss) addresses every tool inside the `functions` namespace; the name after it is the tool. */
const HARMONY_NAMESPACE = /^functions[./]/;

/** Chat-template text in a name (gpt-oss harmony: `…<|channel|>commentary to=functions.exec_shell`) keeps only the addressed recipient, when there is one. */
function cleanToolName(name: string): string {
  if (TEMPLATE_TOKEN.test(name)) {
    const to = /\bto=([\w./-]+)/.exec(name);
    if (!to) return name;
    name = to[1];
  }
  return name.replace(HARMONY_NAMESPACE, '');
}

export function normalizeToolCall(call: { id?: string; type?: string; function?: { name?: string; arguments?: unknown; }; }): import('../types.ts').ToolCall {
  const name = cleanToolName(call?.function?.name ?? '');
  const rawArgs = call?.function?.arguments;

  let args = {};
  if (typeof rawArgs === 'string') {
    // Empty text is the empty call.
    const text = rawArgs.trim();
    if (text === '') {
      args = {};
    } else {
      try {
        const parsed = JSON.parse(rawArgs);
        args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _raw: rawArgs };
      } catch {
        args = { _raw: rawArgs };
      }
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = (rawArgs as Record<string, unknown>);
  }

  return {
    id: call?.id || newToolCallId(),
    type: TOOL_CALL_TYPE,
    function: { name, arguments: args },
  };
}

