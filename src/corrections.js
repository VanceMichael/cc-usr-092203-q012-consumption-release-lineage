import { isRecordedBy } from './time.js';

// 归因修正。每类修正都是带记录时间的追加资料：
// 只有记录时间不晚于报告截止（asOf）的修正才生效，
// 因此旧报告可以用旧的截止时间原样重放，新修正确产生新版本。
export function applyCorrections(events, corrections, { asOf, mappingVersion }) {
  const active = corrections.filter((c) => isRecordedBy(c, asOf));
  const adjustments = [];
  const adjusted = events
    .filter((e) => isRecordedBy(e, asOf))
    .map((e) => ({ ...e }));

  for (const correction of active) {
    if (correction.type === 'fraud_orders') {
      // 异常刷单：整笔订单的所有事件不计入归因。
      const orderIds = new Set(correction.order_ids);
      for (const event of adjusted) {
        if (orderIds.has(event.order_id) && !event.excluded) {
          event.excluded = { reason: 'fraud_orders', correction_id: correction.correction_id };
          adjustments.push({ correction_id: correction.correction_id, event_id: event.event_id, change: 'excluded' });
        }
      }
    }

    if (correction.type === 'duplicate_claim') {
      // 跨活动重复领取：同一对象只保留最早一笔领取，其余不计入。
      const bySubject = new Map();
      for (const event of adjusted) {
        if (event.kind !== 'claim' || event.excluded) {
          continue;
        }
        const list = bySubject.get(event.subject_id) ?? [];
        list.push(event);
        bySubject.set(event.subject_id, list);
      }
      for (const list of bySubject.values()) {
        const campaigns = new Set(list.map((e) => e.campaign_id));
        if (campaigns.size < 2) {
          continue;
        }
        list.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
        const [kept, ...duplicates] = list;
        for (const dup of duplicates) {
          dup.excluded = {
            reason: 'duplicate_claim',
            correction_id: correction.correction_id,
            kept_event_id: kept.event_id,
          };
          adjustments.push({
            correction_id: correction.correction_id,
            event_id: dup.event_id,
            change: 'excluded',
            kept_event_id: kept.event_id,
          });
        }
      }
    }

    if (correction.type === 'merchant_relocation') {
      // 商户迁址：生效时间之前的事件仍归原地区，之后归新地区。
      for (const event of adjusted) {
        if (
          event.merchant_id === correction.merchant_id
          && event.occurred_at >= correction.effective_from
          && event.region_code !== correction.region_to
        ) {
          adjustments.push({
            correction_id: correction.correction_id,
            event_id: event.event_id,
            change: 'region',
            from: event.region_code,
            to: correction.region_to,
          });
          event.region_code = correction.region_to;
        }
      }
    }

    if (correction.type === 'classification_change') {
      // 统计分类变化：报告固定一个分类版本，只有版本匹配时才重编码，
      // 这样旧报告用旧版本重放时数字不变。
      if (correction.mapping_version !== mappingVersion) {
        continue;
      }
      for (const event of adjusted) {
        const mapped = correction.map[event.category_code];
        if (mapped && event.occurred_at >= correction.effective_from) {
          adjustments.push({
            correction_id: correction.correction_id,
            event_id: event.event_id,
            change: 'category',
            from: event.category_code,
            to: mapped,
          });
          event.category_code = mapped;
        }
      }
    }
  }

  return { events: adjusted, adjustments };
}
