import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage, usageTotals, usageSince, resetUsage, formatTokens, describeTurnUsage } from '../src/core/usage';

test('totals add up per session and per model', () => {
  resetUsage();
  recordUsage('local:4b', { sent: 4000, received: 120, estimated: false });
  recordUsage('local:4b', { sent: 4500, received: 80, estimated: false });
  recordUsage('cloud', { sent: 10_000, received: 900, estimated: true });
  const t = usageTotals();
  assert.equal(t.sent, 18_500);
  assert.equal(t.received, 1100);
  assert.equal(t.calls, 3);
  assert.equal(t.estimated, 1);
  assert.deepEqual(t.byModel['local:4b'], { sent: 8500, received: 200, calls: 2, estimated: 0 });
  assert.equal(t.byModel.cloud.estimated, 1);
});

test('a turn is what moved since its snapshot', () => {
  resetUsage();
  recordUsage('m', { sent: 1000, received: 10, estimated: false });
  const before = usageTotals();
  recordUsage('m', { sent: 2500, received: 40, estimated: false });
  recordUsage('m', { sent: 2600, received: 60, estimated: true });
  assert.deepEqual(usageSince(before), { sent: 5100, received: 100, calls: 2, estimated: 1 });
});

test('the snapshot is a copy: later calls do not change it', () => {
  resetUsage();
  const before = usageTotals();
  recordUsage('m', { sent: 10, received: 1, estimated: false });
  assert.equal(before.sent, 0);
});

test('a resumed session keeps counting from its saved totals; /clear starts over', () => {
  resetUsage();
  recordUsage('m', { sent: 3000, received: 30, estimated: false });
  const saved = JSON.parse(JSON.stringify(usageTotals()));
  resetUsage(saved);
  recordUsage('m', { sent: 1000, received: 10, estimated: false });
  assert.equal(usageTotals().sent, 4000);
  assert.equal(usageTotals().byModel.m.calls, 2);
  resetUsage();
  assert.equal(usageTotals().calls, 0);
  resetUsage({ nonsense: true } as any);
  assert.equal(usageTotals().calls, 0);
});

test('compact numbers for the footer', () => {
  assert.equal(formatTokens(640), '640');
  assert.equal(formatTokens(12_400), '12k');
  assert.equal(formatTokens(9_800), '9.8k');
  assert.equal(formatTokens(120_000), '120k');
  assert.equal(formatTokens(1_250_000), '1.3M');
  assert.equal(formatTokens(12_400, true), '~12k');
});

test('the per-turn line for runs without a footer', () => {
  assert.equal(describeTurnUsage({ sent: 12_400, received: 640, calls: 5, estimated: 0 }), 'this turn: 12k sent · 640 received · 5 model calls');
  assert.equal(describeTurnUsage({ sent: 900, received: 20, calls: 1, estimated: 1 }), 'this turn: ~900 sent · ~20 received · 1 model call');
});
