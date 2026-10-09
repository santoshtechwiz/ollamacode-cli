import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdown } from '../src/ui/render/markdown';
import { setColorMode, visibleWidth } from '../src/ui/ansi';

setColorMode('off');

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
});
