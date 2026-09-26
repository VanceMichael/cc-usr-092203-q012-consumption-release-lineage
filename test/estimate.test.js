import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateIncrementDiD, estimateIncrementPhased, scaleToWindow } from '../src/estimate.js';

test('双重差分剥离共同趋势后给出增量与不确定范围', () => {
  const est = estimateIncrementDiD({
    treatPre: [98, 102, 100, 101, 99],
    treatPost: [128, 132, 130, 131, 129],
    controlPre: [88, 92, 90, 91, 89],
    controlPost: [98, 102, 100, 101, 99],
  });
  // 处理组上升 30，对照组同期上升 10（季节、平台活动等共同趋势），增量为 20。
  assert.equal(est.kind, 'estimate');
  assert.ok(Math.abs(est.point - 20) < 1e-9);
  assert.ok(est.lower < est.point && est.point < est.upper);
  assert.equal(est.confidence, 0.95);
});

test('分阶段规则按系数分摊核销增量并标注更低置信度', () => {
  const redemptions = [
    { occurred_at: '2026-06-05T00:00:00Z', amount: 1000 },
    { occurred_at: '2026-06-20T00:00:00Z', amount: 2000 },
  ];
  const rules = [
    { from: '2026-06-01T00:00:00Z', to: '2026-06-15T00:00:00Z', factor: 0.5 },
    { from: '2026-06-15T00:00:00Z', to: '2026-07-01T00:00:00Z', factor: 0.2 },
  ];
  const est = estimateIncrementPhased({ redemptions, rules, uncertaintyRatio: 0.3 });
  assert.equal(est.point, 900);
  assert.equal(est.lower, 630);
  assert.equal(est.upper, 1170);
  assert.ok(est.confidence < 0.95);
});

test('日均估计可放大到整个活动窗口', () => {
  const scaled = scaleToWindow({ kind: 'estimate', method: 'm', point: 20, lower: 10, upper: 30 }, 30);
  assert.equal(scaled.point, 600);
  assert.equal(scaled.lower, 300);
  assert.equal(scaled.upper, 900);
});
