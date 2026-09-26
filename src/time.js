// 时间边界统一为左闭右开区间 [from, to)，to 省略表示持续有效。
// 活动、人群、商户、地区、品类、预算、曝光、领取、核销和退货都使用同一套边界。

export function inWindow(at, window) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) {
    throw new Error(`无法解析时间: ${at}`);
  }
  if (t < Date.parse(window.from)) {
    return false;
  }
  if (window.to != null && t >= Date.parse(window.to)) {
    return false;
  }
  return true;
}

export function windowDays(window) {
  const from = Date.parse(window.from);
  const to = window.to != null ? Date.parse(window.to) : from;
  return Math.round((to - from) / 86400000);
}

// 资料的知识截止：只有记录时间不晚于 asOf 的内容才进入某一版报告。
export function isRecordedBy(record, asOf) {
  return Date.parse(record.recorded_at) <= Date.parse(asOf);
}
