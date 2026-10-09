import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compressToolOutput } from '../src/context/result-compression';

const CUT = /\d+ chars omitted — start and end kept/;

/** A result shaped like the ones the turn actually stores: status, command, diagnostics, exit code. */
function shellResult(bodyLines: number, { exit = 0 }: { exit?: number } = {}): string {
  const middle = Array.from(
    { length: bodyLines },
    (_, i) => `src/module-${i}.ts:${i + 1}:0  info  checking module ${i}`,
  ).join('\n');
  return [
    'OK exec_shell — $ npm run build',
    middle,
    '[diagnostics]',
    `[exit ${exit}]`,
  ].join('\n');
}

describe('compressToolOutput', () => {

  it('keeps the head, the exit code and a truncation marker when the budget is exceeded', () => {
    const out = compressToolOutput(shellResult(500, { exit: 1 }), 600);

    assert.match(out, /^OK exec_shell — \$ npm run build/, 'lost the status and the command');
    assert.match(out, /\[exit 1\]$/, 'lost the exit code that ends the result');
    assert.match(out, CUT, 'never said that the middle was cut');
    assert.ok(out.length <= 600, `over budget: ${out.length}`);
  });

  it('strips ANSI escape codes', () => {
    const text = '\u001B[32mPASS\u001B[0m src/a.test.ts\n\u001B[1;31mFAIL\u001B[0m src/b.test.ts';
    assert.equal(compressToolOutput(text, 8000), 'PASS src/a.test.ts\nFAIL src/b.test.ts');
  });

  it('drops repeated long lines, keeps every distinct one, and says so', () => {
    const noise = 'a diagnostic line long enough to be recognised as duplicated noise';
    const text = [noise, 'src/a.ts:1:0 error something broke here', noise, 'src/b.ts:2:0 error and again', noise].join('\n');
    const out = compressToolOutput(text, 8000);

    assert.equal(out.match(/recognised as duplicated noise/g)?.length, 1, 'left the repeats in');
    assert.match(out, /src\/a\.ts:1:0 error something broke here/);
    assert.match(out, /src\/b\.ts:2:0 error and again/);
    assert.match(out, /…\[2 repeated lines removed\]…/);
  });

  it('collapses alignment padding but never indentation, however deep', () => {
    const padded = `column${' '.repeat(40)}value\n    indented`;
    assert.equal(compressToolOutput(padded, 8000), 'column value\n    indented');

    const deep = `    12\t${' '.repeat(24)}return value;`;
    assert.equal(compressToolOutput(deep, 8000), deep);
  });

  it('never splits a surrogate pair at a cut', () => {
    const out = compressToolOutput(`${'a'.repeat(50)}${'𝄞'.repeat(200)}${'b'.repeat(50)}`, 300);

    assert.match(out, CUT);
    assert.doesNotMatch(out, /\uD834(?![\uDC00-\uDFFF])/, 'left a lone high surrogate');
    assert.doesNotMatch(out, /(?<![\uD800-\uDBFF])\uDF1E/, 'left a lone low surrogate');
  });
});
