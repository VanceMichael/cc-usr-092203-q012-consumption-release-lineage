import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyCorrections } from '../src/corrections.js';

const events = JSON.parse(await readFile(new URL('../fixtures/events.json', import.meta.url), 'utf8'));
const corrections = JSON.parse(await readFile(new URL('../fixtures/corrections.json', import.meta.url), 'utf8'));

const AS_OF_V1 = '2026-07-10T00:00:00Z';
const AS_OF_V2 = '2026-07-25T00:00:00Z';

function adjustedAt(asOf, mappingVersion) {
  return applyCorrections(events, corrections, { asOf, mappingVersion }).events;
}

test('异常刷单整笔订单剔除', () => {
  const adjusted = adjustedAt(AS_OF_V1, 'cat-2026v1');
  const fraud = adjusted.filter((e) => e.order_id === 'o-fraud-1');
  assert.ok(fraud.length > 0);
  assert.ok(fraud.every((e) => e.excluded?.reason === 'fraud_orders'));
});

test('跨活动重复领取只保留最早一笔', () => {
  const adjusted = adjustedAt(AS_OF_V1, 'cat-2026v1');
  const dup = adjusted.find((e) => e.event_id === 'e5');
  assert.equal(dup.excluded.reason, 'duplicate_claim');
  assert.equal(dup.excluded.kept_event_id, 'e4');
  const kept = adjusted.find((e) => e.event_id === 'e4');
  assert.equal(kept.excluded, undefined);
});

test('商户迁址只影响生效时间之后的事件', () => {
  const adjusted = adjustedAt(AS_OF_V1, 'cat-2026v1');
  assert.equal(adjusted.find((e) => e.event_id === 'e6').region_code, 'R1');
  assert.equal(adjusted.find((e) => e.event_id === 'e7').region_code, 'R2');
});

test('统计分类变化按报告固定的分类版本生效', () => {
  const v1 = adjustedAt(AS_OF_V1, 'cat-2026v1');
  assert.equal(v1.find((e) => e.event_id === 'e7').category_code, 'SMART_SERVICE');

  const v2 = adjustedAt(AS_OF_V2, 'cat-2026v2');
  // 生效时间之前的事件保持原分类，之后的重编码。
  assert.equal(v2.find((e) => e.event_id === 'e6').category_code, 'SMART_SERVICE');
  assert.equal(v2.find((e) => e.event_id === 'e7').category_code, 'SMART_SERVICES');
});

test('迟到退款在记录时间之后才进入报告', () => {
  assert.equal(adjustedAt(AS_OF_V1, 'cat-2026v1').find((e) => e.event_id === 'e9'), undefined);
  assert.ok(adjustedAt(AS_OF_V2, 'cat-2026v2').find((e) => e.event_id === 'e9'));
});

test('记录时间晚于截止的修正不生效', () => {
  const early = applyCorrections(events, corrections, { asOf: '2026-07-04T00:00:00Z', mappingVersion: 'cat-2026v1' });
  // c1 刷单修正记录于 07-05，07-04 截止时还不存在。
  const fraud = early.events.find((e) => e.event_id === 'e10');
  assert.equal(fraud.excluded, undefined);
});
