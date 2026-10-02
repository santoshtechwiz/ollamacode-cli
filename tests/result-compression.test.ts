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
  it('leaves a normal small result whole', () => {
    const text = 'OK read_file — src/index.ts\n  1 | export const a = 1;';
    assert.equal(compressToolOutput(text, 8000), text);
  });

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

  it('strips ANSI codes carrying a window title, which hold no text', () => {
    assert.equal(compressToolOutput('\u001B]0;some-title\u0007build succeeded', 8000), 'build succeeded');
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

  it('keeps short repeated lines, adjacent or not, because they are content', () => {
    const text = ['src/index.ts', 'total 0', 'src/index.ts', '    }', '    }', '  }', '  }'].join('\n');
    assert.equal(compressToolOutput(text, 8000), text);
  });

  it('treats differently indented long lines as different lines', () => {
    const line = 'const value = computeSomethingExpensive(input, options);';
    const text = [`    ${line}`, `        ${line}`].join('\n');
    assert.equal(compressToolOutput(text, 8000), text);
  });

  it('says a cut result was cut even when it also dropped repeats', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i} ${'x'.repeat(300)}`);
    const out = compressToolOutput([...lines, lines[0], 'done'].join('\n'), 600);

    assert.equal(out.length, 600);
    assert.match(out, CUT);
    assert.match(out, /…\[1 repeated line removed\]…/);
  });

  it('trims trailing whitespace and runs of blank lines', () => {
    assert.equal(compressToolOutput('first line   \n\n\n\n\nsecond line\t\n', 8000), 'first line\n\nsecond line\n');
  });

  it('collapses alignment padding but never indentation, however deep', () => {
    const padded = `column${' '.repeat(40)}value\n    indented`;
    assert.equal(compressToolOutput(padded, 8000), 'column value\n    indented');

    const deep = `    12\t${' '.repeat(24)}return value;`;
    assert.equal(compressToolOutput(deep, 8000), deep);
  });

  it('keeps an error, its code and its hint whole', () => {
    const text = [
      'ERROR exec_shell [EEXIT] — Command exited with code 1 at src/a.ts:10',
      'TypeError: cannot read properties of undefined',
      'Hint: check the argument shape',
    ].join('\n');
    assert.equal(compressToolOutput(text, 8000), text);
  });

  it('keeps the error head and the exit code when a failing result is too long to keep whole', () => {
    const text = [
      'ERROR exec_shell [EEXIT] — Command exited with code 1 at src/a.ts:10',
      ...Array.from({ length: 400 }, (_, i) => `frame ${i} at src/deep/module-${i}.js:${i}`),
      '[diagnostics]',
      '[exit 1]',
    ].join('\n');
    const out = compressToolOutput(text, 500);

    assert.ok(out.startsWith('ERROR exec_shell [EEXIT] — Command exited with code 1'), `lost the failure: ${out.slice(0, 80)}`);
    assert.match(out, /\[exit 1\]\n?$/, 'lost the exit code');
    assert.ok(out.length <= 500);
  });

  it('spends more of the budget on the end than the start', () => {
    const out = compressToolOutput('A'.repeat(4000) + '\n[exit 0]', 600);
    const markerAt = out.indexOf('\n…[');

    assert.ok(out.length - markerAt > markerAt, 'gave the head more room than the end');
    assert.match(out, /\[exit 0\]$/);
  });

  it('never splits a surrogate pair at a cut', () => {
    const out = compressToolOutput(`${'a'.repeat(50)}${'𝄞'.repeat(200)}${'b'.repeat(50)}`, 300);

    assert.match(out, CUT);
    assert.doesNotMatch(out, /\uD834(?![\uDC00-\uDFFF])/, 'left a lone high surrogate');
    assert.doesNotMatch(out, /(?<![\uD800-\uDBFF])\uDF1E/, 'left a lone low surrogate');
  });

  it('spends the whole budget, marker included', () => {
    assert.equal(compressToolOutput('x'.repeat(5000), 400).length, 400);
  });

  it('falls back to a hard cut when the budget cannot even hold the marker', () => {
    assert.equal(compressToolOutput('x'.repeat(500), 10), 'x'.repeat(10));
  });

  it('handles an empty result', () => {
    assert.equal(compressToolOutput('', 8000), '');
  });
});
