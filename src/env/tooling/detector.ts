import path from 'node:path';
import fs from 'node:fs/promises';

import { logger } from '../../core/logger';

import { detectOne, exists } from './probe';
import { getProviders } from './registry';
import { type Language } from '../languages';
import { isProjectMarker } from '../project-layout';
import { walkFiles } from '../../tool/filesystem/_fs';
import type { StackInfo } from '../../types';

export async function detectRuntimes(): Promise<Record<string, import('../../types.ts').RuntimeInfo>> {
  const jobs: Promise<[string, import('../../types.ts').RuntimeInfo]>[] = [];
  for (const provider of getProviders()) {
    for (const rt of provider.runtimes) {
      jobs.push(
        detectOne(rt.name, rt.commands, rt.args ?? ['--version'], {
          searchPaths: provider.searchPaths,
        }).then((info) => [rt.name, info])
      );
    }
  }
  return Object.fromEntries(await Promise.all(jobs));
}

async function findSourceMarker(root: string, extensions: string[], depth: number): Promise<string | null> {
  const ignore = new Set([
    'node_modules',
    '.git',
    '.tc-llm',
    '__pycache__',
    '.venv',
    'venv',
    'bin',
    'obj',
    '.ollamacode',
  ]);
  const want = new Set(extensions.map((e) => e.toLowerCase()));
  async function scan(dir: string, remaining: number): Promise<string | null> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.isFile() && want.has(path.extname(e.name).toLowerCase())) {
        return path.relative(root, path.join(dir, e.name)) || e.name;
      }
    }
    if (remaining <= 0) return null;
    for (const e of entries) {
      if (!e.isDirectory() || ignore.has(e.name) || e.name.startsWith('.')) continue;
      const hit = await scan(path.join(dir, e.name), remaining - 1);
      if (hit) return hit;
    }
    return null;
  }
  return scan(root, depth);
}

// A language without custom detection is found by a marker file, or failing that by source files near the root.
async function detectByMarkers(root: string, lang: Language): Promise<StackInfo | null> {
  let marker: string | null = null;
  for (const m of lang.markers ?? []) {
    if (await exists(path.join(root, m))) {
      marker = m;
      break;
    }
  }
  marker ??= await findSourceMarker(root, lang.extensions ?? [], 2);
  if (!marker) return null;

  const main = lang.runtimes[0];
  const runtime = await detectOne(main.name, main.commands);
  const candidates = typeof main.commands === 'function' ? main.commands(process.platform) : main.commands;
  const cmd = runtime.command ?? candidates[0];
  const c = lang.commands ?? {};
  return {
    id: lang.id,
    label: lang.label,
    root,
    marker,
    test: c.test?.(cmd, marker),
    build: c.build?.(cmd, marker),
    check: c.check?.(cmd, marker),
    lint: c.lint?.(cmd, marker),
    run: c.run?.(cmd, marker),
  };
}

export async function detectStacks(root: string): Promise<StackInfo[]> {
  const stacks: StackInfo[] = [];
  for (const lang of getProviders()) {
    const found = lang.detect ? await lang.detect(root) : lang.markers || lang.extensions ? await detectByMarkers(root, lang) : null;
    if (found) stacks.push(found);
  }
  logger.debug(`detected stacks: ${stacks.map((s) => s.id).join(', ') || 'none'}`);
  return stacks;
}

/**
 * The stacks of a whole workspace: the root's, and those of every folder below it that holds a project marker
 * (package.json, a .csproj, main.tf …), as the workspace index finds projects. detectStacks looks at one folder.
 */
export async function detectWorkspaceStacks(root: string): Promise<StackInfo[]> {
  const dirs = new Set<string>([path.resolve(root)]);
  for await (const { abs } of walkFiles(root, { maxDepth: 6 })) {
    if (isProjectMarker(path.basename(abs))) dirs.add(path.dirname(abs));
  }
  const seen = new Set<string>();
  const stacks: StackInfo[] = [];
  for (const dir of dirs) {
    for (const s of await detectStacks(dir)) {
      const key = `${s.id}@${path.resolve(s.root)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stacks.push(s);
    }
  }
  return stacks;
}
