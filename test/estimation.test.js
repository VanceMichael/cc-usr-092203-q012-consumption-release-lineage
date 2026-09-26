import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/events.js';
import { freezeBaseline, verifyBaseline } from '../src/baseline.js';
import { applyCorrections } from '../src/corrections.js';
import { estimateWindowEffect, resolveControlRegions } from '../src/estimate.js';
import { loadScenario } from './helpers.js';

test('基线必须在政策开始前冻结，且事后改动可被校验发现', () => {
  const { store, scenario } = loadScenario();
  assert.throws(
    () => freezeBaseline(store, { campaign_id: 'camp-01', as_of: '2026-03-01T08:00:00Z' }),
    /政策开始前/,
  );
  const baseline = freezeBaseline(store, { campaign_id: 'camp-01', as_of: scenario.baseline_as_of });
  assert.equal(baseline.stat_count, 32); // 政策前 8 周 × 2 地区 × 2 品类
  assert.ok(verifyBaseline(store, baseline));
  // 注入一条迟到的政策前统计，基线哈希立即失配
  store.append({
    id: 'cs-late',
    kind: 'consumption_stat',
    valid_from: '2026-02-16',
    valid_to: null,
    recorded_at: '2026-02-20T09:00:00Z',
    payload: { region_id: 'r-yunzhou', category: 'cat-smart-device', week_start: '2026-02-16', amount: 1, classification_version: 'cat-v1' },
  });
  assert.equal(verifyBaseline(store, baseline), false);
});

test('双重差分估计增量消费，区间不含零', () => {
  const { store, scenario, pick } = loadScenario();
  const { config } = scenario;
  const stats = applyCorrections(store.all(), pick(['cor-class'])).consumption_stats;
  const increment = estimateWindowEffect(stats, {
    treatment_region: 'r-yunzhou',
    control_regions: ['r-linjiang'],
    categories: config.category_scope,
    baseline_window: config.windows.pre,
    effect_window: config.windows.post,
  });
  assert.ok(Math.abs(increment.weekly.value - 260000) < 1e-6);
  assert.equal(increment.n_weeks, 6);
  assert.ok(Math.abs(increment.total.value - 1560000) < 1e-6);
  assert.ok(increment.total.ci[0] > 0, '增量区间应不含零');
  assert.ok(Math.abs(increment.total.ci[0] - 1313855) < 5000);
  assert.ok(Math.abs(increment.total.ci[1] - 1806145) < 5000);
});

test('持续消费为正、挤出效应为负，均可解释', () => {
  const { store, scenario, pick } = loadScenario();
  const { config } = scenario;
  const stats = applyCorrections(store.all(), pick(['cor-class'])).consumption_stats;
  const base = {
    treatment_region: 'r-yunzhou',
    control_regions: ['r-linjiang'],
    categories: config.category_scope,
    baseline_window: config.windows.pre,
  };
  const sustained = estimateWindowEffect(stats, { ...base, effect_window: config.windows.after });
  assert.ok(Math.abs(sustained.weekly.value - 70000) < 1e-6);
  assert.ok(sustained.weekly.ci[0] > 0, '政策后仍有显著持续消费');

  const crowding = estimateWindowEffect(stats, { ...base, categories: config.comparison_categories, effect_window: config.windows.post });
  assert.ok(Math.abs(crowding.weekly.value - -30000) < 1e-6);
  assert.ok(crowding.weekly.ci[1] < 0, '非补贴品类显著被挤占');
});

test('缺少分类重述时，政策前后口径断裂导致无法估计', () => {
  const { store, scenario } = loadScenario();
  const { config } = scenario;
  const stats = applyCorrections(store.all(), []).consumption_stats;
  assert.throws(
    () => estimateWindowEffect(stats, {
      treatment_region: 'r-yunzhou',
      control_regions: ['r-linjiang'],
      categories: config.category_scope,
      baseline_window: config.windows.pre,
      effect_window: config.windows.post,
    }),
    /缺少统计数据/,
  );
});

test('分阶段规则：以尚未实施政策的地区为对照', () => {
  const dt = (d) => `${d}T08:00:00Z`;
  const events = [
    { id: 'ra', kind: 'region', valid_from: '2025-01-01', valid_to: null, recorded_at: dt('2025-01-01'), payload: { name: '甲区', level: 'district' } },
    { id: 'rb', kind: 'region', valid_from: '2025-01-01', valid_to: null, recorded_at: dt('2025-01-01'), payload: { name: '乙区', level: 'district' } },
    { id: 'ca', kind: 'campaign', valid_from: '2026-02-01', valid_to: '2026-03-01', recorded_at: dt('2026-01-20'), payload: { name: '甲区消费券', region_id: 'ra', measure_type: '消费券', category_scope: ['c1'], budget_total: 1000 } },
    { id: 'cb', kind: 'campaign', valid_from: '2026-04-01', valid_to: '2026-05-01', recorded_at: dt('2026-03-01'), payload: { name: '乙区消费券', region_id: 'rb', measure_type: '消费券', category_scope: ['c1'], budget_total: 1000 } },
  ];
  const stat = (id, region, week, amount) => ({
    id, kind: 'consumption_stat', valid_from: week, valid_to: null, recorded_at: dt(week),
    payload: { region_id: region, category: 'c1', week_start: week, amount, classification_version: 'cat-v2' },
  });
  const preWeeks = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'];
  const postWeeks = ['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23'];
  let seq = 0;
  for (const week of preWeeks) {
    events.push(stat(`s${(seq += 1)}`, 'ra', week, 100));
    events.push(stat(`s${(seq += 1)}`, 'rb', week, 80));
  }
  for (const week of postWeeks) {
    events.push(stat(`s${(seq += 1)}`, 'ra', week, 130));
    events.push(stat(`s${(seq += 1)}`, 'rb', week, 80));
  }
  const store = new EventStore(events);
  const config = {
    campaign_id: 'ca',
    control: { type: 'not_yet_treated' },
    windows: { pre: ['2026-01-01', '2026-01-31'], post: ['2026-02-01', '2026-02-28'], after: ['2026-03-01', '2026-03-31'] },
    category_scope: ['c1'],
    comparison_categories: [],
    classification_version: 'cat-v2',
  };
  const controls = resolveControlRegions(store.all(), config);
  assert.deepEqual(controls, ['rb']);
  const effect = estimateWindowEffect(store.byKind('consumption_stat').map((e) => ({ id: e.id, ...e.payload })), {
    treatment_region: 'ra',
    control_regions: controls,
    categories: ['c1'],
    baseline_window: config.windows.pre,
    effect_window: config.windows.post,
  });
  assert.ok(Math.abs(effect.weekly.value - 30) < 1e-6);
});
