import { digest } from './digest.js';
import { mean } from './stats.js';
import { inWindow, windowDays } from './time.js';
import { applyCorrections } from './corrections.js';
import { estimateIncrementDiD, estimateIncrementPhased, scaleToWindow } from './estimate.js';
import { assertAuthorized } from './access.js';

// 归因计算：从固定输入纯函数式地算出一份结论。
// 同样的输入永远得到同样的结果，这是审计重放的基础。
export function computeAttribution(inputs) {
  const { campaign, events, corrections = [], asOf, mappingVersion, series, rules, baseline } = inputs;

  // 平台明细只在授权环境处理。
  if (events.some((e) => e.classification === 'restricted')) {
    assertAuthorized(inputs.env);
  }

  const { events: adjusted, adjustments } = applyCorrections(events, corrections, { asOf, mappingVersion });
  const usable = adjusted.filter((e) => e.campaign_id === campaign.campaign_id && !e.excluded);
  const ofKind = (kind, window) => usable.filter((e) => e.kind === kind && inWindow(e.occurred_at, window));

  const exposures = ofKind('exposure', campaign.exposure_window);
  const claims = ofKind('claim', campaign.claim_window);
  const redemptions = ofKind('redemption', campaign.redeem_window);
  const refunds = ofKind('refund', campaign.refund_window);
  const sum = (list, field) => list.reduce((acc, e) => acc + (e[field] ?? 0), 0);

  // 迟到退款：记录时间晚于核销窗口结束的退款，在调整记录中明确标注。
  for (const refund of refunds) {
    if (refund.recorded_at > campaign.redeem_window.to) {
      adjustments.push({
        correction_id: null,
        event_id: refund.event_id,
        change: 'late_refund',
        recorded_at: refund.recorded_at,
      });
    }
  }

  const observed = {
    exposures: exposures.length,
    claims: claims.length,
    redemptions: { count: redemptions.length, amount: sum(redemptions, 'amount'), subsidy: sum(redemptions, 'subsidy_amount') },
    refunds: { count: refunds.length, amount: sum(refunds, 'amount'), subsidy_returned: sum(refunds, 'subsidy_amount') },
  };
  observed.net_redemption_amount = observed.redemptions.amount - observed.refunds.amount;
  observed.net_subsidy_amount = observed.redemptions.subsidy - observed.refunds.subsidy_returned;

  // 增量估计：有对照序列用双重差分，否则退回分阶段规则。
  const days = windowDays(campaign.redeem_window);
  const estimates = {};
  if (series?.increment) {
    estimates.increment_consumption = scaleToWindow(estimateIncrementDiD(series.increment), days);
  } else if (rules) {
    estimates.increment_consumption = estimateIncrementPhased({ redemptions, rules });
  }
  if (estimates.increment_consumption) {
    estimates.unit_cost = divideEstimate(observed.net_subsidy_amount, estimates.increment_consumption);
  }
  // 挤出效应：非补贴品类的对照估计，负值表示被补贴活动挤出的消费。
  if (series?.crowding) {
    estimates.crowding_out = scaleToWindow(estimateIncrementDiD(series.crowding), days);
  }

  // 持续消费：活动结束后处理组日均消费与冻结基线之比，属于观察事实。
  const sustained = series?.sustain && baseline
    ? {
      kind: 'observed',
      post_window_daily_mean: mean(series.sustain.treat),
      baseline_daily_mean: baseline.metrics.treat_mean,
      ratio: mean(series.sustain.treat) / baseline.metrics.treat_mean,
    }
    : null;

  return { as_of: asOf, mapping_version: mappingVersion, observed, estimates, sustained, adjustments };
}

// 单位成本 = 补贴净支出 / 新增消费。增量不大于零时单位成本无法定义。
function divideEstimate(amount, estimate) {
  if (estimate.point <= 0) {
    return {
      kind: 'estimate',
      method: 'unit-cost',
      point: null,
      lower: null,
      upper: null,
      confidence: estimate.confidence,
      note: '增量估计不大于零，单位成本无法定义',
    };
  }
  return {
    kind: 'estimate',
    method: 'unit-cost',
    point: amount / estimate.point,
    lower: estimate.upper > 0 ? amount / estimate.upper : null,
    upper: estimate.lower > 0 ? amount / estimate.lower : null,
    confidence: estimate.confidence,
  };
}

// 追加式报告库：每次修正产生新版本，旧版本与其固定输入一起保留。
export function createReportStore() {
  const reports = [];

  function get(reportId) {
    const report = reports.find((r) => r.report_id === reportId);
    if (!report) {
      throw new Error(`报告不存在: ${reportId}`);
    }
    return report;
  }

  return {
    produce(inputs) {
      const result = computeAttribution(inputs);
      const report = {
        report_id: `rpt-${reports.length + 1}`,
        version: reports.length + 1,
        as_of: inputs.asOf,
        inputs,
        inputs_digest: digest(inputs),
        result,
        result_digest: digest(result),
      };
      reports.push(report);
      return report;
    },
    get,
    list() {
      return reports.map(({ report_id, version, as_of }) => ({ report_id, version, as_of }));
    },
    // 审计重放：用报告固定的输入重新计算，核对输入与结果两份摘要。
    replay(reportId) {
      const report = get(reportId);
      const inputsOk = digest(report.inputs) === report.inputs_digest;
      const recomputed = computeAttribution(report.inputs);
      const resultOk = digest(recomputed) === report.result_digest;
      return { report_id: report.report_id, ok: inputsOk && resultOk, inputs_ok: inputsOk, result_ok: resultOk };
    },
  };
}

// 公开说明：明确区分观察事实与估计，估计一律带不确定范围。
export function publicStatement(report) {
  const { observed, estimates, sustained, as_of: asOf } = report.result;
  const facts = [
    `截至 ${asOf}，曝光 ${observed.exposures} 次、领取 ${observed.claims} 笔、核销 ${observed.redemptions.count} 笔`,
    `核销净额 ${observed.net_redemption_amount} 元，补贴净支出 ${observed.net_subsidy_amount} 元（已扣减退款）`,
  ];
  if (sustained) {
    facts.push(
      `活动结束后处理组日均消费 ${sustained.post_window_daily_mean.toFixed(2)} 元，`
      + `为冻结基线的 ${(sustained.ratio * 100).toFixed(1)}%`,
    );
  }
  const estimateLines = [];
  if (estimates.increment_consumption) {
    estimateLines.push(formatEstimate('补贴带来的新增消费（窗口期）', estimates.increment_consumption, '元'));
  }
  if (estimates.unit_cost && estimates.unit_cost.point != null) {
    estimateLines.push(formatEstimate('每带动 1 元新增消费的补贴成本', estimates.unit_cost, '元'));
  }
  if (estimates.crowding_out) {
    estimateLines.push(formatEstimate('非补贴品类的挤出效应', estimates.crowding_out, '元'));
  }
  return { observed_facts: facts, estimates: estimateLines };
}

function formatEstimate(label, estimate, unit) {
  return {
    label,
    method: estimate.method,
    point: estimate.point,
    range: [estimate.lower, estimate.upper],
    confidence: estimate.confidence,
    text: `${label}约为 ${estimate.point.toFixed(2)} ${unit}，`
      + `${estimate.confidence * 100}% 不确定范围 [${estimate.lower.toFixed(2)}, ${estimate.upper.toFixed(2)}]`
      + `（${estimate.method} 估计）`,
  };
}
