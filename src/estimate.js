// 可解释的增量估计：双重差分。
// 对照可以是指定的可比地区（matched_region），
// 也可以是分阶段实施中“政策尚未覆盖”的地区（not_yet_treated）。
// 估计结果都带 95% 不确定区间，假设以文字列出，供公开说明引用。

export const MATCHED_CONTROL_ASSUMPTIONS = [
  '处理地区与对照地区在政策前满足平行趋势',
  '对照地区同期未实施同类促消费措施',
  '季节、价格与全国性平台活动对两类地区影响一致',
  '统计口径变化已按映射重述，前后可比',
];

export const PHASED_CONTROL_ASSUMPTIONS = [
  '以政策尚未实施的地区作为对照（分阶段规则）',
  '各地区在政策前满足平行趋势',
  '后续阶段的政策不会提前影响对照地区消费',
  '统计口径变化已按映射重述，前后可比',
];

export function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values) {
  if (values.length < 2) {
    return 0;
  }
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

export function differenceInDifferences({ treatment_pre, treatment_post, control_pre, control_post }) {
  const groups = { treatment_pre, treatment_post, control_pre, control_post };
  for (const [name, values] of Object.entries(groups)) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`窗口内缺少统计数据：${name}`);
    }
  }
  const value = mean(treatment_post) - mean(treatment_pre) - (mean(control_post) - mean(control_pre));
  const se = Math.sqrt(
    sampleVariance(treatment_pre) / treatment_pre.length
      + sampleVariance(treatment_post) / treatment_post.length
      + sampleVariance(control_pre) / control_pre.length
      + sampleVariance(control_post) / control_post.length,
  );
  return { value, se, ci: [value - 1.96 * se, value + 1.96 * se] };
}

// 按周汇总指定地区集合与品类集合的消费统计。
export function weeklySeries(stats, regionIds, categories, [start, end]) {
  const regions = new Set(regionIds);
  const scope = new Set(categories);
  const weeks = new Map();
  for (const stat of stats) {
    if (!regions.has(stat.region_id) || !scope.has(stat.category)) {
      continue;
    }
    if (stat.week_start < start || stat.week_start > end) {
      continue;
    }
    weeks.set(stat.week_start, (weeks.get(stat.week_start) ?? 0) + stat.amount);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([week, amount]) => ({ week, amount }));
}

// 多个对照地区按周取平均，避免对照组规模随地区数量变化。
function controlWeeklySeries(stats, controlRegions, categories, window) {
  const perRegion = controlRegions.map((region) => weeklySeries(stats, [region], categories, window));
  const weeks = new Map();
  for (const series of perRegion) {
    for (const { week, amount } of series) {
      if (!weeks.has(week)) {
        weeks.set(week, []);
      }
      weeks.get(week).push(amount);
    }
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([week, amounts]) => ({ week, amount: mean(amounts) }));
}

// 解析对照地区：指定对照，或分阶段规则下政策尚未覆盖的地区。
export function resolveControlRegions(events, config) {
  if (config.control?.type === 'matched_region') {
    return [config.control.region_id];
  }
  if (config.control?.type === 'not_yet_treated') {
    const postEnd = config.windows.post[1];
    const regions = events
      .filter((event) => event.kind === 'campaign' && event.id !== config.campaign_id && event.valid_from > postEnd)
      .map((event) => event.payload.region_id);
    const unique = [...new Set(regions)];
    if (unique.length === 0) {
      throw new Error('分阶段规则下没有找到尚未实施政策的对照地区');
    }
    return unique;
  }
  throw new Error(`未知对照构建方式：${config.control?.type}`);
}

// 估计某个窗口相对基线窗口的效应（周均与窗口合计），单位与统计数据一致。
export function estimateWindowEffect(
  stats,
  { treatment_region, control_regions, categories, baseline_window, effect_window, method = '双重差分（对照地区）', assumptions = MATCHED_CONTROL_ASSUMPTIONS },
) {
  const treatmentPre = weeklySeries(stats, [treatment_region], categories, baseline_window).map((row) => row.amount);
  const treatmentPost = weeklySeries(stats, [treatment_region], categories, effect_window).map((row) => row.amount);
  const controlPre = controlWeeklySeries(stats, control_regions, categories, baseline_window).map((row) => row.amount);
  const controlPost = controlWeeklySeries(stats, control_regions, categories, effect_window).map((row) => row.amount);
  const did = differenceInDifferences({
    treatment_pre: treatmentPre,
    treatment_post: treatmentPost,
    control_pre: controlPre,
    control_post: controlPost,
  });
  const weeks = treatmentPost.length;
  return {
    method,
    assumptions,
    weekly: { value: did.value, se: did.se, ci: did.ci },
    n_weeks: weeks,
    total: { value: did.value * weeks, ci: did.ci.map((bound) => bound * weeks) },
  };
}
