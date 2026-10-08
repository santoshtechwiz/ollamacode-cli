import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BackgroundInbox, type BackgroundExit } from '../src/tool/process/background-inbox';
import { createBackgroundHandoff, MAX_AUTO_HANDOFFS } from '../src/cli/chat/background-handoff';

const exit = (id: string): BackgroundExit => ({
  id, command: `run ${id}`, outcome: 'finished', exitCode: 0, signal: null, durationMs: 11_000, tail: 'FizzBuzz', endedAt: Date.now(),
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function chat(over: { busy?: boolean; typing?: boolean; unfinished?: boolean } = {}) {
  const background = new BackgroundInbox();
  const state = { busy: false, typing: false, unfinished: false, ...over };
  const notes: string[] = [];
  const turns: string[] = [];
  const handoff = createBackgroundHandoff({
    background,
    busy: () => state.busy,
    queued: () => false,
    typing: () => state.typing,
    lastTurnUnfinished: () => state.unfinished,
    note: (text) => notes.push(text),
    echo: () => {},
    // What executeTurn does with the inbox: the request shows the exits, the finished turn settles them.
    runTurn: async (text) => {
      turns.push(text);
      background.markShown();
      background.settle();
    },
    afterTurn: async () => handoff.handOff(),
  });
  return { background, state, notes, turns, handoff };
}

describe('background results reach the agent without anyone typing', () => {
  it('an idle chat hands the result to the agent and says so', async () => {
    const c = chat();
    c.background.record(exit('fizzbuzz'));
    await tick();
    assert.match(c.notes[0], /^background "fizzbuzz" finished \(exit 0\) after 11s — passing it to the agent now\nFizzBuzz$/);
    assert.deepEqual(c.turns, ['background "fizzbuzz" finished (exit 0) after 11s']);
  });

  it('says when a process starts that nobody needs to type anything', () => {
    const c = chat();
    c.background.watching({ id: 'fizzbuzz', command: 'cargo run' });
    assert.match(c.notes[0], /"fizzbuzz" is still running, so it carries on in the background .* no need to type anything/);
  });

  it('exits that land together go to the agent in one turn', async () => {
    const c = chat();
    c.background.record(exit('build'));
    c.background.record(exit('tests'));
    await tick();
    assert.equal(c.turns.length, 1);
    assert.match(c.turns[0], /"build".*; .*"tests"/);
  });

  it('a running turn gets it itself; one that already asked its last gets it as soon as it ends', async () => {
    const c = chat({ busy: true });
    c.background.record(exit('late'));
    await tick();
    assert.match(c.notes[0], /the agent gets it with this turn/);
    assert.deepEqual(c.turns, [], 'no second turn while one runs');
    c.state.busy = false;
    await c.handoff.handOff();
    assert.equal(c.turns.length, 1);
  });

  it('does not pick up after a stopped or failed turn, or while the person is typing', async () => {
    for (const over of [{ unfinished: true }, { typing: true }]) {
      const c = chat(over);
      c.background.record(exit('job'));
      await tick();
      assert.match(c.notes[0], /the agent will see it with your next message/);
      assert.deepEqual(c.turns, []);
    }
  });

  it('stops after a few in a row with nobody typing, until the person speaks', async () => {
    const c = chat();
    for (let i = 0; i <= MAX_AUTO_HANDOFFS; i++) {
      c.background.record(exit(`job${i}`));
      await tick();
    }
    assert.equal(c.turns.length, MAX_AUTO_HANDOFFS);
    assert.match(c.notes.at(-1)!, /with your next message/);
    c.handoff.personSpoke();
    await c.handoff.handOff();
    assert.equal(c.turns.length, MAX_AUTO_HANDOFFS + 1, 'the waiting result goes once the person is back');
  });
});
