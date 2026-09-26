// 归因报告：版本化、可重放。
// 报告内容 = 纯函数(事件库 as_of 视图, 修正集, 配置, 基线)，
// 内容哈希存进报告；审计时用相同输入重算并比对哈希即可重放任何结论。
// 修正只产生新版本，旧报告永远保留、永远可复算。
import { applyCorrections, validateCorrection } from './corrections.js';
import { verifyBaseline } from './baseline.js';
import {
  MATCHED_CONTROL_ASSUMPTIONS,
  PHASED_CONTROL_ASSUMPTIONS,
  estimateWindowEffect,
  resolveControlRegions,
} from './estimate.js';
import { crowdingOut, sustainedConsumption, unitCost } from './metrics.js';
import { requireAuthorized } from './environment.js';
import { hashValue } from './hash.js';

const sum = (values) => values.reduce((total, value) => total + value, 0);

function computeCore({ store, corrections, baseline, config, as_of }) {
  if (baseline) {
    if (baseline.campaign_id !== config.campaign_id) {
      throw new Error('基线与报告针对的活动不一致');
    }
    if (!verifyBaseline(store, baseline)) {
      throw new Error('基线校验失败：政策前数据已被改动');
    }
  }
  const view = store.asOf(as_of);
  const campaign = view.byId(config.campaign_id);
  if (!campaign || campaign.kind !== 'campaign') {
    throw new Error(`找不到活动：${config.campaign_id}`);
  }

  const applied = applyCorrections(view.all(), corrections);
  const notes = [...applied.notes];

  // —— 观察事实：直接来自记录，修正口径单独列示 ——
  const claims = applied.claims.filter((claim) => claim.campaign_id === config.campaign_id);
  const claimIds = new Set(claims.map((claim) => claim.id));
  const redemptions = applied.redemptions.filter((redemption) => claimIds.has(redemption.claim_id));
  const redemptionIds = new Set(redemptions.map((redemption) => redemption.id));
  const refunds = applied.refunds.filter((refund) => redemptionIds.has(refund.redemption_id));

  const excluded = redemptions.filter((redemption) => redemption.excluded);
  const refundByRedemption = new Map();
  for (const refund of refunds) {
    const current = refundByRedemption.get(refund.redemption_id) ?? { amount: 0, subsidy_amount: 0 };
    current.amount += refund.amount;
    current.subsidy_amount += refund.subsidy_amount;
    refundByRedemption.set(refund.redemption_id, current);
  }

  const grossAmount = sum(redemptions.map((redemption) => redemption.amount));
  const grossSubsidy = sum(redemptions.map((redemption) => redemption.subsidy_amount));
  const excludedAmount = sum(excluded.map((redemption) => redemption.amount));
  const excludedSubsidy = sum(excluded.map((redemption) => redemption.subsidy_amount));
  const refundAmount = sum(refunds.map((refund) => refund.amount));
  const refundSubsidy = sum(refunds.map((refund) => refund.subsidy_amount));

  const byRegion = {};
  for (const redemption of redemptions) {
    if (redemption.excluded) {
      continue;
    }
    const refunded = refundByRedemption.get(redemption.id)?.amount ?? 0;
    const region = redemption.region_id ?? '未知地区';
    byRegion[region] = (byRegion[region] ?? 0) + (redemption.amount - refunded);
  }

  const claimantsByCampaign = new Map();
  for (const claim of applied.claims) {
    if (!claimantsByCampaign.has(claim.campaign_id)) {
      claimantsByCampaign.set(claim.campaign_id, new Set());
    }
    claimantsByCampaign.get(claim.campaign_id).add(claim.person_ref);
  }
  const naiveSum = sum([...claimantsByCampaign.values()].map((persons) => persons.size));
  const uniqueCross = new Set(applied.claims.map((claim) => claim.person_ref)).size;
  if (naiveSum !== uniqueCross) {
    notes.push(`跨活动去重：各活动领取人数简单相加为 ${naiveSum}，去重后为 ${uniqueCross}`);
  }

  const exposures = sum(
    view
      .byKind('exposure')
      .filter((event) => event.payload.campaign_id === config.campaign_id)
      .map((event) => event.payload.count),
  );

  const observed = {
    exposures_total: exposures,
    claims_total: claims.length,
    unique_claimants_campaign: new Set(claims.map((claim) => claim.person_ref)).size,
    claimants_naive_sum_across_campaigns: naiveSum,
    unique_claimants_cross_campaign: uniqueCross,
    redemptions_count: redemptions.length,
    redemption_amount_gross: grossAmount,
    subsidy_gross: grossSubsidy,
    excluded_fraud: { count: excluded.length, amount: excludedAmount, subsidy: excludedSubsidy },
    refunds: { count: refunds.length, amount: refundAmount, subsidy: refundSubsidy },
    attributed_redemption_amount: grossAmount - excludedAmount - refundAmount,
    attributed_subsidy_spent: grossSubsidy - excludedSubsidy - refundSubsidy,
    attributed_amount_by_region: byRegion,
  };

  // —— 估计：可解释的对照规则，带不确定区间 ——
  const controlRegions = resolveControlRegions(view.all(), config);
  const treatmentRegion = campaign.payload.region_id;
  const assumptions = config.control.type === 'not_yet_treated' ? PHASED_CONTROL_ASSUMPTIONS : MATCHED_CONTROL_ASSUMPTIONS;
  const method = config.control.type === 'not_yet_treated' ? '双重差分（分阶段规则：尚未实施地区为对照）' : '双重差分（对照地区）';

  const increment = estimateWindowEffect(applied.consumption_stats, {
    treatment_region: treatmentRegion,
    control_regions: controlRegions,
    categories: config.category_scope,
    baseline_window: config.windows.pre,
    effect_window: config.windows.post,
    method,
    assumptions,
  });
  const sustained = sustainedConsumption(applied.consumption_stats, {
    treatment_region: treatmentRegion,
    control_regions: controlRegions,
    categories: config.category_scope,
    baseline_window: config.windows.pre,
    after_window: config.windows.after,
    assumptions,
  });
  const crowding = crowdingOut(applied.consumption_stats, {
    treatment_region: treatmentRegion,
    control_regions: controlRegions,
    categories: config.category_scope,
    comparison_categories: config.comparison_categories,
    baseline_window: config.windows.pre,
    effect_window: config.windows.post,
    assumptions,
  });
  const cost = unitCost(observed.attributed_subsidy_spent, increment.total);

  const estimates = {
    increment: { ...increment, unit: '元' },
    unit_cost: { ...cost, unit: '元财政补贴/元增量消费' },
    sustained: { ...sustained, unit: '元/周' },
    crowding_out: { ...crowding, unit: '元/周' },
  };

  return {
    domain: 'consumption-release-lineage',
    report_kind: 'campaign_effectiveness',
    campaign_id: config.campaign_id,
    as_of,
    config,
    corrections_applied: corrections.map((correction) => correction.id),
    inputs: {
      events_hash: view.hash(),
      corrections_hash: hashValue(corrections),
      config_hash: hashValue(config),
      baseline_hash: baseline ? baseline.baseline_hash : null,
    },
    observed,
    estimates,
    notes,
  };
}

// 生成新版本报告。必须在授权环境内调用（过程会接触人级明细）。
export function buildReport({ store, corrections = [], baseline = null, config, as_of, environment, id, created_at, previous = [] }) {
  requireAuthorized(environment, '生成归因报告');
  const checked = corrections.map((correction) => validateCorrection(correction));
  const core = computeCore({ store, corrections: checked, baseline, config, as_of });
  const version = previous.length > 0 ? Math.max(...previous.map((report) => report.version)) + 1 : 1;
  const supersedes = previous.length > 0 ? previous[previous.length - 1].id : null;
  return Object.freeze({
    id,
    version,
    created_at,
    supersedes,
    ...core,
    hash: hashValue(core),
  });
}

// 审计重放：用相同的事件库、修正日志与报告内保存的输入重算，比对内容哈希。
export function replayReport(report, { store, corrections = [], baseline = null }) {
  const applied = corrections.filter((correction) => report.corrections_applied.includes(correction.id));
  const core = computeCore({ store, corrections: applied, baseline, config: report.config, as_of: report.as_of });
  const recomputed = hashValue(core);
  return {
    reproducible: recomputed === report.hash,
    expected_hash: report.hash,
    recomputed_hash: recomputed,
  };
}

// 决策比较：按单位成本排序，并列示持续消费与挤出效应，便于跨措施（或跨版本）对比。
export function compareReports(reports) {
  return reports
    .map((report) => ({
      report_id: report.id,
      campaign_id: report.campaign_id,
      version: report.version,
      incremental_consumption: report.estimates.increment.total.value,
      incremental_ci: report.estimates.increment.total.ci,
      unit_cost: report.estimates.unit_cost.value,
      unit_cost_ci: report.estimates.unit_cost.ci,
      sustained_weekly: report.estimates.sustained.weekly.value,
      crowding_out_weekly: report.estimates.crowding_out.weekly.value,
    }))
    .sort((a, b) => a.unit_cost - b.unit_cost);
}
