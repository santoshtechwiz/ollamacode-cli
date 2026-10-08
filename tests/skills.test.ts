// Skills are folders of instructions: read from disk, offered through use_skill, and pointed at once per turn when a
// call works on a file a skill covers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { findSkill, loadSkills, parseSkill, skillDirs } from '../src/skills/loader';
import { skillNote } from '../src/skills/notes';

const SKILL = (name: string, extra = '') => `---\nname: ${name}\ndescription: does ${name} things\n${extra}---\nStep one.\n`;

function skillTree(tree: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-skills-'));
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe('reading a skill', () => {
  it('takes name, description, paths and instructions from SKILL.md', () => {
    const skill = parseSkill(SKILL('forms', 'paths: ["**/*.css", "src/**/*.html"]\n'), '/x');
    assert.equal(typeof skill, 'object');
    if (typeof skill === 'string') return;
    assert.equal(skill.name, 'forms');
    assert.equal(skill.description, 'does forms things');
    assert.equal(skill.instructions, 'Step one.');
    assert.equal(skill.matches('a/b/site.css'), true);
    assert.equal(skill.matches('src/pages/index.html'), true);
    assert.equal(skill.matches('docs/index.html'), false);
  });

  it('says why a file is not a skill', () => {
    assert.match(String(parseSkill('Step one.', '/x')), /no header/);
    assert.match(String(parseSkill('---\nname: Bad Name\ndescription: d\n---\nx', '/x')), /lowercase/);
    assert.match(String(parseSkill('---\nname: ok\n---\nx', '/x')), /no description/);
    assert.match(String(parseSkill('---\nname: ok\ndescription: d\npaths: "*.css"\n---\nx', '/x')), /list of globs/);
    assert.match(String(parseSkill('---\nname: ok\ndescription: d\n---\n  ', '/x')), /no instructions/);
  });

  it('lets a later folder replace a skill of the same name and skips broken ones', () => {
    const a = skillTree({ 'one/SKILL.md': SKILL('one'), 'two/SKILL.md': SKILL('two'), 'bad/SKILL.md': 'nothing' });
    const b = skillTree({ 'mine/SKILL.md': SKILL('two').replace('Step one.', 'My own steps.') });
    try {
      const found = loadSkills([a, path.join(a, 'missing'), b]);
      assert.deepEqual(found.map((s) => s.name), ['one', 'two']);
      assert.equal(found[1].instructions, 'My own steps.');
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('looks in the built-in folder, then the person\'s, then the project\'s', () => {
    const dirs = skillDirs('/work/app');
    assert.equal(dirs.length, 3);
    assert.ok(fs.existsSync(path.join(dirs[0], 'ui-ux', 'SKILL.md')), 'the built-in skills ship with ocode');
    assert.match(dirs[1], /\.ollamacode[\\/]skills$/);
    assert.equal(dirs[2], path.join('/work/app', '.ocode', 'skills'));
  });
});

describe('the ui-ux skill', () => {
  it('covers web UI files and nothing else', () => {
    const skill = findSkill('ui-ux')!;
    assert.ok(skill, 'built in');
    for (const rel of ['index.html', 'src/App.tsx', 'styles/site.scss', 'web/Card.vue', 'tailwind.config.js']) assert.equal(skill.matches(rel), true, rel);
    for (const rel of ['main.go', 'src/server.ts', 'README.md']) assert.equal(skill.matches(rel), false, rel);
  });
});

describe('use_skill', () => {
  const run = async (args: Record<string, unknown>) =>
    (await createExecutor({ root: os.tmpdir(), state: createWorkspaceState(os.tmpdir()) }).run('use_skill', args)).result;

  it('returns the instructions and lists the skill\'s files', async () => {
    const r = await run({ name: 'ui-ux' });
    assert.equal(r.ok, true, r.error);
    assert.match(r.display, /^Follow these steps in order\./);
    assert.match(r.display, /Files in this skill \(read one with use_skill file\): tokens\.css$/);
  });

  it('reads one of the skill\'s files', async () => {
    const r = await run({ name: 'ui-ux', file: 'tokens.css' });
    assert.equal(r.ok, true, r.error);
    assert.match(r.display, /--color-accent:/);
  });

  it('names what exists when asked for something that does not', async () => {
    const noFile = await run({ name: 'ui-ux', file: '../../package.json' });
    assert.equal(noFile.ok, false);
    assert.match(noFile.hint, /Its files: tokens\.css/);
  });
});

describe('pointing at a skill', () => {
  const ui = parseSkill(SKILL('ui', 'paths: ["**/*.css"]\n'), '/x');
  const find = (rel: string) => (typeof ui !== 'string' && ui.matches(rel) ? [ui] : []);

  it('points once per skill per turn, and not at files no skill covers', () => {
    const noted = new Set<string>();
    assert.equal(skillNote(['main.go'], noted, find), undefined);
    assert.match(String(skillNote(['a.css'], noted, find)), /The ui skill covers a\.css \(does ui things\)\. .*use_skill with name "ui"/);
    assert.equal(skillNote(['b.css'], noted, find), undefined, 'already pointed at this turn');
  });

  it('rides on the result of the first call in a turn that works on a covered file', async () => {
    const replies = [
      [['read_file', { path: 'main.go' }]],
      [['read_file', { path: 'src/App.tsx' }]],
      [['read_file', { path: 'src/site.css' }]],
    ];
    let asked = 0;
    const result: any = await runTurn({
      model: 'test',
      history: new ContextStore({ messages: [], budgetTokens: 8000 }),
      config: { maxIterations: 8 },
      toolsEnabled: true,
      toolsAllowed: true,
      state: { todos: [], changeSeq: 0 },
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          const calls = replies[asked++];
          const toolCalls = (calls ?? []).map(([name, args], k) => ({ id: `${asked}-${k}`, type: 'function', function: { name, arguments: args } }));
          return { result: { content: calls ? '' : 'Done.', toolCalls, finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { return { result: { ok: true, kind: 'text', display: 'contents' } }; } } as any,
    } as any);
    const notes = result.toolResults.map((t: any) => t.result.modelNote);
    assert.equal(notes[0], undefined, 'a Go file is no skill\'s');
    assert.match(String(notes[1]), /The ui-ux skill covers src[\\/]App\.tsx/);
    assert.equal(notes[2], undefined, 'once per turn');
  });
});
