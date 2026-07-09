import express from "express";
import cors from "cors";
import { bearerAuth, publicUser } from "./http/auth-middleware.mjs";
import { verifySessionToken } from "./http/session.mjs";
import { mountAuthRoutes } from "./auth/routes.mjs";
import { mountJobRoutes } from "./jobs/routes.mjs";
import { mountInternalRoutes } from "./http/internal-routes.mjs";
import { mountAdminRoutes } from "./http/admin-routes.mjs";

// createApp(deps)：deps 随任务推进逐步补齐；骨架需 deps.db + deps.config.sessionSecret。
export function createApp(deps) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  // 免登录：与 /api/health 同段
  app.get("/api/health/lark", (_req, res) => {
    const h = deps.larkHealth?.last ?? { ok: null, ts: 0, detail: "未启用（无 larkProfile）" };
    res.json(h);
  });

  // 内部通道在 bearerAuth 之前挂载（自带独立 token 校验）
  if (deps.internal) mountInternalRoutes(app, deps.internal);

  const now = deps.now ?? (() => Date.now());
  const verify = (token) => verifySessionToken(token, { secret: deps.config.sessionSecret, now: now() });
  app.use(bearerAuth(deps.db, { verify }));
  app.get("/api/me", (req, res) => res.json({ user: publicUser(req.user) }));

  if (deps.feishu) mountAuthRoutes(app, { db: deps.db, config: deps.config, feishu: deps.feishu, now });

  if (deps.admin) mountAdminRoutes(app, { db: deps.db, config: deps.config, ...deps.admin });

  if (deps.startPi && deps.semaphore && deps.bus && deps.buffer && deps.registry) {
    mountJobRoutes(app, {
      db: deps.db, config: deps.config, startPi: deps.startPi,
      semaphore: deps.semaphore, bus: deps.bus, buffer: deps.buffer, registry: deps.registry,
      extensions: deps.extensions, piCwd: deps.piCwd, now,
      launcher: deps.launcher,
    });
  }

  app.use((req, res) => res.status(404).json({ error: "not found", path: req.path }));
  app.locals.deps = deps;
  return app;
}
