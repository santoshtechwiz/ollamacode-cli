import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ToolRegistry } from '../src/tool/execution/registry';
import { buildToolIndex, briefOf, formatToolIndex } from '../src/tool/execution/tool-index';
import { ToolResolver, isResolved } from '../src/tool/execution/tool-resolver';
import { loadToolsSchema } from '../src/tool/core/load-tools.tool';
import { defineTool } from '../src/tool/core/defineTool';
import { TOOL_NAME } from '../src/protocol';
import type { ToolDef } from '../src/types';

function tool(name: string, overrides: Partial<ToolDef> = {}): ToolDef {
  return defineTool({
    name,
    category: 'filesystem',
    brief: `Brief for ${name}.`,
    description: `First sentence for ${name}. Second sentence that the index should not carry.`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', pathArg: true, description: 'Target path' } },
      required: ['path'],
    },
    execute: async () => ({ ok: true, kind: 'text', display: 'ok', data: {} }),
    ...overrides,
  });
}

function registryOf(...defs: ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const def of defs) registry.register(def);
  return registry;
}

describe('tool index', () => {
  it('carries only name, brief and category', () => {
    const index = buildToolIndex(registryOf(tool('read_file')));

    assert.equal(index.entries.length, 1);
    assert.deepEqual(Object.keys(index.entries[0]).sort(), ['brief', 'category', 'name']);
    assert.deepEqual(index.entries[0], {
      name: 'read_file',
      brief: 'Brief for read_file.',
      category: 'filesystem',
    });
  });

  it('never carries parameters, so an index costs a fraction of the schemas', () => {
    const registry = registryOf(tool('read_file'), tool('write_file', { category: 'filesystem' }));
    const index = buildToolIndex(registry);
    const wire = JSON.stringify([...registry.defs].map((d) => d.parameters));

    assert.ok(
      JSON.stringify(index.entries).length < wire.length,
      'index should be smaller than the parameter schemas it replaces',
    );
    assert.ok(!JSON.stringify(index).includes('properties'));
  });

  it("falls back to the description's first sentence and truncates a long one", () => {
    const long = 'x'.repeat(400);
    assert.equal(briefOf(tool('a', { brief: undefined, description: `${long}. Second.` })).length, 120);
    assert.equal(briefOf(tool('b', { brief: undefined, description: 'One. Two.' })), 'One.');
    assert.equal(briefOf(tool('c')), 'Brief for c.');
  });

  it('defaults a tool with no category to agent', () => {
    const index = buildToolIndex(registryOf(tool('mystery', { category: undefined })));
    assert.equal(index.entries[0].category, 'agent');
  });

  it('groups by category and renders one line per tool', () => {
    const index = buildToolIndex(
      registryOf(
        tool('read_file', { category: 'filesystem' }),
        tool('grep_content', { category: 'search' }),
      ),
    );

    assert.deepEqual(
      index.byCategory.get('filesystem')?.map((e) => e.name),
      ['read_file'],
    );
    assert.equal(formatToolIndex(index), 'filesystem:\n  read_file — Brief for read_file.\nsearch:\n  grep_content — Brief for grep_content.');
  });
});

describe('tool resolver', () => {
  const registry = registryOf(
    tool('read_file', { category: 'filesystem' }),
    tool('write_file', { category: 'filesystem' }),
    tool('grep_content', { category: 'search' }),
  );

  it('resolves a valid tool to its full schema on demand', () => {
    const resolver = new ToolResolver({ registry });
    const outcome = resolver.load('read_file');

    assert.ok(isResolved(outcome));
    assert.equal(outcome.name, 'read_file');
    assert.equal(outcome.schema.function.name, 'read_file');
    assert.deepEqual(
      Object.keys((outcome.schema.function.parameters as any).properties),
      ['path'],
    );
  });

  it('starts with no schemas loaded', () => {
    assert.deepEqual(new ToolResolver({ registry }).schemas(), []);
  });

  it('rejects a name the registry does not hold', () => {
    const resolver = new ToolResolver({ registry });
    const outcome = resolver.load('rm_minus_rf');

    assert.ok(!isResolved(outcome));
    assert.match(outcome.reason, /is registered/);
    assert.deepEqual(resolver.schemas(), [], 'a rejected name must load nothing');
  });

  it('strips process-only schema keys off the wire', () => {
    const resolver = new ToolResolver({ registry });
    const outcome = resolver.load('read_file');

    assert.ok(isResolved(outcome));
    assert.equal((outcome.schema.function.parameters as any).properties.path.pathArg, undefined);
  });

  it('resolves a name the model wrote loosely', () => {
    const resolver = new ToolResolver({ registry });

    assert.ok(isResolved(resolver.load('read-file')));
    assert.ok(isResolved(resolver.load('READ_FILE')));
  });

  it('loads several tools for one task in a single request', () => {
    const resolver = new ToolResolver({ registry });
    const outcomes = resolver.loadAll(['read_file', 'grep_content', 'write_file']);

    assert.deepEqual(outcomes.map((o) => o.name), ['read_file', 'grep_content', 'write_file']);
    assert.ok(outcomes.every(isResolved));
    assert.deepEqual(resolver.schemas().map((s) => s.function.name), [
      'read_file',
      'grep_content',
      'write_file',
    ]);
  });

  it('resolves a repeated name once and skips it from the cache', () => {
    const resolver = new ToolResolver({ registry });
    const outcomes = resolver.loadAll(['read_file', 'read-file', 'read_file']);

    assert.equal(outcomes.length, 1);
    assert.equal(resolver.schemas().length, 1);
  });

  it('caches a resolved schema for the turn and reuses the same object', () => {
    const resolver = new ToolResolver({ registry });
    const first = resolver.load('read_file');
    const second = resolver.load('read_file');

    assert.ok(isResolved(first) && isResolved(second));
    assert.equal(first.schema, second.schema, 'the cache should hand back the same schema');
    assert.equal(resolver.schemas().length, 1);
  });

  it('caches across load requests, so a second ask costs nothing', () => {
    const resolver = new ToolResolver({ registry });
    resolver.load('read_file');
    const afterFirst = resolver.schemas();
    resolver.loadAll(['read_file', 'grep_content']);

    assert.equal(resolver.schemas()[0], afterFirst[0], 'the first schema should survive the second load');
  });

  it('resolves only what the session allows, and says why not otherwise', () => {
    const resolver = new ToolResolver({
      registry,
      selectable: (def) => def.category === 'search',
    });

    assert.ok(isResolved(resolver.load('grep_content')));
    assert.ok(!isResolved(resolver.load('read_file')));
    assert.match((resolver.load('read_file') as any).reason, /not available/);
  });

  it('describes only what the session may load', () => {
    const resolver = new ToolResolver({
      registry,
      selectable: (def) => def.category === 'search',
    });

    assert.equal(resolver.describe(), 'search:\n  grep_content — Brief for grep_content.');
  });

  it('seeds an always tool straight into the cache, off the index', () => {
    const resolver = new ToolResolver({ registry, always: ['read_file'] });

    // Loaded up front, so a turn can start without spending a call on discovery.
    assert.equal(resolver.schemas().length, 1);
    assert.equal(resolver.schemas()[0]?.function.name, 'read_file');
    // Already on the wire in full, so listing it in the index would pay for it twice.
    assert.equal(
      resolver.describe(),
      'filesystem:\n  write_file — Brief for write_file.\nsearch:\n  grep_content — Brief for grep_content.',
    );
  });

  it('resolves an always tool the model spelled loosely', () => {
    const resolver = new ToolResolver({ registry, always: ['read-file'] });

    assert.equal(resolver.schemas()[0]?.function.name, 'read_file');
  });
});

describe('load_tools', () => {
  const registry = registryOf(tool('read_file'), tool('grep_content', { category: 'search' }));

  it('puts the index on the wire behind one call', () => {
    const resolver = new ToolResolver({ registry });
    const wire = loadToolsSchema(resolver.describe());

    assert.equal(wire.function.name, TOOL_NAME.LOAD_TOOLS);
    assert.match(wire.function.description, /read_file — Brief for read_file\./);
    assert.match(wire.function.description, /grep_content — Brief for grep_content\./);
    assert.deepEqual(wire.function.parameters.required, ['tools']);
  });

  it('advertises the index and nothing else until a tool is loaded', () => {
    const resolver = new ToolResolver({ registry });

    assert.equal(resolver.schemas().length, 0);
    resolver.load('read_file');
    assert.equal(resolver.schemas().length, 1);
  });
});
