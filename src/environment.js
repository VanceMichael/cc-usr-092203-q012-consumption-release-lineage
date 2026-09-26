// 授权环境：平台明细（到人级的领取、核销）只能在授权环境内处理；
// 授权环境之外只允许输出汇总数字与估计结果。
export function createEnvironment({ authorized = false, purpose = '' } = {}) {
  return Object.freeze({ authorized: Boolean(authorized), purpose });
}

export function requireAuthorized(environment, action) {
  if (!environment || environment.authorized !== true) {
    throw new Error(`未授权环境：${action}只能在授权环境内处理`);
  }
}

// 查询某人的领取与核销明细。这是典型的平台明细操作，必须授权。
export function platformPersonDetail(store, environment, personRef) {
  requireAuthorized(environment, '查询平台明细');
  const claims = store
    .byKind('claim')
    .filter((event) => event.payload.person_ref === personRef)
    .map((event) => ({ id: event.id, ...event.payload, date: event.valid_from }));
  const claimIds = new Set(claims.map((claim) => claim.id));
  const redemptions = store
    .byKind('redemption')
    .filter((event) => claimIds.has(event.payload.claim_id))
    .map((event) => ({ id: event.id, ...event.payload, date: event.valid_from }));
  return { person_ref: personRef, claims, redemptions };
}
