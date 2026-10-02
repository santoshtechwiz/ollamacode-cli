import type { ToolResult } from '../../types';

/** A tool result's text: status line, then what the tool reported; the length budget is `compressToolOutput`'s. */
export function renderToolResult(result: ToolResult, toolName = ''): string {
  const text = renderBody(result, toolName);
  if (!result.modelNote) return text;
  // Right under the status line, where trimming a long output cannot cut it.
  const [head, ...rest] = text.split('\n');
  return [head, result.modelNote, ...rest].join('\n');
}

function renderBody(result: ToolResult, toolName: string): string {
  const label = toolName ? ` ${toolName}` : '';

  if (!result.ok) {
    if (result.code === 'ENOTVERIFIED') {
      const head = `ERROR${label} [ENOTVERIFIED] — the repository state does not verify this action.`;
      const rest = result.hint ? `Hint: ${result.hint}` : '';
      return rest ? `${head}\n${rest}` : head;
    }

    const head = `ERROR${label}${result.code ? ` [${result.code}]` : ''} — ${String(result.error ?? 'failed').split('\n')[0]}`;
    const rest = [
      String(result.error ?? '').split('\n').slice(1).join('\n'),
      result.hint ? `Hint: ${result.hint}` : '',
      result.display,
    ]
      .filter(Boolean)
      .join('\n');
    return rest ? `${head}\n${rest}` : head;
  }

  const display = result.display || '(no output)';
  // For backward compatibility with tests expecting raw display
  const isSimpleDisplay = !display.includes('\n') && !display.includes(' — ');
  if (isSimpleDisplay) {
    return display;
  }
  const [first, ...others] = display.split('\n');
  const head = `OK${label} — ${first}`;
  return others.length ? `${head}\n${others.join('\n')}` : head;
}
