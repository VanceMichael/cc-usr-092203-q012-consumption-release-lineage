// 领域事件：活动、适用人群、商户、地区、品类、预算、曝光、领取、核销、退货与消费统计。
// 每条事件都带业务时间边界（valid_from/valid_to）与系统记录时间（recorded_at）：
// 时间边界描述“什么时候生效”，记录时间描述“系统什么时候知道”，
// 迟到数据（如退款）通过 recorded_at 与报告的 as_of 截止进入对应版本。
import { hashValue } from './hash.js';

export const EVENT_KINDS = [
  'campaign',
  'eligibility',
  'merchant',
  'region',
  'category',
  'budget',
  'exposure',
  'claim',
  'redemption',
  'refund',
  'consumption_stat',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const REQUIRED_PAYLOAD_FIELDS = {
  campaign: ['name', 'region_id', 'measure_type', 'category_scope', 'budget_total'],
  eligibility: ['campaign_id', 'rule'],
  merchant: ['name', 'region_id', 'category'],
  region: ['name', 'level'],
  category: ['name', 'classification_version'],
  budget: ['campaign_id', 'amount'],
  exposure: ['campaign_id', 'channel', 'count'],
  claim: ['campaign_id', 'person_ref'],
  redemption: ['claim_id', 'merchant_id', 'amount', 'subsidy_amount'],
  refund: ['redemption_id', 'amount', 'subsidy_amount'],
  consumption_stat: ['region_id', 'category', 'week_start', 'amount', 'classification_version'],
};

export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('事件必须是对象');
  }
  const { id, kind, valid_from, valid_to = null, recorded_at, payload } = event;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('事件缺少标识');
  }
  if (!EVENT_KINDS.includes(kind)) {
    throw new Error(`未知事件类型：${kind}`);
  }
  if (typeof valid_from !== 'string' || !DATE_RE.test(valid_from)) {
    throw new Error(`事件 ${id} 缺少有效起始日期`);
  }
  if (valid_to !== null && (typeof valid_to !== 'string' || !DATE_RE.test(valid_to) || valid_to < valid_from)) {
    throw new Error(`事件 ${id} 的时间边界无效`);
  }
  if (typeof recorded_at !== 'string' || !DATETIME_RE.test(recorded_at)) {
    throw new Error(`事件 ${id} 缺少记录时间`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`事件 ${id} 缺少内容`);
  }
  for (const field of REQUIRED_PAYLOAD_FIELDS[kind]) {
    if (payload[field] === undefined || payload[field] === null) {
      throw new Error(`事件 ${id} 缺少字段 ${field}`);
    }
  }
  return Object.freeze({ id, kind, valid_from, valid_to, recorded_at, payload: Object.freeze({ ...payload }) });
}

// 只追加的事件库：不提供修改与删除，保证旧报告随时可以按原样重放。
export class EventStore {
  #events;

  constructor(events = []) {
    this.#events = events.map((event) => validateEvent(event));
    const seen = new Set();
    for (const event of this.#events) {
      if (seen.has(event.id)) {
        throw new Error(`事件标识重复：${event.id}`);
      }
      seen.add(event.id);
    }
  }

  append(event) {
    const checked = validateEvent(event);
    if (this.#events.some((existing) => existing.id === checked.id)) {
      throw new Error(`事件标识重复：${checked.id}`);
    }
    this.#events.push(checked);
    return checked;
  }

  all() {
    return [...this.#events];
  }

  byKind(kind) {
    return this.#events.filter((event) => event.kind === kind);
  }

  byId(id) {
    return this.#events.find((event) => event.id === id) ?? null;
  }

  // 按记录时间截取视图：报告只应看到 as_of 之前系统已知的数据。
  asOf(recordedAt) {
    return new EventStore(this.#events.filter((event) => event.recorded_at <= recordedAt));
  }

  hash() {
    return hashValue(this.#events);
  }
}
