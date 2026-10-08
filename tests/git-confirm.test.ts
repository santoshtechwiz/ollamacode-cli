import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/tool/index';
import { shellConfirmReason } from '../src/tool/policy/mutation-policy';
import { defaultRegistry } from '../src/tool/execution/registry';

test('routine git commands are not asked about every time', () => {
  for (const c of ['git init', 'git add .', 'git add -A', 'git commit -m "first"', 'git checkout -b feat', 'git switch main',
    'git branch -d done', 'git stash', 'git stash pop', 'git reset', 'git restore --staged a.ts', 'git mv a b', 'git rm --cached a.ts']) {
    assert.equal(shellConfirmReason(c), null, c);
  }
});

test('git commands that reach a remote, rewrite the branch, or delete still are, with the reason', () => {
  const cases: Array<[string, RegExp]> = [
    ['git push', /remote/],
    ['git pull', /rewrites the branch/],
    ['git merge dev', /rewrites the branch/],
    ['git rebase main', /rewrites the branch/],
    ['git commit --amend -m x', /last commit/],
    ['git branch -D old', /deletes a branch/],
    ['git rm a.ts', /deletes files/],
    ['git checkout .', /discards/],
    ['git add . && git push', /remote/],
  ];
  for (const [c, why] of cases) assert.match(String(shellConfirmReason(c)), why, c);
});

test('the git tool asks every time only for a merge or a branch delete', () => {
  const git = defaultRegistry.find('git')!;
  const reason = (args: Record<string, unknown>) => git.confirmReason?.(args, { cwd: '/tmp', root: '/tmp' }) ?? null;
  for (const op of ['add', 'commit', 'checkout', 'stash', 'reset']) assert.equal(reason({ operation: op }), null, op);
  assert.equal(reason({ operation: 'branch', name: 'feat' }), null);
  assert.match(String(reason({ operation: 'merge', ref: 'dev' })), /rewrites the branch/);
  assert.match(String(reason({ operation: 'branch', name: 'old', delete: true })), /deletes a branch/);
});
