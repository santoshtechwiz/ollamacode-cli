// How one turn answers repeated calls, and what the model reads back from a few tools.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { STOP_REASONS } from '../src/protocol';
import { renderToolResult } from '../src/agent/router/render';

/** A workspace state as the runtime leaves it at the start of a turn. */
function stateFor(): any {
  return { todos: [], changeSeq: 0 };
}

describe('repeated calls in a turn', () => {
  function turnWith(replies: any[][], state: any, onRun: (name: string) => any) {
    let asked = 0;
    return runTurn({
      model: 'test',
      history: new ContextStore({ messages: [], budgetTokens: 8000 }),
      config: { maxIterations: 8 },
      toolsEnabled: true,
      toolsAllowed: true,
      state,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          const calls = replies[asked++];
          const toolCalls = (calls ?? []).map(([name, args], k) => ({ id: `${asked}-${k}`, type: 'function', function: { name, arguments: args } }));
          return { result: { content: calls ? '' : 'Done.', toolCalls, finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run(name: string) { return { result: onRun(name) }; } } as any,
    } as any);
  }

  it('a read repeated with nothing changed in between is answered from the first, and says so', async () => {
    let runs = 0;
    const result: any = await turnWith(
      [[['read_file', { path: 'a.ts' }]], [['list_directory', { path: '.' }]], [['read_file', { path: 'a.ts' }]]],
      stateFor(),
      () => { runs++; return { ok: true, kind: 'text', display: 'contents' }; },
    );
    assert.equal(runs, 2, 'read_file ran once, list_directory once');
    assert.equal(result.toolResults.length, 3, 'every call still gets exactly one result');
    assert.match(String(result.toolResults[2].result.modelNote), /Not run again/);
  });

  it('a read after the workspace changed runs again', async () => {
    const state = stateFor();
    let runs = 0;
    await turnWith(
      [[['read_file', { path: 'a.ts' }]], [['list_directory', { path: '.' }]], [['read_file', { path: 'a.ts' }]]],
      state,
      (name) => {
        runs++;
        // A change recorded between the two reads, as a write (or the person editing the file) records one.
        if (name === 'list_directory') state.changeSeq += 1;
        return { ok: true, kind: 'text', display: 'ok' };
      },
    );
    assert.equal(runs, 3);
  });

  it('a failed read sent again runs again', async () => {
    let runs = 0;
    await turnWith(
      [[['read_file', { path: 'a.ts' }]], [['read_file', { path: 'a.ts' }]]],
      stateFor(),
      () => { runs++; return { ok: false, kind: 'text', error: 'ENOENT' }; },
    );
    assert.equal(runs, 2);
  });

  it('two failing calls taking turns stop on the 4th time one comes with nothing changed', async () => {
    let runs = 0;
    const a = ['list_directory', { path: 'TodoApi' }];
    const b = ['list_directory', { path: 'TodoApi/TodoApi.Tests' }];
    const result: any = await turnWith([[a], [b], [a], [b], [a], [b], [a], [b]], stateFor(), () => {
      runs++;
      return { ok: false, kind: 'text', error: 'exited with code 1' };
    });
    assert.equal(runs, 6, 'each ran three times');
    assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
  });

  it('a read of a file edited outside the session, with nothing recorded, runs again', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-stamps-'));
    try {
      const file = path.join(root, 'a.ts');
      fs.writeFileSync(file, 'one');
      const state = { ...stateFor(), root };
      let runs = 0;
      await turnWith(
        [[['read_file', { path: 'a.ts' }]], [['list_directory', { path: '.' }]], [['read_file', { path: 'a.ts' }]]],
        state,
        (name) => {
          runs++;
          // The person saves the file in their editor between the two reads; the session records no change.
          if (name === 'list_directory') fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
          return { ok: true, kind: 'text', display: 'x' };
        },
      );
      assert.equal(state.changeSeq, 0, 'nothing was recorded');
      assert.equal(runs, 3, 'the second read ran, because the file is newer');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('a new file is not echoed back to the model', () => {
  it('the person sees its listing; the model reads only that it was created', async () => {
    const { default: writeFile } = await import('../src/tool/filesystem/write-file.tool');
    const { describeToolResult } = await import('../src/ui/tool-preview');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-newfile-'));
    try {
      const ctx: any = { root, ws: { rel: (abs: string) => path.relative(root, abs).split(path.sep).join('/') }, state: { note() {} } };
      const created: any = await writeFile.execute({ path: path.join(root, 'a.js'), content: 'const unique_marker = 1;\n' }, ctx);
      assert.equal(created.ok, true, created.error);
      const forModel = renderToolResult(created, 'write_file');
      assert.match(forModel, /Created a\.js/);
      assert.doesNotMatch(forModel, /unique_marker/, 'the model already has the text it sent');
      const view = describeToolResult('write_file', created);
      assert.match([view.title, ...view.detail].join('\n'), /unique_marker/, 'the person still sees the new file');

      const changed: any = await writeFile.execute({ path: path.join(root, 'a.js'), content: 'const other_marker = 2;\n' }, ctx);
      assert.match(renderToolResult(changed, 'write_file'), /other_marker/, 'an overwrite still shows the model its diff');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('an edit that writes a block twice', () => {
  async function edit(content: string, search: string, replace: string) {
    const { default: editFile } = await import('../src/tool/filesystem/edit-file.tool');
    const { noteSeen } = await import('../src/tool/filesystem/_seen');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-twice-'));
    const file = path.join(root, 'client.js');
    fs.writeFileSync(file, content);
    const state: any = { note() {} };
    noteSeen(state, 'client.js');
    const ctx: any = { root, ws: { rel: (abs: string) => path.relative(root, abs).split(path.sep).join('/') }, state };
    const result: any = await editFile.execute({ path: file, search, replace }, ctx);
    const after = fs.readFileSync(file, 'utf8');
    fs.rmSync(root, { recursive: true, force: true });
    return { result, after };
  }

  // Whole statements, so the doubled file still parses: only the repeat check can catch it.
  const block = "init();\nsocket.on('connect', onConnect);\nsocket.on('users', onUsers);\nsocket.on('message', onMessage);\n";

  it('is refused when search names only its first line and replace is the whole block again', async () => {
    const { result, after } = await edit(block, 'init();\n', block);
    assert.equal(result.ok, false);
    assert.match(result.error, /writes lines \d+-\d+ again/);
    assert.equal(after, block, 'nothing was written');
  });

  it('one repeated line is still written, with the warning', async () => {
    const { result, after } = await edit("a();\nb();\n", 'a();\n', 'a();\nb();\n');
    assert.equal(result.ok, true);
    assert.match(result.display, /now appears twice/);
    assert.equal(after, 'a();\nb();\nb();\n');
  });
});
