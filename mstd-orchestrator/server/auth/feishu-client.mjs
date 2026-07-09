// makeFeishuClient：authorization code → user_access_token → 用户信息。
export function makeFeishuClient(config, { fetchImpl = fetch } = {}) {
  async function exchangeCode(code) {
    const tokenRes = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
    });
    const tokenBody = await tokenRes.json();
    const accessToken = tokenBody?.access_token ?? tokenBody?.data?.access_token;
    if (!accessToken) throw new Error(`飞书 token 交换失败: ${JSON.stringify(tokenBody).slice(0, 200)}`);

    const infoRes = await fetchImpl(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const infoBody = await infoRes.json();
    const d = infoBody?.data ?? infoBody;
    if (!d?.open_id) throw new Error(`飞书 user_info 缺少 open_id: ${JSON.stringify(infoBody).slice(0, 200)}`);
    return { openId: d.open_id, name: d.name ?? null, avatar: d.avatar_url ?? d.avatar_big ?? null };
  }
  return { exchangeCode };
}
