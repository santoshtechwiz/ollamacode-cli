import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modeOf, nextMode, setMode, withoutMode, modeNotice } from '../src/cli/chat/mode';
import { runAsk } from '../src/cli/commands/cmds/ask';
import { runPlan } from '../src/cli/commands/cmds/plan';
import { runReview } from '../src/cli/commands/cmds/review';

const session = (mode: 'agent' | 'plan' | 'ask' | 'review' = 'agent') => {
  const s: any = { planMode: false, askMode: false, reviewMode: false, announcedMode: mode, persist: () => {} };
  setMode(s, mode);
  return s;
};

describe('mode', () => {
  it('cycling says nothing; the first message in the new mode says it once', () => {
    const s = session('agent');
    setMode(s, nextMode(modeOf(s)));
    setMode(s, nextMode(modeOf(s)));
    assert.equal(modeOf(s), 'ask');
    assert.equal(modeNotice(s), 'Ask · read-only — was Agent', 'one line, from where the chat last was');
    assert.equal(modeNotice(s), null, 'and only once');
  });

  it('cycling back to where the chat last was says nothing at all', () => {
    const s = session('agent');
    for (let i = 0; i < 3; i++) setMode(s, nextMode(modeOf(s)));
    assert.equal(modeOf(s), 'agent');
    assert.equal(modeNotice(s), null);
  });

  it('an approved plan switching to Agent says why', () => {
    const s = session('plan');
    setMode(s, 'agent');
    assert.equal(modeNotice(s, 'switched to carry out the approved plan'), 'Agent — was Plan · read-only · switched to carry out the approved plan');
  });

  it('the commands go through the one owner and never leave two modes on', async () => {
    const s = session('plan');
    await runAsk(s, '');
    assert.deepEqual([s.planMode, s.askMode, s.reviewMode], [false, true, false]);
    await runPlan(s, 'off');
    assert.equal(modeOf(s), 'ask', '/plan off leaves another mode alone');
    await runAsk(s, 'off');
    assert.equal(modeOf(s), 'agent');
    await runReview(s, '');
    await runAsk(s, 'toggle');
    assert.deepEqual([s.planMode, s.askMode, s.reviewMode], [false, true, false]);
    assert.equal(withoutMode(s, 'ask'), 'agent');
  });
});
