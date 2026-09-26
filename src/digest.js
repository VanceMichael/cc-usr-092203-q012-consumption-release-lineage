import { createHash } from 'node:crypto';

// 生成键序稳定的 JSON 文本，保证同一份资料永远得到同一个摘要。
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// 报告与其固定输入的摘要，用于审计重放时核对资料是否被改动。
export function digest(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
