import type { FileScopedCommand, StackInfo, ToolchainProvider } from '../../types';

/**
 * What a project can be asked to do, by name. The one list of them: a language fills the ones it has, the detector
 * maps each, and agent.afterEdit / agent.beforeDone take them as words. One more verb is one more entry here.
 */
export const VERBS = ['test', 'build', 'check', 'lint', 'run'] as const;
export type Verb = (typeof VERBS)[number];

/** The verbs that check work rather than run it: what agent.afterEdit and agent.beforeDone accept as words. */
export const CHECK_VERBS: readonly Verb[] = VERBS.filter((v) => v !== 'run');

/** Project commands built from the runtime command that was found (e.g. `python` or `py`) and the marker that identified the project. */
export type Command = (cmd: string, marker: string) => string[] | undefined;
export type Commands = Partial<Record<Verb, Command>>;

export interface Language extends ToolchainProvider {
  /** Files whose presence marks a project root. */
  markers?: string[];
  /** Marker names that vary per project, like `App.csproj`. */
  markerPattern?: RegExp;
  /** Dependency files besides the markers whose change means the project's packages changed. */
  manifests?: string[];
  /** Source file extensions; a project with no marker is still found by these. */
  extensions?: string[];
  commands?: Commands;
  /** Verbs whose command can be given files, built from the runtime command: `ruff check <files>`. */
  fileScoped?: Partial<Record<Verb, (cmd: string) => FileScopedCommand>>;
  /** Custom project detection when markers and commands are not enough. */
  detect?: (root: string) => Promise<StackInfo | null>;
  /** Folders a build writes inside the project (`bin/`, `obj/`, `dist/`): generated, never the project's own source. */
  outputDirs?: string[];
  /** Patterns the workspace index uses to find symbols and imports in source files. */
  source?: { symbols: RegExp[]; imports: RegExp[]; exportRe?: RegExp };
}
