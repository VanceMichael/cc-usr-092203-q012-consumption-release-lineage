import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { platformDetails, visibleEvents } from '../src/access.js';

const events = JSON.parse(await readFile(new URL('../fixtures/events.json', import.meta.url), 'utf8'));

test('非授权环境不能处理平台明细', () => {
  assert.throws(() => platformDetails(events, { authorized: false }), /授权环境/);
  assert.throws(() => platformDetails(events, undefined), /授权环境/);
});

test('非授权环境只能看到非受限记录', () => {
  const visible = visibleEvents(events, undefined);
  assert.ok(visible.length < events.length);
  assert.ok(visible.every((e) => e.classification !== 'restricted'));
});

test('授权环境可以读取平台明细', () => {
  const details = platformDetails(events, { authorized: true });
  assert.ok(details.length > 0);
  assert.ok(details.every((e) => e.classification === 'restricted'));
});
