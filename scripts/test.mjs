// `npm test`: every tests/**/*.test.ts, so a new test file runs without being listed; Node 20's --test takes no glob and Windows npm expands none.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const found = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.test.ts')) found.push(relative(root, path));
  }
};
walk(join(root, 'tests'));

const args = ['--import', 'tsx', '--import', './tests/setup.ts', '--test', ...process.argv.slice(2), ...found.sort()];
const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
