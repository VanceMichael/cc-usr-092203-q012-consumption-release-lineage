import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCorrections, validateCorrection } from '../src/corrections.js';
import { detectFraud } from '../src/fraud.js';
import { loadScenario } from './helpers.js';

test('统计分类变化：旧口径历史数据重述到新口径', () => {
  const { store, pick } = loadScenario();
  const before = applyCorrections(store.all(), []).consumption_stats;
  assert.ok(before.some((stat) => stat.classification_version === 'cat-v1'));

  const after = applyCorrections(store.all(), pick(['cor-class'])).consumption_stats;
  assert.equal(after.length, 72);
  assert.ok(after.every((stat) => stat.classification_version === 'cat-v2'));
  assert.ok(after.every((stat) => ['cat-smarthome', 'cat-dining'].includes(stat.category)));
  assert.ok(after.filter((stat) => stat.restated_by === 'cor-class').length > 0);
});

test('商户迁址：核销按核销发生时的所在地区归属', () => {
  const { store, pick } = loadScenario();
  const withoutFix = applyCorrections(store.all(), []);
  assert.ok(withoutFix.redemptions.every((redemption) => redemption.region_id === 'r-yunzhou'));

  const withFix = applyCorrections(store.all(), pick(['cor-reloc']));
  const byId = Object.fromEntries(withFix.redemptions.map((redemption) => [redemption.id, redemption]));
  assert.equal(byId['red-03'].region_id, 'r-yunzhou'); // 2026-03-10，迁址前
  assert.equal(byId['red-05'].region_id, 'r-linjiang'); // 2026-03-20，迁址后
  assert.equal(byId['red-07'].region_id, 'r-linjiang'); // 2026-03-25，迁址后
});

test('跨活动重复领取：按先领先得标记归属', () => {
  const { store, pick } = loadScenario();
  const { claims, notes } = applyCorrections(store.all(), pick(['cor-dup']));
  const byId = Object.fromEntries(claims.map((claim) => [claim.id, claim]));
  assert.equal(byId['cl-03'].duplicate_of, null); // 2026-02-28 先领，归属 camp-01
  assert.equal(byId['cl-15'].duplicate_of, 'cl-03'); // 2026-03-05 后领，标记为重复
  assert.ok(notes.some((note) => note.includes('p-007')));
});

test('异常刷单：规则可解释地识别线索，修正后核销被剔除', () => {
  const { store, pick } = loadScenario();
  const flags = detectFraud(store.all());
  const burst = flags.find((flag) => flag.type === 'person_daily_burst');
  assert.equal(burst.person_ref, 'p-013');
  assert.deepEqual([...burst.claim_ids].sort(), ['cl-12', 'cl-13', 'cl-14']);

  const { redemptions } = applyCorrections(store.all(), pick(['cor-fraud']));
  const excluded = redemptions.filter((redemption) => redemption.excluded);
  assert.deepEqual(excluded.map((redemption) => redemption.id).sort(), ['red-12', 'red-13', 'red-14']);
  assert.ok(excluded.every((redemption) => redemption.exclude_reason === '异常刷单标记'));
});

test('迟到退款：修正必须引用已存在的退款记录', () => {
  const { store, pick } = loadScenario();
  assert.throws(
    () => applyCorrections(store.all(), [{ ...pick(['cor-refund'])[0], id: 'cor-x', payload: { refund_id: 'ref-99' } }]),
    /不存在的退款/,
  );
  const { refunds, notes } = applyCorrections(store.all(), pick(['cor-refund']));
  assert.equal(refunds.length, 1);
  assert.ok(notes.some((note) => note.includes('ref-01')));
});

test('修正记录本身需要理由，保证审计叙述完整', () => {
  const { pick } = loadScenario();
  assert.throws(() => validateCorrection({ ...pick(['cor-dup'])[0], reason: '' }), /理由/);
});
