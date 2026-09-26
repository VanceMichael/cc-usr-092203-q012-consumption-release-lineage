import { mean } from './stats.js';
import { digest } from './digest.js';

// 在政策开始前冻结基线。冻结后的基线被深冻结，任何修改都会抛错，
// 保证后续所有报告与重放都使用同一个基准，而不是事后挑选的数字。
export function freezeBaseline({ campaignId, policyStart, frozenAt, window, series }) {
  if (Date.parse(frozenAt) >= Date.parse(policyStart)) {
    throw new Error('基线必须在政策开始前冻结');
  }
  const baseline = {
    campaign_id: campaignId,
    window,
    frozen_at: frozenAt,
    metrics: {
      treat_mean: mean(series.treat),
      control_mean: series.control ? mean(series.control) : null,
      days: series.treat.length,
    },
  };
  baseline.baseline_id = `bl-${digest(baseline).slice(0, 12)}`;
  return deepFreeze(baseline);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}
