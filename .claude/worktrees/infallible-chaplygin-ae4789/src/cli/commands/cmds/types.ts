export const CmdCategory = Object.freeze({
  CORE: 'core',
  AGENT: 'agent',
  WORKSPACE: 'workspace',
  TOOLS: 'tools',
  SETTINGS: 'settings',
  ADVANCED: 'advanced',
});

export type CmdCategoryName = (typeof CmdCategory)[keyof typeof CmdCategory];

export const CmdResult = Object.freeze({
  HANDLED: true,
  EXIT: 'exit',
  UNHANDLED: false,
});

/** Minimal context every slash-command receives. */
export interface CmdContext {
  write(text: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export type CommandEntry = { name: string; aliases: string[]; category: CmdCategoryName; description: string; arg?: string; hidden?: boolean; more?: boolean; needsThinking?: boolean; usage: string; details: string; run: (ctx: CmdContext, arg: string) => Promise<boolean | 'exit'>; };
