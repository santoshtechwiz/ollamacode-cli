import path from 'node:path';
import os from 'node:os';
import { parseCargo } from '../parsers/cargo';
import type { Language } from './types';

export const RUST: Language = {
  id: 'rust',
  label: 'Rust',
  runtimes: [
    { name: 'cargo', commands: ['cargo'] },
    { name: 'rustc', commands: ['rustc'] },
  ],
  searchPaths: [path.join(os.homedir(), '.cargo', 'bin')],
  markers: ['Cargo.toml'],
  manifests: ['Cargo.lock'],
  extensions: ['.rs'],
  commands: {
    test: (cargo) => [cargo, 'test'],
    build: (cargo) => [cargo, 'build'],
    check: (cargo) => [cargo, 'check'],
    lint: (cargo) => [cargo, 'clippy'],
    run: (cargo) => [cargo, 'run'],
  },
  commandPattern: /\b(?:cargo|rustc)\b/,
  parse: parseCargo,
  source: {
    symbols: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/gm],
    imports: [/^\s*use\s+([\w:]+)/gm],
  },
};
