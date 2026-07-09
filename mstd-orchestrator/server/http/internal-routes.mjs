// 内部通道：仅供本机 Pi 扩展（reply/memory 等工具）回传 daemon。独立 Bearer token，与用户会话体系无关。
export function mountInternalRoutes(app, { token, handleReply, memoryTool = null, searchTool = null, spawnBackground = null, proposeActions = null, log = console.error }) {
  const guard = (req, res) => {
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return false;
    }
    if (!req.body?.session_key) {
      res.status(400).json({ ok: false, error: "session_key 必填" });
      return false;
    }
    return true;
  };

  app.post("/internal/reply", async (req, res) => {
    if (!guard(req, res)) return;
    const { session_key: sessionKey, kind, brief, tone, target } = req.body;
    try {
      res.json(await handleReply({ sessionKey, kind, brief, tone, target }));
    } catch (e) {
      log(`[internal/reply] ${e?.message ?? e}`);
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  app.post("/internal/memory", (req, res) => {
    if (!guard(req, res)) return;
    if (!memoryTool) return res.status(501).json({ ok: false, error: "memory 未启用" });
    const { session_key: sessionKey, ...params } = req.body;
    res.json(memoryTool.run(params, { sessionKey }));
  });

  app.post("/internal/propose-actions", async (req, res) => {
    if (!guard(req, res)) return;
    if (!proposeActions) return res.status(501).json({ ok: false, error: "写路径未启用" });
    const { session_key: sessionKey, title, intents } = req.body;
    try {
      const r = await proposeActions({ sessionKey, title, intents });
      res.json(r.ok ? { ok: true, job_id: r.jobId, message_id: r.messageId } : r);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  app.post("/internal/background", (req, res) => {
    if (!guard(req, res)) return;
    if (!spawnBackground) return res.status(501).json({ ok: false, error: "后台 job 未启用" });
    const { session_key: sessionKey, kind, brief, params } = req.body;
    try {
      const jobId = spawnBackground({ sessionKey, kind, brief, params });
      res.json({ ok: true, job_id: jobId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  app.post("/internal/session-search", (req, res) => {
    if (!guard(req, res)) return;
    if (!searchTool) return res.status(501).json({ ok: false, error: "session_search 未启用" });
    const { session_key: sessionKey, ...params } = req.body;
    res.json(searchTool.run(params, { sessionKey }));
  });
}
