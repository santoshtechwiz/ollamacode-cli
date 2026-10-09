import path from 'node:path';
import fs from 'node:fs/promises';
import { parseDotnet } from '../parsers/dotnet';
import type { StackInfo } from '../../types';
import type { Language } from './types';

const DOTNET_PROJECT = /\.(sln|slnx|csproj|fsproj|vbproj)$/i;
const MAX_SIBLINGS_FOR_NESTED_DOTNET_SCAN = 8;

async function detectDotnet(root: string): Promise<StackInfo | null> {
  const project = await findDotnetProject(root);
  if (!project) return null;
  return { id: 'dotnet', label: 'C# / .NET', root, marker: path.basename(project), test: ['dotnet', 'test'], build: ['dotnet', 'build'], check: ['dotnet', 'build'], run: ['dotnet', 'run'] };
}

async function findDotnetProject(root: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const direct = entries.find((e) => e.isFile() && /\.(sln|slnx|csproj|fsproj)$/i.test(e.name));
    if (direct) return path.join(root, direct.name);
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'bin', 'obj'].includes(e.name));
    if (subdirs.length > MAX_SIBLINGS_FOR_NESTED_DOTNET_SCAN) return null;
    for (const entry of subdirs) {
      const nested = await fs.readdir(path.join(root, entry.name), { withFileTypes: true }).catch((): import('node:fs').Dirent[] => []);
      const hit = nested.find((e) => e.isFile() && /\.(csproj|fsproj)$/i.test(e.name));
      if (hit) return path.join(root, entry.name, hit.name);
    }
  } catch { /* unreadable root: not a .NET project */ }
  return null;
}

export const DOTNET: Language = {
  id: 'dotnet',
  label: 'C# / .NET',
  runtimes: [{ name: 'dotnet', commands: ['dotnet'] }],
  markerPattern: DOTNET_PROJECT,
  extensions: ['.cs'],
  outputDirs: ['bin', 'obj'],
  detect: detectDotnet,
  commandPattern: /dotnet\b/,
  parse: parseDotnet,
  source: {
    symbols: [
      /^\s*(?:public|internal|private|protected)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*?(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/gm,
      /^\s*namespace\s+([A-Za-z_][\w.]*)/gm,
    ],
    imports: [/^\s*using\s+([A-Za-z_][\w.]*)\s*;/gm],
  },
};
