import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeBaseline } from '../src/baseline.js';
import { createEnvironment, platformPersonDetail } from '../src/environment.js';
import { buildPublicStatement } from '../src/disclosure.js';
import { buildReport, compareReports, replayReport } from '../src/report.js';
import { loadScenario } from './helpers.js';

const authorized = createEnvironment({ authorized: true, purpose: '政策评估' });

function buildV1(context) {
  const { scenario, store, pick } = context;
  const baseline = freezeBaseline(store, { campaign_id: 'camp-01', as_of: scenario.baseline_as_of });
  return buildReport({
    store,
    corrections: pick(scenario.report_v1.correction_ids),
    baseline,
    config: scenario.config,
    as_of: scenario.report_v1.as_of,
    environment: authorized,
    id: 'rep-v1',
    created_at: '2026-05-08T10:00:00Z',
  });
}

function buildV2(context, previous) {
  const { scenario, store, pick } = context;
  const baseline = freezeBaseline(store, { campaign_id: 'camp-01', as_of: scenario.baseline_as_of });
  return buildReport({
    store,
    corrections: pick(scenario.report_v2.correction_ids),
    baseline,
    config: scenario.config,
    as_of: scenario.report_v2.as_of,
    environment: authorized,
    id: 'rep-v2',
    created_at: '2026-05-12T10:00:00Z',
    previous,
  });
}

test('报告版本：修正归因产生新版本，旧报告保留且数值不变', () => {
  const context = loadScenario();
  const v1 = buildV1(context);
  const v2 = buildV2(context, [v1]);

  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes, 'rep-v1');

  // v1：未应用刷单/退款修正，补贴为核销口径 325000
  assert.equal(v1.observed.subsidy_gross, 325000);
  assert.equal(v1.observed.attributed_subsidy_spent, 325000);
  assert.equal(v1.observed.refunds.amount, 0);
  assert.deepEqual(v1.observed.attributed_amount_by_region, { 'r-yunzhou': 3250000 });

  // v2：刷单剔除 39000、迟到退款冲减 26000，归因口径 260000
  assert.equal(v2.observed.excluded_fraud.subsidy, 39000);
  assert.equal(v2.observed.refunds.subsidy, 26000);
  assert.equal(v2.observed.attributed_subsidy_spent, 260000);
  assert.deepEqual(v2.observed.attributed_amount_by_region, { 'r-yunzhou': 2340000, 'r-linjiang': 260000 });

  // 跨活动重复领取：简单相加 15 人，去重 14 人
  assert.equal(v2.observed.claimants_naive_sum_across_campaigns, 15);
  assert.equal(v2.observed.unique_claimants_cross_campaign, 14);

  // 估计不受这些修正影响，两版一致；单位成本随归因口径下降
  assert.equal(v1.estimates.increment.total.value, v2.estimates.increment.total.value);
  assert.ok(Math.abs(v1.estimates.unit_cost.value - 325000 / 1560000) < 1e-9);
  assert.ok(Math.abs(v2.estimates.unit_cost.value - 260000 / 1560000) < 1e-9);

  // 旧报告对象未被改写
  assert.equal(v1.observed.attributed_subsidy_spent, 325000);
  assert.ok(v2.notes.length > v1.notes.length);
});

test('审计重放：相同输入复算任意版本，输入被改动则不可复算', () => {
  const context = loadScenario();
  const { scenario, store } = context;
  const baseline = freezeBaseline(store, { campaign_id: 'camp-01', as_of: scenario.baseline_as_of });
  const v1 = buildV1(context);
  const v2 = buildV2(context, [v1]);

  assert.equal(replayReport(v1, { store, corrections: scenario.corrections, baseline }).reproducible, true);
  assert.equal(replayReport(v2, { store, corrections: scenario.corrections, baseline }).reproducible, true);

  // 向事件库补录一条 v1 截止前的核销（篡改输入），v1 立即不可复算
  const tampered = loadScenario();
  tampered.store.append({
    id: 'red-99',
    kind: 'redemption',
    valid_from: '2026-04-01',
    valid_to: null,
    recorded_at: '2026-04-02T08:00:00Z',
    payload: { claim_id: 'cl-01', merchant_id: 'm-02', amount: 1000, subsidy_amount: 100 },
  });
  const replayed = replayReport(v1, { store: tampered.store, corrections: tampered.scenario.corrections, baseline });
  assert.equal(replayed.reproducible, false);
  assert.notEqual(replayed.recomputed_hash, replayed.expected_hash);
});

test('平台明细与报告生成只能在授权环境处理', () => {
  const context = loadScenario();
  const { scenario, store, pick } = context;
  const baseline = freezeBaseline(store, { campaign_id: 'camp-01', as_of: scenario.baseline_as_of });
  const open = createEnvironment({ authorized: false });

  assert.throws(() => platformPersonDetail(store, open, 'p-007'), /未授权环境/);
  assert.throws(
    () => buildReport({
      store,
      corrections: pick(scenario.report_v1.correction_ids),
      baseline,
      config: scenario.config,
      as_of: scenario.report_v1.as_of,
      environment: open,
      id: 'rep-x',
      created_at: '2026-05-08T10:00:00Z',
    }),
    /未授权环境/,
  );

  const detail = platformPersonDetail(store, authorized, 'p-007');
  assert.equal(detail.claims.length, 2);
  assert.equal(detail.redemptions.length, 1);
});

test('公开说明：观察事实不带区间，估计必带方法、假设与不确定范围', () => {
  const context = loadScenario();
  const v2 = buildV2(context, [buildV1(context)]);
  const statement = buildPublicStatement(v2, { campaign_name: '智能家电消费券' });

  assert.ok(statement.observed_facts.length >= 5);
  for (const fact of statement.observed_facts) {
    assert.equal(fact.nature, 'observed');
    assert.equal('ci' in fact, false, `观察事实不应带区间：${fact.label}`);
  }
  assert.ok(statement.estimates.length >= 3);
  for (const estimate of statement.estimates) {
    assert.equal(estimate.nature, 'estimate');
    assert.ok(Array.isArray(estimate.ci), `估计应带不确定范围：${estimate.label}`);
    assert.ok(estimate.method.length > 0);
  }
  const increment = statement.estimates.find((estimate) => estimate.label === '增量消费');
  assert.ok(increment.assumptions.length >= 3);
  assert.ok(increment.ci[0] > 0);
});

test('决策比较：按单位成本排序并列出持续消费与挤出效应', () => {
  const context = loadScenario();
  const v1 = buildV1(context);
  const v2 = buildV2(context, [v1]);
  const table = compareReports([v1, v2]);
  assert.equal(table.length, 2);
  assert.equal(table[0].report_id, 'rep-v2', '单位成本更低（更优）的版本应排在前面');
  assert.ok(table[0].unit_cost < table[1].unit_cost);
  assert.ok(table.every((row) => row.sustained_weekly === 70000));
  assert.ok(table.every((row) => row.crowding_out_weekly === -30000));
});
