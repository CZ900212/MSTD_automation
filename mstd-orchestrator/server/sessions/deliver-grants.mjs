// C0.4 投递授权表：reply.target 的唯一放行依据。
// 默认仅 target === source（本会话）放行;跨会话必须由 daemon 显式 grant（如 cron 执行窗口）,
// 用完 finally revoke。纯内存即可——grant 生命周期从不跨进程/跨重启。
export function createDeliverGrants() {
  const grants = new Map();   // sourceSessionKey -> Set<targetSessionKey>

  function grant(sourceSessionKey, target) {
    let set = grants.get(sourceSessionKey);
    if (!set) { set = new Set(); grants.set(sourceSessionKey, set); }
    set.add(target);
  }

  function allowed(sourceSessionKey, target) {
    if (target === sourceSessionKey) return true;
    return grants.get(sourceSessionKey)?.has(target) ?? false;
  }

  function revoke(sourceSessionKey) {
    grants.delete(sourceSessionKey);
  }

  return { grant, allowed, revoke };
}
