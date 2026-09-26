import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, validateEvent } from '../src/events.js';
import { loadScenario } from './helpers.js';

const baseEvent = {
  id: 'evt-1',
  kind: 'exposure',
  valid_from: '2026-02-23',
  valid_to: null,
  recorded_at: '2026-02-23T08:00:00Z',
  payload: { campaign_id: 'camp-01', channel: 'app_push', count: 1000 },
};

test('事件必须带完整时间边界与记录时间', () => {
  assert.throws(() => validateEvent({ ...baseEvent, valid_from: undefined }), /有效起始日期/);
  assert.throws(() => validateEvent({ ...baseEvent, recorded_at: undefined }), /记录时间/);
  assert.throws(() => validateEvent({ ...baseEvent, valid_to: '2026-02-01' }), /时间边界无效/);
  assert.throws(() => validateEvent({ ...baseEvent, kind: 'unknown' }), /未知事件类型/);
  assert.throws(() => validateEvent({ ...baseEvent, payload: { campaign_id: 'camp-01' } }), /缺少字段/);
});

test('事件库只追加，标识不可重复', () => {
  const store = new EventStore([baseEvent]);
  assert.throws(() => store.append(baseEvent), /重复/);
  const extra = { ...baseEvent, id: 'evt-2', recorded_at: '2026-03-01T08:00:00Z' };
  store.append(extra);
  assert.equal(store.all().length, 2);
});

test('as_of 视图只包含截止前记录的数据（迟到退款的关键机制）', () => {
  const { store, scenario } = loadScenario();
  const v1 = store.asOf(scenario.report_v1.as_of);
  const v2 = store.asOf(scenario.report_v2.as_of);
  assert.equal(v1.byKind('refund').length, 0);
  assert.equal(v2.byKind('refund').length, 1);
  assert.equal(v2.byKind('refund')[0].id, 'ref-01');
});

test('事件库哈希对内容敏感、对读取稳定', () => {
  const { store: a } = loadScenario();
  const { store: b } = loadScenario();
  assert.equal(a.hash(), b.hash());
  b.append({ ...baseEvent, id: 'evt-extra', recorded_at: '2026-03-01T08:00:00Z' });
  assert.notEqual(a.hash(), b.hash());
});
