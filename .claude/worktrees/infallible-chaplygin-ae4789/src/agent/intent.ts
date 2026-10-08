/**
 * What a continuing turn records as the person's message. The turn continues because the person chose
 * /continue (or the paused-plan prompt), never because of how a message is worded; this text is only how
 * that choice reads in the conversation, and how saved history recognises it.
 */
export const CONTINUE_INPUT = 'continue';

/** A message a continuing turn recorded, as opposed to anything the person wrote. */
export function isContinueInput(text: unknown): boolean {
  return typeof text === 'string' && text.trim() === CONTINUE_INPUT;
}

/** "playwright-mcp", "@playwright/mcp": the name is glued to the marker. */
const GLUED_MCP = /^@?([\w.+]+(?:[-.][\w.+]+)*?)[/-]mcp$/;

/** The MCP servers a request asks for by name: a configured server named alongside "mcp", or any "name-mcp" / "@name/mcp". */
export function namedMcpServers(text: string | undefined, configured: readonly string[] = []): string[] {
  const words = String(text ?? '').toLowerCase().match(/[@\w][\w@/.+-]*/g);
  if (!words) return [];
  const names = new Set<string>();
  for (const word of words) {
    const glued = GLUED_MCP.exec(word)?.[1];
    if (glued && !/^\d+$/.test(glued)) names.add(glued);
  }
  // Configured names are explicit enough to recognize without requiring the user to say "MCP".
  // This lets "use sequential thinking" load the deferred sequential-thinking tools.
  const phrase = String(text ?? '').toLowerCase().replace(/[-_]+/g, ' ');
  for (const name of configured) {
    const normalized = name.toLowerCase().replace(/[-_]+/g, ' ');
    if (phrase.includes(normalized) || words.includes(name.toLowerCase())) names.add(name.toLowerCase());
  }
  return [...names];
}
