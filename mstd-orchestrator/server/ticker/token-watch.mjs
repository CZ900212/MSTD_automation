// 迭代二 T1.3：user token 续期哨兵。
// lark-cli 每次调用会自动用 refresh token 换发 access token（无手动 refresh 命令），
// 但 refresh token 只有 7 天窗口——到期只能重走 device flow。此哨兵读本地 auth status
// （零网络），refresh 剩余不足 warnMs 时私聊 owner 告警，同一天只警一次。

export function createTokenWatch({ runLark, alert = null, warnMs = 48 * 3600_000, now = Date.now, log = console.error }) {
  let lastWarnDay = null;

  async function checkOnce() {
    const r = await runLark(["auth", "status", "--json"]);
    if (r.exitCode !== 0) {
      log(`[token-watch] auth status 失败: ${(r.stderr || r.stdout).slice(0, 200)}`);
      return { ok: false };
    }
    let j;
    try { j = JSON.parse(r.stdout); } catch {
      log(`[token-watch] auth status 输出不是 JSON`);
      return { ok: false };
    }
    const u = j?.identities?.user;
    const refreshExpiresAt = u?.refreshExpiresAt ? new Date(u.refreshExpiresAt).getTime() : null;
    if (!refreshExpiresAt || Number.isNaN(refreshExpiresAt)) {
      log(`[token-watch] user 身份缺 refreshExpiresAt（未授权？）`);
      return { ok: false };
    }
    const leftMs = refreshExpiresAt - now();
    if (leftMs >= warnMs) return { ok: true, warned: false, leftMs };

    const day = Math.floor(now() / 86_400_000);
    if (lastWarnDay === day) return { ok: true, warned: false, leftMs };   // 今天已警过
    lastWarnDay = day;
    const leftH = Math.max(0, Math.round(leftMs / 3600_000));
    const msg = `飞书 user 授权 refresh token 将于 ${u.refreshExpiresAt} 过期（剩约 ${leftH} 小时）。过期后感知层全部哑火——请尽快重新完成一次 device flow 授权。`;
    if (alert) {
      try { await alert(msg); } catch (e) { log(`[token-watch] 告警发送失败: ${e?.message ?? e}`); }
    } else {
      log(`[token-watch] ${msg}`);
    }
    return { ok: true, warned: true, leftMs };
  }

  return { checkOnce };
}
