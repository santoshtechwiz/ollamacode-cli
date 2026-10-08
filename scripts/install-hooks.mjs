// `npm install` points git at the shared hooks in .githooks (see docs/BRANCHING.md). Outside a git checkout, such as
// an installed package, there is nothing to set and nothing fails.
import { spawnSync } from 'node:child_process';

const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (inRepo.status === 0 && inRepo.stdout.trim() === 'true') {
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
}
