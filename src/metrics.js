// 决策比较指标：单位成本、持续消费与挤出效应，全部带不确定区间。
import { estimateWindowEffect } from './estimate.js';

// 单位成本 = 归因口径财政补贴 / 增量消费（元财政补贴撬动 1 元增量消费的成本）。
// 区间由增量区间换算；若增量区间包含零，成本上限无界，必须如实标注。
export function unitCost(subsidySpent, incrementTotal) {
  const value = subsidySpent / incrementTotal.value;
  const [lo, hi] = incrementTotal.ci;
  if (lo > 0) {
    return { value, ci: [subsidySpent / hi, subsidySpent / lo], note: null };
  }
  return {
    value,
    ci: [hi > 0 ? subsidySpent / hi : null, null],
    note: '增量区间包含零，单位成本上限无界',
  };
}

// 持续消费：政策结束后窗口内，处理地区相对对照地区仍高出的部分（周均）。
export function sustainedConsumption(stats, args) {
  return estimateWindowEffect(stats, {
    ...args,
    effect_window: args.after_window,
    method: '持续消费（政策后窗口双重差分）',
  });
}

// 挤出效应：同一地区非补贴品类的双重差分。负值表示消费被补贴品类挤占。
export function crowdingOut(stats, args) {
  const effect = estimateWindowEffect(stats, {
    ...args,
    categories: args.comparison_categories,
    method: '挤出效应（非补贴品类双重差分）',
  });
  return {
    ...effect,
    interpretation: effect.weekly.value < 0
      ? '非补贴品类相对对照地区下降，存在挤出迹象'
      : '未见明显挤出',
  };
}
