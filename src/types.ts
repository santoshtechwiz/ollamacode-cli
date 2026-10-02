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
}

export type { ToolContext, ToolContextInput } from './tool/execution/context';

/** What kind of work a tool does. The only grouping the model sees before it asks for a schema. */
export type ToolCategory = 'filesystem' | 'search' | 'process' | 'git' | 'web' | 'agent';

export type ToolProfileName = 'core' | 'planning' | 'always';

export interface ToolDef {
  name: string;
  /**
   * The profiles that offer this tool: core (the compact set), planning (plan mode's read-only set),
   * always (schema sent on every request). A tool in none is offered only by the full profile.
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
  /** The call writes file *contents*, so its pre-image is worth copying for the session's `/undo` ledger. */
  restorable?: boolean;
  parameters: JsonSchema;
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult>;
  preview?: (args: any) => string;
  isRisky?: (args: any) => boolean | Promise<boolean>;
  /** Would this call fail before it changed anything? */
  cannotRun?: (args: any, ctx: ToolContext) => Promise<ToolResult | null>;
  /** Its result can change while the project stays the same (time, processes, the person), so a repeat always runs. */
  volatile?: boolean;
  /** It runs the project's code (a build, the tests, the program), so running it after a change is checking that change. */
  runsCode?: boolean;
  /** The argument that carries a shell command; the session's shell refusals and danger checks read the command from it. */
  shellCommand?: string;
  /** What this call would destroy that no standing approval may cover, or null. */
  dangerReason?: (args: any, where: { cwd: string; root: string }) => string | null;
  /** Why this call is asked about every time, even after "always allow" — recoverable but consequential (deletes, git writes). */
  confirmReason?: (args: any, where: { cwd: string; root: string }) => string | null;
  /** The files this call would rewrite and what each would hold after: new text, null when deleted, undefined when it cannot lose content. */
  wouldWrite?: (args: any) => Array<{ path: string; after: (before: string, rel: string) => string | null | undefined }>;
  /** It writes a finished output (a PDF, a spreadsheet), not project code, so its own result is the check and no build or test run is owed. */
  outputOnly?: boolean;
  /** A key for what a successful result found; two calls with different args but the same key found nothing new. */
  resultKey?: (result: ToolResult) => string | undefined;
  /** It records the turn's task list, so a successful call is the model committing to finish that list this turn. */
  tracksTasks?: boolean;
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

export interface StackInfo {
  id: string;
  label: string;
  root: string;
  test?: string[];
  build?: string[];
  run?: string[];
  dev?: string[];
  lint?: string[];
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

export interface PlanTask {
  index: number;
  text: string;
  status: import('./protocol.ts').TaskStatus;
  fileOp?: string | null;
  filePath?: string | null;
  runCommand?: string | null;
  reason?: string;
  dependencies?: number[];
  verify?: string | null;
  attempts?: number;
  lastError?: string;
  /** Every diagnostic the task collected, oldest first: block reasons and recovery notes alike. */
  recoveryNotes?: string[];
  diagnostic?: { file?: string; line?: number | null; message?: string; } | null;
  /** Nothing a tool call does can ever tick this step off. */
  untrackable?: boolean;
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

export interface InstallSpec {
  strategy: string;
  packageId?: string;
  package?: string;
  formula?: string;
  cask?: boolean;
  args?: string[];
}

export interface ToolchainProvider {
  id: string;
  label: string;
  runtimes: ProviderRuntime[];
  searchPaths?: string[];
  install?: { strategies: InstallSpec[]; hint?: string; };
  installHint?: string;
}

export interface InstallStrategy {
  id: string;
  label: string;
  os: string[];
  isAvailable: () => Promise<boolean>;
  render: (spec: InstallSpec, platform: string) => { command: string; };
}

export {};
