// marked-terminal ships no types. It is consumed here through one narrow surface:
// a factory returning a marked extension whose renderer methods we wrap.
declare module 'marked-terminal' {
  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>
  ): { renderer: Record<string, (...args: any[]) => string>; useNewRenderer?: boolean; };
}
