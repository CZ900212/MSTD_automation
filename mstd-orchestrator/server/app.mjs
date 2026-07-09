import express from "express";
import cors from "cors";
import { bearerAuth, publicUser } from "./http/auth-middleware.mjs";
import { verifySessionToken } from "./http/session.mjs";
import { mountAuthRoutes } from "./auth/routes.mjs";
import { mountJobRoutes } from "./jobs/routes.mjs";

// createApp(deps)：deps 随任务推进逐步补齐；骨架需 deps.db + deps.config.sessionSecret。
export function createApp(deps) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  const now = deps.now ?? (() => Date.now());
  const verify = (token) => verifySessionToken(token, { secret: deps.config.sessionSecret, now: now() });
  app.use(bearerAuth(deps.db, { verify }));
  app.get("/api/me", (req, res) => res.json({ user: publicUser(req.user) }));

  if (deps.feishu) mountAuthRoutes(app, { db: deps.db, config: deps.config, feishu: deps.feishu, now });

  if (deps.startPi && deps.semaphore && deps.bus && deps.buffer && deps.registry) {
    mountJobRoutes(app, {
      db: deps.db, config: deps.config, startPi: deps.startPi,
      semaphore: deps.semaphore, bus: deps.bus, buffer: deps.buffer, registry: deps.registry,
      extensions: deps.extensions, piCwd: deps.piCwd, writeDeps: deps.writeDeps, now,
      launcher: deps.launcher,
    });
  }

  app.use((req, res) => res.status(404).json({ error: "not found", path: req.path }));
  app.locals.deps = deps;
  return app;
}
