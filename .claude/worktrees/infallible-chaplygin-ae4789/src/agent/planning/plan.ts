import { normalizeRelPath } from '../../core/paths';

export interface FilePlan {
  create: string[];
  edit: string[];
  del: string[];
}

export interface Plan {
  summary: string;
  steps: string[];
  files: FilePlan;
  runs?: string[];
  risks?: string;
  constraints?: string[];
  raw: string;
  /** The plan as the model wrote it, for the approval view; absent for a plan rebuilt from a record. */
  presented?: string;
  skip?: boolean;
  noChangesNeeded?: boolean;
  /** Why no plan came back, when none did. */
  stoppedBecause?: string;
  /** Shell commands that exited cleanly while this plan ran. */
  ran?: string[];
  /** Steps an earlier session finished; that session's file changes are gone, so its verdict carries over. */
  doneSteps?: number[];
}

const NO_PLAN_NEEDED_RE = /^\s*no_plan_needed\s*[.!]?\s*$/i;
const NO_FILE_CHANGES_RE =
  /^\s*no (file|concrete) changes?( are| is)? needed\b/i;
const NOTHING_TO_CHANGE_RE =
  /^\s*nothing_to_change\b[.:!]?\s*\n?/i;

const MAX_STEPS = 30;
const MAX_FILES = 12;
const MAX_STEP_CHARS = 400;

/** Clip at a word boundary and say so; a step cut mid-word reads as the model's typo. */
function clipStep(text: string): string {
  if (text.length <= MAX_STEP_CHARS) return text;
  const cut = text.slice(0, MAX_STEP_CHARS - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_STEP_CHARS / 2)).trimEnd()}…`;
}

/** The part of a step that names what to do; the `Why:` rationale mentions files the step does not touch. */
function withoutRationale(step: string): string {
  return String(step ?? '').split(/;\s*why\s*:/i)[0];
}

const KNOWN_EXTENSIONS = new Set([
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'vue',
  'svelte',
  'py',
  'pyi',
  'rb',
  'php',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'groovy',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'cs',
  'fs',
  'swift',
  'm',
  'mm',
  'lua',
  'pl',
  'r',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'psm1',
  'bat',
  'cmd',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'json',
  'json5',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'cfg',
  'conf',
  'env',
  'md',
  'mdx',
  'txt',
  'rst',
  'adoc',
  'sql',
  'graphql',
  'gql',
  'proto',
  'sln',
  'csproj',
  'fsproj',
  'vbproj',
  'gradle',
  'lock',
  'gitignore',
  'dockerfile',
  'tf',
  'tfvars',
  'wasm',
  'wat',
]);

const PROSE_ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'cf',
  'al',
  'no',
  'its',
  'this',
  'that',
  'these',
  'those',
  'their',
  'there',
  'here',
  'our',
  'your',
  'new',
  'old',
  'basic',
  'simple',
  'main',
  'current',
  'local',
  'same',
  'other',
  'next',
  'last',
  'node.ts',
  'node.js',
  'nodejs',
  'socket.io',
  'socketio',
  'html/js',
  'html/css',
  'css/js',
]);

const FILE_ACTION_RE =
  /\b(create(?:_directory|_file)?|add|new|write|edit|modify|update|change|delete|remove)\b/i;

const INVESTIGATION_STEP_RE =
  /^(read|review|inspect|view|open|list|check|look)\b/i;

function emptyFilePlan(): FilePlan {
  return {
    create: [],
    edit: [],
    del: [],
  };
}

function listItem(line: string): string | null {
  const match =
    /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
  return match?.[1]?.trim() ?? null;
}

function pushUnique(
  bucket: string[],
  value: string,
): void {
  const normalized = value.trim();
  if (!normalized || bucket.includes(normalized)) return;
  bucket.push(normalized);
}

function collectMarkedFile(
  line: string,
  files: FilePlan,
): boolean {
  const match =
    /^\s*([+~-])\s+([^\s,]+\.[A-Za-z0-9]{1,8})\s*$/.exec(line);
  if (!match) return false;
  const [, marker, file] = match;
  if (marker === '+') pushUnique(files.create, file);
  else if (marker === '-') pushUnique(files.del, file);
  else pushUnique(files.edit, file);
  return true;
}

function looksLikeRawCall(text: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s+\S+(?:\s+-?\d+(?:\.\d+)?){0,4}$/.test(text.trim());
}

function isKnownFileToken(token: string): boolean {
  const value = token.replace(/^["'`]|["'`]$/g, '');
  // A quoted command ending in a file (`dotnet sln add X.csproj`) is not itself a file.
  if (!value || /\s/.test(value)) return false;
  const lastSegment = value.split('/').pop() ?? '';
  if (!lastSegment.includes('.')) return false;
  const extension = lastSegment.split('.').pop()?.toLowerCase() ?? '';
  if (!KNOWN_EXTENSIONS.has(extension)) return false;
  if (/^[A-Z]/.test(extension)) return false;
  return true;
}

// A bare quoted word (`ISubject`, `NewsPublisher`) is a code identifier; a file name carries an extension or a path.
function isQuotedFileName(value: string): boolean {
  return /^[A-Za-z0-9_@.-]+(\/[A-Za-z0-9_@.-]+)*$/.test(value) && /[./]/.test(value) && !/^\.+$/.test(value);
}

function collectFiles(
  line: string,
  files: FilePlan,
): void {
  const action = FILE_ACTION_RE.exec(line);
  if (!action && INVESTIGATION_STEP_RE.test(line.trim())) return;
  const bucket = getActionBucket(action?.[1], files);

  const rest = line.replace(
    /(["'`])((?:(?!\1).)+)\1/g,
    (whole, _quote, inner) => {
      const value = String(inner);
      if (isKnownFileToken(value) || isQuotedFileName(value)) pushUnique(bucket, value);
      return ' '.repeat(whole.length);
    },
  );

  for (const match of rest.matchAll(/\b([\w.@-]+\/[\w./-]+|[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{1,8})\b/g)) {
    const token = match[1];
    if (!token || /^\d+(?:\.\d+)*$/.test(token) || PROSE_ABBREVIATIONS.has(token.toLowerCase().replace(/\.$/, ''))) continue;
    if ((rest[match.index + token.length] ?? '') === '(') continue;
    if (!isKnownFileToken(token)) continue;
    pushUnique(bucket, token);
  }
}

function getActionBucket(
  action: string | undefined,
  files: FilePlan,
): string[] {
  if (!action) return files.edit;
  if (/^(create(?:_directory|_file)?|add|new|write)$/i.test(action)) return files.create;
  if (/^(delete|remove)$/i.test(action)) return files.del;
  return files.edit;
}

export function stepFileScope(step: string): { op: 'create' | 'edit' | 'delete' | 'run' | null; files: string[] } {
  const value = String(step ?? '');
  if (/^run\s*:?/i.test(value.trim())) return { op: 'run', files: [] };
  const files = emptyFilePlan();
  collectFiles(withoutRationale(value), files);
  if (files.create.length) return { op: 'create', files: [...files.create] };
  if (files.del.length) return { op: 'delete', files: [...files.del] };
  if (files.edit.length) return { op: 'edit', files: [...files.edit] };
  return { op: null, files: [] };
}

function normalizePath(path: string): string {
  return normalizeRelPath(String(path ?? '').trim());
}

function normalizeFileList(files: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const file of files ?? []) {
    const original = String(file ?? '').trim();
    if (!original) continue;
    const normalized = normalizePath(original);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(original);
    if (result.length >= MAX_FILES) break;
  }
  return result;
}

function reconcileFilePlan(files: FilePlan): FilePlan {
  const create = normalizeFileList(files.create);
  const edit = normalizeFileList(files.edit).filter((file) => !samePathIn(file, create));
  const del = normalizeFileList(files.del).filter((file) => !samePathIn(file, create) && !samePathIn(file, edit));
  return { create, edit, del };
}

function samePathIn(file: string, candidates: string[]): boolean {
  const normalized = normalizePath(file);
  return candidates.some((candidate) => normalizePath(candidate) === normalized);
}

function undecorate(line: string): string {
  return String(line ?? '')
    .replace(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?/, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1');
}

export function parsePlan(answer: string): Plan {
  const raw = String(answer ?? '').trim();

  if (NO_PLAN_NEEDED_RE.test(raw) || NO_FILE_CHANGES_RE.test(raw)) {
    return {
      summary: '',
      steps: [],
      files: emptyFilePlan(),
      runs: [],
      risks: '',
      constraints: [],
      raw,
      skip: true,
    };
  }

  const nothingMatch = NOTHING_TO_CHANGE_RE.exec(raw);
  if (nothingMatch) {
    const explanation = raw.slice(nothingMatch[0].length).trim();
    return {
      // Kept whole: after NOTHING_TO_CHANGE comes the reason, or the full answer to a question, markdown and all.
      summary: explanation,
      steps: [],
      files: emptyFilePlan(),
      runs: [],
      risks: '',
      constraints: [],
      raw,
      noChangesNeeded: true,
    };
  }

  const lines = raw.split('\n');
  const files = emptyFilePlan();
  const steps: string[] = [];
  const runs: string[] = [];
  const constraints: string[] = [];
  let risks = '';
  let goal = '';

  let section: 'goal' | 'implementation' | 'validation' | 'constraints' | null = null;
  const pushStep = (text: string) => {
    if (steps.length >= MAX_STEPS) return;
    // Emphasis is formatting, not content: a step reads the same with or without the model's bold.
    const step = clipStep(text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/\s+/g, ' ').trim());
    if (!step) return;
    steps.push(step);
    collectFiles(withoutRationale(step), files);
  };
  const pushRun = (item: string) => {
    const runMatch = /^run\s*:?\s+(.+)/i.exec(item);
    if (!runMatch) return false;
    // An item carrying the step fields (File:/Why:) is a step the model filed under the wrong heading, not a command.
    if (/;\s*(file|why)\s*:/i.test(runMatch[1])) {
      pushStep(runMatch[1]);
      return true;
    }
    const command = runMatch[1].split(/\s[—–-]\s|:\s/)[0].replace(/\s+/g, ' ').trim().slice(0, 200);
    if (command) runs.push(command);
    pushStep(item);
    return true;
  };

  // A step is a top-level list item. Deeper items, code blocks and tables are detail of the step above them.
  let inFence = false;
  let baseIndent: number | null = null;
  for (const raw of lines) {
    const line = raw;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*\|/.test(line)) continue;
    const bare = undecorate(raw).replace(/^\s*#{1,6}\s+/, '');
    const header = bare.trim().toLowerCase();
    if (/^(goal)\s*:?\s*$/.test(header)) {
      section = 'goal';
      const inline = /^goal\s*:\s*(.+)\s*$/i.exec(bare);
      if (inline?.[1]) goal = inline[1].replace(/\s+/g, ' ').trim().slice(0, 200);
      continue;
    }
    if (/^(implementation|steps|plan|tasks)\s*:?\s*$/.test(header)) {
      section = 'implementation';
      baseIndent = null;
      continue;
    }
    if (/^validation\s*:?\s*$/.test(header)) {
      section = 'validation';
      baseIndent = null;
      continue;
    }
    if (/^constraints?\s*:?\s*$/.test(header)) {
      section = 'constraints';
      continue;
    }
    const goalMatch = /^\s*(goal|summary)\s*:\s*(.+)\s*$/i.exec(bare);
    if (goalMatch?.[2] && !goal) {
      goal = goalMatch[2].replace(/\s+/g, ' ').trim().slice(0, 200);
      continue;
    }
    const risksMatch = /^\s*risks\s*:\s*(.+)\s*$/i.exec(bare);
    if (risksMatch && !risks) {
      risks = risksMatch[1].replace(/\s+/g, ' ').trim().slice(0, 200);
      continue;
    }
    if (collectMarkedFile(line, files)) continue;

    const item = listItem(line);
    if (item === null) {
      if (section === 'goal' && !goal && line.trim() !== '') {
        goal = line.trim().replace(/\s+/g, ' ').slice(0, 200);
      }
      continue;
    }

    if (looksLikeRawCall(item)) {
      collectFiles(item, files);
      continue;
    }

    if (/\bask[_\s-]?user\b/i.test(item)) continue;

    const indent = (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '  ').length;
    if (baseIndent === null) baseIndent = indent;
    if (indent > baseIndent && steps.length > 0) {
      const folded = clipStep(`${steps[steps.length - 1]}; ${item}`);
      steps[steps.length - 1] = folded;
      collectFiles(withoutRationale(item), files);
      continue;
    }

    if (section === 'validation') {
      if (!pushRun(item)) pushStep(item);
      continue;
    }

    if (section === 'constraints') {
      if (constraints.length < MAX_STEPS) {
        constraints.push(clipStep(item.replace(/\s+/g, ' ').trim()));
      }
      continue;
    }

    if (pushRun(item)) continue;
    pushStep(item);
  }

  const foundSummary = lines
    .map((line) => line.trim())
    .find(
      (line) =>
        line !== '' &&
        listItem(line) === null &&
        !/^#{1,6}\s|^plan\b:?$/i.test(line) &&
        !/^(goal|implementation|validation|constraints?)\s*:?\s*$/i.test(line),
    ) ?? '';
  const summary = goal || foundSummary;

  const risksOut = risks || constraints.slice(0, 2).join('; ').slice(0, 200);

  return {
    summary: summary.replace(/\s+/g, ' ').slice(0, 200),
    steps,
    files: reconcileFilePlan(files),
    runs,
    risks: risksOut,
    constraints,
    raw,
  };
}

export function isPlanEmpty(plan: Plan): boolean {
  return String(plan?.raw ?? '').trim() === '';
}

function wrapStep(
  num: number,
  step: string,
  width = 80,
): string[] {
  const prefix = `  ${num}. `;
  const continuation = ' '.repeat(prefix.length);
  const lines: string[] = [];
  let line = prefix;
  for (const word of String(step).split(/\s+/)) {
    if (line !== prefix && (line + word).length > width) {
      lines.push(line.trimEnd());
      line = continuation + word + ' ';
    } else {
      line += word + ' ';
    }
  }
  if (line !== prefix) lines.push(line.trimEnd());
  return lines;
}

export function renderPlan(plan: Plan): string {
  const out: string[] = [];
  if (plan.summary) out.push('Goal', plan.summary, '');

  const runSteps = new Set((plan.runs ?? []).map((r) => r.toLowerCase()));
  const implSteps = (plan.steps ?? []).filter((s) => !/^run\s*:?/i.test(s.trim()) && !runSteps.has(s.toLowerCase()));
  const validationSteps = (plan.steps ?? []).filter((s) => /^run\s*:?/i.test(s.trim()) || runSteps.has(s.toLowerCase()));

  if (implSteps.length) {
    out.push('Implementation', '');
    for (const [index, step] of implSteps.entries()) out.push(...wrapStep(index + 1, step));
    out.push('');
  }

  if (validationSteps.length || ((plan.runs ?? []).length > 0)) {
    out.push('Validation', '');
    const seen = new Set<string>();
    let n = 0;
    const emit = (text: string) => {
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      n += 1;
      out.push(...wrapStep(n, text));
    };
    for (const s of validationSteps) emit(s);
    for (const r of plan.runs ?? []) {
      if (!seen.has(`run: ${r}`.toLowerCase()) && ![...seen].some((k) => k.includes(r.toLowerCase()))) emit(`Run: ${r}`);
    }
    out.push('');
  }

  const scope = [
    ...(plan.files.create ?? []),
    ...(plan.files.edit ?? []),
    ...(plan.files.del ?? []),
  ].filter((file, index, files) => files.findIndex((candidate) => normalizePath(candidate) === normalizePath(file)) === index);

  if (scope.length) out.push(`  Files: ${scope.join(', ')}`);
  else if (plan.steps.length) out.push('  Files: named while working — each write still asks');

  const constraints = [...(plan.constraints ?? [])];
  if (!constraints.length && plan.risks) constraints.push(plan.risks);
  if (constraints.length) {
    out.push('Constraints', '');
    for (const c of constraints.slice(0, 4)) out.push(`  - ${c}`);
    out.push('');
  }

  return out.join('\n').trimEnd() || plan.raw.slice(0, 400).trim();
}

type FsChange = import('../../context/workspace-state.ts').FsChange;

export type ChecklistStatus = 'done' | 'active' | 'open';

export interface ChecklistItem {
  /** The step's heading, for the person watching. */
  title: string;
  /** The step without its rationale, for the model's execution pin. */
  text: string;
  status: ChecklistStatus;
}

function changedPath(changes: FsChange[], file: string, wantDelete: boolean): boolean {
  const normalized = normalizePath(file);
  if (!normalized) return false;
  return (changes ?? []).some((change) => {
    const path = normalizePath(change?.path ?? '');
    if (!path || (change.op === 'delete') !== wantDelete) return false;
    return path === normalized || (!normalized.includes('/') && path.endsWith(`/${normalized}`));
  });
}

// A command is identified by its words before the first option: `dotnet run --project X` and `dotnet run` are the same step.
// A `<shell> -c <script>` wrapper runs the script; the wrapper is not the command.
const SHELL_SCRIPT_FLAG = /^(?:-[a-z]*c|\/c|-command)$/i;

// A command that starts with a file (`build.bat`, `./scripts/test.sh`) is that file, resolved from where it ran,
// so `build.bat` run in `c-demo` and `c-demo\build.bat` run from the workspace root are the same step.
function commandKey(value: string, cwd = ''): string {
  let words = String(value ?? '').replace(/`/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3 && SHELL_SCRIPT_FLAG.test(words[1])) words = words.slice(2).map((w) => w.replace(/^["']|["']$/g, ''));
  const firstOption = words.findIndex((word) => word.startsWith('-'));
  const kept = words.slice(0, firstOption < 0 ? words.length : firstOption);
  const head = kept[0] ?? '';
  if (/[\\/]/.test(head) || /\.[A-Za-z0-9]{1,4}$/.test(head)) {
    const joined = [cwd, head.replace(/^\.[\\/]/, '')].filter(Boolean).join('/');
    kept[0] = normalizeRelPath(joined.replace(/\\/g, '/'));
  }
  return kept.join(' ').toLowerCase();
}

/** The command a `Run:` step names, or null for a step that is not a command. */
function stepCommand(step: string): string | null {
  const match = /^run\s*:?\s+(.+)/i.exec(String(step ?? '').trim());
  if (!match) return null;
  // A backticked command is exact; notes after it ("(from the app folder)") are not part of it.
  const quoted = /`([^`]+)`/.exec(match[1])?.[1];
  return commandKey(quoted ?? match[1].split(/\s[—–-]\s|:\s/)[0]) || null;
}

/** Records each command in a shell call that exited cleanly, so the plan's `Run:` steps can be ticked off. */
export function noteCommandRan(plan: Plan | null | undefined, command: string, cwd = ''): void {
  if (!plan) return;
  const ran = (plan.ran ??= []);
  for (const part of String(command ?? '').split(/&&|\|\||;|\|/)) {
    const key = commandKey(part, cwd);
    if (key && !ran.includes(key)) ran.push(key);
  }
  if (ran.length > 50) ran.splice(0, ran.length - 50);
}

function commandRan(plan: Plan, command: string): boolean {
  return (plan.ran ?? []).includes(command);
}

/** A checklist line, not a paragraph: a short "Label: detail" keeps its label, anything else its first words. */
function stepTitle(step: string): string {
  // "Run: Run dotnet run" names the verb once.
  const first = String(step ?? '').replace(/^run\s*:?\s*(?:run\s+)?/i, 'Run ').split(/;\s|\s[—–]\s/)[0].replace(/[`*]/g, '').trim();
  const label = /^([^:]{2,40}):\s/.exec(first)?.[1];
  if (label && !/^Run\b/.test(first)) return label.trim();
  return first.length > 60 ? `${first.slice(0, 59).replace(/\s+\S*$/, '')}…` : first;
}

/**
 * A file name or path standing as a word of its own in `text`; a sentence-ending full stop after it still counts.
 * Case-insensitive, like every other path comparison here (paths are normalized to lower case).
 */
function namesFile(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w./\\\\-])${escaped}(?![\\w/\\\\-])(?!\\.\\w)`, 'i').test(text);
}

/**
 * The files this plan actually changed that a step names, by path or by file name. Read from the change record, so any
 * name counts (`Dockerfile`, `.dockerignore`, `Makefile`), not only the ones the step's prose parsing recognises as files.
 */
function changedFilesNamedIn(text: string, changes: FsChange[]): string[] {
  return (changes ?? []).flatMap((change) => {
    const path = normalizePath(change?.path ?? '');
    const name = path.split('/').pop() ?? '';
    return name && (namesFile(text, path) || namesFile(text, name)) ? [path] : [];
  });
}

// A step is done when its files changed or its command ran; one with nothing to check, once later work lands or a finished turn left nothing checkable open.
export function planChecklist(
  plan: Plan,
  changes: FsChange[],
  { running = false, finished = false }: { running?: boolean; finished?: boolean } = {},
): ChecklistItem[] {
  const entries: { title: string; text: string; done: boolean | null }[] = [];
  if ((plan?.steps ?? []).length > 0) {
    plan.steps.forEach((step, index) => {
      const text = withoutRationale(step).trim();
      const command = stepCommand(step);
      const scope = command ? null : stepFileScope(step);
      // A changed file the step names is evidence by itself, whatever its name looks like.
      const named = command ? [] : changedFilesNamedIn(text, changes);
      const evidence = command
        ? commandRan(plan, command)
        : scope?.files.length || named.length
          ? (scope?.files ?? []).every((file) => changedPath(changes, file, scope?.op === 'delete'))
          : null;
      entries.push({ title: stepTitle(step), text, done: plan.doneSteps?.includes(index) ? true : evidence });
    });
  } else {
    for (const file of [...(plan?.files?.create ?? []), ...(plan?.files?.edit ?? [])]) {
      entries.push({ title: file, text: file, done: changedPath(changes, file, false) });
    }
    for (const file of plan?.files?.del ?? []) entries.push({ title: `Delete ${file}`, text: `Delete ${file}`, done: changedPath(changes, file, true) });
    for (const run of plan?.runs ?? []) entries.push({ title: `Run ${run.replace(/`/g, '')}`, text: `Run: ${run}`, done: commandRan(plan, commandKey(run)) });
  }

  const checkableDone = entries.every((e) => e.done !== false);
  const items: ChecklistItem[] = entries.map((entry, index) => {
    // While the plan runs, a step is done only on evidence. A step with nothing to check is judged once the
    // turn has finished: done if later work landed or nothing checkable is still open.
    const done = entry.done ?? (finished && (entries.slice(index + 1).some((later) => later.done === true) || checkableDone));
    return { title: entry.title, text: entry.text, status: done ? 'done' : 'open' };
  });
  if (running) {
    const next = items.find((item) => item.status === 'open');
    if (next) next.status = 'active';
  }
  return items;
}

/**
 * The checklist shown while a plan runs. The model's own task list, when it keeps one, is the progress it
 * reports; otherwise a step ticks only on evidence from after the plan was approved.
 */
export function liveChecklist(
  plan: Plan | null | undefined,
  state: { todos?: Array<{ content?: unknown; status?: unknown }>; changes?: FsChange[] } | null | undefined,
  changesFrom = 0,
): ChecklistItem[] {
  // A running plan is the one list: its steps, ticked on evidence, live and in the transcript alike. A task list the
  // model keeps beside it would be a second, differently worded copy of the same work, so it shows only without a plan.
  if (plan) return planChecklist(plan, (state?.changes ?? []).slice(Number(changesFrom) || 0), { running: true });
  const status: Record<string, ChecklistStatus> = { completed: 'done', in_progress: 'active', pending: 'open' };
  return (state?.todos ?? []).map((t) => ({ title: String(t.content ?? ''), text: String(t.content ?? ''), status: status[String(t.status)] ?? 'open' }));
}

export function executionProgress(
  plan: Plan,
  changes: FsChange[],
): { done: number; total: number; remaining: { index: number; text: string; }[] } {
  const items = planChecklist(plan, changes ?? []);
  return {
    done: items.filter((item) => item.status === 'done').length,
    total: items.length,
    remaining: items.flatMap((item, index) => (item.status === 'done' ? [] : [{ index, text: item.text }])),
  };
}

export function buildRegenerationNote(feedback?: string): string {
  const trimmed = String(feedback ?? '').trim();
  return trimmed ? `The previous plan was not approved. Revise it to address this feedback: ${trimmed}` : 'The previous plan was not approved. Propose a different plan.';
}

function stepKey(step: string): string {
  const value = String(step ?? '').trim();
  const runMatch = /^run\s*:?\s+(.+)/i.exec(value);
  if (runMatch) {
    return `run:${runMatch[1].split(/\s[—–-]\s|:\s/)[0].trim().toLowerCase().replace(/\s+/g, ' ')}`;
  }
  const files = emptyFilePlan();
  collectFiles(value, files);
  const bucket = files.create.length ? 'create' : files.edit.length ? 'edit' : files.del.length ? 'delete' : null;
  const targets = [...files.create, ...files.edit, ...files.del].map(normalizePath).sort().join(',');
  return bucket && targets ? `${bucket}:${targets}` : value.toLowerCase().replace(/\s+/g, ' ');
}

function dedupNormalize(files: string[] = []): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const value = String(file ?? '').trim();
    const normalized = normalizePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
    if (result.length >= MAX_FILES) break;
  }
  return result;
}

export function validatePlan(plan: Plan): Plan {
  const seenSteps = new Set<string>();
  const steps: string[] = [];
  for (const step of plan.steps ?? []) {
    const key = stepKey(step);
    if (seenSteps.has(key)) continue;
    seenSteps.add(key);
    steps.push(step);
    if (steps.length >= MAX_STEPS) break;
  }
  const files = reconcileFilePlan({
    create: dedupNormalize(plan.files?.create ?? []),
    edit: dedupNormalize(plan.files?.edit ?? []),
    del: dedupNormalize(plan.files?.del ?? []),
  });
  return {
    ...plan,
    steps,
    files,
    runs: [...(plan.runs ?? [])].slice(0, MAX_STEPS),
    risks: String(plan.risks ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    constraints: [...(plan.constraints ?? [])].map((c) => String(c ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_CHARS)).filter(Boolean).slice(0, 4),
  };
}