import { mean, sampleVariance } from './stats.js';
import { inWindow } from './time.js';

// 双重差分估计：处理组与对照组在政策前后的变化量之差。
// 返回带 95% 不确定范围的估计，而不是单一的同比上升数字，
// 从而把季节、价格和全国性平台活动等共同趋势剥离出去。
export function estimateIncrementDiD({ treatPre, treatPost, controlPre, controlPost }) {
  const dTreat = mean(treatPost) - mean(treatPre);
  const dControl = mean(controlPost) - mean(controlPre);
  const point = dTreat - dControl;
  const se = Math.sqrt(
    sampleVariance(treatPre) / treatPre.length
      + sampleVariance(treatPost) / treatPost.length
      + sampleVariance(controlPre) / controlPre.length
      + sampleVariance(controlPost) / controlPost.length,
  );
  return {
    kind: 'estimate',
    method: 'difference-in-differences',
    point,
    lower: point - 1.96 * se,
    upper: point + 1.96 * se,
    confidence: 0.95,
  };
}

// 没有对照组时的分阶段规则：按规则为各阶段核销额乘以可归因系数。
// 规则估计的置信度低于对照组，不确定范围更宽，必须在公开说明中标注。
export function estimateIncrementPhased({ redemptions, rules, uncertaintyRatio = 0.3 }) {
  let point = 0;
  for (const rule of rules) {
    const stageAmount = redemptions
      .filter((event) => inWindow(event.occurred_at, rule))
      .reduce((acc, event) => acc + event.amount, 0);
    point += stageAmount * rule.factor;
  }
  return {
    kind: 'estimate',
    method: 'phased-rule',
    point,
    lower: point * (1 - uncertaintyRatio),
    upper: point * (1 + uncertaintyRatio),
    confidence: 0.5,
  };
}

// 将日均估计放大到整个活动窗口，得到窗口期总量，便于比较单位成本。
export function scaleToWindow(estimate, days) {
  return {
    ...estimate,
    point: estimate.point * days,
    lower: estimate.lower * days,
    upper: estimate.upper * days,
  };
}
