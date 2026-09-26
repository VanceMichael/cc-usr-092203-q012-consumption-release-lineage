// 异常刷单识别：只使用可解释的规则，输出候选线索；
// 是否剔除由人工确认后以 fraud_flag 修正记录进入归因，识别本身不改动任何数据。
export function detectFraud(events, rules = {}) {
  const maxPerPersonPerDay = rules.max_redemptions_per_person_per_day ?? 2;
  const merchantSpikeFactor = rules.merchant_spike_factor ?? 5;
  const merchantMinCount = rules.merchant_min_count ?? 5;

  const claims = new Map(
    events.filter((event) => event.kind === 'claim').map((event) => [event.id, event.payload]),
  );
  const redemptions = events.filter((event) => event.kind === 'redemption');

  // 规则一：同一人员同日核销次数异常集中。
  const byPersonDay = new Map();
  for (const redemption of redemptions) {
    const person = claims.get(redemption.payload.claim_id)?.person_ref;
    if (!person) {
      continue;
    }
    const key = `${person}|${redemption.valid_from}`;
    if (!byPersonDay.has(key)) {
      byPersonDay.set(key, []);
    }
    byPersonDay.get(key).push(redemption);
  }
  const flags = [];
  for (const [key, group] of byPersonDay) {
    if (group.length > maxPerPersonPerDay) {
      const [person_ref, day] = key.split('|');
      flags.push({
        type: 'person_daily_burst',
        person_ref,
        day,
        count: group.length,
        claim_ids: group.map((redemption) => redemption.payload.claim_id),
        rule: `同一人员同日核销超过 ${maxPerPersonPerDay} 次`,
      });
    }
  }

  // 规则二：商户单日核销笔数相对自身日均显著突增。
  const byMerchant = new Map();
  for (const redemption of redemptions) {
    const merchant = redemption.payload.merchant_id;
    if (!byMerchant.has(merchant)) {
      byMerchant.set(merchant, new Map());
    }
    const days = byMerchant.get(merchant);
    days.set(redemption.valid_from, (days.get(redemption.valid_from) ?? 0) + 1);
  }
  for (const [merchant_id, days] of byMerchant) {
    const counts = [...days.values()];
    const average = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    for (const [day, count] of days) {
      if (count >= merchantMinCount && count > merchantSpikeFactor * average) {
        flags.push({
          type: 'merchant_daily_spike',
          merchant_id,
          day,
          count,
          average_per_day: average,
          rule: `商户单日核销超过自身日均 ${merchantSpikeFactor} 倍`,
        });
      }
    }
  }

  return flags;
}
