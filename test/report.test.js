import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freezeBaseline } from '../src/baseline.js';
import { createReportStore, publicStatement } from '../src/report.js';

const campaign = JSON.parse(await readFile(new URL('../fixtures/campaign.json', import.meta.url), 'utf8'));
const events = JSON.parse(await readFile(new URL('../fixtures/events.json', import.meta.url), 'utf8'));
const corrections = JSON.parse(await readFile(new URL('../fixtures/corrections.json', import.meta.url), 'utf8'));

const env = { authorized: true };

const baseline = freezeBaseline({
  campaignId: campaign.campaign_id,
  policyStart: campaign.exposure_window.from,
  frozenAt: '2026-05-30T00:00:00Z',
  window: { from: '2026-05-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
  series: { treat: [100, 100, 100], control: [90, 90, 90] },
});

const series = {
  increment: {
    treatPre: [98, 102, 100, 101, 99],
    treatPost: [128, 132, 130, 131, 129],
    controlPre: [88, 92, 90, 91, 89],
    controlPost: [98, 102, 100, 101, 99],
  },
  crowding: {
    treatPre: [50, 51, 49],
    treatPost: [47, 48, 48],
    controlPre: [50, 50, 50],
    controlPost: [51, 51, 51],
  },
  sustain: { treat: [105, 103, 104] },
};

function inputsFor(asOf, mappingVersion) {
  return { campaign, events, corrections, series, baseline, asOf, mappingVersion, env };
}

test('迟到退款产生新版本，旧报告原样保留', () => {
  const store = createReportStore();
  const v1 = store.produce(inputsFor('2026-07-10T00:00:00Z', 'cat-2026v1'));
  const v2 = store.produce(inputsFor('2026-07-25T00:00:00Z', 'cat-2026v2'));

  assert.equal(v1.result.observed.refunds.count, 1);
  assert.equal(v1.result.observed.net_redemption_amount, 2800);
  assert.equal(v2.result.observed.refunds.count, 2);
  assert.equal(v2.result.observed.net_redemption_amount, 2000);
  assert.ok(v2.result.adjustments.some((a) => a.change === 'late_refund' && a.event_id === 'e9'));

  // 旧报告连同固定输入一起保留，不受新版本影响。
  assert.equal(store.get(v1.report_id).result.observed.net_redemption_amount, 2800);
  assert.equal(store.list().length, 2);
});

test('观察指标经过刷单与重复领取修正', () => {
  const store = createReportStore();
  const v1 = store.produce(inputsFor('2026-07-10T00:00:00Z', 'cat-2026v1'));
  const { observed } = v1.result;
  assert.equal(observed.exposures, 2);
  assert.equal(observed.claims, 3);
  assert.equal(observed.redemptions.count, 3);
  assert.equal(observed.redemptions.amount, 4000);
  assert.equal(observed.net_subsidy_amount, 450);
});

test('增量、单位成本、持续消费与挤出效应可供决策比较', () => {
  const store = createReportStore();
  const v1 = store.produce(inputsFor('2026-07-10T00:00:00Z', 'cat-2026v1'));
  const { estimates, sustained } = v1.result;

  // 日均增量 20 元 × 30 天窗口 = 600 元。
  assert.ok(Math.abs(estimates.increment_consumption.point - 600) < 1e-9);
  // 单位成本 = 补贴净支出 450 / 新增消费 600 = 0.75。
  assert.ok(Math.abs(estimates.unit_cost.point - 0.75) < 1e-9);
  assert.ok(estimates.unit_cost.lower < 0.75 && estimates.unit_cost.upper > 0.75);
  // 持续消费为观察事实：活动后日均消费为基线的 104%。
  assert.equal(sustained.kind, 'observed');
  assert.ok(Math.abs(sustained.ratio - 1.04) < 1e-9);
  // 非补贴品类出现负增量，即挤出效应。
  assert.ok(estimates.crowding_out.point < 0);
});

test('任何结论都可以按固定输入重放，篡改会被发现', () => {
  const store = createReportStore();
  const v1 = store.produce(inputsFor('2026-07-10T00:00:00Z', 'cat-2026v1'));
  const v2 = store.produce(inputsFor('2026-07-25T00:00:00Z', 'cat-2026v2'));
  assert.equal(store.replay(v1.report_id).ok, true);
  assert.equal(store.replay(v2.report_id).ok, true);

  const tampered = createReportStore();
  const report = tampered.produce(inputsFor('2026-07-10T00:00:00Z', 'cat-2026v1'));
  tampered.get(report.report_id).inputs.asOf = '2026-01-01T00:00:00Z';
  const result = tampered.replay(report.report_id);
  assert.equal(result.ok, false);
  assert.equal(result.inputs_ok, false);
});

test('公开说明区分观察事实与估计，估计带不确定范围', () => {
  const store = createReportStore();
  const v1 = store.produce(inputsFor('2026-07-10T00:00:00Z', 'cat-2026v1'));
  const statement = publicStatement(v1);

  assert.ok(statement.observed_facts.length >= 2);
  assert.ok(statement.estimates.length >= 2);
  for (const est of statement.estimates) {
    assert.ok(est.range[0] <= est.point && est.point <= est.range[1]);
    assert.ok(est.text.includes('不确定范围'));
  }
});

test('含平台明细的输入必须在授权环境计算', () => {
  const store = createReportStore();
  assert.throws(
    () => store.produce({ ...inputsFor('2026-07-10T00:00:00Z', 'cat-2026v1'), env: undefined }),
    /授权环境/,
  );
});
