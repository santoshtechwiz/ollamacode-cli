import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { choiceFor } from '../src/ui/prompts';
import { modeOf, setMode, withoutMode } from '../src/cli/chat/mode';
import { runAsk } from '../src/cli/commands/cmds/ask';
import { runPlan } from '../src/cli/commands/cmds/plan';
import { runReview } from '../src/cli/commands/cmds/review';

describe('choice-prompt', () => {
  describe('a choice prompt reads a number or the start of one option', () => {
    const labels = ['Yes, start now', 'Not yet'];
    it('takes the option number', () => {
      assert.equal(choiceFor('1', labels), 0);
      assert.equal(choiceFor('2', labels), 1);
      assert.equal(choiceFor('3', labels), null);
    });
    it('takes the start of a label, case-insensitively', () => {
      assert.equal(choiceFor('y', labels), 0);
      assert.equal(choiceFor('N', labels), 1);
      assert.equal(choiceFor('not', labels), 1);
    });
    it('an answer that fits no option, or more than one, picks nothing', () => {
      assert.equal(choiceFor('maybe', labels), null);
      assert.equal(choiceFor('n', ['No', 'Not yet']), null);
    });
  });
});

describe('mode', () => {
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
});
