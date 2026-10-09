import type { ToolResult, ToolResultKind, ToolErrorCode } from './tool/core/tool-result';
import type { ToolContext } from './tool/execution/context';

export interface Message {
  /** Stable identity for merge/dedupe when the conversation is saved. */
  id?: string;
  role: import('./protocol.ts').Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * What the model reasoned before asking for these tool calls. Sent back while its turn lasts: a model that thinks
   * (gpt-oss, qwen3) otherwise starts every step without the plan it made on the one before.
   */
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  type: typeof import('./protocol.ts').TOOL_CALL_TYPE;
  function: { name: string; arguments: Record<string, unknown>; };
}

export type { ToolResult, ToolResultKind, ToolErrorCode };

/** What an answer to a question may look like, for a question that has a grammar. */
export interface AskOptions {
  accepts?: (answer: string) => boolean;
  signal?: AbortSignal;
  /** Markdown shown above the question (a plan to approve), so the question itself stays one short line. */
  detail?: string;
}

export type { ToolContext, ToolContextInput } from './tool/execution/context';

/** What kind of work a tool does. The only grouping the model sees before it asks for a schema. */
export type ToolCategory = 'filesystem' | 'search' | 'process' | 'git' | 'web' | 'agent';

export type ToolProfileName = 'core' | 'planning';

export interface ToolDef {
  name: string;
  /**
   * The profiles that offer this tool: core (the compact set), planning (the read-only set of Ask and Review modes).
   * A tool in none is offered only by the full profile.
   */
  profiles?: readonly ToolProfileName[];
  /** Other names a model calls this tool by ("cat" for read_file); matched like the name itself. */
  aliases?: readonly string[];
  /** Other spellings of this tool's arguments, alias → parameter ("file_path" → "path"). */
  argAliases?: Readonly<Record<string, string>>;
  label?: string;
  description: string;
  brief?: string;
  /** The index groups tools by this so a model can pick a capability without every schema. */
  category?: ToolCategory;
  /** What the loader shows while the tool runs, e.g. "Reading a file". */
  activity?: string;
  risky?: boolean;
  /** False for a tool that may need approval (it runs project scripts) but never writes files: look-only modes allow it. */
  writesFiles?: boolean;
  /** The call writes file *contents*, so its pre-image is worth copying for the session's `/undo` ledger. */
  restorable?: boolean;
  parameters: JsonSchema;
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult>;
  preview?: (args: any) => string;
  /** Whether this call changes something (and so needs approval); `where` is where it would run. */
  isRisky?: (args: any, where?: { cwd?: string; root?: string; cmd?: import('./tool/policy/mutation-policy.ts').CommandClassify }) => boolean | Promise<boolean>;
  /** Would this call fail before it changed anything? */
  cannotRun?: (args: any, ctx: ToolContext) => Promise<ToolResult | null>;
  /** It runs the project's code (a build, the tests, the program), so running it after a change is checking that change. */
  runsCode?: boolean;
  /** The argument that carries a shell command; the session's shell refusals and danger checks read the command from it. */
  shellCommand?: string;
  /** What this call would destroy that no standing approval may cover, or null. */
  dangerReason?: (args: any, where: { cwd: string; root: string }) => string | null;
  /**
   * A group whose own "always" is the only standing approval that covers this tool (an MCP server's tools). The session's
   * "always allow routine changes" does not: the server says the tool changes things ocode cannot see.
   */
  grantGroup?: string;
  /** Why this call is asked about every time, even after "always allow" — recoverable but consequential (deletes, git writes). */
  /** `state` is the session's, when the asker has it: what a call would do can depend on it (the working project). */
  confirmReason?: (args: any, where: { cwd: string; root: string; state?: any }) => string | null;
  /** The files this call would rewrite and what each would hold after: new text, null when deleted, undefined when it cannot lose content. */
  wouldWrite?: (args: any) => Array<{ path: string; after: (before: string, rel: string) => string | null | undefined }>;
  /** It writes a finished output (a PDF, a spreadsheet), not project code, so its own result is the check and no build or test run is owed. */
  outputOnly?: boolean;
  /** This call changes nothing the calls beside it read, so it may run at the same time as them when one reply asks for several. */
  concurrent?: (args: any) => boolean;
  /** It records the turn's task list, so a successful call is the model committing to finish that list this turn. */
  tracksTasks?: boolean;
  /** Its answer changes without the workspace changing (a running job's status), so asking again is not a repeat. */
  changesOnItsOwn?: boolean;
  /** Only reads the workspace: the same call, with nothing changed since it ran, returns the same result. */
  readOnly?: boolean;
}

/** A tool as the *model* sees it — the wire shape `getToolDefs()` produces and every provider translates from. */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  // One alternative must hold; each inner array needs ALL its keys.
  requiredOneOf?: string[][];
}

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  pattern?: string;
  enum?: string[];
  default?: unknown;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  requiredOneOf?: string[][];
  items?: JsonSchemaProperty;
  pathArg?: boolean;
  /** Carries a whole-file payload, so a cut-off call must shrink rather than repeat; stripped before going on the wire. */
  bulkArg?: boolean;
}

export interface ProviderDetect {
  available: boolean;
  detail: string;
  base?: string;
}

export interface StreamChatParams {
  model: string;
  messages: Message[];
  tools?: any[];
  signal?: AbortSignal;
  onDelta?: (delta: string, full: string) => void;
  onReasoning?: (delta: string, full: string) => void;
  sampling?: SamplingOptions;
}

export interface SamplingOptions {
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  keepAlive?: string;
  think?: boolean;
}

export interface StreamChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** The reasoning the reply carried, whatever channel it arrived on. */
  reasoning?: string;
  finishReason?: import('./protocol.ts').FinishReason;
  usage?: { promptTokens?: number; completionTokens?: number; };
  metrics?: { promptMs?: number; genMs?: number; loadMs?: number; promptTokensPerSec?: number; genTokensPerSec?: number; };
}

export interface ProviderDef {
  id: string;
  label: string;
  detect: () => Promise<ProviderDetect>;
  ensureAuth: (opts?: { interactive?: boolean; token?: string; }) => Promise<boolean>;
  listModels: () => Promise<{ name: string; size?: number; }[]>;
  streamChat: (p: StreamChatParams) => Promise<StreamChatResult>;
  tokenEnvVar?: string;
}

/** A command that takes the files to work on after its own arguments, and the kinds of file it reads. */
export interface FileScopedCommand {
  argv: string[];
  extensions: string[];
}

export interface StackInfo {
  id: string;
  label: string;
  root: string;
  /** A Node project written in TypeScript. */
  typescript?: boolean;
  /** The front-end frameworks it uses, by name (Next.js, Angular …); see env/frameworks.ts. */
  frameworks?: string[];
  test?: string[];
  build?: string[];
  /** The fastest command that proves the code still compiles or parses, without running the app. */
  check?: string[];
  run?: string[];
  dev?: string[];
  lint?: string[];
  /** Verbs whose command also takes files: a check after an edit runs on only the changed files with these extensions. */
  fileScoped?: Partial<Record<import('./env/languages/types.ts').Verb, FileScopedCommand>>;
  marker?: string;
}

export interface Diagnostic {
  file: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'failure';
  message: string;
  code?: string;
  project?: string;
  /** Machine-readable shape, tagged by the language parser that owns the format (see `env/languages.ts`). */
  kind?: string;
  symbol?: string;
}

export interface RuntimeInfo {
  name: string;
  available: boolean;
  version?: string;
  command?: string;
  pathRefresh?: boolean;
}

export interface ProviderRuntime {
  name: string;
  commands: string[] | ((platform: string) => string[]);
  args?: string[];
}

export interface ToolchainProvider {
  id: string;
  label: string;
  runtimes: ProviderRuntime[];
  searchPaths?: string[];
}

export {};
