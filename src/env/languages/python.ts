import fs from 'node:fs/promises';
import path from 'node:path';
import type { Language } from './types';

/**
 * The project chose ruff: a ruff config of its own, a [tool.ruff] section, or ruff in its dependencies. Run in a
 * project that never chose it, the lint check failed with "No module named ruff" and the model installed it with pip,
 * then rearranged the project's imports to ruff's taste.
 */
async function usesRuff(root: string): Promise<boolean> {
  const names = await fs.readdir(root).catch((): string[] => []);
  if (names.includes('ruff.toml') || names.includes('.ruff.toml')) return true;
  const declared = names.filter((n) => n === 'pyproject.toml' || n === 'setup.cfg' || n === 'Pipfile' || /^requirements.*\.(txt|in)$/i.test(n));
  for (const name of declared) {
    const text = await fs.readFile(path.join(root, name), 'utf8').catch(() => '');
    if (/^\s*\[tool\.ruff\b|(^|["'\s,=])ruff\b/m.test(text)) return true;
  }
  return false;
}

export const PYTHON: Language = {
  id: 'python',
  label: 'Python',
  runtimes: [
    { name: 'python', commands: (platform: string) => (platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) },
    { name: 'pip', commands: (platform: string) => (platform === 'win32' ? ['pip'] : ['pip3', 'pip']) },
    { name: 'uv', commands: ['uv'] },
  ],
  markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'],
  extensions: ['.py'],
  commands: {
    test: (py) => [py, '-m', 'pytest'],
    build: (py, marker) => (marker === 'pyproject.toml' ? [py, '-m', 'build'] : undefined),
    // Every file compiled, none run: a syntax error anywhere in the project, not only in what a test imports.
    // No backslashes in the pattern: it reaches PowerShell, cmd and bash alike, and only bash reads them as escapes.
    check: (py) => [py, '-m', 'compileall', '-q', '-x', 'venv|site-packages|node_modules|__pycache__', '.'],
    lint: (py) => [py, '-m', 'ruff', 'check', '.'],
  },
  uses: { lint: usesRuff },
  fileScoped: {
    lint: (py) => ({ argv: [py, '-m', 'ruff', 'check'], extensions: ['.py', '.pyi'] }),
  },
  source: {
    symbols: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
    imports: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  },
};
