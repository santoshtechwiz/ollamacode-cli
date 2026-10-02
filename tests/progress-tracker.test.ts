import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProgressTracker } from '../src/agent/turn/progress-tracker';
import type { EvidenceType } from '../src/agent/turn/progress-tracker';
import type { ToolCallRecord } from '../src/agent/turn/turn-state';

function record(
  name: string,
  ok = true,
  args: Record<string, unknown> = {},
): ToolCallRecord {
  return {
    name,
    args,
    result: { ok, kind: 'text' },
    isRepeat: false,
    at: 1,
  };
}

function observe(
  tracker: ProgressTracker,
  name: string,
  ok = true,
  args: Record<string, unknown> = {},
): void {
  tracker.recordResult(
    record(name, ok, args),
    'observation',
    ok,
  );
}

function mutate(
  tracker: ProgressTracker,
  name: string,
  args: Record<string, unknown> = {},
): void {
  tracker.recordResult(
    record(name, true, args),
    'mutation',
    true,
  );
}

function verify(
  tracker: ProgressTracker,
  command: string,
  ok = true,
): void {
  tracker.recordResult(
    record('exec_shell', ok, { command }),
    'verification',
    ok,
  );
}

/**
 * The tracker consumes evidence: the turn loop decides what a call was and whether it worked
 * (see progressTypeFor/recordProgress in src/agent/turn/turn.ts) and hands that over. Command
 * classification itself is covered by tests/exec-shell.test.ts. What is left here is the state
 * machine: which phase a piece of evidence moves the turn to, and what it then reports.
 */
describe('ProgressTracker', () => {
  it('continues after an observation', () => {
    const tracker = new ProgressTracker();

    observe(tracker, 'read_file', true, { path: 'src/app.ts' });

    const decision = tracker.decide();

    assert.equal(decision.action, 'CONTINUE');
    assert.equal(decision.phase, 'OBSERVE');
    assert.match(decision.reason, /information/i);
  });

  it('continues when the caller records nothing', () => {
    const tracker = new ProgressTracker();

    // A skipped call is not evidence: the turn loop returns before it records anything, so the
    // tracker never sees it.
    const decision = tracker.decide();

    assert.equal(decision.action, 'CONTINUE');
    assert.equal(decision.phase, 'OBSERVE');
    assert.deepEqual(tracker.getEvidence(), []);
  });

  it('moves toward diagnosis after repeated failed observations', () => {
    const tracker = new ProgressTracker();

    for (let i = 0; i < 8; i++) {
      observe(tracker, 'read_file', false, {
        path: `src/file-${i}.ts`,
      });
    }

    const decision = tracker.decide();

    assert.equal(decision.phase, 'DIAGNOSE');
    assert.equal(decision.action, 'ACT');
    assert.match(decision.reason, /corrective/i);
  });

  it('leaves stopping an observation loop to the turn loop', () => {
    const tracker = new ProgressTracker();

    for (let i = 0; i < 12; i++) {
      observe(tracker, 'grep_content', true, {
        pattern: 'foo',
        path: 'src',
      });
    }

    const decision = tracker.decide();

    // The tracker reports; the turn loop owns continuation and termination, so reading and
    // re-reading must not look like a reason to end the turn.
    assert.equal(decision.phase, 'OBSERVE');
    assert.equal(decision.action, 'CONTINUE');
  });

  it('classifies a successful mutation as action', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });

    const decision = tracker.decide();

    // A mutation is action, not observation — and it is not completion either: the model
    // still has to report or continue.
    assert.notEqual(decision.phase, 'OBSERVE');
    assert.notEqual(decision.action, 'COMPLETE');
  });

  it('does not complete from a mutation alone', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });
    mutate(tracker, 'edit_file', { path: 'src/service.ts' });
    mutate(tracker, 'git', { operation: 'commit' });

    const decision = tracker.decide();

    // A git commit is still just a mutation to this layer: the work is not declared finished
    // until a check has passed.
    assert.notEqual(decision.action, 'COMPLETE');
  });

  it('settles instead of oscillating when the model keeps mutating', () => {
    const tracker = new ProgressTracker();

    // A model that only ever writes files and never runs a check. The tracker used to hand
    // ACT <-> VERIFY back and forth for the whole turn, emitting a fresh "Run verification" every
    // round, and never reaching a state it was willing to stay in.
    const phases = new Set<string>();
    const actions = new Set<string>();

    for (let i = 0; i < 40; i++) {
      tracker.recordResult(
        record(i % 2 === 0 ? 'write_file' : 'exec_shell', true, {
          path: `src/file-${i}.ts`,
          command: 'node index.js',
        }),
        'mutation',
        true,
      );
      const decision = tracker.decide();
      phases.add(decision.phase);
      actions.add(decision.action);
    }

    assert.ok(
      !actions.has('STOP'),
      'mutating without a check is not a reason to stop the turn',
    );
    assert.equal([...phases].length, 1, `the phase kept changing: ${[...phases].join(', ')}`);
  });

  it('returns to action after failed verification', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });
    verify(tracker, 'npm test', false);

    const decision = tracker.decide();

    assert.equal(decision.phase, 'ACT');
    assert.notEqual(decision.action, 'COMPLETE');
  });

  it('completes after successful verification', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });
    verify(tracker, 'npm test');

    const decision = tracker.decide();

    assert.equal(decision.action, 'COMPLETE');
    assert.equal(decision.phase, 'COMPLETE');
  });

  it('completes on a successful check regardless of how many mutations preceded it', () => {
    for (const command of [
      'npm test',
      'npm run test:unit',
      'npm run lint',
      'npm run typecheck',
    ]) {
      const tracker = new ProgressTracker();

      mutate(tracker, 'edit_file', { path: 'src/app.ts' });
      mutate(tracker, 'edit_file', { path: 'src/service.ts' });
      verify(tracker, command);

      const decision = tracker.decide();

      assert.equal(
        decision.action,
        'COMPLETE',
        `expected ${command} to complete`,
      );
      assert.equal(
        decision.phase,
        'COMPLETE',
        `expected ${command} to complete`,
      );
    }
  });

  it('leaves stopping after failed verification to the turn loop', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });
    verify(tracker, 'npm test', false);
    verify(tracker, 'npm test', false);

    const decision = tracker.decide();

    // Repeating the same failing check is the turn loop's signal to stop, not the tracker's:
    // reporting STOP here would end a turn that still has a next step available.
    assert.equal(decision.phase, 'ACT');
    assert.notEqual(decision.action, 'STOP');
  });

  it('does not treat a failed verification as successful verification', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });
    mutate(tracker, 'edit_file', { path: 'src/service.ts' });
    verify(tracker, 'npm test', false);

    const decision = tracker.decide();

    assert.notEqual(decision.action, 'COMPLETE');
  });

  it('does not complete from observations alone', () => {
    const tracker = new ProgressTracker();

    observe(tracker, 'read_file', true, { path: 'src/app.ts' });
    observe(tracker, 'grep_content', true, { pattern: 'foo', path: 'src' });
    observe(tracker, 'git', true, { operation: 'status' });

    const decision = tracker.decide();

    assert.notEqual(decision.action, 'COMPLETE');
  });

  it('records the evidence it is given', () => {
    const tracker = new ProgressTracker();

    observe(tracker, 'read_file', false, { path: 'src/missing.ts' });
    mutate(tracker, 'write_file', { path: 'src/app.ts' });
    verify(tracker, 'npm test');

    const evidence = tracker.getEvidence();

    assert.deepEqual(
      evidence.map(item => ({
        type: item.type,
        success: item.success,
      })),
      [
        { type: 'observation', success: false },
        { type: 'mutation', success: true },
        { type: 'verification', success: true },
      ],
    );
    assert.equal(evidence[0]?.callSignature.startsWith('read_file:'), true);
  });

  it('reports recent evidence in its decision', () => {
    const tracker = new ProgressTracker();

    observe(tracker, 'read_file', true, { path: 'src/app.ts' });
    mutate(tracker, 'write_file', { path: 'src/app.ts' });

    const decision = tracker.decide();

    assert.deepEqual(decision.evidence, [
      'observation:read_file=ok',
      'mutation:write_file=ok',
    ]);
  });

  it('keeps the phase it reports', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });

    assert.equal(tracker.getPhase(), tracker.decide().phase);
  });

  it('is deterministic for the same state', () => {
    const tracker = new ProgressTracker();

    observe(tracker, 'read_file', true, { path: 'src/app.ts' });

    const first = tracker.decide();
    const second = tracker.decide();

    assert.deepEqual(second, first);
  });

  it('does not change state when decide is called repeatedly', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });

    const decisions = Array.from(
      { length: 5 },
      () => tracker.decide(),
    );

    for (const decision of decisions) {
      assert.deepEqual(decision, decisions[0]);
    }
  });

  it('returns to observe after a reset', () => {
    const tracker = new ProgressTracker();

    mutate(tracker, 'edit_file', { path: 'src/app.ts' });

    tracker.reset();

    assert.equal(tracker.getPhase(), 'OBSERVE');
    assert.deepEqual(tracker.getEvidence(), []);
    assert.equal(tracker.decide().action, 'CONTINUE');
  });

  it('handles failed observations without throwing', () => {
    const tracker = new ProgressTracker();

    observe(tracker, 'read_file', false, { path: 'missing.ts' });

    assert.doesNotThrow(() => tracker.decide());
  });

  it('moves from a successful diagnosis to action', () => {
    const tracker = new ProgressTracker();

    observe(tracker, 'read_file', false, { path: 'missing.ts' });

    tracker.recordResult(
      record('grep_content', true, { pattern: 'missing' }),
      'diagnosis',
      true,
    );

    const decision = tracker.decide();

    assert.equal(decision.phase, 'ACT');
    assert.equal(decision.action, 'CONTINUE');
  });

  it('stays in diagnosis when the diagnosis itself fails', () => {
    const tracker = new ProgressTracker();

    tracker.recordResult(
      record('grep_content', false, { pattern: 'missing' }),
      'diagnosis',
      false,
    );

    const decision = tracker.decide();

    assert.equal(decision.phase, 'DIAGNOSE');
    assert.equal(decision.action, 'ACT');
  });

  it('reports progress for a successful mutation in the current round', () => {
    const tracker = new ProgressTracker();

    tracker.beginRound();
    mutate(tracker, 'edit_file', { path: 'src/app.ts' });

    const decision = tracker.decide();

    assert.equal(decision.action, 'VERIFY');
    assert.equal(decision.madeProgress, true);
  });

  it('does not verify again when the round only repeats earlier success', () => {
    const tracker = new ProgressTracker();

    tracker.beginRound();
    mutate(tracker, 'edit_file', { path: 'src/app.ts' });
    assert.equal(tracker.decide().action, 'VERIFY');

    // A reused-only round records nothing: the executor answered
    // the calls from earlier results instead of running them.
    tracker.beginRound();

    const decision = tracker.decide();

    assert.equal(decision.madeProgress, false);
    assert.equal(decision.action, 'STOP');
    assert.match(
      decision.reason,
      /without making progress/,
    );
  });

  it('keeps the turn going when a round only closed a step in the task list', () => {
    const tracker = new ProgressTracker();

    tracker.beginRound();
    mutate(tracker, 'write_file', { path: 'src/lib/slugify.js' });
    assert.equal(tracker.decide().action, 'VERIFY');

    // Marking that step done is the bookkeeping the task list exists for. It records no evidence
    // and must not be read as the model repeating itself: three of five steps were still to do.
    tracker.beginRound();
    tracker.recordBookkeeping();

    const decision = tracker.decide();

    assert.equal(decision.madeProgress, false);
    assert.equal(decision.action, 'CONTINUE');
    assert.match(decision.reason, /housekeeping/);
  });

  it('does not carry bookkeeping into a later round', () => {
    const tracker = new ProgressTracker();

    tracker.beginRound();
    mutate(tracker, 'write_file', { path: 'src/lib/slugify.js' });
    assert.equal(tracker.decide().action, 'VERIFY');

    tracker.beginRound();
    tracker.recordBookkeeping();
    assert.equal(tracker.decide().action, 'CONTINUE');

    // The exemption belongs to the round that closed a step, not to the rest of the turn.
    tracker.beginRound();

    assert.equal(tracker.decide().action, 'STOP');
  });

  it('does not let historical mutations force verification across rounds', () => {    const tracker = new ProgressTracker();

    tracker.beginRound();
    mutate(tracker, 'write_file', { path: 'a.ts' });
    mutate(tracker, 'write_file', { path: 'b.ts' });

    tracker.beginRound();
    tracker.beginRound();

    const decision = tracker.decide();

    assert.notEqual(decision.action, 'VERIFY');
    assert.equal(decision.madeProgress, false);
  });

  it('still verifies when the round contains a new successful execution', () => {
    const tracker = new ProgressTracker();

    tracker.beginRound();
    mutate(tracker, 'edit_file', { path: 'src/app.ts' });

    tracker.beginRound();
    mutate(tracker, 'edit_file', { path: 'src/service.ts' });

    const decision = tracker.decide();

    assert.equal(decision.action, 'VERIFY');
    assert.equal(decision.madeProgress, true);
  });

  it('reports no progress for a reused-only round in other phases', () => {
    const tracker = new ProgressTracker();

    tracker.beginRound();
    observe(tracker, 'read_file', true, { path: 'src/app.ts' });
    assert.equal(tracker.decide().madeProgress, true);

    tracker.beginRound();

    const decision = tracker.decide();

    // Reporting is the tracker's job; stopping is the turn
    // loop's, so the phase default stands and only the round
    // progress flag goes false.
    assert.equal(decision.action, 'CONTINUE');
    assert.equal(decision.madeProgress, false);
  });
});
