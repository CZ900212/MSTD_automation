// 内部通道：仅供本机 Pi 扩展（reply 等工具）回传 daemon。独立 Bearer token，与用户会话体系无关。
export function mountInternalRoutes(app, { token, handleReply, log = console.error }) {
  app.post("/internal/reply", async (req, res) => {
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const { session_key: sessionKey, kind, brief, tone, target } = req.body ?? {};
    if (!sessionKey) return res.status(400).json({ ok: false, error: "session_key 必填" });
    try {
      res.json(await handleReply({ sessionKey, kind, brief, tone, target }));
    } catch (e) {
      log(`[internal/reply] ${e?.message ?? e}`);
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });
}
