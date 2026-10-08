import { RESULT_TAGS, extractTagged } from './tags';
import { createChannelParser } from './channel-parser';

const RESULT_LINE = /^\s*(OK|ERROR)\s+([a-z_][a-z0-9_]*)\s*(?:\[[A-Z_]+\])?\s*[—-]\s/i;

const TOOL_RESULT_JSON = /["']tool_result["']\s*:\s*["'](OK|ERROR|FAILED)\b/i;

export function findFabricatedResults(text: string, isKnownTool: (name: string) => boolean = () => true): string[] {
  const hits: any[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = RESULT_LINE.exec(line);
    if (match && isKnownTool(match[2])) {
      hits.push(line.trim());
      continue;
    }
    if (TOOL_RESULT_JSON.test(line)) hits.push(line.trim());
  }
  return hits;
}

function isContraband(message: { role?: string; content?: unknown; }, isKnownTool: (name: string) => boolean = () => true): boolean {
  if (!message || message.role !== 'assistant') return false;
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content) return false;
  return extractTagged(content, RESULT_TAGS).found || findFabricatedResults(content, isKnownTool).length > 0;
}

/** An assistant turn whose text is nothing but reasoning tags and made no calls: there is no answer in it to send back. */
function isTagOnlyReply(message: { role?: string; content?: unknown; tool_calls?: unknown[]; }): boolean {
  if (message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  const parser = createChannelParser();
  return !`${parser.push(message.content).answer}${parser.flush().answer}`.trim();
}

function isUnsafeToRestore(message: { role?: string; content?: unknown; }, isKnownTool: (name: string) => boolean = () => true): boolean {
  if (isContraband(message, isKnownTool)) return true;
  // A reply is judged by the harness's own shapes (result lines, tags), never by what its prose seems to say.
  return isTagOnlyReply(message);
}

export function sanitizeMessages<T>(messages: T[], isKnownTool: (name: string) => boolean = () => true): { messages: T[]; removed: number; } {
  const kept = (messages ?? []).filter((m) => !isUnsafeToRestore(m as any, isKnownTool));
  return { messages: kept, removed: (messages?.length ?? 0) - kept.length };
}

