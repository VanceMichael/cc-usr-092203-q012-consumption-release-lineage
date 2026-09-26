// 归因修正：跨活动重复领取、商户迁址、统计分类变化、迟到退款与异常刷单。
// 修正以追加方式记录，从不改写原始事件；旧报告保持原样可重放，
// 新报告在计算时应用修正集，并记录实际应用了哪些修正。
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CORRECTION_KINDS = [
  'duplicate_claim',
  'merchant_relocation',
  'classification_change',
  'late_refund',
  'fraud_flag',
];

const REQUIRED_CORRECTION_FIELDS = {
  duplicate_claim: ['person_ref', 'campaign_ids', 'rule'],
  merchant_relocation: ['merchant_id', 'from_region', 'to_region', 'effective_from'],
  classification_change: ['from_version', 'to_version', 'mapping'],
  late_refund: ['refund_id'],
  fraud_flag: ['claim_ids'],
};

export function validateCorrection(correction) {
  if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {
    throw new Error('修正必须是对象');
  }
  const { id, kind, recorded_at, reason, payload } = correction;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('修正缺少标识');
  }
  if (!CORRECTION_KINDS.includes(kind)) {
    throw new Error(`未知修正类型：${kind}`);
  }
  if (typeof recorded_at !== 'string' || !DATETIME_RE.test(recorded_at)) {
    throw new Error(`修正 ${id} 缺少记录时间`);
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error(`修正 ${id} 缺少理由说明`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`修正 ${id} 缺少内容`);
  }
  for (const field of REQUIRED_CORRECTION_FIELDS[kind]) {
    if (payload[field] === undefined || payload[field] === null) {
      throw new Error(`修正 ${id} 缺少字段 ${field}`);
    }
  }
  if (kind === 'merchant_relocation' && !DATE_RE.test(payload.effective_from)) {
    throw new Error(`修正 ${id} 的迁址生效日期无效`);
  }
  return Object.freeze({ id, kind, recorded_at, reason, payload: Object.freeze({ ...payload }) });
}

// 把修正应用到事件列表上，产出用于归因计算的“视图”。
// 原始事件不变；视图中的派生字段（归属地区、排除标记、重述分类）都可追溯到修正编号。
export function applyCorrections(events, corrections = []) {
  const checked = corrections.map((correction) => validateCorrection(correction));
  const notes = [];
  const byKind = (kind) => events.filter((event) => event.kind === kind);

  // 1. 统计分类变化：把旧口径的统计重述到新口径，保证政策前后可比。
  //    映射值可以是新分类标识（一比一），也可以是 { 新分类: 分摊比例 }（一对多拆分）。
  let consumptionStats = byKind('consumption_stat').map((event) => ({ id: event.id, ...event.payload }));
  for (const correction of checked.filter((c) => c.kind === 'classification_change')) {
    const { from_version, to_version, mapping } = correction.payload;
    const restated = [];
    for (const stat of consumptionStats) {
      const target = stat.classification_version === from_version ? mapping[stat.category] : null;
      if (!target) {
        restated.push(stat);
      } else if (typeof target === 'string') {
        restated.push({ ...stat, category: target, classification_version: to_version, restated_by: correction.id });
      } else {
        for (const [category, share] of Object.entries(target)) {
          restated.push({
            ...stat,
            category,
            classification_version: to_version,
            amount: Math.round(stat.amount * share),
            restated_by: correction.id,
          });
        }
      }
    }
    consumptionStats = restated;
    notes.push(`统计分类变化：${from_version} 已按映射重述为 ${to_version}（${correction.id}）`);
  }

  // 2. 商户迁址：核销按“核销发生时商户所在地区”归属，而不是商户当前地区。
  const merchants = new Map(byKind('merchant').map((event) => [event.id, event.payload]));
  const relocations = checked
    .filter((c) => c.kind === 'merchant_relocation')
    .map((c) => ({ id: c.id, ...c.payload }))
    .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  for (const relocation of relocations) {
    notes.push(`商户迁址：${relocation.merchant_id} 自 ${relocation.effective_from} 起归入 ${relocation.to_region}（${relocation.id}）`);
  }
  const resolveRegion = (merchantId, date) => {
    let region = merchants.get(merchantId)?.region_id ?? null;
    for (const relocation of relocations.filter((r) => r.merchant_id === merchantId)) {
      if (date >= relocation.effective_from) {
        region = relocation.to_region;
      }
    }
    return region;
  };

  // 3. 异常刷单：被确认的领取及其核销从归因口径中剔除（原始记录仍保留）。
  const fraudClaimIds = new Set(
    checked.filter((c) => c.kind === 'fraud_flag').flatMap((c) => c.payload.claim_ids),
  );
  if (fraudClaimIds.size > 0) {
    notes.push(`异常刷单：${fraudClaimIds.size} 笔领取的核销不计入归因（${checked
      .filter((c) => c.kind === 'fraud_flag')
      .map((c) => c.id)
      .join('、')}）`);
  }

  const redemptions = byKind('redemption').map((event) => {
    const excluded = fraudClaimIds.has(event.payload.claim_id);
    return {
      id: event.id,
      ...event.payload,
      date: event.valid_from,
      region_id: resolveRegion(event.payload.merchant_id, event.valid_from),
      excluded,
      exclude_reason: excluded ? '异常刷单标记' : null,
    };
  });

  // 4. 跨活动重复领取：同一人员在多个活动领取时，按规则（默认先领先得）只归属一次。
  const claims = byKind('claim').map((event) => ({
    id: event.id,
    ...event.payload,
    date: event.valid_from,
    duplicate_of: null,
  }));
  for (const correction of checked.filter((c) => c.kind === 'duplicate_claim')) {
    const { person_ref, campaign_ids } = correction.payload;
    const personClaims = claims
      .filter((claim) => claim.person_ref === person_ref && campaign_ids.includes(claim.campaign_id))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (personClaims.length < 2) {
      throw new Error(`修正 ${correction.id} 未找到 ${person_ref} 的跨活动重复领取`);
    }
    for (const duplicate of personClaims.slice(1)) {
      duplicate.duplicate_of = personClaims[0].id;
    }
    notes.push(`重复领取：${person_ref} 的 ${personClaims.length} 次领取按先领先得归属 ${personClaims[0].campaign_id}（${correction.id}）`);
  }

  // 5. 迟到退款：退款是否进入某期报告由报告的 as_of 截止决定，
  //    修正记录用于把退款与“为什么出了新版本”关联起来，便于审计叙述。
  const refunds = byKind('refund').map((event) => ({
    id: event.id,
    ...event.payload,
    date: event.valid_from,
    recorded_at: event.recorded_at,
  }));
  for (const correction of checked.filter((c) => c.kind === 'late_refund')) {
    const refund = refunds.find((item) => item.id === correction.payload.refund_id);
    if (!refund) {
      throw new Error(`迟到退款修正引用了不存在的退款：${correction.payload.refund_id}`);
    }
    notes.push(`迟到退款：${refund.id} 记录于 ${refund.recorded_at}，已纳入本期归因（${correction.id}）`);
  }

  return { claims, redemptions, refunds, consumption_stats: consumptionStats, notes };
}
