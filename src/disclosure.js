// 公开说明：明确区分观察事实与估计结果。
// 观察事实直接来自记录，不带区间；估计必须给出方法、假设与 95% 不确定范围。
export function buildPublicStatement(report, { campaign_name = report.campaign_id } = {}) {
  const { observed, estimates } = report;
  return {
    title: `${campaign_name} 促消费成效公开说明（报告 v${report.version}）`,
    as_of: report.as_of,
    observed_facts: [
      { label: '累计曝光', value: observed.exposures_total, unit: '次', nature: 'observed' },
      { label: '券领取张数', value: observed.claims_total, unit: '张', nature: 'observed' },
      { label: '领取人数（活动内去重）', value: observed.unique_claimants_campaign, unit: '人', nature: 'observed' },
      { label: '核销金额', value: observed.redemption_amount_gross, unit: '元', nature: 'observed' },
      { label: '退货退款金额', value: observed.refunds.amount, unit: '元', nature: 'observed' },
      { label: '财政补贴（核销口径）', value: observed.subsidy_gross, unit: '元', nature: 'observed' },
      { label: '财政补贴（归因口径）', value: observed.attributed_subsidy_spent, unit: '元', nature: 'observed' },
    ],
    estimates: [
      {
        label: '增量消费',
        value: estimates.increment.total.value,
        ci: estimates.increment.total.ci,
        unit: '元',
        method: estimates.increment.method,
        assumptions: estimates.increment.assumptions,
        nature: 'estimate',
      },
      {
        label: '单位增量财政成本',
        value: estimates.unit_cost.value,
        ci: estimates.unit_cost.ci,
        unit: '元/元',
        method: '归因口径财政补贴 ÷ 增量消费',
        assumptions: estimates.unit_cost.note ? [estimates.unit_cost.note] : [],
        nature: 'estimate',
      },
      {
        label: '政策后持续消费（周均）',
        value: estimates.sustained.weekly.value,
        ci: estimates.sustained.weekly.ci,
        unit: '元/周',
        method: estimates.sustained.method,
        assumptions: estimates.sustained.assumptions,
        nature: 'estimate',
      },
      {
        label: '挤出效应（周均）',
        value: estimates.crowding_out.weekly.value,
        ci: estimates.crowding_out.weekly.ci,
        unit: '元/周',
        method: estimates.crowding_out.method,
        assumptions: [...estimates.crowding_out.assumptions, estimates.crowding_out.interpretation],
        nature: 'estimate',
      },
    ],
    statement:
      '观察事实直接来自领取、核销、退货与统计记录；估计值基于可解释的对照规则（双重差分），'
      + '区间为 95% 不确定范围。任何结论均可在授权环境内按报告哈希重放核验。',
  };
}
