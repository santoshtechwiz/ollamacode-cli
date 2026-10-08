/** Single shared protocol surface: error codes, roles, states, storage keys, limits, tools, thinking, turn results. */

export const TOOL_ERROR_CODE = Object.freeze({
  ENOENT: 'ENOENT',
  EACCES: 'EACCES',
  EISDIR: 'EISDIR',
  ENOTDIR: 'ENOTDIR',
  ESCAPE: 'ESCAPE',
  EINVAL: 'EINVAL',
  ETIMEDOUT: 'ETIMEDOUT',
  EDENIED: 'EDENIED',
  EAMBIGUOUS: 'EAMBIGUOUS',
  ENOTREPO: 'ENOTREPO',
  ETOOLARGE: 'ETOOLARGE',
  ECANCELLED: 'ECANCELLED',
  EUNKNOWN: 'EUNKNOWN',
  EEXIST_FILE: 'EEXIST_FILE',
  EISDIR_INTENT: 'EISDIR_INTENT',
  ENOMATCH: 'ENOMATCH',
  EBADRESULT: 'EBADRESULT',
  EBADSHELL: 'EBADSHELL',
  ENOCHANGE: 'ENOCHANGE',
  EEXIT: 'EEXIT',
  ESKIPPED: 'ESKIPPED',
  ENOTTY: 'ENOTTY',
  EBLOCKED: 'EBLOCKED',
  EUNPLANNED: 'EUNPLANNED',
  ESCOPE: 'ESCOPE',
  EBUSY: 'EBUSY',
  EPERM: 'EPERM',
  EAGAIN: 'EAGAIN',
  EMFILE: 'EMFILE',
  ENFILE: 'ENFILE',
  ETXTBSY: 'ETXTBSY',
  ENOTSUPPORTED: 'ENOTSUPPORTED',
  ENOTVERIFIED: 'ENOTVERIFIED',
  EREVIEW: 'EREVIEW',
  EPOLICY: 'EPOLICY',
  EINTERNAL: 'EINTERNAL',
});

export type ToolErrorCode = typeof TOOL_ERROR_CODE[keyof typeof TOOL_ERROR_CODE];

/** The result contract every tool produces and every consumer reads. */
export const TOOL_RESULT_STATUS = Object.freeze({
  /** The operation performed and its post-condition was confirmed. */
  SUCCESS: 'SUCCESS',
  /** The operation did not happen, or happened wrongly. */
  FAILED: 'FAILED',
  /** Part of the intended work happened and part did not. */
  PARTIAL: 'PARTIAL',
  /** The call was refused or never attempted (a gate, approval or scope). */
  BLOCKED: 'BLOCKED',
  /** The target was absent: a read of a missing file, a delete of an already-gone one. */
  NOT_FOUND: 'NOT_FOUND',
  /** The operation ran but its effect could not be verified afterwards. */
  NOT_VERIFIED: 'NOT_VERIFIED',
});

export type ToolResultStatus = typeof TOOL_RESULT_STATUS[keyof typeof TOOL_RESULT_STATUS];

const CODE_TO_RESULT_STATUS: Record<string, ToolResultStatus> = {
  [TOOL_ERROR_CODE.ENOENT]: TOOL_RESULT_STATUS.NOT_FOUND,
  [TOOL_ERROR_CODE.ENOTVERIFIED]: TOOL_RESULT_STATUS.NOT_VERIFIED,
};

/** The status a result acquires from its code alone. */
export function statusForCode(code: ToolErrorCode | string | undefined): ToolResultStatus | null {
  if (!code) return null;
  return CODE_TO_RESULT_STATUS[code] ?? TOOL_RESULT_STATUS.FAILED;
}

export const PROVIDER_ERROR_CODE = Object.freeze({
  ETIMEDOUT: 'ETIMEDOUT',
  ECANCELLED: 'ECANCELLED',
  ECONTEXT_OVERFLOW: 'ECONTEXT_OVERFLOW',
  ETOOLS_UNSUPPORTED: 'ETOOLS_UNSUPPORTED',
  ETRUNCATED: 'ETRUNCATED',
  ENOSTREAM: 'ENOSTREAM',
  EQUOTA: 'EQUOTA',
  EPROVIDER_INVALID: 'EPROVIDER_INVALID',
  EPROVIDER_UNKNOWN: 'EPROVIDER_UNKNOWN',
  EPROVIDER_UNAVAILABLE: 'EPROVIDER_UNAVAILABLE',
  EPROVIDER_NONE: 'EPROVIDER_NONE',
  ENOMODELS: 'ENOMODELS',
});

export const CLI_ERROR_CODE = Object.freeze({
  EINVAL: 'EINVAL',
  ENOENT: 'ENOENT',
  EUNKNOWN: 'EUNKNOWN',
  ETOOL_INVALID: 'ETOOL_INVALID',
});

export const NOT_ATTEMPTED_CODES: readonly ToolErrorCode[] = Object.freeze([
  TOOL_ERROR_CODE.EINVAL,
  TOOL_ERROR_CODE.EBLOCKED,
  TOOL_ERROR_CODE.EUNPLANNED,
  TOOL_ERROR_CODE.EDENIED,
  TOOL_ERROR_CODE.ESKIPPED,
  TOOL_ERROR_CODE.ECANCELLED,
  TOOL_ERROR_CODE.ESCOPE,
  TOOL_ERROR_CODE.ESCAPE,
  TOOL_ERROR_CODE.EREVIEW,
  TOOL_ERROR_CODE.EPOLICY,
]);

/** Not-attempted codes a gate decided, so an identical retry is refused the same way; `EINVAL` is the model's to fix, so it is not here. */
const GATE_REFUSAL_CODES: readonly ToolErrorCode[] = Object.freeze([
  TOOL_ERROR_CODE.EPOLICY,
  TOOL_ERROR_CODE.EDENIED,
  TOOL_ERROR_CODE.EBLOCKED,
  TOOL_ERROR_CODE.EUNPLANNED,
  TOOL_ERROR_CODE.EREVIEW,
  TOOL_ERROR_CODE.ESCOPE,
  TOOL_ERROR_CODE.ESCAPE,
]);

export function isGateRefusal(code: ToolErrorCode | string | undefined): boolean {
  if (!code) return false;
  return GATE_REFUSAL_CODES.includes(code as ToolErrorCode);
}

for (const code of NOT_ATTEMPTED_CODES) {
  CODE_TO_RESULT_STATUS[code] = TOOL_RESULT_STATUS.BLOCKED;
}

const TRANSIENT_CODES: readonly ToolErrorCode[] = Object.freeze([
  TOOL_ERROR_CODE.EBUSY,
  TOOL_ERROR_CODE.EAGAIN,
  TOOL_ERROR_CODE.EMFILE,
  TOOL_ERROR_CODE.ENFILE,
  TOOL_ERROR_CODE.ETXTBSY,
  TOOL_ERROR_CODE.EPERM,
]);

/** Whether a failed call is worth one automatic retry (never ran to completion). */
export function isTransient(code: ToolErrorCode | string | undefined): boolean {
  return TRANSIENT_CODES.includes(code as ToolErrorCode);
}

/** Failure kinds: actionable categories that determine what correction to give and whether a retry is semantically redundant. */
export const FAILURE_KIND = Object.freeze({
  NOT_FOUND: 'not-found',
  PERMISSION: 'permission',
  EXISTS: 'exists',
  IS_DIR: 'is-dir',
  NOT_DIR: 'not-dir',
  IS_DIR_INTENT: 'is-dir-intent',
  TIMEOUT: 'timeout',
  EXIT_FAILURE: 'exit-failure',
  ARGUMENT: 'argument',
  BLOCKED: 'blocked',
  NOT_CHANGE: 'not-change',
  TOO_LARGE: 'too-large',
  UNKNOWN: 'unknown',
} as const);

export type FailureKind = typeof FAILURE_KIND[keyof typeof FAILURE_KIND];

const CODE_TO_KIND: Record<string, FailureKind> = {
  [TOOL_ERROR_CODE.ENOENT]: FAILURE_KIND.NOT_FOUND,
  [TOOL_ERROR_CODE.EACCES]: FAILURE_KIND.PERMISSION,
  [TOOL_ERROR_CODE.EPERM]: FAILURE_KIND.PERMISSION,
  [TOOL_ERROR_CODE.EEXIST_FILE]: FAILURE_KIND.EXISTS,
  [TOOL_ERROR_CODE.EISDIR]: FAILURE_KIND.IS_DIR,
  [TOOL_ERROR_CODE.ENOTDIR]: FAILURE_KIND.NOT_DIR,
  [TOOL_ERROR_CODE.EISDIR_INTENT]: FAILURE_KIND.IS_DIR_INTENT,
  [TOOL_ERROR_CODE.ETIMEDOUT]: FAILURE_KIND.TIMEOUT,
  [TOOL_ERROR_CODE.EEXIT]: FAILURE_KIND.EXIT_FAILURE,
  [TOOL_ERROR_CODE.EINVAL]: FAILURE_KIND.ARGUMENT,
  [TOOL_ERROR_CODE.EAMBIGUOUS]: FAILURE_KIND.ARGUMENT,
  [TOOL_ERROR_CODE.ENOMATCH]: FAILURE_KIND.ARGUMENT,
  [TOOL_ERROR_CODE.EBADRESULT]: FAILURE_KIND.ARGUMENT,
  [TOOL_ERROR_CODE.EBLOCKED]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.EUNPLANNED]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.EDENIED]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.EREVIEW]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.ESCOPE]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.ESCAPE]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.EPOLICY]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.ESKIPPED]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.ECANCELLED]: FAILURE_KIND.BLOCKED,
  [TOOL_ERROR_CODE.EBUSY]: FAILURE_KIND.TIMEOUT,
  [TOOL_ERROR_CODE.EAGAIN]: FAILURE_KIND.TIMEOUT,
  [TOOL_ERROR_CODE.EMFILE]: FAILURE_KIND.TIMEOUT,
  [TOOL_ERROR_CODE.ENFILE]: FAILURE_KIND.TIMEOUT,
  [TOOL_ERROR_CODE.ETXTBSY]: FAILURE_KIND.TIMEOUT,
  [TOOL_ERROR_CODE.ETOOLARGE]: FAILURE_KIND.TOO_LARGE,
  [TOOL_ERROR_CODE.ENOCHANGE]: FAILURE_KIND.NOT_CHANGE,
};

export function classifyFailure(code: ToolErrorCode | string | undefined): FailureKind {
  return CODE_TO_KIND[code ?? ''] ?? FAILURE_KIND.UNKNOWN;
}

export const ROLE = Object.freeze({
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
});

export type Role = typeof ROLE[keyof typeof ROLE];

export const FINISH_REASON = Object.freeze({
  STOP: 'stop',
  LENGTH: 'length',
  TOOL_CALLS: 'tool_calls',
  ABORTED: 'aborted',
  ERROR: 'error',
});

export type FinishReason = typeof FINISH_REASON[keyof typeof FINISH_REASON];

export const TOOL_CALL_TYPE = 'function';

const RESULT_KIND = Object.freeze({
  TEXT: 'text',
  FILE: 'file',
  LISTING: 'listing',
  MATCHES: 'matches',
  COMMAND: 'command',
  STATUS: 'status',
  LOG: 'log',
  WEB: 'web',
  NONE: 'none',
});

export type ResultKind = typeof RESULT_KIND[keyof typeof RESULT_KIND];

export const AGENT_PHASE = Object.freeze({
  THINKING: 'thinking',
  WORKING: 'working',
});

/** Loader labels for work that is not a tool call, in plain words. */
export const AGENT_STATUS = Object.freeze({
  THINKING: 'Thinking',
  MAKING_ROOM: 'Making room in the conversation',
  RECONNECTING: 'Reconnecting to the model',
});

export type ApprovalVerdict = boolean | typeof APPROVAL.UNAVAILABLE | typeof APPROVAL.REFUSED | typeof APPROVAL.CANCELLED;

export const APPROVAL = Object.freeze({
  UNAVAILABLE: 'unavailable',
  /** The approver refuses *by policy*, distinct from "there is nobody to ask" (`UNAVAILABLE`) and from a person saying no (`false`). */
  REFUSED: 'refused',
  /** Nobody answered: the prompt was dismissed, closed, or answered with something that was not an answer. Never a decline. */
  CANCELLED: 'cancelled',
});

export const CHECKPOINT_VERSION = 1;

export const MEMORY_VERSION = 1;

export const SESSION_RECORD_VERSION = 2;

export const SESSION_ID_LENGTH = 8;

/** The session id a context uses when it deliberately has no durable conversation behind it — an auto-context probe, a `@mention` resolve, a `/copy`. */
export const EPHEMERAL_SESSION = 'ephemeral';

export const STORAGE = Object.freeze({
  PROJECT_DIR: '.ollamacode',
  /** The workspace index, inside ocode's own folder so a rebuild only ever removes what ocode made. */
  INDEX_DIR: '.ollamacode/index',
  /** Where the index lived before: a folder name other tools use for their own files. */
  LEGACY_INDEX_DIR: '.agent',
  USER_DATA_DIR: 'userdata',
  /** Under the *project* dir, beside `sessions/` and `recovery/`, because a checkpoint belongs to one conversation. */
  CHECKPOINTS_DIR: 'checkpoints',
  /** The pre-move location, read once by the migration and then removed. */
  LEGACY_CHECKPOINTS_DIR: 'checkpoints',
  MEMORY_FILE: 'memory.json',
  SESSIONS_DIR: 'sessions',
  CONVENTIONS_FILE: 'CONVENTIONS.md',
  PLAN_FILE: 'plan.json',
});

/** Thinking tokens count against num_predict, so a reasoning reply needs room for both the reasoning and the answer. */
export const REASONING_MIN_PREDICT = 2048;

/** …but never at the prompt's expense: the reply reserve is capped at this share of the window. */
export const REASONING_RESERVE_FRACTION = 0.4;

/** A forced reasoning channel may not authorise more than this many seconds of generation. */
export const REASONING_SECONDS_BUDGET = 45;

/** Below this measured generation rate, reasoning is not worth what it costs. */
export const REASONING_MIN_TOKENS_PER_SEC = 30;

/** Generations shorter than this do not measure a backend. */
export const RATE_SAMPLE_MIN_TOKENS = 24;

export type StopReason = typeof STOP_REASONS[keyof typeof STOP_REASONS];

export const STOP_REASONS = Object.freeze({
  COMPLETE: 'complete',
  MAX_ITERATIONS: 'max_iterations',
  CANCELLED: 'cancelled',
  OUTPUT_TRUNCATED: 'output_truncated',
  GUARD_STUCK: 'guard_stuck',
});

export const INCOMPLETE_STOP_REASONS: readonly StopReason[] = Object.freeze([
  STOP_REASONS.GUARD_STUCK,
  STOP_REASONS.MAX_ITERATIONS,
  STOP_REASONS.OUTPUT_TRUNCATED,
]);

export function isIncompleteStop(reason: StopReason): boolean {
  return INCOMPLETE_STOP_REASONS.includes(reason);
}

export interface TurnResult {
  content: string;
  toolResults: { name: string; args: any; result: import('./types.ts').ToolResult; }[];
  iterations: number;
  stopReason: StopReason;
  telemetry?: import('./core/telemetry.ts').ModelCallRecord[];
}

/** Whether the model is asked to think, and whether the user sees it. */
export const THINKING_MODE = Object.freeze({
  AUTO: 'auto',
  SHOW: 'show',
  DETAILED: 'detailed',
  HIDE: 'hide',
} as const);

export type ThinkingMode = (typeof THINKING_MODE)[keyof typeof THINKING_MODE];

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return Object.values(THINKING_MODE).includes(value as ThinkingMode);
}

/** Canonical tool-name constants and well-known tool-name sets. */

export const TOOL_NAME = Object.freeze({
  ASK_USER: 'ask_user',
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  EDIT_FILE: 'edit_file',
  DELETE_FILE: 'delete_file',
  LIST_DIRECTORY: 'list_directory',
  FIND_FILES: 'find_files',
  GREP_CONTENT: 'grep_content',
  EXEC_SHELL: 'exec_shell',
  RUN_SCRIPT: 'run_script',
  STOP_SUBPROCESS: 'stop_subprocess',
  SUBPROCESS_STATUS: 'subprocess_status',
  STOP_PROCESS: 'stop_process',
  GIT: 'git',
  WEB_SEARCH: 'web_search',
  WEB_FETCH: 'web_fetch',
  READ_DOCUMENT: 'read_document',
  SAVE_MEMORY: 'save_memory',
  UNDO: 'undo',
  /** Hands a task to a subagent; offered only in a turn that can start one. */
  DELEGATE_TASK: 'delegate_task',
} as const);


/** Tools safe to re-execute (read-only): re-running produces the same result. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = Object.freeze(new Set([
  TOOL_NAME.READ_FILE,
  TOOL_NAME.LIST_DIRECTORY,
  TOOL_NAME.FIND_FILES,
  TOOL_NAME.GREP_CONTENT,
]));

/** Tools whose results can be shown as a file-change preview (diff / create / delete / stop). */
export const PREVIEWABLE_TOOLS: ReadonlySet<string> = Object.freeze(new Set([
  TOOL_NAME.WRITE_FILE,
  TOOL_NAME.EDIT_FILE,
  TOOL_NAME.DELETE_FILE,
  TOOL_NAME.STOP_PROCESS,
  TOOL_NAME.UNDO,
]));
