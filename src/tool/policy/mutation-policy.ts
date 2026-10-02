import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../core/paths';
import type { ToolDef } from '../../types';

/** The defs available for classification, keyed by canonical tool name. */
export type ToolMetaMap = Readonly<Record<string, ToolDef>>;

/** Command recognition hooks from the process tools; without them an unknown command fails closed. */
export interface CommandClassify {
  isReadOnlyCommand(command: string): boolean;
  isTestCommand(command: string): boolean;
  escapesWorkspace(command: string, cwd: string, root: string): string | null;
}

export interface ClassifyOptions {
  cwd?: string;
  root?: string;
  hooks?: Array<
    (
      name: string,
      args: Record<string, unknown>,
    ) => 'allow' | 'deny' | 'ask' | null
  >;
  meta?: ToolMetaMap;
  cmd?: CommandClassify;
}

/** The single definition of git operations that write, shared by the plan gate, the git tool and the shell pattern. */
export const GIT_WRITE_OPS = new Set([
  'add',
  'commit',
  'checkout',
  'branch',
  'merge',
  'stash',
  'restore',
  'reset',
]);

/** The git verbs, in shell text, that write to the repository. */
const GIT_WRITE_COMMANDS = [
  'add',
  'commit',
  'checkout',
  'switch',
  'branch',
  'merge',
  'rebase',
  'stash',
  'restore',
  'reset',
  'push',
  'pull',
  'clean',
  'rm',
  'mv',
];

/** A git command (in shell text) that writes. */
export const GIT_MUTATING_PATTERN = new RegExp(
  `^\\s*git\\s+(?:${GIT_WRITE_COMMANDS.join('|')})\\b`,
  'i',
);

const ALWAYS_READ_ONLY = new Set([
  'read_file',
  'list_directory',
  'find_files',
  'grep_content',
  'search_symbols',
  'symbol_references',
  'file_info',
  'diff',
  'web_search',
  'web_fetch',
  'read_document',
  'ask_user',
  // Reading the registry changes nothing; without it a non-interactive session could never load a schema.
  'load_tools',
]);

const ALWAYS_MUTATING = new Set([
  'write_file',
  'edit_file',
  'json_patch',
  'yaml_patch',
  'create_directory',
  'delete_file',
  'undo',
  'save_memory',
  'stop_process',
]);

const POWER_SHELL_MUTATIONS = [
  /\bremove-item\b/i,
  /\bnew-item\b/i,
  /\bset-content\b/i,
  /\badd-content\b/i,
  /\bout-file\b/i,
  /\bclear-content\b/i,
  /\brename-item\b/i,
  /\bcopy-item\b/i,
  /\bmove-item\b/i,
];

const POSIX_MUTATIONS = [
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\brm\b/i,
  /\brmdir\b/i,
  /\bcp\b/i,
  /\bmv\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\btruncate\b/i,
];

const WINDOWS_MUTATIONS = [
  /\bdel(?:ete)?\b/i,
  /\berase\b/i,
  /\bcopy\b/i,
  /\bmove\b/i,
  /\bren(?:ame)?\b/i,
  /\bmkdir\b/i,
  /\brmdir\b/i,
];

const SHELL_CHAIN_PATTERN = /[|&;><`]/;

const COMMAND_SUBSTITUTION_PATTERN = /\$\(/;

/** Package commands that change dependency state. */
export const PACKAGE_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|pip|uv|prisma|alembic|dotnet|nuget|msbuild)\b.*\b(?:install|uninstall|add|remove|migrate|test|build|restore|update|upgrade|pack)\b/i;

export function normalizeToolName(toolName: string): string {
  return String(toolName ?? '').trim().toLowerCase();
}

function hasShellChaining(command: string): boolean {
  return (
    SHELL_CHAIN_PATTERN.test(command) ||
    COMMAND_SUBSTITUTION_PATTERN.test(command)
  );
}

function looksLikeMutation(command: string): boolean {
  if (POWER_SHELL_MUTATIONS.some((pattern) => pattern.test(command))) {
    return true;
  }

  if (POSIX_MUTATIONS.some((pattern) => pattern.test(command))) {
    return true;
  }

  if (WINDOWS_MUTATIONS.some((pattern) => pattern.test(command))) {
    return true;
  }

  if (GIT_MUTATING_PATTERN.test(command)) {
    return true;
  }

  if (PACKAGE_COMMAND_PATTERN.test(command)) {
    return true;
  }

  return false;
}

function isSafeTestCommand(
  command: string,
  cmd?: CommandClassify,
): boolean {
  if (hasShellChaining(command)) {
    return false;
  }

  try {
    if (cmd?.isTestCommand(command)) {
      return true;
    }
  } catch {
    // Fail closed below.
  }

  return false;
}

function isSafeReadOnlyCommand(
  command: string,
  cmd?: CommandClassify,
): boolean {
  if (hasShellChaining(command)) {
    return false;
  }

  try {
    return Boolean(cmd?.isReadOnlyCommand(command));
  } catch {
    return false;
  }
}

function classifyRunCommand(
  command: string,
  cwd?: string,
  root?: string,
  cmd?: CommandClassify,
): 'read-only' | 'mutating' {
  const normalized = command.trim();

  if (!normalized) {
    return 'mutating';
  }

  // A command that contains a mutation must never be classified as read-only merely because it also contains a test/read-only keyword.
  if (looksLikeMutation(normalized)) {
    return 'mutating';
  }

  if (isSafeTestCommand(normalized, cmd)) {
    if (cwd && root && cmd?.escapesWorkspace(normalized, cwd, root)) {
      return 'mutating';
    }
    return 'read-only';
  }

  if (isSafeReadOnlyCommand(normalized, cmd)) {
    if (cwd && root && cmd?.escapesWorkspace(normalized, cwd, root)) {
      return 'mutating';
    }
    return 'read-only';
  }

  // Unknown shell commands are treated as mutating.
  return 'mutating';
}

/** May this call proceed without approval? */
export function classifyTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: ClassifyOptions = {},
): 'read-only' | 'mutating' {
  const name = normalizeToolName(toolName);

  if (ALWAYS_READ_ONLY.has(name)) {
    return 'read-only';
  }

  if (ALWAYS_MUTATING.has(name)) {
    return 'mutating';
  }

  if (name === 'exec_shell') {
    return classifyRunCommand(
      String(args?.command ?? ''),
      opts.cwd,
      opts.root,
      opts.cmd,
    );
  }

  const meta = opts.meta?.[name];

  if (!meta) {
    // Unknown tools must fail closed.
    return 'mutating';
  }

  if (typeof meta.isRisky === 'function') {
    try {
      const verdict = meta.isRisky(args);

      // Permission classification is synchronous.
      if (
        verdict &&
        typeof (verdict as Promise<boolean>).then === 'function'
      ) {
        return 'mutating';
      }

      return verdict ? 'mutating' : 'read-only';
    } catch {
      return 'mutating';
    }
  }

  return meta.risky ? 'mutating' : 'read-only';
}

const READ_ONLY_PATTERNS = [
  /^(?:npm|npx|pnpm|yarn|node|python|py|pip|dotnet|git|tsc|uv|code)\s+(?:--version|-v|--help|-h)$/i,
  /^(?:node|python|py)\s+-v$/i,
  /^npm\s+(?:ls|list|view|config\s+get\b.*|root|prefix)(?:\s+[\w@./-]+)*$/i,
  /^pip\s+(?:list|show\s+[\w.-]+|--version)$/i,
  /^dotnet\s+(?:--info|--list-sdks|--list-runtimes)$/i,
  /^git\s+(?:status|log|diff|show|rev-parse)\b[^|&;><]*$/i,
  /^git\s+branch(?:\s+(?:-a|-r|-v|-vv|--list|--all|--remote|--verbose))*\s*$/i,
  /^git\s+remote(?:\s+(?:-v|--verbose))?\s*$/i,
  /^(?:dir|ls|pwd|cd|where|which|whoami|hostname)(?:\s+-\S+)*$/i,
  /^(?:dir|ls)\s+(?:-\S+\s+)*[.\w\\/-]*$/i,
  /^(?:type|cat)\s+[^|&;><]+$/i,
  /^echo\s+[^|&;><]*$/i,
  // PowerShell cmdlets — the shell `resolveShell()` selects on Windows.
  /^Test-Path\b/i,
  /^Get-Content\b/i,
];

const TEST_PATTERNS = [
  /^\s*(npm|pnpm|yarn)\s+test\b/i,
  /\bpytest\b/i,
  /\bdotnet\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\s+test\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bmocha\b/i,
];

const DANGEROUS_PATTERNS = [
  { re: /\bterraform\s+(apply|destroy)\b[^|&;]*-auto-approve\b/i, why: 'terraform auto-approve applies/destroys infrastructure without confirmation' },
  // `-fu` is one flag group meaning `-f -u`, and it force-pushes.
  { re: /^\s*git\s+(push|fetch|pull)\b[^|&;\n]*\s-[a-z]*f[a-z]*(?=\s|$)/i, why: 'force-pushing overwrites remote history' },
  { re: /^\s*git\s+(push|fetch|pull)\b[^|&;\n]*\s--force\b/i, why: 'force-pushing overwrites remote history' },
  { re: /^\s*git\s+reset\s+--hard\b/i, why: 'git reset --hard discards uncommitted work permanently' },
  // `-fd` and `-fdx` are the forms people actually type; requiring a word boundary right after `-f` matched only a lone `-f`.
  { re: /^\s*git\s+clean\b[^|&;\n]*\s-[a-z]*f[a-z]*(?=\s|$)/i, why: 'git clean deletes untracked files permanently' },
  { re: /^\s*git\s+clean\b[^|&;\n]*\s--force(?=\s|$)/i, why: 'git clean deletes untracked files permanently' },
  // The r may sit anywhere in a bundled flag group: `-rf`, `-fr` and `-Rf` are the same command.
  { re: /\brm\b[^|&;\n]*\s-[a-z]*[rR][a-z]*(?=\s|$)/i, why: 'recursive delete permanently removes files' },
  { re: /\brm\b[^|&;\n]*\s--recursive(?=\s|$)/i, why: 'recursive delete permanently removes files' },
  // `ri` is PowerShell's own alias for Remove-Item and was not recognised at all — the same command under the name the shell itself suggests.
  { re: /\b(?:Remove-Item|ri)\b[^|&;\n]*\s-Recurse\b/i, why: 'recursive delete permanently removes files' },
  { re: /\b(del|erase|rd|rmdir)\b[^|&;\n]*\s\/s\b/i, why: 'recursive delete permanently removes files' },
  { re: /^\s*git\s+restore\b(?![^|&;]*--staged\b)/i, why: 'git restore discards uncommitted working-tree changes permanently' },
  { re: /^\s*git\s+stash\s+(drop|clear)\b/i, why: 'dropping a stash entry destroys the stashed work permanently' },
  { re: /^\s*git\s+restore\b[^|&;]*--(worktree|source)\b/i, why: 'git restore with --worktree/--source discards working-tree changes permanently' },
  { re: /^\s*git\s+checkout\b[^|&;]*\s--(\s|$)/i, why: 'git checkout -- discards uncommitted working-tree changes permanently' },
  { re: /\bdrop\s+(database|table|schema|view)\b/i, why: 'dropping a database/table destroys data' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, why: 'publishing a package is irreversible and public' },
  { re: /^\s*pip\s+uninstall\b/i, why: 'uninstalling a Python package removes it from the environment' },
  { re: /^\s*(apt|apt-get|yum|dnf|pacman)\s+.*\b(remove|purge|autoremove)\b/i, why: 'removing system packages can break the environment' },
  { re: /\bkubectl\s+delete\b/i, why: 'deleting Kubernetes resources can take down services' },
  { re: /^\s*aws\s+s3\s+(rm|sync)\b.*(--recursive|--delete)\b/i, why: 'recursive AWS S3 deletion removes objects permanently' },
  { re: /\bdocker\s+(rm|rmi)\b/i, why: 'deleting Docker containers/images is destructive' },
  { re: /\bgcloud\s+compute\s+instances\s+delete\b/i, why: 'deleting a cloud instance is destructive' },
  { re: /^\s*heroku\s+apps:destroy\b/i, why: 'destroying a Heroku app removes its data' },
];

const REFUSED_PATTERNS = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rR][a-z]*f?[a-z]*\s+["']?(\/|~|\$HOME|\/\*)["']?(\s|$)/i, why: 'recursive delete of a root or home directory' },
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*[rR]\s+["']?(\/|~|\$HOME)["']?(\s|$)/i, why: 'recursive delete of a root or home directory' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bmkfs(\.\w+)?\b/i, why: 'filesystem format' },
  { re: /\bdd\b[^|]*\bof=\/dev\/(disk|sd|nvme|hd)/i, why: 'raw device write' },
  { re: /\b(del|erase|rd|rmdir)\b(\s+\/\w+)*\s+"?([a-z]:([\\/]\*?)?|[\\/])"?(\s|$)/i, why: 'recursive delete of a drive root' },
  { re: /\b(del|erase|rd|rmdir)\b(\s+\/\w+)*\s+"?%(systemroot|windir|userprofile|systemdrive)%/i, why: 'recursive delete of a system directory' },
  { re: /\b(del|erase|rd|rmdir)\b(\s+\/\w+)*\s+"?[a-z]:[\\/]windows\b/i, why: 'recursive delete of a system directory' },
  { re: /\bformat\s+[a-z]:/i, why: 'drive format' },
  { re: /\b(?:Remove-Item|rm)\b[^\n]*\s-Recurse\b[^\n]*\s["']?(?:[a-z]:[\\/]\*?|[\\/]|\$env:(?:userprofile|onedrive|appdata|systemroot|windir|systemdrive)|\$HOME\b)(?:\\[*]?)?["']?(\s|$)/i, why: 'recursive delete of a drive root or user/system directory' },
  { re: /\b(?:Remove-Item|rm)\b[^\n]*\b-Recurse\b[^\n]*["']?[a-z]:[\\/]\*["']?(\s|$)/i, why: 'recursive delete of a drive root' },
  { re: /\b(?:Remove-Item|rm)\b[^\n]*["']?[a-z]:[\\/]\*["']?[^\n]*\s-Recurse\b(\s|$)/i, why: 'recursive delete of a drive root' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, why: 'raw device write' },
  { re: /(^|[;&|]\s*)\s*(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/i, why: 'system power control' },
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: 'piping a remote script into a shell' },
  { re: /\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: 'piping a remote script into a shell' },
  { re: /\bchmod\s+-R\s+777\s+\/(\s|$)/i, why: 'recursive permission change on root' },
];

/** A listing operand (`ls`/`dir`) that reads above the workspace root. */
function listingReadsOutsideWorkspace(operand: string): boolean {
  if (!operand || operand === '-') return false;
  return (
    /^[A-Za-z]:[\\/]/.test(operand) ||
    operand.startsWith('/') ||
    operand.startsWith('\\') ||
    /(^|[\\/])\.\.([\\/]|$)/.test(operand)
  );
}

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return false;
  if (/[|&;><`]/.test(trimmed) || /\$\(/.test(trimmed)) return false;
  if (READ_ONLY_PATTERNS.some((re) => re.test(trimmed))) {
    // Only the listing forms take a path operand; a flag-only `ls -a` has nothing to contain.
    const listing = trimmed.match(/^(?:dir|ls)\s+(?:-\S+\s+)*([.\w\\/-]*)$/i);
    if (listing && listingReadsOutsideWorkspace(listing[1])) return false;
    return true;
  }
  return false;
}

export function isTestCommand(command: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(String(command ?? '')));
}

export function refusalReason(command: string): string | null {
  for (const { re, why } of REFUSED_PATTERNS) {
    if (re.test(String(command ?? ''))) return why;
  }
  return null;
}

/** Deleting verbs, in the three shells this runs under. */
const DELETE_VERB = /^(rm|ri|del|erase|rd|rmdir|Remove-Item|unlink)$/i;

/**
 * The individual commands the shell would run.
 *
 * `rm -rf build && rm *.log` is two deletes, and reading only the first one is how a second
 * deletion slips through unrecoverable. Splitting is what makes a chain answerable at all.
 */
function chainSegments(command: string): string[] {
  const text = String(command ?? '');
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    // A backslash-quoted character is literal, so the next character never ends a segment.
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1];
      i++;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    if ((ch === '&' || ch === '|') && text[i + 1] === ch) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** Shell expansions: the target is computed at run time, so it is not in the text. */
const SHELL_EXPANSION = /\$\(|\$\{|`|\$\w|%[A-Za-z_]\w*%|\$env:/i;

/** What one segment says about deletion: nothing, a set of paths, or paths only the shell can name. */
type DeleteShape =
  | { kind: 'none' }
  | { kind: 'targets'; targets: string[] }
  | { kind: 'opaque'; globs: string[]; why: string };

function deleteShape(segment: string): DeleteShape {
  const tokens: string[] = [];
  for (const m of segment.matchAll(/(["'])((?:(?!\1).)+)\1|(\S+)/g)) {
    const token = m[2] ?? m[3];
    // PowerShell takes a comma-separated array; each element is its own path.
    if (token) tokens.push(...token.split(',').map((t) => t.trim()).filter(Boolean));
  }
  if (!tokens.length || !DELETE_VERB.test(tokens[0])) return { kind: 'none' };

  if (SHELL_EXPANSION.test(segment)) {
    return { kind: 'opaque', globs: [], why: 'its paths come from a shell expansion' };
  }

  const cmdStyle = /^(del|erase|rd|rmdir)$/i.test(tokens[0]);
  const targets: string[] = [];
  const globs: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) continue; // -Recurse, -Force, -rf
    if (cmdStyle && /^\/\w+$/.test(token)) continue; // cmd.exe's /s /q
    if (/[*?]/.test(token)) {
      globs.push(token);
      continue;
    }
    targets.push(token);
  }
  if (globs.length > 0) {
    return { kind: 'opaque', globs, why: 'its paths are wildcards only the shell expands' };
  }
  if (targets.length === 0) {
    return { kind: 'opaque', globs: [], why: 'it names no path' };
  }
  return { kind: 'targets', targets };
}

/** A delete whose targets are not the first token of the segment, and so are invisible to any operand scan. */
const OPAQUE_DELETES: { re: RegExp; why: string }[] = [
  { re: /\bfind\b[^|&\n]*\s-(?:delete|exec\s+rm)\b/i, why: 'find -delete removes whatever it matches' },
  { re: /\bxargs\b[^|&\n]*\b(?:rm|del|Remove-Item)\b/i, why: 'xargs feeds paths to rm from a listing' },
  // `for ... ; do rm ...` puts a semicolon between the loop and its delete, so it cannot be excluded here.
  { re: /\bfor\b[^|&\n]*\bdo\b[^|&\n]*\b(?:rm|del|ri|Remove-Item)\b/i, why: 'a loop deletes a computed list' },
  { re: /\bfor\b[^|&\n]*\bdo\b/i, why: 'a loop deletes whatever it walks' },
  { re: /\|\s*(?:rm|ri|del|erase|rd|rmdir|Remove-Item)\b/i, why: 'a pipe feeds paths to a delete' },
  { re: /^\s*git\s+clean\b/i, why: 'git clean deletes untracked files, which git cannot restore' },
];

/**
 * These are matched against the whole command, not one segment: splitting `for f in *.txt; do rm
 * $f; done` at its semicolons separates the loop from its delete, and a delete that only exists
 * across a split is exactly the one that must not run unbacked.
 */
function opaqueDelete(command: string): string | null {
  for (const { re, why } of OPAQUE_DELETES) {
    if (re.test(command)) return why;
  }
  return null;
}

/** The paths a delete command would remove — `null` when that cannot be read off the command with confidence, which is every case that must keep its warning. */
export function deleteTargets(command: string): string[] | null {
  if (opaqueDelete(command)) return null;
  const segments = chainSegments(command);
  if (segments.length === 0) return null;

  const targets: string[] = [];
  for (const segment of segments) {
    const shape = deleteShape(segment);
    if (shape.kind === 'none') continue;
    if (shape.kind === 'opaque') return null;
    targets.push(...shape.targets);
  }
  return targets.length > 0 ? targets : null;
}

/** Delete targets resolved against the filesystem, with wildcards enumerated before the delete runs. */
export interface ResolvedDeletes {
  /** Every path the command would remove, absolute. */
  paths: string[];
  /** The segment that deletes without naming its paths, if there is one. */
  opaque: string | null;
}

/**
 * The files a delete will actually remove, resolved now.
 *
 * Snapshots are taken before the command runs, so a wildcard has to be enumerated here — the
 * shell's own expansion happens too late to copy anything. A delete that cannot be enumerated
 * comes back as `opaque` rather than as an empty list, so the caller refuses it instead of
 * running a delete it could not back up.
 */
export function resolveDeleteTargets(command: string, cwd: string): ResolvedDeletes {
  const wholeCommandOpaque = opaqueDelete(command);
  const segments = chainSegments(command);
  const paths: string[] = [];
  let opaque: string | null = wholeCommandOpaque;

  for (const segment of segments) {
    const shape = deleteShape(segment);
    if (shape.kind === 'none') continue;
    if (shape.kind === 'opaque') {
      if (shape.globs.length === 0) {
        opaque = opaque ?? shape.why;
        continue;
      }
      for (const pattern of shape.globs) {
        const matches = expandGlob(pattern, cwd);
        if (matches === null) {
          opaque = opaque ?? `the wildcard ${pattern} could not be enumerated`;
          continue;
        }
        paths.push(...matches);
      }
      continue;
    }
    for (const target of shape.targets) {
      const abs = path.resolve(cwd, target);
      paths.push(abs);
    }
  }

  return { paths: [...new Set(paths)], opaque };
}

/** `*` and `?` only: bracket and brace expansion differ per shell, so they stay opaque. */
function expandGlob(pattern: string, cwd: string): string[] | null {
  if (/[!^]\[|\{[^}]*\}|\$\(|\$\{|`/.test(pattern)) return null;
  if (path.isAbsolute(pattern)) return null;
  const resolved = path.resolve(cwd, pattern);
  if (!isInside(path.resolve(cwd), resolved)) return null;

  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const re = new RegExp(
    `^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]')}$`,
  );
  return entries
    .filter((entry) => re.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}


/** Programs whose arguments are text to print, not work to do. */
const PRINTS_ITS_ARGUMENTS = /^\s*(echo|printf|Write-Host|Write-Output|Write-Debug|print)\b/i;

/** The command with quoted spans replaced by a placeholder. */
function withoutQuotedText(command: string): string {
  return command.replace(/(["'])(?:(?!\1)[\s\S])*\1/g, ' _ ');
}

export function dangerousReason(command: string, cwd?: string): string | null {
  const c = String(command ?? '').trim();
  if (!c) return null;
  if (PRINTS_ITS_ARGUMENTS.test(c)) return null;
  const body = withoutQuotedText(c);
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(body)) {
      if (cwd && deletesNothing(c, cwd)) return null;
      return why;
    }
  }
  return null;
}

/** Why a shell command is asked about every time, even under an always-allow: it writes to git or deletes files. */
export function shellConfirmReason(command: string): string | null {
  const c = String(command ?? '').trim();
  if (!c || PRINTS_ITS_ARGUMENTS.test(c)) return null;
  if (chainSegments(c).some((segment) => GIT_MUTATING_PATTERN.test(segment))) return 'changes the git repository';
  if (mentionsDelete(c)) return 'deletes files';
  return null;
}

/** True when the command contains a delete at all — a verb in first position, or one that only its own author knows about. */
function mentionsDelete(command: string): boolean {
  return opaqueDelete(command) !== null || chainSegments(command).some((segment) => deleteShape(segment).kind !== 'none');
}

/** True only when this is a delete and every path it names is already gone. */
function deletesNothing(command: string, cwd: string): boolean {
  // A command that deletes nothing is not a delete. Without this, an empty path list made every
  // non-delete danger — a hard reset, a force-push — look like it had nothing to lose.
  if (!mentionsDelete(command)) return false;
  const { paths, opaque } = resolveDeleteTargets(command, cwd);
  // An opaque delete might still remove something, and "unreadable" is not the same as "absent".
  if (opaque || paths.length === 0) return false;
  return paths.every((abs) => {
    try {
      return !fs.existsSync(abs);
    } catch {
      return false;
    }
  });
}

/**
 * Why a delete cannot be backed up, when the paths it removes are not knowable before it runs.
 *
 * The alternative was running it anyway: a chain whose second half deletes, a wildcard, or a
 * `find -delete` all remove files with no copy anywhere, and the user is told only afterwards.
 * Naming the block is the only way the user can choose differently.
 */
export function unbackupableDeleteReason(command: string, cwd: string): string | null {
  const { paths, opaque } = resolveDeleteTargets(command, cwd);
  if (!opaque) return null;
  // A delete that provably touches nothing is not a risk, opaque text or not.
  if (paths.length > 0 && paths.every((abs) => existsSync(abs))) return null;
  if (paths.length === 0 && deletesNothing(command, cwd)) return null;
  return opaque;
}

function existsSync(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return true; // Unreadable is not absent.
  }
}

export function escapesWorkspace(command: string, cwd: string, root: string): string | null {
  const c = String(command ?? '');
  if (!c.trim() || !cwd || !root) return null;
  const tokens: string[] = [];
  for (const m of c.matchAll(/(["'])((?:(?!\1).)+)\1|(\S+)/g)) tokens.push(m[2] ?? m[3]);
  for (const token of tokens) {
    if (token.startsWith('-')) continue;
    if (
      /^~(?:[\\/]|$)/.test(token) ||
      /^\$(?:HOME|USERPROFILE)(?:[\\/]|$)/i.test(token) ||
      /^\$env:(?:USERPROFILE|HOMEDRIVE|HOMEPATH)(?:[\\/]|$)/i.test(token) ||
      /^%(?:USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMDRIVE)%/i.test(token)
    ) {
      return `references a path with shell expansion that may leave the workspace (${token})`;
    }
    const looksAbsolute = /^[A-Za-z]:[\\/]|^\//.test(token);
    const looksParentTraversal = /(^|[\\/])\.\.([\\/]|$)/.test(token);
    if (!looksAbsolute && !looksParentTraversal) continue;
    let resolved;
    try {
      resolved = path.resolve(cwd, token);
    } catch {
      continue;
    }
    if (!isInside(root, resolved)) return `references a path outside the workspace (${token})`;
  }
  return null;
}