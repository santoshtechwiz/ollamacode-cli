import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInit } from '../src/cli/commands/cmds/init';

// /init over a throwaway project; `turn` stands in for the chat turn the command runs.
function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-init-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  return root;
}

function context(root: string, mode: { planMode?: boolean; askMode?: boolean; reviewMode?: boolean }, turn: (ctx: any) => Promise<any>) {
  const out: string[] = [];
  const turns: any[] = [];
  const ctx: any = {
    planMode: false, askMode: false, reviewMode: false, ...mode,
    workspace: { state: { root } },
    flags: { yes: true },
    write: (t: string) => out.push(t),
    confirm: async () => true,
    runOneTurn: async () => {
      turns.push({ planMode: ctx.planMode, askMode: ctx.askMode, reviewMode: ctx.reviewMode });
      return turn(ctx);
    },
  };
  return { ctx, out, turns };
}

const writesDoc = (root: string) => async () => {
  fs.writeFileSync(path.join(root, 'OLLAMACODE.md'), '# Project\n');
  return { cancelled: false };
};

describe('/init', () => {
  it('writes the doc in Agent mode even when the chat is in Ask mode, then puts Ask back', async () => {
    const root = project({ 'package.json': '{"name":"x","scripts":{"test":"node --test"}}', 'index.js': 'console.log(1)\n' });
    const t = context(root, { askMode: true }, writesDoc(root));
    await runInit(t.ctx);
    assert.deepEqual(t.turns[0], { planMode: false, askMode: false, reviewMode: false }, 'the write ran in Agent mode');
    assert.ok(fs.existsSync(path.join(root, 'OLLAMACODE.md')));
    assert.equal(t.ctx.askMode, true, 'the person\'s mode came back');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stops when the person cancels, without retrying or blaming the model', async () => {
    const root = project({ 'index.js': 'console.log(1)\n' });
    const t = context(root, {}, async () => ({ cancelled: true }));
    await runInit(t.ctx);
    assert.equal(t.turns.length, 1, 'no second turn after a cancel');
    assert.match(t.out.join(''), /stopped/);
    assert.doesNotMatch(t.out.join(''), /did not write OLLAMACODE\.md, even after a retry/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not ask the model to document an empty project', async () => {
    const root = project({});
    const t = context(root, {}, writesDoc(root));
    await runInit(t.ctx);
    assert.equal(t.turns.length, 0);
    assert.match(t.out.join(''), /empty/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
