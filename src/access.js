// 平台明细属于受限资料，只能在授权环境处理；
// 非授权环境只能看到不含受限记录的部分或聚合结果。

export function assertAuthorized(env) {
  if (!env || env.authorized !== true) {
    throw new Error('平台明细只能在授权环境处理');
  }
}

export function platformDetails(events, env) {
  assertAuthorized(env);
  return events.filter((e) => e.classification === 'restricted');
}

export function visibleEvents(events, env) {
  if (env && env.authorized === true) {
    return events;
  }
  return events.filter((e) => e.classification !== 'restricted');
}
