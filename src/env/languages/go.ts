import type { Language } from './types';

export const GO: Language = {
  id: 'go',
  label: 'Go',
  runtimes: [{ name: 'go', commands: ['go'] }],
  markers: ['go.mod'],
  manifests: ['go.sum'],
  extensions: ['.go'],
  commands: {
    test: (go) => [go, 'test', './...'],
    build: (go) => [go, 'build', './...'],
    check: (go) => [go, 'vet', './...'],
    lint: (go) => [go, 'vet', './...'],
    run: (go) => [go, 'run', '.'],
  },
  source: {
    symbols: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm],
    imports: [/import\s*\(\s*([\s\S]*?)\)/g, /^\s*"([^"]+)"/gm],
  },
};
