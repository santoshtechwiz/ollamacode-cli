// Front-end frameworks are rows in one table: detected from package.json, they name the stack and widen what ESLint reads.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FRAMEWORKS, eslintFiles, frameworksOf } from '../src/env/frameworks';

const labels = (deps: Record<string, string>, dev: Record<string, string> = {}) => frameworksOf({ dependencies: deps, devDependencies: dev }).map((f) => f.label);

describe('frameworksOf', () => {
  it('names the most specific framework, not the one it is built on', () => {
    assert.deepEqual(labels({ next: '16', react: '19' }), ['Next.js']);
    assert.deepEqual(labels({ nuxt: '3', vue: '3' }), ['Nuxt']);
    assert.deepEqual(labels({}, { '@sveltejs/kit': '2', svelte: '5' }), ['SvelteKit']);
    assert.deepEqual(labels({ react: '19' }), ['React']);
    assert.deepEqual(labels({ '@angular/core': '20' }), ['Angular']);
    assert.deepEqual(labels({ express: '5' }), []);
  });
});

describe('eslintFiles', () => {
  it('lints scripts, and a framework\'s own files only when its ESLint plugin is installed', () => {
    assert.equal(eslintFiles({ dependencies: { vue: '3' } }), undefined, 'no ESLint, nothing to run');
    const plain = eslintFiles({ dependencies: { vue: '3' }, devDependencies: { eslint: '9' } })!;
    assert.deepEqual(plain.argv, ['npx', 'eslint']);
    assert.equal(plain.extensions.includes('.vue'), false);
    const withPlugins = eslintFiles({ devDependencies: { eslint: '9', 'eslint-plugin-vue': '9', 'angular-eslint': '20' } })!;
    assert.ok(withPlugins.extensions.includes('.vue') && withPlugins.extensions.includes('.html') && withPlugins.extensions.includes('.tsx'));
  });
});

describe('the FRAMEWORKS table', () => {
  it('has unique ids, and builtOn names only rows that exist', () => {
    const ids = FRAMEWORKS.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const f of FRAMEWORKS) for (const base of f.builtOn ?? []) assert.ok(ids.includes(base), `${f.id} is built on ${base}`);
  });
});
