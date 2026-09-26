// 基线冻结：政策开始前把基线数据快照并固化哈希。
// 之后的任何报告都引用同一份基线；若政策前数据被事后补录或改动，校验会失败。
import { hashValue } from './hash.js';

function baselineStats(store, campaign, asOf) {
  return store
    .byKind('consumption_stat')
    .filter((event) => event.recorded_at <= asOf && event.valid_from < campaign.valid_from)
    .map((event) => ({
      id: event.id,
      valid_from: event.valid_from,
      recorded_at: event.recorded_at,
      payload: event.payload,
    }));
}

export function freezeBaseline(store, { campaign_id, as_of }) {
  const campaign = store.byId(campaign_id);
  if (!campaign || campaign.kind !== 'campaign') {
    throw new Error(`找不到活动：${campaign_id}`);
  }
  if (as_of.slice(0, 10) >= campaign.valid_from) {
    throw new Error('基线必须在政策开始前冻结');
  }
  const stats = baselineStats(store, campaign, as_of);
  if (stats.length === 0) {
    throw new Error('政策开始前没有可用于基线的消费统计');
  }
  const weeks = stats.map((stat) => stat.valid_from).sort();
  const baseline = {
    kind: 'baseline',
    campaign_id,
    frozen_at: as_of,
    stat_count: stats.length,
    week_start: weeks[0],
    week_end: weeks[weeks.length - 1],
    stats,
  };
  baseline.baseline_hash = hashValue({ campaign_id, frozen_at: as_of, stats });
  return Object.freeze(baseline);
}

export function verifyBaseline(store, baseline) {
  const campaign = store.byId(baseline.campaign_id);
  if (!campaign || campaign.kind !== 'campaign') {
    return false;
  }
  const stats = baselineStats(store, campaign, baseline.frozen_at);
  const recomputed = hashValue({ campaign_id: baseline.campaign_id, frozen_at: baseline.frozen_at, stats });
  return recomputed === baseline.baseline_hash;
}
