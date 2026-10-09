import path from 'node:path';
import { readdirSync } from 'node:fs';
import { LANGUAGES, type Language } from './languages';

// Where projects are in a workspace: which files mark one, which folder a file's project is, what a build writes.

/** Other ecosystems whose projects we recognise and index, but have no toolchain support for yet. */
const OTHER_MARKERS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'composer.json', 'Gemfile'];

const MARKER_FILES: ReadonlySet<string> = new Set([...LANGUAGES.flatMap((l) => l.markers ?? []), ...OTHER_MARKERS]);

/** Does this filename mark the root of a project? */
export function isProjectMarker(basename: string): boolean {
  return MARKER_FILES.has(basename) || LANGUAGES.some((l) => l.markerPattern?.test(basename));
}

/** Does this folder hold a project marker (package.json, go.mod, a .csproj …)? An unreadable folder does not. */
export function holdsProjectMarker(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => isProjectMarker(name));
  } catch {
    return false;
  }
}

/** The direct subfolders of `dir` that hold a project marker, as absolute paths. */
export function projectDirsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(dir, e.name))
      .filter((sub) => holdsProjectMarker(sub));
  } catch {
    return [];
  }
}

/** The nearest folder at or above `abs`, up to `root`, that holds a project marker; null when none does. */
export function projectFolderOf(root: string, abs: string): string | null {
  const top = path.resolve(root);
  // Inside the root by path.relative, which holds for a drive root (C:\) and for a differently-cased drive letter.
  const within = (dir: string) => {
    const rel = path.relative(top, dir);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  let dir = path.resolve(abs);
  if (!holdsProjectMarker(dir)) dir = path.dirname(dir);
  while (within(dir)) {
    if (holdsProjectMarker(dir)) return dir;
    if (path.relative(top, dir) === '') break;
    dir = path.dirname(dir);
  }
  return null;
}

/** Files whose change means a project's dependencies changed. */
export const MANIFEST_FILES: ReadonlySet<string> = new Set([...MARKER_FILES, ...LANGUAGES.flatMap((l) => l.manifests ?? [])]);

/** The build output folders of every kind of project rooted at `root`, as absolute paths. */
export function outputDirsAt(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const rootedHere = (language: Language) =>
    names.some((name) => language.markers?.includes(name) || language.markerPattern?.test(name));
  return LANGUAGES.filter((language) => language.outputDirs?.length && rootedHere(language))
    .flatMap((language) => language.outputDirs!.map((dir) => path.join(root, dir)));
}
