import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../src/ui/render/markdown';
import { setColorMode, visibleWidth } from '../src/ui/ansi';

setColorMode('off');
const md = (text: string, width = 100) => renderMarkdown(text, width).join('\n');

describe('math, however the model writes it', () => {
  it('$…$ inline', () => assert.equal(md('The cost is $x_1 + x_2$ total.'), 'The cost is x₁ + x₂ total.'));
  it('\\(…\\) inline, the delimiter markdown used to eat', () =>
    assert.equal(md('The area is \\(\\pi r^2\\) for radius \\(r\\).'), 'The area is π r² for radius r.'));
  it('$$…$$ on its own lines', () =>
    assert.equal(md('Sum:\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\nDone.'), 'Sum:\n\n  ∑ᵢ₌₁ⁿ i = n(n+1)⁄2\n\nDone.'));
  it('\\[…\\] on its own lines', () => assert.equal(md('Formula:\n\n\\[\n\\frac{a}{b} = c\n\\]\n\nEnd.'), 'Formula:\n\n  a⁄b = c\n\nEnd.'));
  it('a boxed answer stays marked', () => assert.equal(md('So the answer is $\\boxed{42}$.'), 'So the answer is [42].'));
  it('operator names and \\text', () =>
    assert.equal(md('Runtime is $O(n \\log n)$ and $\\text{speed} = \\frac{d}{t}$.'), 'Runtime is O(n log n) and speed = d⁄t.'));
  it('underscores inside math are subscripts, not italics', () => assert.equal(md('Use $a_i b_i$ here.'), 'Use aᵢ bᵢ here.'));
});

describe('text that only looks like math is left alone', () => {
  it('prices', () => assert.equal(md('It costs $5 and $10 later, or $5-$10.'), 'It costs $5 and $10 later, or $5-$10.'));
  it('Windows paths', () => assert.equal(md('Open C:\\new\\to\\file.txt now.'), 'Open C:\\new\\to\\file.txt now.'));
  it('code spans', () => assert.equal(md('Run `echo $HOME $PATH` first.'), 'Run echo $HOME $PATH first.'));
});

describe('tables fit the terminal', () => {
  const wide = [
    '| Option | Description | When to use it | Cost |',
    '|---|---|---|---|',
    '| Docker | Packages the app with its runtime so it runs the same everywhere you deploy it | Production deploys and CI pipelines | Free for small teams |',
    '| Bare metal | Install the .NET runtime directly on the server and copy the build output | One server you fully control | Hardware only |',
  ].join('\n');

  it('a wide table wraps inside its columns instead of overflowing the line', () => {
    const lines = renderMarkdown(wide, 60);
    assert.ok(lines.every((line) => visibleWidth(line) <= 60), `widest line: ${Math.max(...lines.map(visibleWidth))}`);
    assert.ok(lines.some((line) => line.includes('Docker')) && lines.some((line) => line.includes('Bare metal')));
  });

  it('a table that already fits is drawn at its natural size', () => {
    const lines = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |', 80);
    assert.equal(Math.max(...lines.map(visibleWidth)), 9);
  });

  it('a terminal too narrow for any grid lists the rows instead', () => {
    const text = md(wide, 24);
    assert.match(text, /Option: Docker/);
    assert.doesNotMatch(text, /┌/);
  });

  it('math inside a table cell renders like math anywhere else', () => {
    const text = md('| Algorithm | Time |\n|---|---|\n| Merge sort | $O(n \\log n)$ |\n| Binary search | \\(O(\\log n)\\) |');
    assert.match(text, /O\(n log n\)/);
    assert.match(text, /O\(log n\)/);
    assert.doesNotMatch(text, /\\log|\\\(/);
  });
});
