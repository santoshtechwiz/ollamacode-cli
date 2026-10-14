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

const TEST_FILE = /^(test_.+|.+_test)\.py$/;

/**
 * The project has tests for pytest to run: a pytest config, a conftest.py, or test files (test_*.py, *_test.py) at the
 * root or in a folder up to two levels down. Offered pytest in a project with none, a model ran it, got "no tests ran"
 * (exit 5), and read that as a failure to fix.
 */
async function hasTests(root: string): Promise<boolean> {
  const names = await fs.readdir(root).catch((): string[] => []);
  if (names.some((n) => n === 'conftest.py' || n === 'pytest.ini' || TEST_FILE.test(n))) return true;
  for (const name of ['pyproject.toml', 'setup.cfg', 'tox.ini'].filter((n) => names.includes(n))) {
    const text = await fs.readFile(path.join(root, name), 'utf8').catch(() => '');
    if (/^\s*\[(tool\.pytest|tool:pytest|pytest)\b/m.test(text)) return true;
  }
  const look = async (dir: string, depth: number): Promise<boolean> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isFile() && TEST_FILE.test(e.name)) return true;
      if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && !['venv', 'node_modules', '__pycache__', 'site-packages'].includes(e.name)) {
        if (await look(path.join(dir, e.name), depth - 1)) return true;
      }
    }
    return false;
  };
  return look(root, 2);
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
  uses: { lint: usesRuff, test: hasTests },
  fileScoped: {
    lint: (py) => ({ argv: [py, '-m', 'ruff', 'check'], extensions: ['.py', '.pyi'] }),
  },
  source: {
    symbols: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
    imports: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  },
};
