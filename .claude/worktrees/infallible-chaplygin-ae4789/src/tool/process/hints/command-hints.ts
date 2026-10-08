import fs from 'node:fs';
import path from 'node:path';
import { saysUnknownCommand, everyLineSaysNotFound, portFromOutput } from '../command-messages';
import { missingToolHint } from '../../../env/tooling/detector';
import { defaultRegistry, normNameKey } from '../../execution/registry';
import type {
  ShellExecutionResult,
  CommandClassification,
  VerificationMetadata,
  RecoveryResult,
  ShellRequest,
  CommandHint,
} from '../types';

const ABSENCE_PROBE_RE = /^\s*(Get-Process|Get-NetTCPConnection|Get-Service|pgrep|pidof)\b[^|;&]*$/i;
const ABSENCE_NOUN: Record<string, string> = {
  'get-process': 'process',
  'get-nettcpconnection': 'connection',
  'get-service': 'service',
  pgrep: 'process',
  pidof: 'process',
};

const PROJECT_TARGETED_RE =
  /\bTest run for\b|\bPassed!\b|\bFailed!\b|\bTest Suites:\b|\bTests:\s+\d+\s+(?:passed|failed|skipped)\b|={3,}\s*FAILURES?\s*={3,}|\[xUnit\.net\b|^\s*---\s+FAIL:|\bFAIL\s+\S+\s*$|Determining projects to restore|All projects are up-to-date for restore|\bin\s+[\w.\\/-]+\.(?:csproj|sln)\)|\s->\s+[\w.\\/:-]+\.(?:dll|exe)\b/im;

const NOT_VALIDATED_MARKERS = [
  /unable to find a project to restore/i,
  /no (?:projects?|solutions?)(?: file| files)? (?:matched|found|were matched)/i,
  /no test files found/i,
  /no test is available/i,
  /no tests? run/i,
  /no tests? ran/i,
  /no tests? found/i,
  /no tests? executed/i,
  /\[\s*0\s*passing\s*\]|0 passing/i,
  /\[\s*no test files\s*\]/i,
];

const SYSTEM_DIR_WORDS = ['node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'target', '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv', '.git'];
const EXCLUSION_AWARE_RE = /-Exclude\b|--exclude(?:-dir)?\b|-notpath\b|-notmatch\b|-notlike\b|\bWhere(?:-Object)?\b[^|;&]*?-(?:notmatch|notlike|not|ne)\b/i;

function needsProjectTarget(command: string): boolean {
  const c = String(command ?? '').trim();
  return (
    /^\s*dotnet\s+(test|build|run|publish|restore|pack)\b/i.test(c) ||
    /^\s*msbuild\b/i.test(c) ||
    /^\s*(npm|pnpm|yarn)\s+(test|run)\b/i.test(c) ||
    /^\s*(pytest|jest|vitest|mocha)\b/i.test(c) ||
    /^\s*python(?:3)?\s+-m\s+pytest\b/i.test(c) ||
    /^\s*go\s+(test|build)\b/i.test(c) ||
    /^\s*cargo\s+(test|build)\b/i.test(c) ||
    /^\s*(mvn|gradlew?)\b/i.test(c)
  );
}

function findProjectFiles(dir: string): string[] {
  const files: string[] = [];
  const patterns = ['*.csproj', '*.sln', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'pyproject.toml'];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && patterns.some((p) => new RegExp(p.replace('*', '.*')).test(entry.name))) {
        files.push(entry.name);
      }
    }
  } catch {
  }
  return files;
}

function deleteFoundNothing(stderr: string, targets: string[] | null): boolean {
  if (!targets?.length || !everyLineSaysNotFound(stderr)) return false;
  const complaint = String(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return targets.every((target) => {
    const leaf = target.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
    return leaf.length > 0 && complaint.includes(leaf);
  });
}

function notValidatedHint(command: string, output: string): string | null {
  const text = String(output ?? '');
  if (!needsProjectTarget(command)) return null;
  if (PROJECT_TARGETED_RE.test(text) || !NOT_VALIDATED_MARKERS.some((re) => re.test(text))) return null;
  return 'This run exited 0 but its own output says it validated nothing: the toolchain found no project or test to act on (e.g. "Unable to find a project to restore", "No projects matched", "No test files found", "0 passing"). Do not treat this as a passing build or test. Re-run naming the specific project or test target, then report only what that run\'s result proves.';
}

function projectTargetHint(dir: string | undefined, command: string, output?: string): string | null {
  if (!dir || !needsProjectTarget(command) || /(^|\s)[\w./\\-]*[./\\][\w./\\-]*/.test(command.replace(/^\s*\S+/, '')) || PROJECT_TARGETED_RE.test(String(output ?? ''))) return null;
  const files = findProjectFiles(dir);
  if (files.some((file) => !file.includes('/')) || files.length < 2) return null;
  const tests = files.filter((file) => /(^|[\W_])tests?([\W_]|$)/i.test(file));
  const isTest = /^\s*(pytest|jest|vitest|mocha|dotnet\s+test|cargo\s+test|go\s+test)\b/i.test(command);
  const preferred = isTest && tests.length > 0 ? tests : files;
  return `This directory holds no project file, so the command had no target. Re-run naming one:\n${preferred.slice(0, 6).map((file) => `  ${file}`).join('\n')}${isTest ? '\nIt must be the test project — a non-test project exits 0 having run nothing.' : ''}`;
}

function toolNameHint(command: string, stderr: string): string | null {
  if (!saysUnknownCommand(stderr)) return null;
  const first = String(command ?? '').trim().split(/\s+/)[0];
  const bin = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  if (!bin) return null;
  const canonical = defaultRegistry.names.get(normNameKey(bin));
  const tool = canonical ? defaultRegistry.byName[canonical] ?? null : null;
  return tool ? `\`${command}\` is a TOOL call, not a shell command — call the ${tool.name} tool directly (e.g. ${tool.name} {toolchains:["rust"], install:true}); do not type it in the shell.` : null;
}

function powershellParamHint(command: string, output: string): string | null {
  if (!/parameter name ['`]?\w+['`]? is ambiguous|parameter cannot be processed because the parameter name/i.test(String(output ?? ''))) return null;
  return /^\s*ls\b/i.test(String(command ?? ''))
    ? 'Use Get-ChildItem -Force (or list_directory with all:true) — PowerShell ls is Get-ChildItem and does not take Unix -a/-l flags.'
    : null;
}

function searchScopeIsDeliberate(command: string): boolean {
  if (EXCLUSION_AWARE_RE.test(command)) return true;
  const lower = ` ${String(command).toLowerCase()} `;
  return SYSTEM_DIR_WORDS.some((word) => new RegExp(`[/\\\\\\s'"]${word.replace(/\./g, '\\\.')}(?=$|[/\\\\\\s'"])`).test(lower));
}

function isRecursiveListing(command: string, kind: string): boolean {
  if (kind === 'cmd') return /^\s*dir\b/i.test(command) && /(?:^|\s)\/s\b/i.test(command);
  if (kind === 'pwsh' || kind === 'powershell') return /^\s*(?:Get-ChildItem|gci|dir|ls)\b/i.test(command) && /-Recurs\w*\b/i.test(command);
  return !/-maxdepth\s+1\b/i.test(command) && (/(?:^|\s)ls\s+-[a-zA-Z]*R/i.test(command) || /^\s*find\s+\S/i.test(command) || /\bgrep\s+-[a-zA-Z]*r/i.test(command));
}

function isFileSearch(command: string, kind: string): boolean {
  if (/\|\s*(?:Select-String|grep|rg|findstr)\b/i.test(command) || /\bForEach(?:-Object)?\b/i.test(command) && /\bGet-Content\b/i.test(command)) return true;
  if (kind === 'cmd') return /[*?]/.test(command);
  if (kind === 'pwsh' || kind === 'powershell') return /-Filter\b/i.test(command) || /-Include\b/i.test(command);
  return /(?:^|[\s(])-(?:name|iname|path|regex|exec)\b/i.test(command) || /\bgrep\s+-[a-zA-Z]*r/i.test(command);
}

function searchInsteadHint(command: string, kind: string): string | null {
  return isRecursiveListing(command, kind) && !searchScopeIsDeliberate(command) && isFileSearch(command, kind)
    ? 'Use the find_files tool to locate files by name and grep_content to search their contents — both skip node_modules, build output and other system folders by default. Read what they return with read_file (files) or list_directory (directories). A raw recursive shell listing walks straight through system folders and buries the real matches.'
    : null;
}

function systemFoldersHint(command: string, kind: string, output: string): string | null {
  return isRecursiveListing(command, kind) && !searchScopeIsDeliberate(command) && /(^|[/\\])node_modules[/\\]/i.test(String(output ?? ''))
    ? 'Use the find_files tool to locate files by name and grep_content to search their contents — both skip node_modules, build output and other system folders by default. Read what they return with read_file (files) or list_directory (directories). A raw recursive shell listing walks straight through system folders and buries the real matches.'
    : null;
}

function readDirectoryHint(command: string, output: string): string | null {
  return /(?:unable to get content|because it is a directory|\bis a directory\b)/i.test(String(output ?? '')) && /(^|[|&;\s])(?:Get-Content|gc|cat|type)(\s|$)/i.test(String(command ?? ''))
    ? 'That path is a directory, not a file — list it with list_directory, or read a file inside it with read_file.'
    : null;
}

function testLoadFailureBlock(command: string, stdout: string, stderr: string, cwd: string): string | null {
  if (!/\bnode\b[^\n]*--test\b/i.test(command)) return null;
  const combined = `${stdout}\n${stderr}`;
  if (!/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(combined) || !/^not ok \d+ -/m.test(combined)) return null;

  const existingNotOk = (combined.match(/^not ok \d+ -/gm) ?? []).length;
  const missing = combined.match(/Cannot find module '([^']+)'/)?.[1] ?? 'its imports could not be resolved';
  const editedNames: Array<{ file: string; spec: string; names: string[] }> = [];
  const seen = new Set<string>();
  const notOkRe = /^not ok (\d+) - (.+?)(?:\r?\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = notOkRe.exec(combined))) {
    const spec = String(match[2] ?? '').trim();
    if (!spec || seen.has(spec)) continue;
    const file = path.isAbsolute(spec) ? spec.replace(/\\\\/g, '\\') : path.resolve(cwd, spec.replace(/\\\\/g, '\\'));
    let source = '';
    try {
      source = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const names = extractTestNames(source);
    if (!names.length) continue;
    seen.add(spec);
    editedNames.push({ file, spec, names });
  }
  if (!editedNames.length) return null;

  const lines: string[] = [];
  let number = existingNotOk;
  for (const { file, spec, names } of editedNames) {
    const relative = shorten(file, cwd);
    const noun = names.length === 1 ? 'test' : 'tests';
    lines.push(`${relative} could not load (${missing}) — the ${names.length} ${noun} inside it did not run:`);
    for (const name of names) lines.push(`not ok ${++number} - ${name}`);
    lines.push(`  file reported as: ${spec}`);
  }
  return lines.join('\n');
}

function shorten(file: string, cwd: string): string {
  try {
    const relative = path.relative(cwd, file);
    return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : file;
  } catch {
    return file;
  }
}

function extractTestNames(source: string): string[] {
  const names: string[] = [];
  for (const pattern of [/\b(?:test|it|specify)\s*\(\s*(['"`])(.*?)\1/g, /\bdescribe\s*\(\s*(['"`])(.*?)\1/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const name = String(match[2] ?? '').trim();
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

function backgroundJobHint(command: string): string | null {
  if (!/\bkill\s+\$!/i.test(command) && !/\$!/.test(command) && !/\bnohup\b/i.test(command) && !/&\s*$/.test(command)) return null;
  return 'Use start_subprocess instead of Start-Job/Start-Process for anything meant to keep running (a server, a watcher): 1) start_subprocess {command: "node server.ts"} — it keeps running across calls, unlike exec_shell. 2) subprocess_status or curl.exe/Invoke-WebRequest to exercise it. 3) stop_subprocess when done. Do not use Start-Job/Stop-Job: exec_shell starts a fresh shell every call, so a job handle cannot be captured in one call and stopped from another, and a bare Stop-Job/Stop-Process with nothing named or piped in fails outright.';
}

function addrInUseHint(command: string, stdout: string, stderr: string): string | null {
  const addrInUse = portFromOutput(`${stdout}\n${stderr}\n${command}`);
  return addrInUse !== null
    ? `Port ${addrInUse} is already in use by another process — this command never ran. Use stop_process with port ${addrInUse} to see what holds it (approval is asked before anything is killed); stop it if it is stale, then retry this command.`
    : null;
}

export function generateHints(input: {
  execution: ShellExecutionResult;
  classification: CommandClassification;
  verification: VerificationMetadata;
  recovery: RecoveryResult;
  request: ShellRequest;
}): CommandHint[] {
  const { execution, classification, verification, recovery, request } = input;
  const hints: CommandHint[] = [];
  const command = request.command;
  const stdout = execution.stdout;
  const stderr = execution.stderr;
  const combined = `${stdout}\n${stderr}`;

  if (!verification.passed) {
    if (recovery.kind === 'file-lock' && recovery.attempted) {
      if (recovery.succeeded === false) {
        hints.push({
          kind: 'recovery-failed',
          message: `A stale process held the build output and safe recovery ran (stopped ${recovery.killedPids.length} process(es)), but the retry still failed. ${recovery.requiresApproval ? `Remaining candidate PID ${recovery.approvalPid} is not attributable to this project — use stop_process with that pid (approval is asked) and only then retry. ` : ''}Do not edit source for a lock; this is infrastructure.`,
        });
      } else if (recovery.requiresApproval && recovery.approvalPid !== undefined) {
        hints.push({
          kind: 'recovery-approval-needed',
          message: `The build output is locked by PID ${recovery.approvalPid}, which cannot be safely tied to this project — it was NOT stopped. Use stop_process with pid ${recovery.approvalPid} (approval is asked before anything is killed); if it is stale, stop it, then retry this exact command. Do not edit source for a lock and never kill by executable name.`,
        });
      } else if (recovery.succeeded === null) {
        hints.push({
          kind: 'recovery-retry',
          message: `The build output was locked. ${recovery.detail} Retry this exact command once — no source edit is needed for a lock.`,
        });
      }
    } else if (recovery.kind === 'port-in-use') {
      hints.push({
        kind: 'port-in-use',
        message: recovery.detail,
      });
    }
  }

  if (verification.intent === 'test' && !verification.passed && classification.category === 'test') {
    const notValidated = notValidatedHint(command, combined);
    if (notValidated) {
      hints.push({ kind: 'not-validated', message: notValidated });
    }
  }

  if (execution.exitCode !== 0) {
    const noProject = projectTargetHint(request.cwd, command, combined);
    if (noProject) {
      hints.push({ kind: 'no-project-target', message: noProject });
    }
  }

  const toolingHint = missingToolHint(command, combined);
  if (toolingHint) {
    hints.push({ kind: 'missing-tool', message: toolingHint });
  }

  const toolAsCommandHint = toolNameHint(command, stderr);
  if (toolAsCommandHint) {
    hints.push({ kind: 'tool-as-command', message: toolAsCommandHint });
  }

  const psParamHint = powershellParamHint(command, combined);
  if (psParamHint) {
    hints.push({ kind: 'powershell-param', message: psParamHint });
  }

  const addrHint = addrInUseHint(command, stdout, stderr);
  if (addrHint) {
    hints.push({ kind: 'addr-in-use', message: addrHint });
  }

  const searchHint = searchInsteadHint(command, classification.ecosystem ?? 'generic');
  if (searchHint) {
    hints.push({ kind: 'search-redirect', message: searchHint });
  }

  const sysFoldersHint = systemFoldersHint(command, classification.ecosystem ?? 'generic', combined);
  if (sysFoldersHint) {
    hints.push({ kind: 'system-folders', message: sysFoldersHint });
  }

  const dirReadHint = readDirectoryHint(command, combined);
  if (dirReadHint) {
    hints.push({ kind: 'read-directory', message: dirReadHint });
  }

  const testLoad = testLoadFailureBlock(command, stdout, stderr, request.cwd);
  if (testLoad) {
    hints.push({ kind: 'test-load-failure', message: testLoad });
  }

  const deleteTargets = command.match(/\b(rm|remove-item|del)\b/i) ? command.split(/\s+/).slice(1) : null;
  const nothingToDelete = deleteTargets !== null && deleteTargets.length > 0 && deleteFoundNothing(stderr, deleteTargets);
  if (nothingToDelete) {
    const one = deleteTargets.length === 1 ? deleteTargets[0] : null;
    hints.push({
      kind: 'delete-nothing',
      message: one
        ? `Already gone — ${one} was not there, so there was nothing to remove.`
        : 'Already gone — none of those paths existed, so there was nothing to remove.',
    });
  }

  const absenceMatch = execution.exitCode === 1 && !stdout.trim() && !stderr.trim() && ABSENCE_PROBE_RE.exec(command);
  if (absenceMatch) {
    const noun = ABSENCE_NOUN[absenceMatch[1].toLowerCase()] ?? 'target';
    hints.push({
      kind: 'absence-probe',
      message: `No match — the queried ${noun} is not present.`,
    });
  }

  const bgHint = backgroundJobHint(command);
  if (bgHint) {
    hints.push({ kind: 'background-job', message: bgHint });
  }

  return hints;
}