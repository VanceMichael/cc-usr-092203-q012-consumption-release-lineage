import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeBaseline } from '../src/baseline.js';

const series = { treat: [10, 12, 11], control: [8, 9, 8.5] };
const window = { from: '2026-05-01T00:00:00Z', to: '2026-06-01T00:00:00Z' };

test('基线在政策开始前冻结且不可修改', () => {
  const baseline = freezeBaseline({
    campaignId: 'camp-1',
    policyStart: '2026-06-01T00:00:00Z',
    frozenAt: '2026-05-30T00:00:00Z',
    window,
    series,
  });
  assert.equal(baseline.metrics.treat_mean, 11);
  assert.equal(baseline.metrics.control_mean, 8.5);
  assert.ok(baseline.baseline_id.startsWith('bl-'));
  assert.throws(() => { baseline.metrics.treat_mean = 0; }, TypeError);
  assert.throws(() => { baseline.metrics = {}; }, TypeError);
});

test('政策开始后不能再冻结基线', () => {
  assert.throws(
    () => freezeBaseline({
      campaignId: 'camp-1',
      policyStart: '2026-06-01T00:00:00Z',
      frozenAt: '2026-06-02T00:00:00Z',
      window,
      series,
    }),
    /政策开始前/,
  );
});
