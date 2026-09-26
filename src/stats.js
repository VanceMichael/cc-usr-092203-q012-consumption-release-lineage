// 基础统计量，供基线与增量估计共用。

export function mean(values) {
  if (!values.length) {
    throw new Error('序列不能为空');
  }
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function sampleVariance(values) {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  return values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
}
