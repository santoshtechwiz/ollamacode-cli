import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modeOf, setMode, withoutMode } from '../src/cli/chat/mode';
import { runAsk } from '../src/cli/commands/cmds/ask';
import { runPlan } from '../src/cli/commands/cmds/plan';
import { runReview } from '../src/cli/commands/cmds/review';

const session = (mode: 'agent' | 'plan' | 'ask' | 'review' = 'agent') => {
  const s: any = { planMode: false, askMode: false, reviewMode: false, announcedMode: mode, persist: () => {} };
  setMode(s, mode);
  return s;
};

describe('mode', () => {

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
