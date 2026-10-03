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

// A test that waits on something that never comes fails after a deadline instead of holding the run forever, and a
// file whose tests are done exits even when a process or handle it started lingers (Windows is slow to let go).
// Older Nodes lack these flags, so each is passed only where this Node accepts it.
const supported = (flag) => spawnSync(process.execPath, [flag, '-e', ''], { stdio: 'ignore' }).status === 0;
const guards = ['--test-timeout=120000', '--test-force-exit'].filter(supported);

const args = ['--import', 'tsx', '--import', './tests/setup.ts', '--test', ...guards, ...process.argv.slice(2), ...found.sort()];
const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
