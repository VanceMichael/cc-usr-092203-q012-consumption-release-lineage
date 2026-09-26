// 提供可复算的规范哈希，用于基线冻结、报告内容与审计重放的一致性校验。
import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashValue(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
