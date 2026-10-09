import { parsePytest } from '../parsers/python';
import type { Language } from './types';

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
  commandPattern: /pytest|python/,
  parse: parsePytest,
  source: {
    symbols: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
    imports: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  },
};
