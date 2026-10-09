import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage, usageTotals, resetUsage } from '../src/core/usage';

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
