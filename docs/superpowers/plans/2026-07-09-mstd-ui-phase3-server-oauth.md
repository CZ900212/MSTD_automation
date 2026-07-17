# mstd UI · Phase 3（Server 基座 + 飞书 OAuth）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Phase 0-1 安全内核 + Phase 2 Pi RPC 冻结之上，搭起 **Express 后端基座**：飞书 OAuth 登录（state/nonce 挑战 + HMAC 会话 token）、jobs REST + SSE、两段式编排的**第①段只读接线**（真写留 Phase 4，本 Phase 只接到"批准即记录 decision"为止且写执行 gated）、关键审计事件的**批量持久化**、DB 方言适配层、并发信号量、Bearer 鉴权中间件。全部走 vitest（HTTP 用 supertest），飞书侧全部**依赖注入可 mock**，零真实网络/零飞书写。

**Architecture:** 在既有 `mstd-orchestrator/server/` 下新增 `http/`（会话 token、鉴权中间件、cookie、SSE）、`auth/`（飞书 OAuth 原语 + 客户端 + 路由）、`store/`（users/jobs 仓储）、`jobs/`（信号量、事件总线、事件缓冲、模板、意图解析、运行时注册表、编排器、job 路由）、`db/dialect.mjs`（`INSERT OR IGNORE`↔`ON CONFLICT DO NOTHING`）。所有"外部世界"（飞书 token 交换、Pi 子进程）经 `createApp(deps)` 的**注入依赖**进入，单测用 fake 替身，真机只在最后一个手动 smoke 里连真 Pi。**信任边界不变**：模型永不可信，写形状由服务端 Phase 1 纯函数确定；本 Phase 只把这些确定性构造件接进 HTTP 生命周期。

**Tech Stack:** Node ≥22 ESM（`.mjs`）· express ^4.21 + cors ^2.8 · supertest ^7（devDep，HTTP 测试）· better-sqlite3（Phase 0 已装）· vitest ^4 · node:crypto（HMAC 会话 token / sha256）· 全局 `fetch`（真飞书客户端；测试注入 fake）。**无 TS 构建步骤**（与既有 `.mjs` 风格一致）。

**上位 spec：** `docs/superpowers/specs/2026-07-09-mstd-ui-reuse-design.md`（见「后端 server · 端点/持久化写入策略/并发资源」「两段式生命周期」「S5 审批与登录绑定」「错误处理与边界」）。
**前置：**
- Phase 0-1 安全内核已完成：`docs/superpowers/plans/2026-07-09-mstd-ui-phase0-1-safety-core.md`（`server/db/*`、`server/safety/*` 已实现，签名见 Global Constraints）。
- Phase 2 Pi RPC 冻结提供 `startPi(...).runJob(message,{id,onEvent,timeoutMs}) -> Promise<{finalText}>`：`docs/superpowers/plans/2026-07-09-mstd-ui-phase2-pi-rpc-freeze.md`。**本 Phase 的编排器消费此契约**；若 Phase 2 尚未落地，单测用注入的 fake `startPi`（不阻塞本 Phase 前 13 个任务），仅最后的手动真机 smoke（Task 14）需要真实 `runJob`。

## Global Constraints

- **复用 Phase 1 已实现函数（签名已核实真实文件，不得臆造）：**
  - `server/db/index.mjs`：`openDb(path=":memory:") -> Database`（已开 `PRAGMA foreign_keys=ON`）、`migrate(db) -> void`。
  - `server/safety/intent-schema.mjs`：`validateIntent(raw) -> { card_text:string, items:Item[] }`，失败抛 `IntentValidationError`（有 `.reason`）。`Item = { owner_name, task, due:string|null, suggested_open_id:string|null, confidence:"high"|"low" }`；`suggested_open_id` 非空时**必须** `^ou_` 前缀。
  - `server/safety/action-dsl.mjs`：`canonicalJson(v)`、`stableHash(v)`、`isValidOpenId(v)`（`^ou_`）、`canonicalizeActions({ jobId, items, enableNotify=false }) -> Action[]`。`Action = { action_key, kind, payload, payload_hash, target_open_id, ordinal, requires_open_id }`；`requires_open_id = item.confidence==="low" || !isValidOpenId(target_open_id)`。
  - `server/safety/action-store.mjs`：`deriveIdempotencyKey(jobId, actionKey)`、`recordActions(db, jobId, actions, now=Date.now())`、`actionsToExecute(db, jobId)`、`markStatus(db, actionId, status, resultJson?)`。
  - `server/safety/approval.mjs`：`issueApprovalToken(db, { jobId, issuedToOpenId, ttlMs, now=Date.now() }) -> { token }`（DB 只存 sha256 哈希）、`consumeApprovalToken(db, { token, jobId, operatorOpenId, now=Date.now() }) -> { ok, reason?, issuedToOpenId? }`（单次消费；校验 job/操作人/过期/未用）。
  - `server/safety/auth-challenge.mjs`：`createAuthChallenge(db, { redirectAfter="/", ttlMs, now=Date.now() }) -> { state, nonce }`、`consumeAuthChallenge(db, { state, nonce, now=Date.now() }) -> { ok, reason?, redirectAfter? }`。
  - `server/safety/write-args.mjs`：`buildWriteArgs(action, idempotencyKey) -> string[]`（Phase 4 真写用；本 Phase 仅 gated 引用，不 spawn）。
- **DB 列名以 `server/db/migrations/001_init.sql` 为准**（已核实）：时间戳统一 `BIGINT`（epoch 毫秒）；`users(id,feishu_open_id UNIQUE,name,avatar,role,created_at)`（**无 status 列**）；`orch_jobs(id,template_id,title,params_json,status,created_by,thread_ref,created_at,updated_at)`；`job_events(id,job_id,phase,seq,type,payload_json,ts)`；`job_draft(job_id PK,card_text,items_json,action_set_json,raw_output)`；`decisions(id,job_id,decided_by,decision,edited_items_json,approved_action_keys_json,payload_hash_at_decision,approval_token_id,note,ts)`；`job_actions(...,ordinal,UNIQUE(job_id,action_key))`。
- **会话 token = 无状态 HMAC**（复用 pricing `server/auth.js` 的**签发形状**：`base64url(payload).base64url(hmacSig)` + `exp`）。**改编要点**：pricing `verifyToken` 硬编 `payload.uid` 必须是**数字**（`auth.js:167`），而我们的 `users.id` 是 TEXT/UUID、身份是 `feishu_open_id` → **不能原样 import**，Phase 3 自建 `http/session.mjs`（node:crypto `createHmac`，`uid` 为字符串、附 `oid=open_id`）。OAuth/审批**挑战**仍走 Phase 1 有状态落库（不做无状态化）。
- **飞书 OAuth 端点/scope = "实现时须核实"项（禁止当成既成事实）**：`auth/feishu-oauth.mjs` 与 `auth/feishu-client.mjs` 里的 authorize/token/user_info URL、OAuth 参数名（`app_id` vs `client_id`）、`response_type`、`scope` 字符串、token 交换请求体字段、user_info 响应字段路径（`open_id/name/avatar`）**全部做成可配置常量（env 覆盖）**，默认值仅为占位骨架。落地前**必须**用 lark-cli / 飞书 OpenAPI（应用 `cli_aac4855d1a781cd6`）核实并通过 env 校准（"核实"= 配置 env，而非改代码）。**这些配置常量是完整可运行代码，不是 placeholder**——URL 构造/流程形状确定且被单测覆盖；不确定的只是"这些默认 URL/scope 是否与飞书当前 API 一致"，故标注核实步骤。
- **open-redirect 加固（审查落地项）**：`/api/auth/feishu/login?redirectAfter=` 与回调重定向**必须**经 `sanitizeRedirectAfter()` 校验为**同源相对路径**（单 `/` 开头、非 `//`、无 `\`、无内嵌 scheme、无控制字符），否则回落 `/`。
- **两段式边界**：本 Phase 只接**第①段只读**（`runJob` 只读 → `validateIntent` → `canonicalizeActions` → `recordActions`+`job_draft` → `awaiting_approval`；schema 不过 → `needs_attention`）与**审批记录**（`consumeApprovalToken` + 落 `decisions`）。**第②段真写 gated**：`runWritePhase` 受 `MSTD_ENABLE_WRITE`（默认关）门禁，本 Phase 恒返回 `{gated:true}`，不 spawn、不写飞书；批准后 job 置 Phase-3 内部态 `approved`（Phase 4 由此推进 `running_write`→`done/partial_failed`）。
- **持久化写入策略**：实时事件只走 SSE（`event-bus`）；**只有关键审计事件**（`tool_start/tool_result/message_done/error/unknown/retry_status/job_status`）经 **ring buffer + 批量 flush**（`event-buffer`）落 `job_events`，**绝不逐 token 同步写**（better-sqlite3 同步写会堵事件循环，`assistant_delta/thinking_status` 一律不落库）。
- **并发信号量**：`MSTD_MAX_CONCURRENT_PI` 默认 2、上限 3（`maxConcurrentPi` 夹逼到 `[1,3]`）；超出 → job `status=queued`，槽位释放后按 FIFO 出队起跑。
- **DB 方言适配**：新写入统一经 `db/dialect.mjs` 的 `buildInsertIgnore`（SQLite `INSERT OR IGNORE` ↔ Postgres `ON CONFLICT DO NOTHING`）/ `buildUpsert`（`ON CONFLICT ... DO UPDATE SET x=excluded.x`，两库同语法）；同时把 Phase 1 `action-store.recordActions` 的裸 `INSERT OR IGNORE` 迁到该层（兑现 Phase 1 Task 1.7 的"Phase 3 统一"承诺，行为不变）。
- **鉴权**：`Authorization: Bearer <token>` → `verifySessionToken` → 载 `users` 行到 `req.user`；受保护端点 `requireUser` → 未登录 `401`（前端据此重登）。
- **零副作用测试纪律**：飞书 token 交换（`feishu.exchangeCode`）与 Pi（`startPi`）均注入依赖，单测用 fake；无真实 fetch、无 spawn、无飞书写。TDD：先失败测试 → 跑挂 → 最小实现 → 跑过 → commit。
- **提交约定**：`MSTD_automation` 当前非 git 仓库（见 spec 前置依赖）。若尚未 `git init`，各 Commit 步骤先记录预期改动，待版本管理就绪后统一纳入（承接 Phase 0-2 同款约定）。

---

## File Structure

```
mstd-orchestrator/
  package.json                          # 修改：+express +cors(deps) +supertest(dev) +"start" 脚本
  server/
    app.mjs                             # 新建(Task1)→逐任务扩：createApp(deps) 组装中间件+路由
    config.mjs                          # 新建(Task14)：loadServerConfig(env) 汇总所有 env 开关
    index.mjs                           # 新建(Task14)：进程入口(openDb+migrate+构造协作件+listen)
    http/
      session.mjs                       # 新建(Task2)：issueSessionToken/verifySessionToken/sessionSecret/sessionTtlSeconds
      auth-middleware.mjs               # 新建(Task3)：bearerAuth(db,{verify})、requireUser
      cookies.mjs                       # 新建(Task8-dep,建于Task2旁)：parseCookie(header)
      sse.mjs                           # 新建(Task12)：sseFormat(sse)、streamJobEvents(...)
    auth/
      feishu-oauth.mjs                  # 新建(Task7)：resolveFeishuConfig/buildAuthorizeUrl/sanitizeRedirectAfter
      feishu-client.mjs                 # 新建(Task7)：makeFeishuClient(config,{fetchImpl})  ⚠️端点实现时核实
      routes.mjs                        # 新建(Task8)：mountAuthRoutes(app,ctx) login/callback
    store/
      users.mjs                         # 新建(Task8)：upsertUserByOpenId/getUserById
      jobs.mjs                          # 新建(Task9)：createJob/getJobRow/getJob/listJobs/updateJobStatus/saveJobDraft
    db/
      dialect.mjs                       # 新建(Task4)：buildInsertIgnore/buildUpsert
      index.mjs                         # 既有(Phase0)
      migrations/001_init.sql           # 既有(Phase0)
    safety/action-store.mjs             # 修改(Task4)：recordActions 改用 dialect 层（行为不变）
    jobs/
      semaphore.mjs                     # 新建(Task5)：createSemaphore(max)+maxConcurrentPi(env)
      event-bus.mjs                     # 新建(Task6)：createEventBus()（实时 SSE 扇出）
      event-buffer.mjs                  # 新建(Task6)：createEventBuffer(db,opts)（批量落审计）
      templates.mjs                     # 新建(Task10)：TEMPLATES + buildPrompt(templateId,params)
      intent-parse.mjs                  # 新建(Task10)：parseIntentFromText(text)
      runtime.mjs                       # 新建(Task10)：createRuntimeRegistry()
      orchestrator.mjs                  # 新建(Task11)：runReadonlyPhase(...) + runWritePhase(gated)
      routes.mjs                        # 新建(Task12)→扩(Task13)：mountJobRoutes(app,ctx)
  test/
    http-skeleton.test.mjs session.test.mjs cookies.test.mjs auth-middleware.test.mjs
    dialect.test.mjs semaphore.test.mjs event-bus.test.mjs event-buffer.test.mjs
    feishu-oauth.test.mjs feishu-client.test.mjs auth-routes.test.mjs
    users-store.test.mjs jobs-store.test.mjs templates.test.mjs intent-parse.test.mjs
    runtime.test.mjs orchestrator.test.mjs jobs-routes.test.mjs sse.test.mjs decision-routes.test.mjs
```

---

## Task 1: 依赖 + Express 骨架 + 健康检查

**Files:**
- Modify: `mstd-orchestrator/package.json`
- Create: `mstd-orchestrator/server/app.mjs`
- Test: `mstd-orchestrator/test/http-skeleton.test.mjs`

**Interfaces:**
- Produces: `createApp(deps) -> express.Application`。`deps` 至少含 `{ db }`（后续任务追加 `config/feishu/startPi/semaphore/bus/buffer/registry/now`，未用键忽略）。挂 `GET /api/health`、JSON body 解析、CORS、末端 404。

- [ ] **Step 1: 写失败的骨架测试**

`mstd-orchestrator/test/http-skeleton.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";

function app() {
  const db = openDb();
  migrate(db);
  return createApp({ db, config: { sessionSecret: "test-secret" } });
}

describe("http skeleton", () => {
  it("GET /api/health -> 200 { ok:true }", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
  it("unknown route -> 404 json", async () => {
    const res = await request(app()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
  it("accepts JSON body without crashing", async () => {
    const res = await request(app()).post("/api/health").send({ a: 1 });
    // POST /api/health 未定义 → 落 404（但 JSON 解析不得抛 500）
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败（依赖/模块未就绪）**

Run: `cd mstd-orchestrator && npx vitest run test/http-skeleton.test.mjs`
Expected: FAIL —— `Cannot find package 'supertest'/'express'` 或 `Cannot find module '../server/app.mjs'`。

- [ ] **Step 3: 加依赖 + 脚本**

修改 `mstd-orchestrator/package.json`：`dependencies` 增 `"express": "^4.21.2"`、`"cors": "^2.8.5"`；`devDependencies` 增 `"supertest": "^7.1.4"`；`scripts` 增 `"start": "node server/index.mjs"`。改后 `package.json`：
```json
{
  "name": "mstd-orchestrator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "Pi-based autonomous management system for MSTD (local validation)",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node server/index.mjs"
  },
  "dependencies": {
    "better-sqlite3": "^12.2.0",
    "cors": "^2.8.5",
    "express": "^4.21.2"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.3",
    "@types/node": "^26.1.1",
    "supertest": "^7.1.4",
    "typebox": "^1.3.5",
    "vitest": "^4.0.15"
  }
}
```
安装：Run `cd mstd-orchestrator && npm install`
Expected: 装上 express/cors/supertest。

- [ ] **Step 4: 写 app 骨架**

`mstd-orchestrator/server/app.mjs`:
```js
import express from "express";
import cors from "cors";

// createApp(deps)：deps 随任务推进逐步补齐；本骨架仅需 deps.db。
// 后续任务在标注锚点处挂载：鉴权中间件 + /api/me（Task 3）、auth 路由（Task 8）、job 路由（Task 12/13）。
export function createApp(deps) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // <ANCHOR: auth-middleware+me>   (Task 3 在此之前插入 bearerAuth；/api/me 在此之后)
  // <ANCHOR: auth-routes>          (Task 8: mountAuthRoutes)
  // <ANCHOR: job-routes>           (Task 12/13: mountJobRoutes)

  app.use((req, res) => res.status(404).json({ error: "not found", path: req.path }));
  app.locals.deps = deps;
  return app;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/http-skeleton.test.mjs`
Expected: PASS —— 3 passed。

- [ ] **Step 6: Commit**

```bash
cd mstd-orchestrator
git add package.json package-lock.json server/app.mjs test/http-skeleton.test.mjs 2>/dev/null || true
git commit -m "chore(mstd-ui): express skeleton + deps (express/cors/supertest) + /api/health" 2>/dev/null || true
```

---

## Task 2: HMAC 会话 token（改编 pricing auth.js）

**Files:**
- Create: `mstd-orchestrator/server/http/session.mjs`
- Test: `mstd-orchestrator/test/session.test.mjs`

**Interfaces:**
- Produces:
  - `issueSessionToken(user, { secret, ttlSeconds, now=Date.now() }) -> string`（`user={id,feishu_open_id,name?,role?}`；payload `{uid:id, oid:open_id, name, role, iat, exp}`；格式 `base64url(payload).base64url(hmacSha256)`）。
  - `verifySessionToken(token, { secret, now=Date.now() }) -> payload|null`（HMAC 常时比较 `timingSafeEqual`；过期/篡改/`uid` 非字符串 → `null`）。
  - `sessionSecret(env) -> string`（读 `MSTD_SESSION_SECRET`；缺则生成进程级临时密钥并告警——重启后 token 失效）。
  - `sessionTtlSeconds(env) -> number`（读 `MSTD_SESSION_TTL_DAYS`，默认 7 天）。
- 与 pricing `auth.js` 差异：`uid` 为**字符串**（我们 users.id 是 TEXT），附 `oid`（open_id），改用 node:crypto。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/session.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { issueSessionToken, verifySessionToken, sessionSecret, sessionTtlSeconds } from "../server/http/session.mjs";

const user = { id: "u-1", feishu_open_id: "ou_abc", name: "张三", role: "user" };
const opt = { secret: "s3cr3t", ttlSeconds: 3600, now: 1_000_000 };

describe("session token", () => {
  it("issues and verifies a token", () => {
    const t = issueSessionToken(user, opt);
    const p = verifySessionToken(t, { secret: "s3cr3t", now: 1_000_000 });
    expect(p).toBeTruthy();
    expect(p.uid).toBe("u-1");
    expect(p.oid).toBe("ou_abc");
    expect(p.role).toBe("user");
  });
  it("rejects wrong secret", () => {
    const t = issueSessionToken(user, opt);
    expect(verifySessionToken(t, { secret: "other", now: 1_000_000 })).toBeNull();
  });
  it("rejects tampered payload", () => {
    const t = issueSessionToken(user, opt);
    const [, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "admin", exp: 9e12 })).toString("base64url") + "." + sig;
    expect(verifySessionToken(forged, { secret: "s3cr3t", now: 1_000_000 })).toBeNull();
  });
  it("rejects expired token", () => {
    const t = issueSessionToken(user, { secret: "s3cr3t", ttlSeconds: 1, now: 1_000_000 });
    expect(verifySessionToken(t, { secret: "s3cr3t", now: 1_000_000 + 2000 })).toBeNull();
  });
  it("rejects garbage", () => {
    expect(verifySessionToken("", { secret: "s" })).toBeNull();
    expect(verifySessionToken("nodot", { secret: "s" })).toBeNull();
  });
  it("sessionSecret reads env, falls back to ephemeral", () => {
    expect(sessionSecret({ MSTD_SESSION_SECRET: "abc" })).toBe("abc");
    const env = {};
    const s = sessionSecret(env);
    expect(typeof s).toBe("string");
    expect(env.MSTD_SESSION_SECRET).toBe(s); // 回填，进程内稳定
  });
  it("sessionTtlSeconds default 7 days", () => {
    expect(sessionTtlSeconds({})).toBe(7 * 86400);
    expect(sessionTtlSeconds({ MSTD_SESSION_TTL_DAYS: "1" })).toBe(86400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/session.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/http/session.mjs`:
```js
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function sessionSecret(env = {}) {
  const v = String(env?.MSTD_SESSION_SECRET ?? "").trim();
  if (v) return v;
  const tmp = randomBytes(32).toString("base64url");
  if (env && typeof env === "object") env.MSTD_SESSION_SECRET = tmp;
  console.warn("[session] MSTD_SESSION_SECRET 未配置，已生成临时密钥，重启后所有会话失效。");
  return tmp;
}

export function sessionTtlSeconds(env = {}) {
  const days = Number(env?.MSTD_SESSION_TTL_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) return 7 * 86400;
  return Math.floor(days * 86400);
}

function sign(payloadB64, secret) {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

export function issueSessionToken(user, { secret, ttlSeconds, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const exp = iat + ttlSeconds;
  const payload = {
    uid: user.id,
    oid: user.feishu_open_id,
    name: user.name ?? null,
    role: user.role ?? "user",
    iat,
    exp,
  };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${payloadB64}.${b64url(sign(payloadB64, secret))}`;
}

export function verifySessionToken(token, { secret, now = Date.now() }) {
  const s = String(token ?? "").trim();
  if (!s) return null;
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = s.slice(0, dot);
  const sigB64 = s.slice(dot + 1);
  let sig;
  try { sig = Buffer.from(sigB64, "base64url"); } catch { return null; }
  const expected = sign(payloadB64, secret);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")); } catch { return null; }
  if (typeof payload?.exp !== "number" || payload.exp * 1000 < now) return null;
  if (typeof payload?.uid !== "string" || !payload.uid) return null;
  return payload;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/session.test.mjs`
Expected: PASS —— 7 passed。

- [ ] **Step 5: 写 cookie 解析器（供 Task 8 OAuth nonce 用）**

`mstd-orchestrator/server/http/cookies.mjs`:
```js
// 极简 Cookie 头解析（避免引入 cookie-parser 依赖）。
export function parseCookie(header) {
  const out = {};
  const s = String(header ?? "");
  if (!s) return out;
  for (const part of s.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* 保留原值 */ }
    out[k] = v;
  }
  return out;
}
```

`mstd-orchestrator/test/cookies.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { parseCookie } from "../server/http/cookies.mjs";

describe("parseCookie", () => {
  it("parses multiple cookies", () => {
    expect(parseCookie("a=1; b=two; mstd_oauth_nonce=abc")).toEqual({ a: "1", b: "two", mstd_oauth_nonce: "abc" });
  });
  it("handles empty / missing header", () => {
    expect(parseCookie("")).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
  });
  it("url-decodes values", () => {
    expect(parseCookie("x=%2Fboard").x).toBe("/board");
  });
});
```

Run: `cd mstd-orchestrator && npx vitest run test/session.test.mjs test/cookies.test.mjs`
Expected: PASS —— session 7 + cookies 3。

- [ ] **Step 6: Commit**

```bash
git add server/http/session.mjs server/http/cookies.mjs test/session.test.mjs test/cookies.test.mjs
git commit -m "feat(mstd-ui): HMAC session token (text uid + open_id) + cookie parser"
```

---

## Task 3: Bearer 鉴权中间件 + /api/me

**Files:**
- Create: `mstd-orchestrator/server/http/auth-middleware.mjs`
- Modify: `mstd-orchestrator/server/app.mjs`
- Test: `mstd-orchestrator/test/auth-middleware.test.mjs`

**Interfaces:**
- Produces:
  - `bearerAuth(db, { verify }) -> express.RequestHandler`（读 `Authorization: Bearer`；`verify(token)->payload|null`；命中则 `req.user = users 行`，否则 `req.user=null`）。
  - `requireUser(req,res,next)`（`req.user` 空 → `401 {error:"请先登录"}`）。
  - `GET /api/me -> { user: publicUser|null }`（`publicUser = {id,open_id,name,avatar,role}`）。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/auth-middleware.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { issueSessionToken } from "../server/http/session.mjs";

const SECRET = "test-secret";
let db, app;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, avatar, role, created_at) VALUES (?,?,?,?,?,?)")
    .run("u-1", "ou_abc", "张三", null, "user", 1);
  app = createApp({ db, config: { sessionSecret: SECRET }, now: () => 1_000_000 });
});
const tokenFor = (u) => issueSessionToken(u, { secret: SECRET, ttlSeconds: 3600, now: 1_000_000 });

describe("bearer auth + /api/me", () => {
  it("no token -> user null", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
  it("valid token -> user", async () => {
    const t = tokenFor({ id: "u-1", feishu_open_id: "ou_abc", name: "张三", role: "user" });
    const res = await request(app).get("/api/me").set("Authorization", `Bearer ${t}`);
    expect(res.body.user).toEqual({ id: "u-1", open_id: "ou_abc", name: "张三", avatar: null, role: "user" });
  });
  it("bad token -> user null", async () => {
    const res = await request(app).get("/api/me").set("Authorization", "Bearer garbage");
    expect(res.body.user).toBeNull();
  });
  it("token for unknown user -> null", async () => {
    const t = tokenFor({ id: "ghost", feishu_open_id: "ou_x", name: "无", role: "user" });
    const res = await request(app).get("/api/me").set("Authorization", `Bearer ${t}`);
    expect(res.body.user).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/auth-middleware.test.mjs`
Expected: FAIL —— `auth-middleware.mjs` 不存在 / `/api/me` 未定义。

- [ ] **Step 3: 写中间件**

`mstd-orchestrator/server/http/auth-middleware.mjs`:
```js
export function bearerAuth(db, { verify }) {
  return (req, _res, next) => {
    req.user = null;
    const header = req.header("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) {
      const payload = verify(m[1]);
      if (payload) {
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.uid);
        if (user) req.user = user;
      }
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "请先登录" });
  next();
}

export function publicUser(u) {
  return u ? { id: u.id, open_id: u.feishu_open_id, name: u.name, avatar: u.avatar, role: u.role } : null;
}
```

- [ ] **Step 4: 把中间件 + /api/me 挂进 app**

`mstd-orchestrator/server/app.mjs` —— 顶部加 import：
```js
import { bearerAuth, requireUser, publicUser } from "./http/auth-middleware.mjs";
import { verifySessionToken } from "./http/session.mjs";
```
把 `<ANCHOR: auth-middleware+me>` 一行替换为：
```js
  const now = deps.now ?? (() => Date.now());
  const verify = (token) => verifySessionToken(token, { secret: deps.config.sessionSecret, now: now() });
  app.use(bearerAuth(deps.db, { verify }));
  app.get("/api/me", (req, res) => res.json({ user: publicUser(req.user) }));
```
（`requireUser` 供后续 job 路由用，此处 import 但暂未消费。）

- [ ] **Step 5: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/auth-middleware.test.mjs test/http-skeleton.test.mjs`
Expected: PASS —— 4 + 3 passed（骨架不回归）。

- [ ] **Step 6: Commit**

```bash
git add server/http/auth-middleware.mjs server/app.mjs test/auth-middleware.test.mjs
git commit -m "feat(mstd-ui): bearer auth middleware + /api/me"
```

---

## Task 4: DB 方言适配层（`INSERT OR IGNORE` ↔ `ON CONFLICT DO NOTHING`）

**Files:**
- Create: `mstd-orchestrator/server/db/dialect.mjs`
- Modify: `mstd-orchestrator/server/safety/action-store.mjs`（`recordActions` 改用适配层，行为不变）
- Test: `mstd-orchestrator/test/dialect.test.mjs`

**Interfaces:**
- Produces:
  - `buildInsertIgnore({ dialect="sqlite", table, columns, conflictColumns }) -> string`（sqlite → `INSERT OR IGNORE INTO t (cols) VALUES (?,...)`；postgres → `INSERT INTO t (cols) VALUES (?,...) ON CONFLICT (conflictColumns) DO NOTHING`；未知方言抛错）。
  - `buildUpsert({ dialect="sqlite", table, columns, conflictColumns, updateColumns }) -> string`（`... ON CONFLICT (cc) DO UPDATE SET x=excluded.x`，SQLite 3.24+/Postgres 同语法）。
- 说明：占位符统一 `?`（better-sqlite3 原生）；迁 Postgres 时由驱动适配层把 `?` 改写为 `$n`（本 Phase 只负责 `OR IGNORE`↔`ON CONFLICT` 分支，占位符改写在迁移 Phase 落地）。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/dialect.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { buildInsertIgnore, buildUpsert } from "../server/db/dialect.mjs";

describe("buildInsertIgnore", () => {
  it("sqlite -> INSERT OR IGNORE", () => {
    const sql = buildInsertIgnore({ dialect: "sqlite", table: "job_actions", columns: ["job_id", "action_key"] });
    expect(sql).toBe("INSERT OR IGNORE INTO job_actions (job_id, action_key) VALUES (?, ?)");
  });
  it("postgres -> ON CONFLICT DO NOTHING", () => {
    const sql = buildInsertIgnore({ dialect: "postgres", table: "job_actions", columns: ["job_id", "action_key"], conflictColumns: ["job_id", "action_key"] });
    expect(sql).toBe("INSERT INTO job_actions (job_id, action_key) VALUES (?, ?) ON CONFLICT (job_id, action_key) DO NOTHING");
  });
  it("unknown dialect throws", () => {
    expect(() => buildInsertIgnore({ dialect: "mysql", table: "t", columns: ["a"] })).toThrow(/dialect/i);
  });
});

describe("buildUpsert", () => {
  it("emits excluded-based DO UPDATE", () => {
    const sql = buildUpsert({ dialect: "sqlite", table: "users", columns: ["id", "feishu_open_id", "name"], conflictColumns: ["feishu_open_id"], updateColumns: ["name"] });
    expect(sql).toBe("INSERT INTO users (id, feishu_open_id, name) VALUES (?, ?, ?) ON CONFLICT (feishu_open_id) DO UPDATE SET name = excluded.name");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/dialect.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/db/dialect.mjs`:
```js
function placeholders(n) { return Array.from({ length: n }, () => "?").join(", "); }

export function buildInsertIgnore({ dialect = "sqlite", table, columns, conflictColumns = [] }) {
  const cols = columns.join(", ");
  const ph = placeholders(columns.length);
  if (dialect === "sqlite") {
    return `INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${ph})`;
  }
  if (dialect === "postgres") {
    return `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT (${conflictColumns.join(", ")}) DO NOTHING`;
  }
  throw new Error(`unknown dialect: ${dialect}`);
}

export function buildUpsert({ dialect = "sqlite", table, columns, conflictColumns, updateColumns }) {
  if (dialect !== "sqlite" && dialect !== "postgres") throw new Error(`unknown dialect: ${dialect}`);
  const cols = columns.join(", ");
  const ph = placeholders(columns.length);
  const set = updateColumns.map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${set}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/dialect.test.mjs`
Expected: PASS —— 4 passed。

- [ ] **Step 5: 把 Phase 1 `recordActions` 迁到适配层（行为不变）**

`mstd-orchestrator/server/safety/action-store.mjs` —— 替换 `recordActions`（顶部加 import `import { buildInsertIgnore } from "../db/dialect.mjs";`），其余函数不动：
```js
const JOB_ACTION_COLS = [
  "id", "job_id", "action_key", "kind", "target_open_id",
  "canonical_payload_json", "payload_hash", "idempotency_key", "status", "ordinal", "ts",
];

export function recordActions(db, jobId, actions, now = Date.now(), dialect = "sqlite") {
  const sql = buildInsertIgnore({
    dialect, table: "job_actions", columns: JOB_ACTION_COLS,
    conflictColumns: ["job_id", "action_key"],
  });
  const stmt = db.prepare(sql);
  const tx = db.transaction((items) => {
    for (const a of items) {
      stmt.run(
        randomUUID(), jobId, a.action_key, a.kind, a.target_open_id ?? null,
        JSON.stringify(a.payload), a.payload_hash, deriveIdempotencyKey(jobId, a.action_key),
        "pending", a.ordinal ?? null, now
      );
    }
  });
  tx(actions);
}
```
> 关键：列顺序与绑定值和 Phase 1 完全一致（新增的 `status` 由字面量 `"pending"` 变为显式绑定值 `"pending"`，语义不变），故 Phase 1 的 `action-store.test.mjs` 不回归。

- [ ] **Step 6: 跑测试确认无回归**

Run: `cd mstd-orchestrator && npx vitest run test/dialect.test.mjs test/action-store.test.mjs`
Expected: PASS —— dialect 4 + action-store 全部（Phase 1 用例不变）。

- [ ] **Step 7: Commit**

```bash
git add server/db/dialect.mjs server/safety/action-store.mjs test/dialect.test.mjs
git commit -m "feat(mstd-ui): db dialect layer (INSERT OR IGNORE <-> ON CONFLICT) + migrate recordActions"
```

---

## Task 5: 并发信号量（默认 2，上限 3，超出 queued）

**Files:**
- Create: `mstd-orchestrator/server/jobs/semaphore.mjs`
- Test: `mstd-orchestrator/test/semaphore.test.mjs`

**Interfaces:**
- Produces:
  - `maxConcurrentPi(env) -> number`（读 `MSTD_MAX_CONCURRENT_PI`，`Math.floor` 后夹逼到 `[1,3]`，默认 2）。
  - `createSemaphore(max) -> { tryAcquire():boolean, release():void, get active:number, get max:number }`（同步计数闸；`tryAcquire` 满则 `false`——调用方据此把 job 记为 `queued`）。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/semaphore.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { createSemaphore, maxConcurrentPi } from "../server/jobs/semaphore.mjs";

describe("maxConcurrentPi", () => {
  it("defaults to 2", () => expect(maxConcurrentPi({})).toBe(2));
  it("clamps to [1,3]", () => {
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "3" })).toBe(3);
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "9" })).toBe(3);
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "0" })).toBe(1);
    expect(maxConcurrentPi({ MSTD_MAX_CONCURRENT_PI: "x" })).toBe(2);
  });
});

describe("createSemaphore", () => {
  it("acquires up to max then refuses", () => {
    const s = createSemaphore(2);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
    expect(s.active).toBe(2);
  });
  it("release frees a slot", () => {
    const s = createSemaphore(2);
    s.tryAcquire(); s.tryAcquire();
    s.release();
    expect(s.active).toBe(1);
    expect(s.tryAcquire()).toBe(true);
  });
  it("release never goes negative", () => {
    const s = createSemaphore(1);
    s.release();
    expect(s.active).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/semaphore.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/jobs/semaphore.mjs`:
```js
export function maxConcurrentPi(env = {}) {
  const raw = Number(env?.MSTD_MAX_CONCURRENT_PI ?? 2);
  if (!Number.isFinite(raw)) return 2;
  return Math.min(3, Math.max(1, Math.floor(raw)));
}

export function createSemaphore(max) {
  let active = 0;
  return {
    tryAcquire() {
      if (active < max) { active += 1; return true; }
      return false;
    },
    release() {
      if (active > 0) active -= 1;
    },
    get active() { return active; },
    get max() { return max; },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/semaphore.test.mjs`
Expected: PASS —— 5 passed。

- [ ] **Step 5: Commit**

```bash
git add server/jobs/semaphore.mjs test/semaphore.test.mjs
git commit -m "feat(mstd-ui): concurrency semaphore (default 2, cap 3)"
```

---

## Task 6: 事件管道（实时总线 + 批量审计持久化）

**Files:**
- Create: `mstd-orchestrator/server/jobs/event-bus.mjs`
- Create: `mstd-orchestrator/server/jobs/event-buffer.mjs`
- Test: `mstd-orchestrator/test/event-bus.test.mjs`, `mstd-orchestrator/test/event-buffer.test.mjs`

**Interfaces:**
- Produces:
  - `createEventBus() -> { subscribe(jobId, fn)->unsub, publish(jobId, sse):void, subscriberCount(jobId):number }`（内存扇出；单订阅者异常不影响其他）。SSE 形如 `{ event, data }`（承 Phase 2 翻译器）。
  - `createEventBuffer(db, { flushIntervalMs=1000, maxBatch=200, keyEvents } = {}) -> { record(jobId, phase, sse, now?):void, flush():void, start():void, stop():void, get pendingCount:number }`。**只缓冲关键审计事件**（`tool_start/tool_result/message_done/error/unknown/retry_status/job_status`）；`assistant_delta/thinking_status` 直接丢弃；`flush` 事务批量插 `job_events`，`seq` 按 job 单调递增（首用从 DB `MAX(seq)` 播种）。

- [ ] **Step 1: 写失败测试（event-bus）**

`mstd-orchestrator/test/event-bus.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { createEventBus } from "../server/jobs/event-bus.mjs";

describe("event bus", () => {
  it("delivers to subscribers of the same job only", () => {
    const bus = createEventBus();
    const a = [], b = [];
    bus.subscribe("job1", (e) => a.push(e));
    bus.subscribe("job2", (e) => b.push(e));
    bus.publish("job1", { event: "tool_start", data: { x: 1 } });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
  it("unsubscribe stops delivery and cleans up", () => {
    const bus = createEventBus();
    const got = [];
    const off = bus.subscribe("job1", (e) => got.push(e));
    off();
    bus.publish("job1", { event: "message_done", data: {} });
    expect(got).toHaveLength(0);
    expect(bus.subscriberCount("job1")).toBe(0);
  });
  it("one throwing subscriber does not break others", () => {
    const bus = createEventBus();
    const ok = [];
    bus.subscribe("job1", () => { throw new Error("boom"); });
    bus.subscribe("job1", (e) => ok.push(e));
    expect(() => bus.publish("job1", { event: "error", data: {} })).not.toThrow();
    expect(ok).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 写失败测试（event-buffer）**

`mstd-orchestrator/test/event-buffer.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";

let db;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run("job1", "meeting_to_task", "running_readonly", 1, 1);
});
const rows = () => db.prepare("SELECT * FROM job_events WHERE job_id='job1' ORDER BY seq").all();

describe("event buffer", () => {
  it("drops non-key events (assistant_delta/thinking_status)", () => {
    const buf = createEventBuffer(db);
    buf.record("job1", "readonly", { event: "assistant_delta", data: { text: "hi" } });
    buf.record("job1", "readonly", { event: "thinking_status", data: { text: "…" } });
    expect(buf.pendingCount).toBe(0);
    buf.flush();
    expect(rows()).toHaveLength(0);
  });
  it("persists key events with monotonic seq", () => {
    const buf = createEventBuffer(db);
    buf.record("job1", "readonly", { event: "tool_start", data: { toolName: "lark" } }, 10);
    buf.record("job1", "readonly", { event: "tool_result", data: { isError: false } }, 11);
    buf.flush();
    const r = rows();
    expect(r.map((x) => x.type)).toEqual(["tool_start", "tool_result"]);
    expect(r.map((x) => x.seq)).toEqual([1, 2]);
    buf.record("job1", "readonly", { event: "message_done", data: {} }, 12);
    buf.flush();
    expect(rows().map((x) => x.seq)).toEqual([1, 2, 3]);
  });
  it("auto-flushes at maxBatch", () => {
    const buf = createEventBuffer(db, { maxBatch: 2 });
    buf.record("job1", "readonly", { event: "job_status", data: { status: "running_readonly" } });
    buf.record("job1", "readonly", { event: "job_status", data: { status: "awaiting_approval" } });
    expect(rows()).toHaveLength(2); // 达阈值即 flush
    expect(buf.pendingCount).toBe(0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/event-bus.test.mjs test/event-buffer.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 event-bus**

`mstd-orchestrator/server/jobs/event-bus.mjs`:
```js
export function createEventBus() {
  const subs = new Map(); // jobId -> Set<fn>
  return {
    subscribe(jobId, fn) {
      let set = subs.get(jobId);
      if (!set) { set = new Set(); subs.set(jobId, set); }
      set.add(fn);
      return () => {
        const s = subs.get(jobId);
        if (!s) return;
        s.delete(fn);
        if (s.size === 0) subs.delete(jobId);
      };
    },
    publish(jobId, sse) {
      const set = subs.get(jobId);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(sse); } catch { /* 单个订阅者异常隔离 */ }
      }
    },
    subscriberCount(jobId) { return subs.get(jobId)?.size ?? 0; },
  };
}
```

- [ ] **Step 5: 实现 event-buffer**

`mstd-orchestrator/server/jobs/event-buffer.mjs`:
```js
import { randomUUID } from "node:crypto";

const KEY_EVENTS = new Set([
  "tool_start", "tool_result", "message_done", "error", "unknown", "retry_status", "job_status",
]);

export function createEventBuffer(db, { flushIntervalMs = 1000, maxBatch = 200, keyEvents = KEY_EVENTS } = {}) {
  const pending = [];
  const seqByJob = new Map();
  let timer = null;

  function nextSeq(jobId) {
    if (!seqByJob.has(jobId)) {
      const row = db.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM job_events WHERE job_id = ?").get(jobId);
      seqByJob.set(jobId, row.m);
    }
    const n = seqByJob.get(jobId) + 1;
    seqByJob.set(jobId, n);
    return n;
  }

  function flush() {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const stmt = db.prepare(
      "INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = db.transaction((items) => {
      for (const r of items) {
        stmt.run(randomUUID(), r.jobId, r.phase, nextSeq(r.jobId), r.type, r.payloadJson, r.ts);
      }
    });
    tx(batch);
  }

  function record(jobId, phase, sse, now = Date.now()) {
    if (!keyEvents.has(sse.event)) return;
    pending.push({ jobId, phase, type: sse.event, payloadJson: JSON.stringify(sse.data ?? {}), ts: now });
    if (pending.length >= maxBatch) flush();
  }

  function start() {
    if (timer) return;
    timer = setInterval(flush, flushIntervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    flush();
  }

  return { record, flush, start, stop, get pendingCount() { return pending.length; } };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/event-bus.test.mjs test/event-buffer.test.mjs`
Expected: PASS —— bus 3 + buffer 3。

- [ ] **Step 7: Commit**

```bash
git add server/jobs/event-bus.mjs server/jobs/event-buffer.mjs test/event-bus.test.mjs test/event-buffer.test.mjs
git commit -m "feat(mstd-ui): live event bus + batched audit event buffer (ring buffer + flush)"
```

---

## Task 7: 飞书 OAuth 原语（可配置端点 + authorize URL + 同源重定向校验）

> ⚠️ **实现时须核实（外部依赖）**：本任务的 authorize/token/user_info 端点 URL、OAuth 参数名（`app_id` vs `client_id`）、`response_type`、`scope` 字符串、user_info 响应字段路径均为**占位骨架默认值**，落地前**必须**用 lark-cli / 飞书 OpenAPI（应用 `cli_aac4855d1a781cd6`）核实并通过 env 覆盖为准确值。端点做成可配置常量正是为了让"核实 = 配置 env"。URL 构造/流程形状本身确定且被单测覆盖。

**Files:**
- Create: `mstd-orchestrator/server/auth/feishu-oauth.mjs`
- Create: `mstd-orchestrator/server/auth/feishu-client.mjs`
- Test: `mstd-orchestrator/test/feishu-oauth.test.mjs`, `mstd-orchestrator/test/feishu-client.test.mjs`

**Interfaces:**
- Produces（`feishu-oauth.mjs`）：
  - `resolveFeishuConfig(env) -> { appId, appSecret, redirectUri, authorizeUrl, tokenUrl, userInfoUrl, scope }`（全 env 可覆盖）。
  - `buildAuthorizeUrl(config, { state }) -> string`（确定性拼 `client_id/redirect_uri/response_type=code/state/scope?`）。
  - `sanitizeRedirectAfter(raw, fallback="/") -> string`（**open-redirect 加固**：仅接受单 `/` 开头的同源相对路径）。
- Produces（`feishu-client.mjs`）：`makeFeishuClient(config, { fetchImpl=fetch }) -> { exchangeCode(code) -> Promise<{ openId, name, avatar }> }`（真 fetch；测试注入 `fetchImpl`）。

- [ ] **Step 1: 写失败测试（feishu-oauth，含 open-redirect 全覆盖）**

`mstd-orchestrator/test/feishu-oauth.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { resolveFeishuConfig, buildAuthorizeUrl, sanitizeRedirectAfter } from "../server/auth/feishu-oauth.mjs";

describe("resolveFeishuConfig", () => {
  it("reads env overrides", () => {
    const c = resolveFeishuConfig({
      FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "sec", FEISHU_REDIRECT_URI: "https://app/cb",
      FEISHU_AUTHORIZE_URL: "https://auth/authorize", FEISHU_OAUTH_SCOPE: "contact:user.base:readonly",
    });
    expect(c.appId).toBe("cli_x");
    expect(c.authorizeUrl).toBe("https://auth/authorize");
    expect(c.scope).toBe("contact:user.base:readonly");
  });
  it("has default endpoints when env absent", () => {
    const c = resolveFeishuConfig({});
    expect(c.authorizeUrl).toMatch(/^https:\/\//);
    expect(c.tokenUrl).toMatch(/^https:\/\//);
    expect(c.userInfoUrl).toMatch(/^https:\/\//);
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries state, redirect_uri, response_type=code", () => {
    const c = resolveFeishuConfig({ FEISHU_APP_ID: "cli_x", FEISHU_REDIRECT_URI: "https://app/cb", FEISHU_AUTHORIZE_URL: "https://auth/authorize", FEISHU_OAUTH_SCOPE: "s1" });
    const u = new URL(buildAuthorizeUrl(c, { state: "st_123" }));
    expect(u.origin + u.pathname).toBe("https://auth/authorize");
    expect(u.searchParams.get("state")).toBe("st_123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("cli_x");
    expect(u.searchParams.get("scope")).toBe("s1");
  });
  it("omits scope when empty", () => {
    const c = resolveFeishuConfig({ FEISHU_APP_ID: "cli_x", FEISHU_REDIRECT_URI: "https://app/cb", FEISHU_AUTHORIZE_URL: "https://auth/authorize" });
    const u = new URL(buildAuthorizeUrl(c, { state: "s" }));
    expect(u.searchParams.has("scope")).toBe(false);
  });
});

describe("sanitizeRedirectAfter (open-redirect hardening)", () => {
  it("accepts same-origin relative paths", () => {
    expect(sanitizeRedirectAfter("/board")).toBe("/board");
    expect(sanitizeRedirectAfter("/a/b?x=1#h")).toBe("/a/b?x=1#h");
    expect(sanitizeRedirectAfter("/path/to:thing")).toBe("/path/to:thing"); // colon 非首段，放行
  });
  it("rejects protocol-relative //evil", () => expect(sanitizeRedirectAfter("//evil.com")).toBe("/"));
  it("rejects absolute URLs", () => {
    expect(sanitizeRedirectAfter("https://evil.com")).toBe("/");
    expect(sanitizeRedirectAfter("http://evil.com")).toBe("/");
  });
  it("rejects backslash bypass", () => {
    expect(sanitizeRedirectAfter("/\\evil.com")).toBe("/");
    expect(sanitizeRedirectAfter("/a\\b")).toBe("/");
  });
  it("rejects scheme injection in first segment", () => expect(sanitizeRedirectAfter("/javascript:alert(1)")).toBe("/"));
  it("rejects non-slash / control chars / non-string", () => {
    expect(sanitizeRedirectAfter("board")).toBe("/");
    expect(sanitizeRedirectAfter("")).toBe("/");
    expect(sanitizeRedirectAfter("/a\nb")).toBe("/");
    expect(sanitizeRedirectAfter(null)).toBe("/");
    expect(sanitizeRedirectAfter(undefined)).toBe("/");
  });
});
```

- [ ] **Step 2: 写失败测试（feishu-client，注入 fake fetch）**

`mstd-orchestrator/test/feishu-client.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { makeFeishuClient } from "../server/auth/feishu-client.mjs";
import { resolveFeishuConfig } from "../server/auth/feishu-oauth.mjs";

function fakeFetch(sequence) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = sequence[i++];
    return { json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

const config = resolveFeishuConfig({
  FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "sec", FEISHU_REDIRECT_URI: "https://app/cb",
  FEISHU_TOKEN_URL: "https://api/token", FEISHU_USERINFO_URL: "https://api/userinfo",
});

describe("makeFeishuClient.exchangeCode", () => {
  it("exchanges code -> token -> user info", async () => {
    const fetchImpl = fakeFetch([
      { data: { access_token: "uat_1" } },
      { data: { open_id: "ou_real", name: "李四", avatar_url: "http://a/x.png" } },
    ]);
    const client = makeFeishuClient(config, { fetchImpl });
    const profile = await client.exchangeCode("code_1");
    expect(profile).toEqual({ openId: "ou_real", name: "李四", avatar: "http://a/x.png" });
    expect(fetchImpl.calls[0].url).toBe("https://api/token");
    expect(fetchImpl.calls[1].url).toBe("https://api/userinfo");
  });
  it("throws when token missing", async () => {
    const client = makeFeishuClient(config, { fetchImpl: fakeFetch([{ error: "bad" }]) });
    await expect(client.exchangeCode("c")).rejects.toThrow(/token/i);
  });
  it("throws when open_id missing", async () => {
    const client = makeFeishuClient(config, { fetchImpl: fakeFetch([{ data: { access_token: "t" } }, { data: {} }]) });
    await expect(client.exchangeCode("c")).rejects.toThrow(/open_id/i);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/feishu-oauth.test.mjs test/feishu-client.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 feishu-oauth**

`mstd-orchestrator/server/auth/feishu-oauth.mjs`:
```js
// ⚠️ 占位骨架默认值：实现前须用 lark-cli / 飞书 OpenAPI（应用 cli_aac4855d1a781cd6）核实
// authorize/token/user_info 端点、OAuth 参数名、scope 字符串，并通过下列 env 覆盖为准确值。
const DEFAULTS = {
  authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
  userInfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
  scope: "",
};

export function resolveFeishuConfig(env = {}) {
  return {
    appId: String(env.FEISHU_APP_ID ?? "").trim(),
    appSecret: String(env.FEISHU_APP_SECRET ?? "").trim(),
    redirectUri: String(env.FEISHU_REDIRECT_URI ?? "").trim(),
    authorizeUrl: String(env.FEISHU_AUTHORIZE_URL ?? DEFAULTS.authorizeUrl),
    tokenUrl: String(env.FEISHU_TOKEN_URL ?? DEFAULTS.tokenUrl),
    userInfoUrl: String(env.FEISHU_USERINFO_URL ?? DEFAULTS.userInfoUrl),
    scope: String(env.FEISHU_OAUTH_SCOPE ?? DEFAULTS.scope),
  };
}

export function buildAuthorizeUrl(config, { state }) {
  const u = new URL(config.authorizeUrl);
  u.searchParams.set("client_id", config.appId);
  u.searchParams.set("redirect_uri", config.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  if (config.scope) u.searchParams.set("scope", config.scope);
  return u.toString();
}

// open-redirect 加固：只接受单斜杠开头的同源相对路径，否则回落 fallback。
export function sanitizeRedirectAfter(raw, fallback = "/") {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s.startsWith("/")) return fallback;         // 必须相对路径
  if (s.startsWith("//")) return fallback;          // 协议相对 //evil.com
  if (s.includes("\\")) return fallback;            // 反斜杠绕过
  if (/[\u0000-\u001f]/.test(s)) return fallback;   // 控制字符
  if (/^\/[^/]*:/.test(s)) return fallback;         // 首段内嵌 scheme（/javascript:…）
  return s;
}
```

- [ ] **Step 5: 实现 feishu-client**

`mstd-orchestrator/server/auth/feishu-client.mjs`:
```js
// makeFeishuClient：authorization code → user_access_token → 用户信息。
// ⚠️ 端点/请求体字段/响应字段路径为"实现时须核实"项（同 feishu-oauth 顶注）：
// 须核实 tokenUrl/userInfoUrl、请求体（grant_type/client_id/client_secret/code/redirect_uri）、
// 响应路径（access_token 或 data.access_token；data.open_id/name/avatar_url）。
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
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/feishu-oauth.test.mjs test/feishu-client.test.mjs`
Expected: PASS —— oauth（含 open-redirect 全覆盖）+ client 3。

- [ ] **Step 7: Commit**

```bash
git add server/auth/feishu-oauth.mjs server/auth/feishu-client.mjs test/feishu-oauth.test.mjs test/feishu-client.test.mjs
git commit -m "feat(mstd-ui): feishu OAuth primitives (configurable endpoints, authorize URL, same-origin redirect guard)"
```

---

## Task 8: users 仓储 + OAuth 登录/回调路由

**Files:**
- Create: `mstd-orchestrator/server/store/users.mjs`
- Create: `mstd-orchestrator/server/auth/routes.mjs`
- Modify: `mstd-orchestrator/server/app.mjs`（挂 `mountAuthRoutes`）
- Test: `mstd-orchestrator/test/users-store.test.mjs`, `mstd-orchestrator/test/auth-routes.test.mjs`

**Interfaces:**
- Produces（`store/users.mjs`）：`upsertUserByOpenId(db, { openId, name?, avatar?, role="user" }, now?) -> userRow`（`ON CONFLICT(feishu_open_id) DO UPDATE` 只更 name/avatar，保留 id/created_at）、`getUserById(db, id)`。
- Produces（`auth/routes.mjs`）：`mountAuthRoutes(app, { db, config, feishu, now })`：
  - `GET /api/auth/feishu/login?redirectAfter=` → `sanitizeRedirectAfter` → `createAuthChallenge` → 设 `mstd_oauth_nonce` httpOnly cookie → `{ authorizeUrl }`。
  - `GET /api/auth/feishu/callback?code=&state=` → 读 nonce cookie → `consumeAuthChallenge{state,nonce}` → `feishu.exchangeCode` → `upsertUserByOpenId` → `issueSessionToken` → `302` 到 `redirectAfter#token=…`。

- [ ] **Step 1: 写失败测试（users store）**

`mstd-orchestrator/test/users-store.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { upsertUserByOpenId, getUserById } from "../server/store/users.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

describe("upsertUserByOpenId", () => {
  it("inserts a new user with default role", () => {
    const u = upsertUserByOpenId(db, { openId: "ou_a", name: "张三", avatar: "http://x" }, 100);
    expect(u.feishu_open_id).toBe("ou_a");
    expect(u.role).toBe("user");
    expect(getUserById(db, u.id).name).toBe("张三");
  });
  it("updates name/avatar on conflict, keeps id + created_at", () => {
    const first = upsertUserByOpenId(db, { openId: "ou_a", name: "张三" }, 100);
    const second = upsertUserByOpenId(db, { openId: "ou_a", name: "张三改", avatar: "http://y" }, 200);
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("张三改");
    expect(second.avatar).toBe("http://y");
    expect(second.created_at).toBe(100);
    const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: 写失败测试（auth 路由，supertest + fake feishu）**

`mstd-orchestrator/test/auth-routes.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { verifySessionToken } from "../server/http/session.mjs";
import { parseCookie } from "../server/http/cookies.mjs";

const config = {
  sessionSecret: "test-secret",
  sessionTtlSeconds: 3600,
  feishu: {
    appId: "cli_x", redirectUri: "https://app/cb",
    authorizeUrl: "https://auth/authorize", scope: "s1",
  },
};
const fakeFeishu = { exchangeCode: async () => ({ openId: "ou_real", name: "李四", avatar: null }) };

let db, app;
beforeEach(() => {
  db = openDb(); migrate(db);
  app = createApp({ db, config, feishu: fakeFeishu, now: () => 1_000_000 });
});

async function startLogin(redirectAfter = "/board") {
  const res = await request(app).get(`/api/auth/feishu/login?redirectAfter=${encodeURIComponent(redirectAfter)}`);
  const setCookie = res.headers["set-cookie"][0];
  const nonce = parseCookie(setCookie.split(";")[0]).mstd_oauth_nonce;
  const state = new URL(res.body.authorizeUrl).searchParams.get("state");
  return { res, nonce, state, cookie: setCookie.split(";")[0] };
}

describe("feishu OAuth routes", () => {
  it("login returns authorizeUrl + nonce cookie", async () => {
    const { res, nonce, state } = await startLogin("/board");
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("state=");
    expect(nonce).toBeTruthy();
    expect(state).toBeTruthy();
  });

  it("login rejects open-redirect target (falls back to /)", async () => {
    // 校验 sanitize 生效：redirect_after 记录在 challenge 内，回调时回落到 /
    const { state, nonce, cookie } = await startLogin("//evil.com");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=${state}`).set("Cookie", cookie);
    expect(cb.status).toBe(302);
    expect(cb.headers.location.startsWith("/#token=")).toBe(true);
  });

  it("callback happy path: upserts user, issues session, 302 to redirectAfter", async () => {
    const { state, nonce, cookie } = await startLogin("/board");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=${state}`).set("Cookie", cookie);
    expect(cb.status).toBe(302);
    const loc = cb.headers.location;
    expect(loc.startsWith("/board#token=")).toBe(true);
    const token = decodeURIComponent(loc.split("#token=")[1]);
    const payload = verifySessionToken(token, { secret: "test-secret", now: 1_000_000 });
    expect(payload.oid).toBe("ou_real");
    // /api/me 用该 token 可拿到用户
    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.user.open_id).toBe("ou_real");
  });

  it("callback rejects bad state (400)", async () => {
    const { cookie } = await startLogin("/board");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=WRONG`).set("Cookie", cookie);
    expect(cb.status).toBe(400);
  });

  it("callback rejects missing nonce cookie (400)", async () => {
    const { state } = await startLogin("/board");
    const cb = await request(app).get(`/api/auth/feishu/callback?code=c1&state=${state}`);
    expect(cb.status).toBe(400);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/users-store.test.mjs test/auth-routes.test.mjs`
Expected: FAIL —— 模块/路由不存在。

- [ ] **Step 4: 实现 users 仓储**

`mstd-orchestrator/server/store/users.mjs`:
```js
import { randomUUID } from "node:crypto";
import { buildUpsert } from "../db/dialect.mjs";

const USER_COLS = ["id", "feishu_open_id", "name", "avatar", "role", "created_at"];

export function upsertUserByOpenId(db, { openId, name = null, avatar = null, role = "user" }, now = Date.now(), dialect = "sqlite") {
  const sql = buildUpsert({
    dialect, table: "users", columns: USER_COLS,
    conflictColumns: ["feishu_open_id"], updateColumns: ["name", "avatar"],
  });
  db.prepare(sql).run(randomUUID(), openId, name, avatar, role, now);
  return db.prepare("SELECT * FROM users WHERE feishu_open_id = ?").get(openId);
}

export function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
```

- [ ] **Step 5: 实现 auth 路由**

`mstd-orchestrator/server/auth/routes.mjs`:
```js
import { createAuthChallenge, consumeAuthChallenge } from "../safety/auth-challenge.mjs";
import { buildAuthorizeUrl, sanitizeRedirectAfter } from "./feishu-oauth.mjs";
import { parseCookie } from "../http/cookies.mjs";
import { upsertUserByOpenId } from "../store/users.mjs";
import { issueSessionToken } from "../http/session.mjs";

const NONCE_COOKIE = "mstd_oauth_nonce";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export function mountAuthRoutes(app, { db, config, feishu, now = () => Date.now() }) {
  app.get("/api/auth/feishu/login", (req, res) => {
    const redirectAfter = sanitizeRedirectAfter(req.query.redirectAfter);
    const { state, nonce } = createAuthChallenge(db, { redirectAfter, ttlMs: CHALLENGE_TTL_MS, now: now() });
    res.cookie(NONCE_COOKIE, nonce, {
      httpOnly: true, sameSite: "lax", path: "/", maxAge: CHALLENGE_TTL_MS,
    });
    res.json({ authorizeUrl: buildAuthorizeUrl(config.feishu, { state }) });
  });

  app.get("/api/auth/feishu/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const nonce = parseCookie(req.headers.cookie)[NONCE_COOKIE] ?? "";
    const chal = consumeAuthChallenge(db, { state, nonce, now: now() });
    if (!chal.ok) return res.status(400).json({ error: `state 校验失败: ${chal.reason}` });
    if (!code) return res.status(400).json({ error: "缺少 code" });

    let profile;
    try {
      profile = await feishu.exchangeCode(code);
    } catch (err) {
      return res.status(502).json({ error: `飞书换取用户信息失败: ${String(err?.message ?? err)}` });
    }
    const user = upsertUserByOpenId(db, { openId: profile.openId, name: profile.name, avatar: profile.avatar }, now());
    const token = issueSessionToken(user, {
      secret: config.sessionSecret, ttlSeconds: config.sessionTtlSeconds, now: now(),
    });
    const dest = sanitizeRedirectAfter(chal.redirectAfter);
    res.clearCookie(NONCE_COOKIE, { path: "/" });
    // token 放 URL fragment（不进 server 日志 / Referer），302 回 SPA
    res.redirect(302, `${dest}#token=${encodeURIComponent(token)}`);
  });
}
```

- [ ] **Step 6: 挂进 app**

`mstd-orchestrator/server/app.mjs` —— 顶部加 import：
```js
import { mountAuthRoutes } from "./auth/routes.mjs";
```
把 `<ANCHOR: auth-routes>` 一行替换为：
```js
  if (deps.feishu) mountAuthRoutes(app, { db: deps.db, config: deps.config, feishu: deps.feishu, now });
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/users-store.test.mjs test/auth-routes.test.mjs test/auth-middleware.test.mjs`
Expected: PASS —— users 2 + auth-routes 5 + 中间件不回归 4。

- [ ] **Step 8: Commit**

```bash
git add server/store/users.mjs server/auth/routes.mjs server/app.mjs test/users-store.test.mjs test/auth-routes.test.mjs
git commit -m "feat(mstd-ui): feishu OAuth login/callback (state/nonce + session issuance + user upsert)"
```

---

## Task 9: jobs 仓储（建/列/详情/改状态/存 draft）

**Files:**
- Create: `mstd-orchestrator/server/store/jobs.mjs`
- Test: `mstd-orchestrator/test/jobs-store.test.mjs`

**Interfaces:**
- Produces:
  - `createJob(db, { templateId, title?, paramsJson?, status, createdBy? }, now?) -> jobRow`
  - `getJobRow(db, id) -> row|undefined`
  - `updateJobStatus(db, id, status, now?) -> void`
  - `saveJobDraft(db, jobId, { cardText?, itemsJson?, actionSetJson?, rawOutput? }) -> void`（`job_draft` upsert on `job_id`）
  - `listJobs(db, { status?, mine? }) -> row[]`（`mine` = `created_by` 过滤；按 `created_at DESC`）
  - `getJob(db, id) -> { job, events, draft, actions, decisions }|null`（断线重放聚合）

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/jobs-store.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createJob, getJobRow, getJob, listJobs, updateJobStatus, saveJobDraft } from "../server/store/jobs.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

describe("jobs store", () => {
  it("creates a job with timestamps and returns the row", () => {
    const j = createJob(db, { templateId: "meeting_to_task", title: "会议A", paramsJson: "{}", status: "queued", createdBy: "u-1" }, 100);
    expect(j.id).toBeTruthy();
    expect(j.status).toBe("queued");
    expect(j.created_at).toBe(100);
    expect(j.updated_at).toBe(100);
    expect(getJobRow(db, j.id).title).toBe("会议A");
  });

  it("updateJobStatus bumps updated_at", () => {
    const j = createJob(db, { templateId: "meeting_to_task", status: "running_readonly", createdBy: "u-1" }, 100);
    updateJobStatus(db, j.id, "awaiting_approval", 200);
    const r = getJobRow(db, j.id);
    expect(r.status).toBe("awaiting_approval");
    expect(r.updated_at).toBe(200);
  });

  it("saveJobDraft upserts", () => {
    const j = createJob(db, { templateId: "meeting_to_task", status: "running_readonly", createdBy: "u-1" }, 100);
    saveJobDraft(db, j.id, { cardText: "卡1", itemsJson: "[]", actionSetJson: "[]", rawOutput: "raw" });
    saveJobDraft(db, j.id, { cardText: "卡2" });
    const d = db.prepare("SELECT * FROM job_draft WHERE job_id = ?").get(j.id);
    expect(d.card_text).toBe("卡2");
  });

  it("listJobs filters by status and mine", () => {
    createJob(db, { templateId: "meeting_to_task", status: "awaiting_approval", createdBy: "u-1" }, 100);
    createJob(db, { templateId: "meeting_to_task", status: "done", createdBy: "u-1" }, 101);
    createJob(db, { templateId: "meeting_to_task", status: "awaiting_approval", createdBy: "u-2" }, 102);
    expect(listJobs(db, { status: "awaiting_approval" })).toHaveLength(2);
    expect(listJobs(db, { mine: "u-1" })).toHaveLength(2);
    expect(listJobs(db, { status: "awaiting_approval", mine: "u-1" })).toHaveLength(1);
    expect(listJobs(db, {})).toHaveLength(3);
  });

  it("getJob aggregates events/draft/actions/decisions", () => {
    const j = createJob(db, { templateId: "meeting_to_task", status: "awaiting_approval", createdBy: "u-1" }, 100);
    saveJobDraft(db, j.id, { cardText: "卡" });
    db.prepare("INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (?,?,?,?,?,?,?)")
      .run("e1", j.id, "readonly", 1, "tool_start", "{}", 100);
    const detail = getJob(db, j.id);
    expect(detail.job.id).toBe(j.id);
    expect(detail.events).toHaveLength(1);
    expect(detail.draft.card_text).toBe("卡");
    expect(detail.actions).toEqual([]);
    expect(detail.decisions).toEqual([]);
    expect(getJob(db, "missing")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/jobs-store.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/store/jobs.mjs`:
```js
import { randomUUID } from "node:crypto";

export function createJob(db, { templateId, title = null, paramsJson = null, status, createdBy = null }, now = Date.now()) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO orch_jobs (id, template_id, title, params_json, status, created_by, thread_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, templateId, title, paramsJson, status, createdBy, null, now, now);
  return getJobRow(db, id);
}

export function getJobRow(db, id) {
  return db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(id);
}

export function updateJobStatus(db, id, status, now = Date.now()) {
  db.prepare("UPDATE orch_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
}

export function saveJobDraft(db, jobId, { cardText = null, itemsJson = null, actionSetJson = null, rawOutput = null }) {
  db.prepare(
    "INSERT INTO job_draft (job_id, card_text, items_json, action_set_json, raw_output) VALUES (?,?,?,?,?) " +
    "ON CONFLICT (job_id) DO UPDATE SET card_text=excluded.card_text, items_json=excluded.items_json, " +
    "action_set_json=excluded.action_set_json, raw_output=excluded.raw_output"
  ).run(jobId, cardText, itemsJson, actionSetJson, rawOutput);
}

export function listJobs(db, { status = null, mine = null } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push("status = ?"); args.push(status); }
  if (mine) { where.push("created_by = ?"); args.push(mine); }
  const sql = "SELECT * FROM orch_jobs" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC";
  return db.prepare(sql).all(...args);
}

export function getJob(db, id) {
  const job = getJobRow(db, id);
  if (!job) return null;
  return {
    job,
    events: db.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY seq").all(id),
    draft: db.prepare("SELECT * FROM job_draft WHERE job_id = ?").get(id) ?? null,
    actions: db.prepare("SELECT * FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(id),
    decisions: db.prepare("SELECT * FROM decisions WHERE job_id = ? ORDER BY ts").all(id),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/jobs-store.test.mjs`
Expected: PASS —— 5 passed。

- [ ] **Step 5: Commit**

```bash
git add server/store/jobs.mjs test/jobs-store.test.mjs
git commit -m "feat(mstd-ui): jobs store (create/list/detail/status/draft)"
```

---

## Task 10: 模板 + 意图解析 + 运行时注册表

**Files:**
- Create: `mstd-orchestrator/server/jobs/templates.mjs`
- Create: `mstd-orchestrator/server/jobs/intent-parse.mjs`
- Create: `mstd-orchestrator/server/jobs/runtime.mjs`
- Test: `mstd-orchestrator/test/templates.test.mjs`, `mstd-orchestrator/test/intent-parse.test.mjs`, `mstd-orchestrator/test/runtime.test.mjs`

**Interfaces:**
- Produces:
  - `TEMPLATES`（`{ meeting_to_task: { id, title, enableNotify:false } }`，v1 唯一模板）+ `buildPrompt(templateId, params={}) -> string`（内含结构化意图 JSON 契约 + 只读禁令；未知模板抛错）。
  - `parseIntentFromText(text) -> object|null`（优先 ```json 代码块，回退首 `{`…末 `}`；无法解析返回 `null`——不猜）。
  - `createRuntimeRegistry() -> { register(jobId, handle), get(jobId), remove(jobId), has(jobId) }`（`handle={client,abort}`，供 abort 找活跃 Pi）。

- [ ] **Step 1: 写失败测试（templates）**

`mstd-orchestrator/test/templates.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { TEMPLATES, buildPrompt } from "../server/jobs/templates.mjs";

describe("templates", () => {
  it("has meeting_to_task with notify off", () => {
    expect(TEMPLATES.meeting_to_task.enableNotify).toBe(false);
  });
  it("buildPrompt includes intent JSON contract + read-only ban", () => {
    const p = buildPrompt("meeting_to_task", {});
    expect(p).toMatch(/card_text/);
    expect(p).toMatch(/items/);
    expect(p).toMatch(/只读|严禁.*写/);
  });
  it("buildPrompt scopes to minute_token when provided", () => {
    expect(buildPrompt("meeting_to_task", { minute_token: "mt_9" })).toMatch(/mt_9/);
  });
  it("throws on unknown template", () => {
    expect(() => buildPrompt("weekly_report", {})).toThrow(/unknown|未知/i);
  });
});
```

- [ ] **Step 2: 写失败测试（intent-parse）**

`mstd-orchestrator/test/intent-parse.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { parseIntentFromText } from "../server/jobs/intent-parse.mjs";

const B = "`".repeat(3); // 三反引号：避免在计划文档里破坏外层代码围栏

describe("parseIntentFromText", () => {
  it("parses a json fenced block", () => {
    const text = `分析完成。\n${B}json\n{"card_text":"x","items":[]}\n${B}\n`;
    expect(parseIntentFromText(text)).toEqual({ card_text: "x", items: [] });
  });
  it("parses raw json embedded in prose", () => {
    const text = '结果：{"card_text":"y","items":[{"task":"t"}]} 完毕';
    expect(parseIntentFromText(text).card_text).toBe("y");
  });
  it("returns null when no JSON object", () => {
    expect(parseIntentFromText("没有结构化输出")).toBeNull();
    expect(parseIntentFromText("")).toBeNull();
    expect(parseIntentFromText(null)).toBeNull();
  });
  it("returns null on malformed JSON", () => {
    expect(parseIntentFromText(`${B}json\n{not valid}\n${B}`)).toBeNull();
  });
});
```

- [ ] **Step 3: 写失败测试（runtime）**

`mstd-orchestrator/test/runtime.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";

describe("runtime registry", () => {
  it("registers, gets, removes handles", () => {
    const reg = createRuntimeRegistry();
    const handle = { client: {}, abort: () => {} };
    reg.register("job1", handle);
    expect(reg.has("job1")).toBe(true);
    expect(reg.get("job1")).toBe(handle);
    reg.remove("job1");
    expect(reg.has("job1")).toBe(false);
    expect(reg.get("job1")).toBeNull();
  });
});
```

- [ ] **Step 4: 跑三个测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/templates.test.mjs test/intent-parse.test.mjs test/runtime.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 5: 实现三个模块**

`mstd-orchestrator/server/jobs/templates.mjs`:
```js
export const TEMPLATES = {
  meeting_to_task: { id: "meeting_to_task", title: "会议纪要 → 建任务", enableNotify: false },
};

const FENCE = "`".repeat(3); // 避免在计划文档里嵌套三反引号；运行时即三个反引号
const INTENT_CONTRACT = [
  `你必须在最终回复中只输出一个 JSON 对象（可包在 ${FENCE}json 代码块里），形如：`,
  '{"card_text":"<给审批人看的中文卡片文案>","items":[{"owner_name":"张三","task":"...","due":"2026-07-15 或 null","suggested_open_id":"ou_xxx 或 null","confidence":"high|low"}]}',
  "无法确定负责人 open_id 时填 null 且 confidence 设 low。严禁任何写操作（只允许只读工具）。",
].join("\n");

export function buildPrompt(templateId, params = {}) {
  if (templateId !== "meeting_to_task") throw new Error(`unknown/未知模板: ${templateId}`);
  const scope = params.minute_token
    ? `只处理妙记 minute_token=${String(params.minute_token)}。`
    : "搜索我拥有的最近妙记，选择最相关的一条处理。";
  return [
    "你是会议纪要处理助手。第一阶段【只读】：",
    scope,
    "步骤：搜索/定位妙记 → 导出并阅读逐字稿 → 抽取待办事项（负责人、事项、截止、建议 open_id、置信度）→ 生成审批卡文案。",
    INTENT_CONTRACT,
  ].join("\n");
}
```

`mstd-orchestrator/server/jobs/intent-parse.mjs`:
```js
export function parseIntentFromText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const candidates = [];
  const fence = /```json\s*([\s\S]*?)```/i.exec(text) || /```\s*([\s\S]*?)```/.exec(text);
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch { /* 试下一个候选 */ }
  }
  return null;
}
```

`mstd-orchestrator/server/jobs/runtime.mjs`:
```js
export function createRuntimeRegistry() {
  const active = new Map(); // jobId -> { client, abort }
  return {
    register(jobId, handle) { active.set(jobId, handle); },
    get(jobId) { return active.get(jobId) ?? null; },
    remove(jobId) { active.delete(jobId); },
    has(jobId) { return active.has(jobId); },
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/templates.test.mjs test/intent-parse.test.mjs test/runtime.test.mjs`
Expected: PASS —— templates 4 + intent-parse 4 + runtime 1。

- [ ] **Step 7: Commit**

```bash
git add server/jobs/templates.mjs server/jobs/intent-parse.mjs server/jobs/runtime.mjs test/templates.test.mjs test/intent-parse.test.mjs test/runtime.test.mjs
git commit -m "feat(mstd-ui): job templates + intent parser + runtime registry"
```

---

## Task 11: 两段式编排器（第①段只读接线 + 第②段 gated stub）

**Files:**
- Create: `mstd-orchestrator/server/jobs/orchestrator.mjs`
- Test: `mstd-orchestrator/test/orchestrator.test.mjs`

**Interfaces:**
- Produces:
  - `runReadonlyPhase({ db, startPi, bus, buffer, registry, job, extensions=[], piOptions={}, now=()=>Date.now() }) -> Promise<{ status, actions?, reason? }>`：
    - `status=running_readonly` → `startPi(...).runJob(prompt,{id,onEvent})`（`onEvent` 同时 `bus.publish` + `buffer.record`）→ 注册 runtime 句柄。
    - 完成：`parseIntentFromText(finalText)` → `validateIntent` 通过 → `canonicalizeActions`（Phase 1）→ `recordActions` + `saveJobDraft` → `awaiting_approval`；`IntentValidationError` → 存 `raw_output` + `needs_attention`（不猜）。
    - `runJob` 抛错/超时 → `failed`（抓 stderr 意义事件）。
    - 无论何路径都 `registry.remove` + `client.close()` + `buffer.flush()`。
  - `runWritePhase({ config }) -> { gated:true, reason } `（**Phase 3 恒 gated**；`MSTD_ENABLE_WRITE` 未开时不 spawn、不写；开了则抛"Phase 4 未实现"，防误启用）。
- Consumes: Phase 1 `validateIntent/IntentValidationError`、`canonicalizeActions`、`recordActions`；Task 9 `updateJobStatus/saveJobDraft`；Task 10 `buildPrompt/TEMPLATES/parseIntentFromText`；Phase 2 `startPi(...).runJob`。

- [ ] **Step 1: 写失败测试（注入 fake startPi，三条路径）**

`mstd-orchestrator/test/orchestrator.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createJob, getJobRow } from "../server/store/jobs.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";
import { runReadonlyPhase, runWritePhase } from "../server/jobs/orchestrator.mjs";

// fake startPi：回放脚本事件，然后 resolve/reject。
function fakeStartPi(script) {
  return () => ({
    child: { kill() { script.killed = true; } },
    runJob(_prompt, { onEvent }) {
      for (const e of script.events ?? []) onEvent(e);
      if (script.throw) return Promise.reject(new Error(script.throw));
      return Promise.resolve({ finalText: script.finalText });
    },
    close() { return Promise.resolve(); },
  });
}

let db, bus, buffer, registry;
beforeEach(() => {
  db = openDb(); migrate(db);
  bus = createEventBus();
  buffer = createEventBuffer(db);
  registry = createRuntimeRegistry();
});

function makeJob() {
  return createJob(db, { templateId: "meeting_to_task", paramsJson: "{}", status: "queued", createdBy: "u-1" }, 1000);
}

const goodIntent = JSON.stringify({
  card_text: "请确认",
  items: [{ owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" }],
});

describe("runReadonlyPhase", () => {
  it("good intent -> awaiting_approval + records actions + draft", async () => {
    const job = makeJob();
    const sseSeen = [];
    bus.subscribe(job.id, (e) => sseSeen.push(e.event));
    const out = await runReadonlyPhase({
      db, startPi: fakeStartPi({
        events: [{ event: "tool_start", data: { toolName: "lark" } }, { event: "assistant_delta", data: { text: "…" } }],
        finalText: goodIntent,
      }), bus, buffer, registry, job, now: () => 2000,
    });
    expect(out.status).toBe("awaiting_approval");
    expect(getJobRow(db, job.id).status).toBe("awaiting_approval");
    const actions = db.prepare("SELECT * FROM job_actions WHERE job_id = ?").all(job.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("create_task");
    expect(actions[0].target_open_id).toBe("ou_a");
    const draft = db.prepare("SELECT * FROM job_draft WHERE job_id = ?").get(job.id);
    expect(draft.card_text).toBe("请确认");
    // 关键审计事件已落 job_events（tool_start + 两条 job_status），assistant_delta 未落
    const evTypes = db.prepare("SELECT type FROM job_events WHERE job_id = ? ORDER BY seq").all(job.id).map((r) => r.type);
    expect(evTypes).toContain("tool_start");
    expect(evTypes).not.toContain("assistant_delta");
    expect(registry.has(job.id)).toBe(false); // 收尾已注销
  });

  it("unparseable/invalid intent -> needs_attention with raw_output", async () => {
    const job = makeJob();
    const out = await runReadonlyPhase({
      db, startPi: fakeStartPi({ finalText: "没有结构化输出" }),
      bus, buffer, registry, job, now: () => 2000,
    });
    expect(out.status).toBe("needs_attention");
    expect(getJobRow(db, job.id).status).toBe("needs_attention");
    expect(db.prepare("SELECT raw_output FROM job_draft WHERE job_id = ?").get(job.id).raw_output).toBe("没有结构化输出");
    expect(db.prepare("SELECT COUNT(*) AS c FROM job_actions WHERE job_id = ?").get(job.id).c).toBe(0);
  });

  it("runJob throwing -> failed", async () => {
    const job = makeJob();
    const out = await runReadonlyPhase({
      db, startPi: fakeStartPi({ throw: "pi crashed" }),
      bus, buffer, registry, job, now: () => 2000,
    });
    expect(out.status).toBe("failed");
    expect(getJobRow(db, job.id).status).toBe("failed");
    expect(registry.has(job.id)).toBe(false);
  });
});

describe("runWritePhase", () => {
  it("is gated when MSTD_ENABLE_WRITE off", () => {
    expect(runWritePhase({ config: { enableWrite: false } })).toEqual({ gated: true, reason: expect.any(String) });
  });
  it("throws if someone flips enableWrite (Phase 4 not implemented)", () => {
    expect(() => runWritePhase({ config: { enableWrite: true } })).toThrow(/Phase 4/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/orchestrator.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/jobs/orchestrator.mjs`:
```js
import { validateIntent, IntentValidationError } from "../safety/intent-schema.mjs";
import { canonicalizeActions } from "../safety/action-dsl.mjs";
import { recordActions } from "../safety/action-store.mjs";
import { updateJobStatus, saveJobDraft } from "../store/jobs.mjs";
import { parseIntentFromText } from "./intent-parse.mjs";
import { buildPrompt, TEMPLATES } from "./templates.mjs";

function emit(bus, buffer, jobId, phase, sse) {
  bus.publish(jobId, sse);
  buffer.record(jobId, phase, sse);
}

export async function runReadonlyPhase({ db, startPi, bus, buffer, registry, job, extensions = [], piOptions = {}, now = () => Date.now() }) {
  updateJobStatus(db, job.id, "running_readonly", now());
  emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "running_readonly" } });

  const client = startPi({
    provider: piOptions.provider ?? "cz-gpt",
    model: piOptions.model ?? "gpt-5.5",
    thinking: piOptions.thinking ?? "medium",
    cwd: piOptions.cwd,
    extensions,
  });
  registry.register(job.id, { client, abort: () => { try { client.child?.kill(); } catch { /* 已退出 */ } } });

  const prompt = buildPrompt(job.template_id, JSON.parse(job.params_json ?? "{}"));
  let finalText = "";
  try {
    const result = await client.runJob(prompt, {
      id: job.id,
      timeoutMs: piOptions.timeoutMs ?? 240000,
      onEvent: (sse) => emit(bus, buffer, job.id, "readonly", sse),
    });
    finalText = result?.finalText ?? "";
  } catch (err) {
    registry.remove(job.id);
    try { await client.close(); } catch { /* ignore */ }
    updateJobStatus(db, job.id, "failed", now());
    emit(bus, buffer, job.id, "readonly", { event: "error", data: { level: "pi_failed", text: String(err?.message ?? err) } });
    buffer.flush();
    return { status: "failed" };
  }
  registry.remove(job.id);
  try { await client.close(); } catch { /* ignore */ }

  const raw = parseIntentFromText(finalText);
  const enableNotify = TEMPLATES[job.template_id]?.enableNotify ?? false;
  try {
    const intent = validateIntent(raw);
    const actions = canonicalizeActions({ jobId: job.id, items: intent.items, enableNotify });
    recordActions(db, job.id, actions);
    saveJobDraft(db, job.id, {
      cardText: intent.card_text,
      itemsJson: JSON.stringify(intent.items),
      actionSetJson: JSON.stringify(actions),
      rawOutput: finalText,
    });
    updateJobStatus(db, job.id, "awaiting_approval", now());
    emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "awaiting_approval" } });
    buffer.flush();
    return { status: "awaiting_approval", actions };
  } catch (err) {
    if (!(err instanceof IntentValidationError)) throw err;
    saveJobDraft(db, job.id, { rawOutput: finalText });
    updateJobStatus(db, job.id, "needs_attention", now());
    emit(bus, buffer, job.id, "readonly", { event: "job_status", data: { status: "needs_attention", reason: err.reason } });
    buffer.flush();
    return { status: "needs_attention", reason: err.reason };
  }
}

// 第②段真写：Phase 4 才启用。Phase 3 恒 gated；防误启用（enableWrite 打开也抛，直到 Phase 4 实现）。
export function runWritePhase({ config }) {
  if (!config?.enableWrite) {
    return { gated: true, reason: "写执行在 Phase 4 启用（MSTD_ENABLE_WRITE 未开）" };
  }
  throw new Error("runWritePhase 尚未实现（Phase 4：executeApprovedAction + buildWriteArgs + 对账）");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/orchestrator.test.mjs`
Expected: PASS —— 5 passed（awaiting_approval / needs_attention / failed / gated×2）。

- [ ] **Step 5: Commit**

```bash
git add server/jobs/orchestrator.mjs test/orchestrator.test.mjs
git commit -m "feat(mstd-ui): two-stage orchestrator (readonly phase wiring + gated write stub)"
```

---

## Task 12: jobs API（POST/列表/详情）+ SSE 流

**Files:**
- Create: `mstd-orchestrator/server/http/sse.mjs`
- Create: `mstd-orchestrator/server/jobs/routes.mjs`
- Modify: `mstd-orchestrator/server/app.mjs`（挂 `mountJobRoutes`）
- Test: `mstd-orchestrator/test/sse.test.mjs`, `mstd-orchestrator/test/jobs-routes.test.mjs`

**Interfaces:**
- Produces（`http/sse.mjs`）：
  - `sseFormat(sse) -> string`（`event: <name>\ndata: <json>\n\n`）。
  - `streamJobEvents({ bus, jobId, res, heartbeatMs=15000, setInterval, clearInterval }) -> closeFn`（写 SSE 头 + 开流注释帧 + 订阅 bus + 心跳；`res.on("close")` 时注销）。
- Produces（`jobs/routes.mjs`）：`mountJobRoutes(app, ctx)`，`ctx={ db, config, startPi, semaphore, bus, buffer, registry, extensions, piCwd, now }`。本任务实现：
  - `GET /api/templates`（模板列表）。
  - `POST /api/jobs {templateId, params}`（建 job；`semaphore.tryAcquire` → 起第①段 或 记 `queued` 入队；返回 `{jobId, status}`）。
  - `GET /api/jobs?status=&mine=`（列表）。
  - `GET /api/jobs/:id`（详情；`awaiting_approval` 且为授权审批人时**签发一次性 approval token** 随详情返回，供 decision 消费）。
  - `GET /api/jobs/:id/stream`（SSE，15s 心跳）。

- [ ] **Step 1: 写失败测试（sse 单元：fake res + fake timers）**

`mstd-orchestrator/test/sse.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { sseFormat, streamJobEvents } from "../server/http/sse.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";

function fakeRes() {
  const writes = [];
  const handlers = {};
  return {
    writes, headers: null,
    writeHead(_c, h) { this.headers = h; },
    write(s) { writes.push(s); return true; },
    on(ev, fn) { handlers[ev] = fn; },
    _close() { handlers.close?.(); },
  };
}

describe("sseFormat", () => {
  it("formats an event frame", () => {
    expect(sseFormat({ event: "tool_start", data: { a: 1 } })).toBe('event: tool_start\ndata: {"a":1}\n\n');
  });
});

describe("streamJobEvents", () => {
  it("sets SSE headers, forwards published events, heartbeats, and cleans up on close", () => {
    const bus = createEventBus();
    const res = fakeRes();
    let hbFn = null;
    const fakeSetInterval = (fn) => { hbFn = fn; return 123; };
    const cleared = [];
    const fakeClearInterval = (id) => cleared.push(id);

    const close = streamJobEvents({ bus, jobId: "job1", res, heartbeatMs: 15000, setInterval: fakeSetInterval, clearInterval: fakeClearInterval });
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(bus.subscriberCount("job1")).toBe(1);

    bus.publish("job1", { event: "tool_result", data: { isError: false } });
    expect(res.writes.some((w) => w.includes("event: tool_result"))).toBe(true);

    hbFn(); // 触发一次心跳
    expect(res.writes.some((w) => w.startsWith(": ping"))).toBe(true);

    res._close(); // 客户端断开
    expect(cleared).toContain(123);
    expect(bus.subscriberCount("job1")).toBe(0);
    expect(typeof close).toBe("function");
  });
});
```

- [ ] **Step 2: 写失败测试（jobs 路由：supertest + fake startPi）**

`mstd-orchestrator/test/jobs-routes.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { issueSessionToken } from "../server/http/session.mjs";
import { createSemaphore } from "../server/jobs/semaphore.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";

const SECRET = "test-secret";
const goodIntent = JSON.stringify({
  card_text: "请确认",
  items: [{ owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" }],
});
function fakeStartPi() {
  return () => ({
    child: { kill() {} },
    runJob(_p, { onEvent }) { onEvent({ event: "tool_start", data: {} }); return Promise.resolve({ finalText: goodIntent }); },
    close() { return Promise.resolve(); },
  });
}
const flush = () => new Promise((r) => setTimeout(r, 15)); // 等 fire-and-forget 第①段跑完

let db, app, token;
beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, avatar, role, created_at) VALUES (?,?,?,?,?,?)")
    .run("u-1", "ou_me", "我", null, "user", 1);
  token = issueSessionToken({ id: "u-1", feishu_open_id: "ou_me", name: "我", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
  app = createApp({
    db,
    config: { sessionSecret: SECRET, sessionTtlSeconds: 3600, pi: {}, enableWrite: false },
    startPi: fakeStartPi(),
    semaphore: createSemaphore(2),
    bus: createEventBus(),
    buffer: createEventBuffer(db),
    registry: createRuntimeRegistry(),
    now: () => 1000,
  });
});
const auth = (r) => r.set("Authorization", `Bearer ${token}`);

describe("jobs API", () => {
  it("GET /api/templates lists v1 template", async () => {
    const res = await auth(request(app).get("/api/templates"));
    expect(res.body.templates.map((t) => t.id)).toContain("meeting_to_task");
  });

  it("requires auth (401)", async () => {
    expect((await request(app).get("/api/jobs")).status).toBe(401);
  });

  it("POST /api/jobs creates + runs readonly, reaches awaiting_approval", async () => {
    const res = await auth(request(app).post("/api/jobs")).send({ templateId: "meeting_to_task", params: { minute_token: "mt1" } });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("running_readonly");
    await flush();
    const detail = await auth(request(app).get(`/api/jobs/${res.body.jobId}`));
    expect(detail.body.job.status).toBe("awaiting_approval");
    expect(detail.body.actions).toHaveLength(1);
    expect(detail.body.approvalToken).toBeTruthy(); // 授权审批人拿到一次性 token
  });

  it("POST /api/jobs rejects unknown template (400)", async () => {
    const res = await auth(request(app).post("/api/jobs")).send({ templateId: "weekly", params: {} });
    expect(res.status).toBe(400);
  });

  it("GET /api/jobs filters mine + status", async () => {
    await auth(request(app).post("/api/jobs")).send({ templateId: "meeting_to_task", params: {} });
    await flush();
    const mine = await auth(request(app).get("/api/jobs?mine=1"));
    expect(mine.body.jobs).toHaveLength(1);
    const other = await auth(request(app).get("/api/jobs?status=done"));
    expect(other.body.jobs).toHaveLength(0);
  });

  it("GET /api/jobs/:id 403 for non-owner non-admin", async () => {
    const res = await auth(request(app).post("/api/jobs")).send({ templateId: "meeting_to_task", params: {} });
    await flush();
    db.prepare("INSERT INTO users (id, feishu_open_id, role, created_at) VALUES (?,?,?,?)").run("u-2", "ou_other", "user", 1);
    const t2 = issueSessionToken({ id: "u-2", feishu_open_id: "ou_other", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
    const detail = await request(app).get(`/api/jobs/${res.body.jobId}`).set("Authorization", `Bearer ${t2}`);
    expect(detail.status).toBe(403);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/sse.test.mjs test/jobs-routes.test.mjs`
Expected: FAIL —— 模块/路由不存在。

- [ ] **Step 4: 实现 sse.mjs**

`mstd-orchestrator/server/http/sse.mjs`:
```js
export function sseFormat(sse) {
  return `event: ${sse.event}\ndata: ${JSON.stringify(sse.data ?? {})}\n\n`;
}

export function streamJobEvents({ bus, jobId, res, heartbeatMs = 15000, setInterval: si = setInterval, clearInterval: ci = clearInterval }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n"); // 首个注释帧，立即打开流
  const unsub = bus.subscribe(jobId, (sse) => res.write(sseFormat(sse)));
  const hb = si(() => res.write(": ping\n\n"), heartbeatMs);
  const close = () => { ci(hb); unsub(); };
  res.on?.("close", close);
  return close;
}
```

- [ ] **Step 5: 实现 jobs/routes.mjs（POST/列表/详情/流/模板）**

`mstd-orchestrator/server/jobs/routes.mjs`:
```js
import { requireUser } from "../http/auth-middleware.mjs";
import { createJob, getJobRow, getJob, listJobs } from "../store/jobs.mjs";
import { TEMPLATES } from "./templates.mjs";
import { runReadonlyPhase } from "./orchestrator.mjs";
import { issueApprovalToken } from "../safety/approval.mjs";
import { streamJobEvents } from "../http/sse.mjs";

const APPROVAL_TTL_MS = 30 * 60 * 1000;

function canAccess(user, job) {
  return user.role === "admin" || job.created_by === user.id;
}

export function mountJobRoutes(app, ctx) {
  const { db, config, startPi, semaphore, bus, buffer, registry, extensions = [], piCwd, now = () => Date.now() } = ctx;
  const queue = []; // FIFO of jobId 等待跑第①段

  async function launch(jobId) {
    const job = getJobRow(db, jobId);
    try {
      await runReadonlyPhase({
        db, startPi, bus, buffer, registry, job, extensions,
        piOptions: { ...(config.pi ?? {}), cwd: piCwd },
        now,
      });
    } finally {
      semaphore.release();
      pump();
    }
  }
  function pump() {
    while (queue.length > 0 && semaphore.tryAcquire()) {
      launch(queue.shift()).catch(() => { /* 内部已落 failed */ });
    }
  }

  app.get("/api/templates", requireUser, (_req, res) => {
    res.json({ templates: Object.values(TEMPLATES).map((t) => ({ id: t.id, title: t.title })) });
  });

  app.post("/api/jobs", requireUser, (req, res) => {
    const { templateId, params = {} } = req.body ?? {};
    if (!TEMPLATES[templateId]) return res.status(400).json({ error: `未知模板: ${templateId}` });
    const canRun = semaphore.tryAcquire();
    const status = canRun ? "running_readonly" : "queued";
    const job = createJob(db, {
      templateId, title: params.title ?? TEMPLATES[templateId].title,
      paramsJson: JSON.stringify(params), status, createdBy: req.user.id,
    }, now());
    if (canRun) launch(job.id).catch(() => { /* 内部已落 failed */ });
    else queue.push(job.id);
    res.status(201).json({ jobId: job.id, status });
  });

  app.get("/api/jobs", requireUser, (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const mine = req.query.mine === "1" ? req.user.id : null;
    res.json({ jobs: listJobs(db, { status, mine }) });
  });

  app.get("/api/jobs/:id", requireUser, (req, res) => {
    const detail = getJob(db, req.params.id);
    if (!detail) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, detail.job)) return res.status(403).json({ error: "无权访问该任务" });
    let approvalToken = null;
    if (detail.job.status === "awaiting_approval") {
      approvalToken = issueApprovalToken(db, {
        jobId: detail.job.id, issuedToOpenId: req.user.feishu_open_id, ttlMs: APPROVAL_TTL_MS, now: now(),
      }).token;
    }
    res.json({ ...detail, approvalToken });
  });

  app.get("/api/jobs/:id/stream", requireUser, (req, res) => {
    const job = getJobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权访问该任务" });
    streamJobEvents({ bus, jobId: job.id, res, heartbeatMs: 15000 });
  });

  return { queue }; // 暴露给 Task 13 的 decision/abort 复用（同模块内扩展）
}
```

- [ ] **Step 6: 挂进 app**

`mstd-orchestrator/server/app.mjs` —— 顶部加 import：
```js
import { mountJobRoutes } from "./jobs/routes.mjs";
```
把 `<ANCHOR: job-routes>` 一行替换为：
```js
  if (deps.startPi && deps.semaphore && deps.bus && deps.buffer && deps.registry) {
    mountJobRoutes(app, {
      db: deps.db, config: deps.config, startPi: deps.startPi,
      semaphore: deps.semaphore, bus: deps.bus, buffer: deps.buffer, registry: deps.registry,
      extensions: deps.extensions, piCwd: deps.piCwd, now,
    });
  }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/sse.test.mjs test/jobs-routes.test.mjs test/auth-routes.test.mjs test/http-skeleton.test.mjs`
Expected: PASS —— sse 2 + jobs-routes 6 + auth/骨架不回归。

- [ ] **Step 8: Commit**

```bash
git add server/http/sse.mjs server/jobs/routes.mjs server/app.mjs test/sse.test.mjs test/jobs-routes.test.mjs
git commit -m "feat(mstd-ui): jobs API (create/list/detail) + SSE stream (15s heartbeat)"
```

---

## Task 13: 审批决策 + 中止（decision / abort）

**Files:**
- Modify: `mstd-orchestrator/server/jobs/routes.mjs`（在 `mountJobRoutes` 内追加两个路由 + 辅助函数）
- Test: `mstd-orchestrator/test/decision-routes.test.mjs`

**Interfaces:**
- `POST /api/jobs/:id/decision { approve, edited_items?, note?, decision_token }`：
  - job 须 `awaiting_approval`；`consumeApprovalToken`（Phase 1，绑 job + 操作人 open_id + 单次 + 过期）→ 失败 `409`。
  - `approve=false` → 落 `decisions(decision="reject")` + `rejected`。
  - `approve=true`：带 `edited_items` 则 `validateIntent`（Phase 1）→ `canonicalizeActions` → `recordActions` + `saveJobDraft`（hash 重算）；**强制所有 create_task 动作已具合法 `ou_` open_id**（未补齐 → `400`）；落 `decisions(decision="approve", approved_action_keys, payload_hash_at_decision, approval_token_id)` → 置 Phase-3 内部态 `approved`（**写 gated，不 spawn/不写飞书**）。
- `POST /api/jobs/:id/abort`：授权后 `registry.get(id)?.abort()`（kill Pi）+ `aborted`。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/decision-routes.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createApp } from "../server/app.mjs";
import { issueSessionToken } from "../server/http/session.mjs";
import { issueApprovalToken } from "../server/safety/approval.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions } from "../server/safety/action-store.mjs";
import { createJob, updateJobStatus, saveJobDraft, getJobRow } from "../server/store/jobs.mjs";
import { createSemaphore } from "../server/jobs/semaphore.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "../server/jobs/runtime.mjs";

const SECRET = "test-secret";
let db, app, token, registry;

function setupAwaitingJob({ openId = "ou_a" } = {}) {
  const job = createJob(db, { templateId: "meeting_to_task", paramsJson: "{}", status: "running_readonly", createdBy: "u-1" }, 1000);
  const items = [{ owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: openId, confidence: "high" }];
  const actions = canonicalizeActions({ jobId: job.id, items });
  recordActions(db, job.id, actions);
  saveJobDraft(db, job.id, { cardText: "请确认", itemsJson: JSON.stringify(items), actionSetJson: JSON.stringify(actions) });
  updateJobStatus(db, job.id, "awaiting_approval", 1000);
  return job;
}
const tokenFor = (jobId) => issueApprovalToken(db, { jobId, issuedToOpenId: "ou_me", ttlMs: 60000, now: 1000 }).token;

beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO users (id, feishu_open_id, name, role, created_at) VALUES (?,?,?,?,?)").run("u-1", "ou_me", "我", "user", 1);
  token = issueSessionToken({ id: "u-1", feishu_open_id: "ou_me", role: "user" }, { secret: SECRET, ttlSeconds: 3600, now: 1000 });
  registry = createRuntimeRegistry();
  app = createApp({
    db, config: { sessionSecret: SECRET, sessionTtlSeconds: 3600, pi: {}, enableWrite: false },
    startPi: () => ({ child: { kill() {} }, runJob: () => Promise.resolve({ finalText: "" }), close: () => Promise.resolve() }),
    semaphore: createSemaphore(2), bus: createEventBus(), buffer: createEventBuffer(db), registry, now: () => 1000,
  });
});
const auth = (r) => r.set("Authorization", `Bearer ${token}`);

describe("decision", () => {
  it("approve consumes token, records decision, gates write (status=approved)", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: dt });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.writeGated).toBe(true);
    expect(getJobRow(db, job.id).status).toBe("approved");
    const dec = db.prepare("SELECT * FROM decisions WHERE job_id = ?").get(job.id);
    expect(dec.decision).toBe("approve");
    expect(dec.approval_token_id).toBeTruthy();
    expect(JSON.parse(dec.approved_action_keys_json)).toHaveLength(1);
  });

  it("replayed token -> 409", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: dt });
    // 第二次：job 已 approved 且 token 已用
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: dt });
    expect(res.status).toBe(409);
  });

  it("reject -> status rejected", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: false, decision_token: dt, note: "不批" });
    expect(res.status).toBe(200);
    expect(getJobRow(db, job.id).status).toBe("rejected");
  });

  it("approve with edited_items missing open_id -> 400 (blocking)", async () => {
    const job = setupAwaitingJob();
    const dt = tokenFor(job.id);
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({
      approve: true, decision_token: dt,
      edited_items: [{ owner_name: "张三", task: "写周报", due: null, suggested_open_id: null, confidence: "low" }],
    });
    expect(res.status).toBe(400);
    expect(getJobRow(db, job.id).status).toBe("awaiting_approval"); // 未推进
  });

  it("bad token -> 409", async () => {
    const job = setupAwaitingJob();
    const res = await auth(request(app).post(`/api/jobs/${job.id}/decision`)).send({ approve: true, decision_token: "nope" });
    expect(res.status).toBe(409);
  });
});

describe("abort", () => {
  it("kills active Pi and marks aborted", async () => {
    const job = createJob(db, { templateId: "meeting_to_task", status: "running_readonly", createdBy: "u-1" }, 1000);
    let killed = false;
    registry.register(job.id, { client: {}, abort: () => { killed = true; } });
    const res = await auth(request(app).post(`/api/jobs/${job.id}/abort`)).send({});
    expect(res.status).toBe(200);
    expect(killed).toBe(true);
    expect(getJobRow(db, job.id).status).toBe("aborted");
    expect(registry.has(job.id)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/decision-routes.test.mjs`
Expected: FAIL —— 路由未定义（`404`/断言不符）。

- [ ] **Step 3: 扩展 routes.mjs**

`mstd-orchestrator/server/jobs/routes.mjs` —— 顶部补充 import：
```js
import { createHash, randomUUID } from "node:crypto";
import { consumeApprovalToken } from "../safety/approval.mjs";
import { validateIntent } from "../safety/intent-schema.mjs";
import { canonicalizeActions, stableHash } from "../safety/action-dsl.mjs";
import { recordActions } from "../safety/action-store.mjs";
import { updateJobStatus, saveJobDraft } from "../store/jobs.mjs";
import { TEMPLATES } from "./templates.mjs";
```
（`TEMPLATES`/`updateJobStatus`/`saveJobDraft` 若已 import 则合并，勿重复。）在 `mountJobRoutes` 内、`return { queue };` **之前**插入辅助函数与两个路由：
```js
  const sha256 = (s) => createHash("sha256").update(s).digest("hex");

  function recordDecision(db2, { jobId, decidedBy, decision, editedItems = null, approvedActionKeys = null, payloadHashAtDecision = null, approvalTokenId = null, note = null, ts }) {
    db2.prepare(
      "INSERT INTO decisions (id, job_id, decided_by, decision, edited_items_json, approved_action_keys_json, payload_hash_at_decision, approval_token_id, note, ts) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(
      randomUUID(), jobId, decidedBy, decision,
      editedItems ? JSON.stringify(editedItems) : null,
      approvedActionKeys ? JSON.stringify(approvedActionKeys) : null,
      payloadHashAtDecision, approvalTokenId, note, ts
    );
  }

  // 阻断项：create_task 动作缺合法 ou_ open_id（与 buildWriteArgs 的 fail-closed 一致）。
  function blockingActions(db2, jobId) {
    return db2.prepare("SELECT action_key, kind, target_open_id FROM job_actions WHERE job_id = ?").all(jobId)
      .filter((r) => r.kind === "create_task" && !/^ou_/.test(String(r.target_open_id ?? "")));
  }

  app.post("/api/jobs/:id/decision", requireUser, (req, res) => {
    const { approve, edited_items, note = null, decision_token } = req.body ?? {};
    const job = getJobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权审批该任务" });
    if (job.status !== "awaiting_approval") return res.status(409).json({ error: `任务状态 ${job.status} 不可审批` });

    const tokenId = db.prepare("SELECT id FROM approval_tokens WHERE token_hash = ?").get(sha256(String(decision_token ?? "")))?.id ?? null;
    const consumed = consumeApprovalToken(db, { token: String(decision_token ?? ""), jobId: job.id, operatorOpenId: req.user.feishu_open_id, now: now() });
    if (!consumed.ok) return res.status(409).json({ error: `审批令牌无效: ${consumed.reason}` });

    if (!approve) {
      recordDecision(db, { jobId: job.id, decidedBy: req.user.id, decision: "reject", approvalTokenId: tokenId, note, ts: now() });
      updateJobStatus(db, job.id, "rejected", now());
      bus.publish(job.id, { event: "job_status", data: { status: "rejected" } });
      return res.json({ ok: true, status: "rejected" });
    }

    if (Array.isArray(edited_items)) {
      const cardText = db.prepare("SELECT card_text FROM job_draft WHERE job_id = ?").get(job.id)?.card_text ?? "(编辑)";
      let intent;
      try { intent = validateIntent({ card_text: cardText, items: edited_items }); }
      catch (err) { return res.status(400).json({ error: `编辑后的条目校验失败: ${err.reason ?? err.message}` }); }
      const actions = canonicalizeActions({ jobId: job.id, items: intent.items, enableNotify: TEMPLATES[job.template_id]?.enableNotify ?? false });
      recordActions(db, job.id, actions);
      saveJobDraft(db, job.id, { cardText: intent.card_text, itemsJson: JSON.stringify(intent.items), actionSetJson: JSON.stringify(actions) });
    }

    const blocking = blockingActions(db, job.id);
    if (blocking.length > 0) return res.status(400).json({ error: "存在未补齐 open_id 的动作，无法批准", blocking });

    const rows = db.prepare("SELECT action_key, payload_hash FROM job_actions WHERE job_id = ? ORDER BY ordinal, id").all(job.id);
    recordDecision(db, {
      jobId: job.id, decidedBy: req.user.id, decision: "approve",
      editedItems: Array.isArray(edited_items) ? edited_items : null,
      approvedActionKeys: rows.map((r) => r.action_key),
      payloadHashAtDecision: stableHash(rows.map((r) => ({ action_key: r.action_key, payload_hash: r.payload_hash }))),
      approvalTokenId: tokenId, note, ts: now(),
    });
    updateJobStatus(db, job.id, "approved", now()); // Phase-3 内部态；第②段真写 gated 到 Phase 4
    bus.publish(job.id, { event: "job_status", data: { status: "approved", write: "gated_phase4" } });
    res.json({ ok: true, status: "approved", writeGated: true });
  });

  app.post("/api/jobs/:id/abort", requireUser, (req, res) => {
    const job = getJobRow(db, req.params.id);
    if (!job) return res.status(404).json({ error: "job 不存在" });
    if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权操作该任务" });
    const handle = registry.get(job.id);
    if (handle) { try { handle.abort(); } catch { /* 已退出 */ } registry.remove(job.id); }
    updateJobStatus(db, job.id, "aborted", now());
    bus.publish(job.id, { event: "job_status", data: { status: "aborted" } });
    res.json({ ok: true, status: "aborted" });
  });
```
> `approved` 是 Phase-3 引入的内部过渡态（承接 spec 状态机：Phase 4 由 `approved`→`running_write`→`done/partial_failed`）。中止时信号量槽位由第①段 `launch` 的 `finally` 在被 kill 的 `runJob` settle 后释放（Phase 2 pi-client 进程退出即 reject）；长跑取消的槽位/队列精细对账随第②段在 Phase 4 收口。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/decision-routes.test.mjs test/jobs-routes.test.mjs`
Expected: PASS —— decision 5 + abort 1 + jobs-routes 不回归 6。

- [ ] **Step 5: Commit**

```bash
git add server/jobs/routes.mjs test/decision-routes.test.mjs
git commit -m "feat(mstd-ui): decision (consume approval token, gated write) + abort routes"
```

---

## Task 14: 配置聚合 + 进程入口 + 全量回归 + 手动 smoke

**Files:**
- Create: `mstd-orchestrator/server/config.mjs`
- Create: `mstd-orchestrator/server/index.mjs`
- Test: `mstd-orchestrator/test/config.test.mjs`

**Interfaces:**
- Produces:
  - `loadServerConfig(env=process.env) -> { port, sessionSecret, sessionTtlSeconds, maxConcurrentPi, enableWrite, feishu, pi:{provider,model,thinking}, larkProfile }`（汇总所有 env 开关，单一来源）。
  - `server/index.mjs`：`openDb`+`migrate` → 构造 `semaphore/bus/buffer/registry/feishu client/startPi` → `createApp(deps)` → `listen`。真机入口（依赖 Phase 2 `startPi`）。

- [ ] **Step 1: 写失败测试（config 聚合）**

`mstd-orchestrator/test/config.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { loadServerConfig } from "../server/config.mjs";

describe("loadServerConfig", () => {
  it("aggregates env knobs with sane defaults", () => {
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s", PORT: "9000" });
    expect(c.port).toBe(9000);
    expect(c.sessionSecret).toBe("s");
    expect(c.sessionTtlSeconds).toBe(7 * 86400);
    expect(c.maxConcurrentPi).toBe(2);
    expect(c.enableWrite).toBe(false);
    expect(c.pi.provider).toBe("cz-gpt");
    expect(c.pi.model).toBe("gpt-5.5");
    expect(c.feishu).toHaveProperty("authorizeUrl");
  });
  it("honors overrides", () => {
    const c = loadServerConfig({ MSTD_SESSION_SECRET: "s", MSTD_MAX_CONCURRENT_PI: "3", MSTD_ENABLE_WRITE: "1", PI_MODEL: "gpt-5.5-mini" });
    expect(c.maxConcurrentPi).toBe(3);
    expect(c.enableWrite).toBe(true);
    expect(c.pi.model).toBe("gpt-5.5-mini");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/config.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 config 聚合**

`mstd-orchestrator/server/config.mjs`:
```js
import { resolveFeishuConfig } from "./auth/feishu-oauth.mjs";
import { sessionSecret, sessionTtlSeconds } from "./http/session.mjs";
import { maxConcurrentPi } from "./jobs/semaphore.mjs";

export function loadServerConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8787),
    sessionSecret: sessionSecret(env),
    sessionTtlSeconds: sessionTtlSeconds(env),
    maxConcurrentPi: maxConcurrentPi(env),
    enableWrite: String(env.MSTD_ENABLE_WRITE ?? "") === "1",
    feishu: resolveFeishuConfig(env),
    pi: {
      provider: env.PI_PROVIDER ?? "cz-gpt",
      model: env.PI_MODEL ?? "gpt-5.5",
      thinking: env.PI_THINKING ?? "medium",
    },
    larkProfile: env.LARK_PROFILE ?? "",
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/config.test.mjs`
Expected: PASS —— 2 passed。

- [ ] **Step 5: 写进程入口**

`mstd-orchestrator/server/index.mjs`:
```js
import { join } from "node:path";
import { openDb, migrate } from "./db/index.mjs";
import { loadServerConfig } from "./config.mjs";
import { createApp } from "./app.mjs";
import { createSemaphore } from "./jobs/semaphore.mjs";
import { createEventBus } from "./jobs/event-bus.mjs";
import { createEventBuffer } from "./jobs/event-buffer.mjs";
import { createRuntimeRegistry } from "./jobs/runtime.mjs";
import { makeFeishuClient } from "./auth/feishu-client.mjs";
import { startPi } from "../supervisor/pi-client.mjs"; // Phase 2 契约：runJob(message,{id,onEvent})

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const config = loadServerConfig(process.env);
const db = openDb(process.env.MSTD_DB_PATH || join(ROOT, "db", "mstd.sqlite"));
migrate(db);

const buffer = createEventBuffer(db);
buffer.start(); // 起周期 flush（unref，不挡退出）

const app = createApp({
  db,
  config,
  feishu: makeFeishuClient(config.feishu),
  startPi,
  semaphore: createSemaphore(config.maxConcurrentPi),
  bus: createEventBus(),
  buffer,
  registry: createRuntimeRegistry(),
  extensions: [join(ROOT, "pi-ext", "providers.ts"), join(ROOT, "pi-ext", "lark.ts")],
  piCwd: ROOT,
});

app.listen(config.port, () => {
  process.stderr.write(`[mstd-server] listening on :${config.port} (maxConcurrentPi=${config.maxConcurrentPi}, write=${config.enableWrite ? "on" : "GATED"})\n`);
});
```
> 注：第①段只读挂 `providers.ts`+`lark.ts` 扩展（`lark.ts` 的只读白名单加固见 Phase 1 S1；Phase 4 拆 `lark_read`/`lark-execute` 时此处切换）。真 OAuth/真 Pi 需 `.env` 就绪 + 飞书端点 env 已核实。

- [ ] **Step 6: 全量单测回归**

Run: `cd mstd-orchestrator && npm test`
Expected: PASS —— Phase 0-1（smoke/db/safety×6）+ Phase 2（若已落地：pi-fixture/rpc/translator/stream-processor）+ Phase 3（http-skeleton/session/cookies/auth-middleware/dialect/semaphore/event-bus/event-buffer/feishu-oauth/feishu-client/users-store/auth-routes/jobs-store/templates/intent-parse/runtime/orchestrator/sse/jobs-routes/decision-routes/config）全绿。

- [ ] **Step 7: 手动 smoke（健康检查，无需真飞书/真 Pi）**

Run:
```bash
cd mstd-orchestrator && set -a; . ./.env 2>/dev/null; set +a
MSTD_SESSION_SECRET=dev-smoke PORT=8787 node server/index.mjs &
sleep 1
curl -s http://localhost:8787/api/health
curl -s "http://localhost:8787/api/auth/feishu/login?redirectAfter=/board" -i | grep -i "set-cookie\|authorizeUrl" || true
kill %1
```
Expected: `/api/health` → `{"ok":true}`；`/login` → 200 带 `mstd_oauth_nonce` cookie + `authorizeUrl`（URL 里的端点是否正确取决于 `FEISHU_*` env 是否已按下方"实现时核实"校准）。真 OAuth 回调与真 Pi 建 job 的端到端验证走 `verify` skill + Browser 插件（Phase 4 收尾，本 Phase 不真写）。

- [ ] **Step 8: Commit**

```bash
git add server/config.mjs server/index.mjs test/config.test.mjs
git commit -m "feat(mstd-ui): server config aggregation + process entrypoint + health smoke"
```

---

## ⚠️ 实现时须核实清单（外部依赖 · 飞书 OAuth）

以下项**禁止凭空当成既成事实**，落地前用 **lark-cli / 飞书 OpenAPI（应用 `cli_aac4855d1a781cd6`）核实**，再通过 env 校准（"核实 = 配置 env"，代码不改）。全部有 env 覆盖点 + 单测覆盖 URL 构造/流程形状，故是"配置待定"而非"逻辑占位"：

| 待核实项 | 代码位置 / env 覆盖 | 校验手段 |
|---|---|---|
| authorize 端点 URL | `feishu-oauth.DEFAULTS.authorizeUrl` / `FEISHU_AUTHORIZE_URL` | 飞书身份认证 OpenAPI 文档 / lark-cli |
| token 交换端点 URL | `feishu-oauth.DEFAULTS.tokenUrl` / `FEISHU_TOKEN_URL` | 同上 |
| user_info 端点 URL | `feishu-oauth.DEFAULTS.userInfoUrl` / `FEISHU_USERINFO_URL` | 同上 |
| authorize 参数名（`app_id` vs `client_id`）、`response_type`、scope 分隔符 | `buildAuthorizeUrl` | 授权页真跑 / 文档 |
| scope 字符串（取 open_id/name/avatar 所需） | `FEISHU_OAUTH_SCOPE` | 应用后台已授 scope + 文档 |
| token 交换请求体字段（`grant_type/client_id/client_secret/code/redirect_uri`） | `feishu-client.exchangeCode` | 文档 / 真跑 |
| 响应字段路径（`access_token` 或 `data.access_token`；`data.open_id/name/avatar_url`） | `feishu-client.exchangeCode` | 真跑回包 |
| 应用后台 redirect URI 白名单 = `FEISHU_REDIRECT_URI` | 应用后台配置 | 后台核对（spec 前置依赖 1） |

---

## Self-Review

**Spec 覆盖（Phase 3 范围）**：
- 端点全覆盖：`GET /api/auth/feishu/login`（Task 8，含 open-redirect 加固 sanitize）、`GET /api/auth/feishu/callback`（Task 8）、`GET /api/me`（Task 3）、`GET /api/templates`（Task 12）、`POST /api/jobs`（Task 12）、`GET /api/jobs?status=&mine=`（Task 12）、`GET /api/jobs/:id`（Task 12，含断线重放聚合 events+draft+actions+decisions + 一次性 approval token）、`GET /api/jobs/:id/stream`（Task 12，15s 心跳）、`POST /api/jobs/:id/decision`（Task 13，消费 approval token + 落 decisions）、`POST /api/jobs/:id/abort`（Task 13，kill Pi）✓
- 飞书 OAuth = Phase 1 `auth_challenges`（state/nonce，Task 8）+ HMAC 会话 token（改编 pricing auth.js，Task 2）✓；OAuth 端点/scope 全部可配置 + "实现时核实"清单 ✓
- 两段式接线：第①段只读 `runJob`→`validateIntent`→`canonicalizeActions`→`recordActions`+`job_draft`→`awaiting_approval`；schema 不过→`needs_attention`（Task 11）✓；第②段真写 **gated stub**（`runWritePhase` 恒 gated，Task 11）+ 批准仅记录 decision（Task 13）✓
- 持久化批量写：ring buffer + 批量 flush，只落关键审计事件，`assistant_delta` 不落，实时走 SSE（Task 6）✓
- DB 方言适配：`buildInsertIgnore`/`buildUpsert`（SQLite↔Postgres）+ 迁移 `recordActions`（Task 4）✓
- 并发信号量：默认 2 / 上限 3 / 超出 queued + FIFO 出队（Task 5 + Task 12 队列）✓
- Bearer 鉴权中间件：401→前端重登（Task 3）✓
- 错误处理边界（spec）落到：Pi 崩溃→`failed`（Task 11）、意图不过→`needs_attention`（Task 11）、token 重放/过期/绑定→`409`（Task 13）、鉴权过期→`401`（Task 3）、SSE 心跳（Task 12）✓
- 超出 Phase 3 的（真写执行器 `executeApprovedAction`/hash 漂移拒绝/对账/partial_failed 重试、mstd-ui 前端、`verify` Browser 真机）明确归 Phase 4，非本计划遗漏 ✓

**Placeholder 扫描**：无 TBD/TODO/"类似上文"/"加适当错误处理"；每个 code step 给完整可运行代码 + 测试命令 + 预期。唯一标注"实现时核实"的是**飞书 OAuth 端点/参数名/scope/响应字段路径**——这些是**可配置常量 + env 覆盖 + 单测覆盖构造逻辑**的完整代码，不确定的只是"默认 URL/scope 是否与飞书当前 API 一致"（外部事实），已集中列入"实现时须核实清单"并给出 lark-cli/OpenAPI 校验手段（应用 `cli_aac4855d1a781cd6`）。第②段真写 gated 是**显式 Phase 4 边界**（`runWritePhase` 有完整 gated 实现 + 防误启用抛错），非占位。

**类型一致性**：
- SSE 事件统一 `{ event, data }`（Phase 2 翻译器产物）：`event-bus.publish`/`event-buffer.record`/`sseFormat`/`streamJobEvents`/orchestrator `emit` 全一致 ✓
- `Action` 字段（`action_key/kind/payload/payload_hash/target_open_id/ordinal/requires_open_id`）来自 Phase 1 `canonicalizeActions`，被 orchestrator/decision 路由消费一致；`recordActions` 列顺序与 `001_init.sql` 一致（含 `ordinal`）✓
- 会话 token payload `{uid(string),oid,name,role,iat,exp}`：`issueSessionToken`↔`verifySessionToken`↔`bearerAuth`（`payload.uid`→`users.id`）一致；与 pricing `auth.js`（数字 uid）差异已在 Global Constraints 标注并自建 ✓
- Phase 1 函数签名全部按真实文件引用：`consumeApprovalToken({token,jobId,operatorOpenId,now})`、`issueApprovalToken({jobId,issuedToOpenId,ttlMs,now})`、`createAuthChallenge/consumeAuthChallenge`、`validateIntent`(throws `IntentValidationError`)、`canonicalizeActions({jobId,items,enableNotify})`、`recordActions(db,jobId,actions,now?,dialect?)`、`openDb/migrate` ✓
- `createApp(deps)` 契约稳定（Task 1 起），逐任务在锚点挂载中间件/路由，未用 deps 键安全忽略；`ctx` 字段（`db/config/startPi/semaphore/bus/buffer/registry/extensions/piCwd/now`）在 `mountJobRoutes` 定义、`index.mjs` 供给一致 ✓
- DB 列名与 `001_init.sql` 逐一对齐（`orch_jobs.template_id/created_by`、`job_events.seq/phase`、`job_draft.card_text/action_set_json/raw_output`、`decisions.approved_action_keys_json/payload_hash_at_decision/approval_token_id`、`job_actions.ordinal/target_open_id`、时间戳 `BIGINT` epoch ms）✓

**依赖顺序自洽**：Task 1（骨架）→2（会话 token/cookie）→3（鉴权+/me）→4（方言层，迁 `recordActions`）→5（信号量）→6（事件管道）→7（OAuth 原语/客户端）→8（users+OAuth 路由）→9（jobs 仓储）→10（模板/解析/注册表）→11（编排器）→12（jobs API+SSE）→13（decision/abort）→14（config+入口+回归）。每个 Task 的测试只依赖更早 Task 的产物；Phase 2 `startPi` 仅 Task 14 手动 smoke 与 `index.mjs` 真机需要，前 13 个 Task 全用注入 fake，故本计划可在 Phase 2 未完成时先行推进单测。

