# MSTD 第一层闭环完全体（接线收尾 + 触发层 + 运维健壮）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"会议纪要 → 建任务"从「安全的人工触发工作台」推进为需求 v1.0 第一层的完全体：审批即真写（四道锁全程在线）、只读阶段真只读、对账接入运行时、UI 补齐（删条目/中止/断线续传）、妙记生成事件自动触发（event_id 幂等去重）、断档回扫、lark profile 健康检查告警、生产配置收口。

**Architecture:** 全部改动落在既有三层：`pi-ext/`（Pi 工具）、`server/`（Express + better-sqlite3 权威层）、`mstd-ui/`（React SPA）。新增 `server/triggers/`（事件消费+去重+回扫）与 `server/health/`（profile 健康检查）。写路径唯一权威执行器仍是 `executeApprovedAction`（hash 校验/test-target/dry-run/幂等 key 四道锁不动），本计划只做"接线"，不改安全内核语义。

**Tech Stack:** Node ≥22 · Express · better-sqlite3（SQL 保持 Postgres 可移植）· Pi 0.80.3 RPC（`supervisor/pi-client.mjs`）· lark-cli（profile `user613148`，含 `event consume` NDJSON 长连接）· Vite+React+vitest。

## Global Constraints

- **模型永远不可信**：写操作的形状由服务端确定；模型只能选 `action_id`，改不了 payload/收件人/flag。
- **真写默认关**：`MSTD_ENABLE_WRITE=1` 才开写；真写目标只允许 `MSTD_TEST_OPEN_IDS` 白名单（`assertTestTarget` fail-closed，不放宽）。
- **密钥红线**：key/secret 只进 gitignore 的 `.env`（chmod 600），不进代码、日志、Git。
- **SQL Postgres 可移植**：显式主键、无 `AUTOINCREMENT`、时间戳 epoch BIGINT、JSON 存 TEXT、`ON CONFLICT` 语法双方言兼容。
- **事件幂等**：一切外部事件按 `event_id` UNIQUE 去重；job 级去重按 `dedupe_key`（如 `minutes:<minute_token>`）UNIQUE。
- **测试**：服务端/前端均 vitest；单测不得真调飞书（注入 `runLark`/`spawnFn`/`startPi` mock）。真机验证用 Claude-in-Chrome 浏览器插件，**不用 Playwright**（项目约定）。
- **lark-cli 路径**：`~/.hermes/node/bin/lark-cli`；Pi 路径 `~/.hermes/node/bin/pi`。
- **commit 风格**：沿用仓库现状 `feat(mstd-ui)/fix(mstd-ui): 中文短句`；本计划统一用 scope `mstd`。
- 运行测试命令：`cd mstd-orchestrator && npx vitest run`（39 文件 199 用例基线全绿）；`cd mstd-ui && npx vitest run`（13 文件 34 用例基线全绿）。任何任务完成时**全量套件必须全绿**。

---

### Task 1: 事件 seq 实时化（event-buffer 即时分配 seq，SSE 事件携带 seq）

现状：`job_events.seq` 在 flush 时才分配，实时 SSE 事件不带 seq → 客户端无法断点续传。改为 `record()` 即时分配并返回 seq，`emit` 把 seq 附到 bus 发布的事件上。

**Files:**
- Modify: `mstd-orchestrator/server/jobs/event-buffer.mjs`
- Modify: `mstd-orchestrator/server/jobs/orchestrator.mjs`（顶部 `emit` 函数）
- Test: `mstd-orchestrator/test/event-buffer.test.mjs`（追加用例）

**Interfaces:**
- Produces: `buffer.record(jobId, phase, sse, now?) -> number | null`（关键事件返回递增 seq；非关键事件返回 `null` 不落库）。
- Produces: bus 上发布的关键事件对象形如 `{ event, data, seq }`；非关键事件（如 `assistant_delta`）无 `seq` 字段。后续 Task 2/8 依赖。

- [ ] **Step 1: 写失败测试**（追加到 `test/event-buffer.test.mjs`）

```js
it("record 即时返回递增 seq，flush 落库同一 seq", () => {
  const buf = createEventBuffer(db);
  const s1 = buf.record("job1", "readonly", { event: "tool_start", data: {} });
  const s2 = buf.record("job1", "readonly", { event: "tool_result", data: {} });
  expect(s1).toBe(1);
  expect(s2).toBe(2);
  expect(buf.record("job1", "readonly", { event: "assistant_delta", data: {} })).toBeNull();
  buf.flush();
  const rows = db.prepare("SELECT seq, type FROM job_events WHERE job_id = 'job1' ORDER BY seq").all();
  expect(rows.map((r) => r.seq)).toEqual([1, 2]);
});
```

（复用该文件既有的 `db` 初始化方式；`job1` 需先插入 `orch_jobs` 满足外键——照抄文件里现有用例的做法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/event-buffer.test.mjs`
Expected: FAIL（`record` 当前返回 `undefined`）

- [ ] **Step 3: 实现**

`event-buffer.mjs` 的 `record` 与 `flush` 改为：

```js
function record(jobId, phase, sse, now = Date.now()) {
  if (!keyEvents.has(sse.event)) return null;
  const seq = nextSeq(jobId);
  pending.push({ jobId, phase, seq, type: sse.event, payloadJson: JSON.stringify(sse.data ?? {}), ts: now });
  if (pending.length >= maxBatch) flush();
  return seq;
}
```

`flush` 内循环改用已存的 seq（不再在 flush 时调 `nextSeq`）：

```js
for (const r of items) {
  stmt.run(randomUUID(), r.jobId, r.phase, r.seq, r.type, r.payloadJson, r.ts);
}
```

`orchestrator.mjs` 顶部 `emit` 改为：

```js
function emit(bus, buffer, jobId, phase, sse) {
  const seq = buffer.record(jobId, phase, sse);
  bus.publish(jobId, seq == null ? sse : { ...sse, seq });
}
```

- [ ] **Step 4: 全量测试**

Run: `cd mstd-orchestrator && npx vitest run`
Expected: 全绿（orchestrator/sse 等既有用例对事件对象是宽松断言，多一个 `seq` 字段不破坏；若个别用例用了深度相等断言，把期望对象补上 `seq`）。

- [ ] **Step 5: Commit**

```bash
git add mstd-orchestrator/server/jobs/event-buffer.mjs mstd-orchestrator/server/jobs/orchestrator.mjs mstd-orchestrator/test/event-buffer.test.mjs
git commit -m "feat(mstd): 关键事件即时分配 seq 并随 SSE 携带（断线续传地基）"
```

---

### Task 2: SSE 断线重放（服务端 `?sinceSeq=` 补发历史关键事件）

**Files:**
- Modify: `mstd-orchestrator/server/http/sse.mjs`
- Modify: `mstd-orchestrator/server/jobs/routes.mjs`（`GET /api/jobs/:id/stream`）
- Test: `mstd-orchestrator/test/sse.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `{event, data, seq}` 事件与 `buffer.flush()`。
- Produces: `streamJobEvents({ db, bus, buffer, jobId, res, sinceSeq, heartbeatMs })`；`sinceSeq != null` 时先把 `job_events` 中 `seq > sinceSeq` 的行按 SSE 格式补发（带 `id: <seq>` 行），再接实时流。SSE 帧格式 `id: N\nevent: X\ndata: {...}\n\n`（无 seq 的事件不带 `id:` 行）。前端 Task 8 依赖 `id:` 行与 `?sinceSeq=` 查询参。

- [ ] **Step 1: 写失败测试**（追加到 `test/sse.test.mjs`，复用该文件现有的 fake `res` 写法）

```js
it("sinceSeq 重放：先补历史关键事件（带 id 行），再接实时", () => {
  // 预置 job_events：seq=1 tool_start, seq=2 message_done
  seedJobEvent(db, "job1", 1, "tool_start", { toolName: "lark_read" });
  seedJobEvent(db, "job1", 2, "message_done", {});
  const res = fakeRes();
  streamJobEvents({ db, bus, buffer, jobId: "job1", res, sinceSeq: 1, heartbeatMs: 60000 });
  const body = res.written.join("");
  expect(body).toContain("id: 2\nevent: message_done");
  expect(body).not.toContain("id: 1\n"); // seq<=sinceSeq 不补发
  bus.publish("job1", { event: "job_status", data: { status: "done" }, seq: 3 });
  expect(res.written.join("")).toContain("id: 3\nevent: job_status");
});
```

（`seedJobEvent` 是测试内 5 行小工具：直接 `INSERT INTO job_events (id, job_id, phase, seq, type, payload_json, ts) VALUES (...)`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/sse.test.mjs`
Expected: FAIL（`streamJobEvents` 不认识 `db`/`sinceSeq`；`sseFormat` 无 `id:` 行）

- [ ] **Step 3: 实现**（`sse.mjs` 全量替换为）

```js
export function sseFormat(sse) {
  const id = sse.seq != null ? `id: ${sse.seq}\n` : "";
  return `${id}event: ${sse.event}\ndata: ${JSON.stringify(sse.data ?? {})}\n\n`;
}

export function streamJobEvents({ db = null, bus, buffer = null, jobId, res, sinceSeq = null, heartbeatMs = 15000, setInterval: si = setInterval, clearInterval: ci = clearInterval }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");
  const backlog = [];
  let replaying = sinceSeq != null && db != null;
  const unsub = bus.subscribe(jobId, (sse) => {
    if (replaying) backlog.push(sse);
    else res.write(sseFormat(sse));
  });
  if (replaying) {
    buffer?.flush?.(); // 把内存 pending 落库，消灭补发缺口
    let last = Number(sinceSeq);
    const rows = db.prepare(
      "SELECT seq, type, payload_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq"
    ).all(jobId, last);
    for (const r of rows) {
      res.write(sseFormat({ event: r.type, data: JSON.parse(r.payload_json ?? "{}"), seq: r.seq }));
      last = r.seq;
    }
    replaying = false;
    for (const sse of backlog) if (sse.seq == null || sse.seq > last) res.write(sseFormat(sse));
    backlog.length = 0;
  }
  const hb = si(() => res.write(": ping\n\n"), heartbeatMs);
  const close = () => { ci(hb); unsub(); };
  res.on?.("close", close);
  return close;
}
```

`routes.mjs` 的 stream 端点改为：

```js
app.get("/api/jobs/:id/stream", requireUser, (req, res) => {
  const job = getJobRow(db, req.params.id);
  if (!job) return res.status(404).json({ error: "job 不存在" });
  if (!canAccess(req.user, job)) return res.status(403).json({ error: "无权访问该任务" });
  const rawSince = req.query.sinceSeq ?? req.headers["last-event-id"];
  const sinceSeq = rawSince != null && rawSince !== "" && Number.isFinite(Number(rawSince)) ? Number(rawSince) : null;
  streamJobEvents({ db, bus, buffer, jobId: job.id, res, sinceSeq, heartbeatMs: 15000 });
});
```

- [ ] **Step 4: 全量测试**

Run: `cd mstd-orchestrator && npx vitest run`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add mstd-orchestrator/server/http/sse.mjs mstd-orchestrator/server/jobs/routes.mjs mstd-orchestrator/test/sse.test.mjs
git commit -m "feat(mstd): SSE 支持 sinceSeq 断线重放（先补库中关键事件再接实时）"
```

---

### Task 3: 写执行全接线（审批通过 → 自动跑写阶段 → done/partial_failed）

核心缺口：`POST /api/jobs/:id/decision` approve 后只落库不执行。本任务补齐：共享 `runLark`、真实 `spawnPi`（挂 `lark-execute.ts`）、`write-flow` 编排、decision 路由触发。

**Files:**
- Create: `mstd-orchestrator/server/execute/run-lark.mjs`
- Create: `mstd-orchestrator/server/execute/write-pi.mjs`
- Create: `mstd-orchestrator/server/jobs/write-flow.mjs`
- Modify: `mstd-orchestrator/server/jobs/routes.mjs`（decision approve 分支）
- Modify: `mstd-orchestrator/server/index.mjs`（组装 `writeDeps`）
- Test: `mstd-orchestrator/test/write-flow.test.mjs`（新建）、`mstd-orchestrator/test/decision-routes.test.mjs`（追加）

**Interfaces:**
- Produces: `makeRunLark({ larkCli?, profile?, timeoutMs?, spawnFn? }) -> (argv: string[]) => Promise<{exitCode, stdout, stderr}>`（Task 4/12/13/14 复用）。
- Produces: `buildWritePrompt(actionIds: string[]) -> string`；`makeWriteSpawnPi({ startPi, piOptions, extensions, dbPath, jobId, actionIds, onEvent, timeoutMs }) -> () => Promise<void>`。
- Produces: `runWriteFlow({ db, config, startPi, bus, buffer, writeDeps, jobId, now }) -> Promise<{status: "done"|"partial_failed"}>`。
- Produces: `mountJobRoutes` 的 ctx 新增可选 `writeDeps = { runLark, testTarget, dbPath, writeExtensions, piCwd }`；decision 响应在开写时变为 `{ ok: true, status: "running_write" }`（gated 时保持 `{ ok, status: "approved", writeGated: true }`）。前端 Task 9 依赖。

- [ ] **Step 1: 写 `run-lark.mjs`（无独立测试，随 write-flow 用例覆盖）**

```js
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");

export function makeRunLark({ larkCli = DEFAULT_LARK_CLI, profile = "", timeoutMs = 60000, spawnFn = spawn } = {}) {
  return function runLark(argv) {
    return new Promise((resolve) => {
      const finalArgs = profile ? ["--profile", profile, ...argv] : argv;
      const child = spawnFn(larkCli, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
      const out = []; const err = [];
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } }, timeoutMs);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => err.push(d));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
      });
      child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: -1, stdout: "", stderr: String(e) }); });
    });
  };
}
```

- [ ] **Step 2: 写 `write-pi.mjs`**

```js
export function buildWritePrompt(actionIds) {
  return [
    "第二阶段【写执行】。以下是已批准动作的 action_id 列表：",
    JSON.stringify(actionIds),
    "死命令：逐条调用 lark_execute_approved_action（唯一参数 action_id），按列表顺序执行；",
    "不重新判断、不改内容、不跳过、不新增动作；每条完成后用一行文字回报结果；全部执行完输出 DONE。",
  ].join("\n");
}

export function makeWriteSpawnPi({ startPi, piOptions = {}, extensions = [], dbPath, jobId, actionIds, onEvent = () => {}, timeoutMs = 240000 }) {
  return async function spawnPi() {
    const client = startPi({
      provider: piOptions.provider ?? "cz-gpt",
      model: piOptions.model ?? "gpt-5.5",
      thinking: piOptions.thinking ?? "medium",
      cwd: piOptions.cwd,
      extensions,
      env: { LARK_ALLOW_WRITE: "1", MSTD_DB_PATH: dbPath },
    });
    try {
      await client.runJob(buildWritePrompt(actionIds), { id: `${jobId}:write`, timeoutMs, onEvent });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  };
}
```

- [ ] **Step 3: 写失败测试 `test/write-flow.test.mjs`**

用内存库预置：1 个 `approved` job、2 条 `pending` job_actions（payload 指向测试 open_id `ou_test1`）、1 条 approve decision（`approved_action_keys_json` 含两条的 `{action_key, payload_hash}`）。参照 `test/execute-action.test.mjs` 现有的 seed 方式复制其建库/插行辅助。

```js
import { describe, it, expect } from "vitest";
import { runWriteFlow } from "../server/jobs/write-flow.mjs";
import { createEventBus } from "../server/jobs/event-bus.mjs";
import { createEventBuffer } from "../server/jobs/event-buffer.mjs";

const okLark = async (argv) => ({ exitCode: 0, stdout: "{}", stderr: "" }); // dry-run 与真跑都成功

describe("runWriteFlow", () => {
  it("spawnPi 失败走 fallback 直执，全成功 → done", async () => {
    const { db, jobId } = seedApprovedJob(); // 2 条 pending 动作，均指向 ou_test1
    const bus = createEventBus(); const buffer = createEventBuffer(db);
    const events = [];
    bus.subscribe(jobId, (e) => events.push(e));
    const out = await runWriteFlow({
      db, config: { enableWrite: true }, startPi: null, bus, buffer,
      writeDeps: {
        runLark: okLark,
        testTarget: { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "" },
        dbPath: ":memory:", writeExtensions: [], piCwd: ".",
        makeSpawnPi: () => async () => { throw new Error("no pi in test"); },
      },
      jobId,
    });
    expect(out.status).toBe("done");
    const statuses = db.prepare("SELECT status FROM job_actions WHERE job_id = ?").all(jobId).map((r) => r.status);
    expect(statuses).toEqual(["succeeded", "succeeded"]);
    expect(events.some((e) => e.event === "job_status" && e.data.status === "running_write")).toBe(true);
    expect(events.some((e) => e.event === "job_status" && e.data.status === "done")).toBe(true);
  });

  it("一条 dry-run 失败 → partial_failed", async () => {
    const { db, jobId } = seedApprovedJob();
    let n = 0;
    const flaky = async (argv) => (argv.includes("--dry-run") && ++n === 2)
      ? { exitCode: 1, stdout: "", stderr: "boom" }
      : { exitCode: 0, stdout: "{}", stderr: "" };
    const bus = createEventBus(); const buffer = createEventBuffer(db);
    const out = await runWriteFlow({
      db, config: { enableWrite: true }, startPi: null, bus, buffer,
      writeDeps: { runLark: flaky, testTarget: { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "" }, dbPath: ":memory:", writeExtensions: [], piCwd: ".", makeSpawnPi: () => async () => { throw new Error("no pi"); } },
      jobId,
    });
    expect(out.status).toBe("partial_failed");
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/write-flow.test.mjs`
Expected: FAIL（`write-flow.mjs` 不存在）

- [ ] **Step 5: 实现 `server/jobs/write-flow.mjs`**

```js
import { updateJobStatus } from "../store/jobs.mjs";
import { actionsToExecute } from "../safety/action-store.mjs";
import { runWritePhase } from "./orchestrator.mjs";
import { makeWriteSpawnPi } from "../execute/write-pi.mjs";

export async function runWriteFlow({ db, config, startPi, bus, buffer, writeDeps, jobId, now = () => Date.now() }) {
  const emit = (sse) => {
    const seq = buffer.record(jobId, "write", sse);
    bus.publish(jobId, seq == null ? sse : { ...sse, seq });
  };
  updateJobStatus(db, jobId, "running_write", now());
  emit({ event: "job_status", data: { status: "running_write" } });

  const actionIds = actionsToExecute(db, jobId).map((a) => a.id);
  const makeSpawnPi = writeDeps.makeSpawnPi ?? makeWriteSpawnPi; // 测试可注入
  const spawnPi = makeSpawnPi({
    startPi,
    piOptions: { ...(config.pi ?? {}), cwd: writeDeps.piCwd },
    extensions: writeDeps.writeExtensions,
    dbPath: writeDeps.dbPath,
    jobId, actionIds, onEvent: emit,
  });
  await runWritePhase({ config, db, jobId, spawnPi, runLark: writeDeps.runLark, testTarget: writeDeps.testTarget });

  const rows = db.prepare("SELECT status FROM job_actions WHERE job_id = ?").all(jobId);
  const finalStatus = rows.length > 0 && rows.every((r) => r.status === "succeeded") ? "done" : "partial_failed";
  updateJobStatus(db, jobId, finalStatus, now());
  emit({ event: "job_status", data: { status: finalStatus } });
  buffer.flush();
  return { status: finalStatus };
}
```

（注意 `runWritePhase` 是 `orchestrator.mjs` 的 gated 网关——`config.enableWrite` 为假直接返回 `{gated:true}`，行为保持。）

- [ ] **Step 6: decision 路由接线**（`routes.mjs`，替换 approve 分支尾部三行）

```js
updateJobStatus(db, job.id, "approved", now());
if (!config.enableWrite || !ctx.writeDeps) {
  bus.publish(job.id, { event: "job_status", data: { status: "approved", write: "gated" } });
  return res.json({ ok: true, status: "approved", writeGated: true });
}
res.json({ ok: true, status: "running_write" });
runWriteFlow({ db, config, startPi, bus, buffer, writeDeps: ctx.writeDeps, jobId: job.id, now })
  .catch((err) => {
    updateJobStatus(db, job.id, "partial_failed", now());
    bus.publish(job.id, { event: "error", data: { level: "write_flow", text: String(err?.message ?? err) } });
  });
```

顶部补 import：`import { runWriteFlow } from "./write-flow.mjs";`，并在 `mountJobRoutes` 解构里保留 `ctx` 引用（函数签名 `export function mountJobRoutes(app, ctx)` 已有）。

`test/decision-routes.test.mjs` 追加一例：`config.enableWrite=true` + `ctx.writeDeps`（mock `runLark` 全成功、`makeSpawnPi` 抛错走 fallback）→ decision 响应 `status: "running_write"`，随后轮询 db 至 job 状态 `done`。

- [ ] **Step 7: `index.mjs` 组装真实 writeDeps**

```js
import { makeRunLark } from "./execute/run-lark.mjs";
import { testTargetFromEnv } from "./execute/write-target.mjs";
```

`createApp({...})` 入参追加：

```js
writeDeps: {
  runLark: makeRunLark({ profile: config.larkProfile }),
  testTarget: testTargetFromEnv(process.env),
  dbPath,
  writeExtensions: [join(ROOT, "pi-ext", "providers.ts"), join(ROOT, "pi-ext", "lark-execute.ts")],
  piCwd: ROOT,
},
```

并在 `app.mjs` 的 `mountJobRoutes` ctx 里透传 `writeDeps: deps.writeDeps`。

- [ ] **Step 8: 全量测试 + Commit**

Run: `cd mstd-orchestrator && npx vitest run` → 全绿。

```bash
git add mstd-orchestrator/server/execute/run-lark.mjs mstd-orchestrator/server/execute/write-pi.mjs mstd-orchestrator/server/jobs/write-flow.mjs mstd-orchestrator/server/jobs/routes.mjs mstd-orchestrator/server/app.mjs mstd-orchestrator/server/index.mjs mstd-orchestrator/test/write-flow.test.mjs mstd-orchestrator/test/decision-routes.test.mjs
git commit -m "feat(mstd): 审批通过自动触发写阶段（Pi 驱动 + 直执兜底，done/partial_failed 收敛）"
```

---

### Task 4: reconcile 接入运行时（写前对账 + 启动对账）

**Files:**
- Modify: `mstd-orchestrator/server/execute/write-phase.mjs`（删 `void reconcileAction;`，写前对账）
- Create: `mstd-orchestrator/server/execute/reconcile-startup.mjs`
- Modify: `mstd-orchestrator/server/index.mjs`（boot 时调用）
- Test: `mstd-orchestrator/test/write-phase.test.mjs`（追加）、`mstd-orchestrator/test/reconcile-startup.test.mjs`（新建）

**Interfaces:**
- Produces: `reconcileOnBoot(db, { runLark = null, now }) -> Promise<{reconciled: number, failed: number, jobsFinalized: number}>`。
- Modifies: `runWritePhase(db, jobId, {...})` 现在执行前会把该 job 的 `executing/unknown` 动作先对账（命中外部指纹 → `succeeded`；未命中 → `failed(reconcile_not_found)`，从而进入 `actionsToExecute` 的可重试集合）。

- [ ] **Step 1: 失败测试**（`test/write-phase.test.mjs` 追加）

```js
it("写前对账：executing 残留先 reconcile，命中外部指纹则不重复执行", async () => {
  const { db, jobId, actions } = seedApprovedJob(); // 复用/照抄本文件既有 seed
  db.prepare("UPDATE job_actions SET status = 'executing' WHERE id = ?").run(actions[0].id);
  const calls = [];
  const runLark = async (argv) => {
    calls.push(argv.join(" "));
    if (argv[0] === "task" && argv[1] === "+list") {
      return { exitCode: 0, stdout: JSON.stringify({ items: [{ idempotency_key: actions[0].idempotency_key }] }), stderr: "" };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
  await runWritePhase(db, jobId, { spawnPi: async () => { throw new Error("force fallback"); }, runLark, testTarget: TEST_TARGET });
  const row = db.prepare("SELECT status, result_json FROM job_actions WHERE id = ?").get(actions[0].id);
  expect(row.status).toBe("succeeded");
  expect(row.result_json).toContain("reconciled");
  // 已对账成功的动作不应再被真写（argv 中不出现它的 idempotency-key）
  expect(calls.filter((c) => c.includes(actions[0].idempotency_key)).length).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/write-phase.test.mjs`
Expected: FAIL（当前不做写前对账，executing 残留不被处理）

- [ ] **Step 3: 实现**（`write-phase.mjs` 全量替换为）

```js
import { actionsToExecute, markStatus } from "../safety/action-store.mjs";
import { executeApprovedAction, reconcileAction, loadApprovedHashes } from "./execute-action.mjs";

export async function reconcileStale(db, jobId, runLark) {
  const stale = db.prepare(
    "SELECT * FROM job_actions WHERE job_id = ? AND status IN ('executing','unknown')"
  ).all(jobId);
  for (const action of stale) {
    const r = await reconcileAction(db, { action, runLark });
    if (!r.reconciled) markStatus(db, action.id, "failed", JSON.stringify({ error: "reconcile_not_found" }));
  }
  return stale.length;
}

async function directExecute(db, jobId, { runLark, testTarget }) {
  const approved = loadApprovedHashes(db, jobId);
  const results = [];
  for (const action of actionsToExecute(db, jobId)) {
    const approvedHash = approved.get(action.action_key) ?? null;
    const r = await executeApprovedAction(db, { actionId: action.id, approvedHash, runLark, testTarget });
    results.push({ action_key: action.action_key, ...r });
  }
  return results;
}

export async function runWritePhase(db, jobId, { spawnPi, runLark, testTarget, timeoutMs = 240000 }) {
  await reconcileStale(db, jobId, runLark);
  try {
    await Promise.race([
      spawnPi(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("write phase timeout")), timeoutMs)),
    ]);
    const remaining = actionsToExecute(db, jobId);
    if (remaining.length > 0) {
      const results = await directExecute(db, jobId, { runLark, testTarget });
      return { mode: "pi", results };
    }
    return { mode: "pi", results: [] };
  } catch {
    const results = await directExecute(db, jobId, { runLark, testTarget });
    return { mode: "fallback", results };
  }
}
```

- [ ] **Step 4: 实现 `reconcile-startup.mjs` + 测试**

```js
import { reconcileAction } from "./execute-action.mjs";
import { markStatus } from "../safety/action-store.mjs";
import { updateJobStatus } from "../store/jobs.mjs";

export async function reconcileOnBoot(db, { runLark = null, now = () => Date.now() } = {}) {
  let reconciled = 0; let failed = 0;
  if (runLark) {
    const stale = db.prepare("SELECT * FROM job_actions WHERE status IN ('executing','unknown')").all();
    for (const action of stale) {
      const r = await reconcileAction(db, { action, runLark });
      if (r.reconciled) reconciled += 1;
      else { markStatus(db, action.id, "failed", JSON.stringify({ error: "reconcile_not_found_on_boot" })); failed += 1; }
    }
  }
  let jobsFinalized = 0;
  for (const j of db.prepare("SELECT id FROM orch_jobs WHERE status = 'running_write'").all()) {
    const rows = db.prepare("SELECT status FROM job_actions WHERE job_id = ?").all(j.id);
    const done = rows.length > 0 && rows.every((r) => r.status === "succeeded");
    updateJobStatus(db, j.id, done ? "done" : "partial_failed", now());
    jobsFinalized += 1;
  }
  for (const j of db.prepare("SELECT id FROM orch_jobs WHERE status IN ('running_readonly','queued')").all()) {
    updateJobStatus(db, j.id, "failed", now()); // 进程已死；可在 UI 重跑
    jobsFinalized += 1;
  }
  return { reconciled, failed, jobsFinalized };
}
```

`test/reconcile-startup.test.mjs`：三个用例——① executing 动作 + `task +list` 命中指纹 → `succeeded`、job `running_write` → `done`；② 未命中 → 动作 `failed`、job → `partial_failed`；③ `running_readonly` 残留 job → `failed`。

- [ ] **Step 5: `index.mjs` boot 接线**（在 `migrate(db)` 之后、`app.listen` 之前）

```js
import { reconcileOnBoot } from "./execute/reconcile-startup.mjs";
// ...
const bootLark = config.larkProfile ? makeRunLark({ profile: config.larkProfile }) : null;
const boot = await reconcileOnBoot(db, { runLark: config.enableWrite ? bootLark : null });
console.error(`[mstd] boot reconcile: ${JSON.stringify(boot)}`);
```

- [ ] **Step 6: 全量测试 + Commit**

Run: `cd mstd-orchestrator && npx vitest run` → 全绿。

```bash
git add mstd-orchestrator/server/execute/write-phase.mjs mstd-orchestrator/server/execute/reconcile-startup.mjs mstd-orchestrator/server/index.mjs mstd-orchestrator/test/write-phase.test.mjs mstd-orchestrator/test/reconcile-startup.test.mjs
git commit -m "feat(mstd): reconcile 接入运行时（写前对账 + 启动对账，消灭 dead code）"
```

---

### Task 5: 第①段真只读——`pi-ext/lark-read.ts` 接线（deny-by-default）+ draft_zh 挂载

现状：server 第①段挂的是自由 `args[]` + 黑名单的 `pi-ext/lark.ts`，且**没挂 `draft.ts`**（prompt 要卡片文案但模型没有 draft_zh 工具）。本任务把已写好的 `server/safety/lark-read.mjs` 白名单封装成 Pi 工具，替换第①段挂载，并顺手修 `providers.ts:39` 过期注释。

**Files:**
- Create: `mstd-orchestrator/pi-ext/lark-read.ts`
- Modify: `mstd-orchestrator/server/index.mjs`（extensions 列表）
- Modify: `mstd-orchestrator/server/jobs/orchestrator.mjs`（per-job 工作目录 + env）
- Modify: `mstd-orchestrator/server/jobs/templates.mjs`（prompt 点名工具）
- Modify: `mstd-orchestrator/pi-ext/providers.ts`（删"DeepSeek 是唯一支持 function-calling 主脑"过期注释，改为"DeepSeek 直连——备用主脑，网关不可用时兜底"）
- Test: `mstd-orchestrator/test/lark-read.test.mjs`（追加 read_file 路径用例，纯逻辑部分）

**Interfaces:**
- Produces: Pi 工具 `lark_read`，参数 `{op, minute_token?, query?, path?}`，`op ∈ search_minutes|get_transcript|search_user|read_file`；底层 argv 一律出自 `buildLarkReadArgs`（读操作）或 `resolveInsideWorkdir`（read_file，锁在 `MSTD_JOB_WORKDIR` 内）。
- Modifies: `runReadonlyPhase` 为每个 job 建工作目录 `<piCwd>/out/<jobId>`，Pi 子进程 `cwd` 与 `MSTD_JOB_WORKDIR` 都指向它（`get_transcript` 的 `--output-dir ./out` 落在 job 目录内）。

- [ ] **Step 1: 失败测试**（`test/lark-read.test.mjs` 追加——白名单不受 read_file 影响 & 越界拒绝复核）

```js
it("read_file 不进 lark-cli 白名单（buildLarkReadArgs 拒绝）", () => {
  expect(() => buildLarkReadArgs("read_file", { path: "out/a.txt" })).toThrow(/不允许/);
});
```

（read_file 由扩展本地处理，绝不能落到 lark-cli argv——这条测试锁死该边界。`resolveInsideWorkdir` 的越界拒绝已有测试，不重复。）

- [ ] **Step 2: 实现 `pi-ext/lark-read.ts`**

```ts
/**
 * Pi 扩展（仅第①段加载）：lark_read —— deny-by-default 只读白名单。
 * 读飞书走 buildLarkReadArgs 白名单；read_file 只读 job 工作目录内文件。无任何写能力。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildLarkReadArgs } from "../server/safety/lark-read.mjs";
import { resolveInsideWorkdir } from "../server/execute/job-workdir.mjs";

const LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");
const CLIP = 20000;

function runLark(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const profile = process.env.LARK_PROFILE;
    const finalArgs = profile ? ["--profile", profile, ...args] : args;
    const child = spawn(LARK_CLI, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code });
    });
  });
}

const clip = (s: string) => (s.length > CLIP ? s.slice(0, CLIP) + "\n...(截断)" : s);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lark_read",
    label: "Lark Read",
    description:
      "只读飞书（deny-by-default 白名单，无任何写能力）。op:\n" +
      "  search_minutes —— 搜我拥有的妙记\n" +
      "  get_transcript —— 导出逐字稿（必填 minute_token；文件落 ./out）\n" +
      "  search_user —— 按人名搜 open_id（必填 query）\n" +
      "  read_file —— 读工作目录内文件（必填 path，如 out/xxx.txt）",
    parameters: Type.Object({
      op: Type.String({ description: "search_minutes | get_transcript | search_user | read_file" }),
      minute_token: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      try {
        if (params.op === "read_file") {
          const workdir = process.env.MSTD_JOB_WORKDIR || process.cwd();
          const abs = resolveInsideWorkdir(workdir, params.path ?? "");
          return { content: [{ type: "text", text: clip(readFileSync(abs, "utf8")) }], details: { path: abs } };
        }
        const args = buildLarkReadArgs(params.op, params);
        const r = await runLark(args, signal);
        const body = r.code === 0 ? r.stdout || "(空输出)" : `exit=${r.code}\nSTDERR:\n${r.stderr}`;
        return { content: [{ type: "text", text: clip(body) }], details: { exitCode: r.code, argv: args } };
      } catch (e) {
        return { content: [{ type: "text", text: `拒绝/失败: ${e instanceof Error ? e.message : String(e)}` }], details: { error: String(e) } };
      }
    },
  });
}
```

- [ ] **Step 3: 第①段挂载切换 + per-job 工作目录**

`server/index.mjs` extensions 改为：

```js
extensions: [
  join(ROOT, "pi-ext", "providers.ts"),
  join(ROOT, "pi-ext", "lark-read.ts"),
  join(ROOT, "pi-ext", "draft.ts"),
],
```

`orchestrator.mjs` 的 `runReadonlyPhase` 中 `startPi(...)` 前加：

```js
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { jobWorkdir } from "../execute/job-workdir.mjs";
// startPi 调用前：
const workdir = jobWorkdir(join(piOptions.cwd ?? process.cwd(), "out"), job.id);
mkdirSync(workdir, { recursive: true });
```

`startPi` 参数改为 `cwd: workdir, env: { MSTD_JOB_WORKDIR: workdir }`（`startPi` 已支持 `env` 覆盖，经 `buildPiEnv` 白名单合并——`MSTD_JOB_WORKDIR` 属 overrides 直通）。

`templates.mjs` 的 `buildPrompt` 步骤行改为：

```js
"步骤：用 lark_read(op=search_minutes) 定位妙记 → lark_read(op=get_transcript) 导出、lark_read(op=read_file) 阅读逐字稿 → 抽取待办（负责人、事项、截止、建议 open_id——用 lark_read(op=search_user) 对齐、置信度）→ 用 draft_zh 生成审批卡文案。",
```

- [ ] **Step 4: 修 `providers.ts` 过期注释**（第 39 行附近，改为）

```ts
// DeepSeek 直连 —— 备用主脑（CZ 网关不可用时兜底；2026-07-09 起主脑已回归 cz-gpt/gpt-5.5）
```

- [ ] **Step 5: 全量测试 + 真机只读冒烟**

Run: `cd mstd-orchestrator && npx vitest run` → 全绿。
真机（需 `.env` 密钥齐全）：临时把 `supervisor/pi-smoke.mjs` 的扩展列表换成 `lark-read.ts`（该脚本只读冒烟），跑 `set -a; . ./.env; set +a; node supervisor/pi-smoke.mjs`，确认模型能经 `lark_read` 完成一次 `search_minutes`，且任何自由 args 尝试都被拒。把脚本的扩展改动保留（它本来就是验证第①段形态的）。

- [ ] **Step 6: Commit**

```bash
git add mstd-orchestrator/pi-ext/lark-read.ts mstd-orchestrator/pi-ext/providers.ts mstd-orchestrator/server/index.mjs mstd-orchestrator/server/jobs/orchestrator.mjs mstd-orchestrator/server/jobs/templates.mjs mstd-orchestrator/supervisor/pi-smoke.mjs mstd-orchestrator/test/lark-read.test.mjs
git commit -m "feat(mstd): 第①段切换 deny-by-default lark_read + 挂载 draft_zh（只读真只读）"
```

---

### Task 6: 审批编辑支持删条目（服务端：edited_items 全量重建 action 集）

现状：`recordActions` 是 INSERT-IGNORE——审批时缩减 `edited_items` 不会删掉旧动作，approve 仍会放行全部 `job_actions`。改为编辑时**先删后建**。

**Files:**
- Modify: `mstd-orchestrator/server/jobs/routes.mjs`（decision 的 `edited_items` 分支）
- Test: `mstd-orchestrator/test/decision-routes.test.mjs`（追加）

**Interfaces:**
- Modifies: `POST /api/jobs/:id/decision` 传 `edited_items` 时，`job_actions` 变为与 `edited_items` 一一对应（旧集合整体替换）；`edited_items: []` 返回 400（空清单应走驳回）。

- [ ] **Step 1: 失败测试**

```js
it("edited_items 缩减后 job_actions 同步缩减", async () => {
  // seed：awaiting_approval job + 2 items 的 draft/actions + 有效 approval token
  const res = await postDecision(app, jobId, { approve: true, decision_token: token, edited_items: [ITEM_A] }); // 只留 1 条
  expect(res.status).toBe(200);
  const n = db.prepare("SELECT COUNT(*) AS n FROM job_actions WHERE job_id = ?").get(jobId).n;
  expect(n).toBe(1);
});

it("edited_items 为空数组 → 400", async () => {
  const res = await postDecision(app, jobId, { approve: true, decision_token: token, edited_items: [] });
  expect(res.status).toBe(400);
});
```

（复用该测试文件既有的 app/seed/postDecision 辅助。）

- [ ] **Step 2: 跑测试确认失败** → Run: `npx vitest run test/decision-routes.test.mjs`，Expected: FAIL（count 仍为 2 / 空数组不报错）。

- [ ] **Step 3: 实现**（`routes.mjs` 的 `if (Array.isArray(edited_items))` 块改为）

```js
if (Array.isArray(edited_items)) {
  if (edited_items.length === 0) return res.status(400).json({ error: "动作清单为空：请直接驳回，不要批准空清单" });
  const cardText = db.prepare("SELECT card_text FROM job_draft WHERE job_id = ?").get(job.id)?.card_text ?? "(编辑)";
  let intent;
  try { intent = validateIntent({ card_text: cardText, items: edited_items }); }
  catch (err) { return res.status(400).json({ error: `编辑后的条目校验失败: ${err.reason ?? err.message}` }); }
  const actions = canonicalizeActions({ jobId: job.id, items: intent.items, enableNotify: TEMPLATES[job.template_id]?.enableNotify ?? false });
  db.prepare("DELETE FROM job_actions WHERE job_id = ?").run(job.id); // 编辑 = 全量替换（仅 awaiting_approval 状态可达此处）
  recordActions(db, job.id, actions);
  saveJobDraft(db, job.id, { cardText: intent.card_text, itemsJson: JSON.stringify(intent.items), actionSetJson: JSON.stringify(actions) });
}
```

- [ ] **Step 4: 全量测试 + Commit**

```bash
git add mstd-orchestrator/server/jobs/routes.mjs mstd-orchestrator/test/decision-routes.test.mjs
git commit -m "feat(mstd): 审批编辑全量重建 action 集（支持删条目，空清单拒批）"
```

---

### Task 7: 审批编辑器删条目（前端）

**Files:**
- Modify: `mstd-ui/src/views/ApprovalActionEditor.tsx`
- Test: `mstd-ui/src/test/approval-editor.test.tsx`（追加）

**Interfaces:**
- Modifies: `onApprove(edited)` 只收到未删除的条目；全部删除时"批准并真写"禁用并提示改走驳回。删除可撤销（按钮切换 删除/恢复）。

- [ ] **Step 1: 失败测试**

```tsx
it("删除条目后 onApprove 只提交剩余条目；全删则禁用批准", async () => {
  const onApprove = vi.fn();
  render(<ApprovalActionEditor actions={[ACTION_A, ACTION_B]} onApprove={onApprove} onReject={() => {}} />);
  fireEvent.click(screen.getAllByRole("button", { name: "删除" })[1]); // 删 B
  fireEvent.click(screen.getByRole("button", { name: "批准并真写" }));
  expect(onApprove).toHaveBeenCalledWith([expect.objectContaining({ action_key: ACTION_A.action_key })]);
  fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]); // 再删 A（对剩余列表）
  expect(screen.getByRole("button", { name: "批准并真写" })).toBeDisabled();
  expect(screen.getByText(/全部删除请直接驳回/)).toBeTruthy();
});
```

（`ACTION_A/B` 沿用该文件已有的 fixture 写法：合法 `ou_` 开头 open_id、`requires_open_id: false`。）

- [ ] **Step 2: 跑测试确认失败** → `cd mstd-ui && npx vitest run src/test/approval-editor.test.tsx`

- [ ] **Step 3: 实现**（`ApprovalActionEditor.tsx` 增量修改）

```tsx
const [removed, setRemoved] = useState<Set<string>>(new Set());
const kept = actions.filter((a) => !removed.has(a.action_key));

const canApprove = useMemo(
  () => kept.length > 0 && kept.every((a) => !a.requires_open_id || isValidOpenId(openIds[a.action_key])),
  [kept, openIds]
);

function toggleRemoved(key: string) {
  setRemoved((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
}

function submitApprove() {
  const edited = kept.map((a) => ({
    ...a,
    target_open_id: openIds[a.action_key] || a.target_open_id,
    payload: { ...a.payload, assignee_open_id: openIds[a.action_key] || a.payload.assignee_open_id },
  }));
  onApprove(edited);
}
```

每个 `<li className="action-item">` 内（`action-head` 里徽标旁）加：

```tsx
<button type="button" className="ghost" onClick={() => toggleRemoved(a.action_key)}>
  {removed.has(a.action_key) ? "恢复" : "删除"}
</button>
```

被删条目整体加类名 `action-item removed`（CSS 里 `.action-item.removed { opacity: .45; text-decoration: line-through; }`，加到 `mstd-ui/src/styles.css`），且其 open_id 输入禁用、不参与 `canApprove`。按钮区下方加：

```tsx
{kept.length === 0 && <small className="hint">已全部删除：全部删除请直接驳回</small>}
```

- [ ] **Step 4: 全量测试 + Commit**

Run: `cd mstd-ui && npx vitest run` → 全绿。

```bash
git add mstd-ui/src/views/ApprovalActionEditor.tsx mstd-ui/src/styles.css mstd-ui/src/test/approval-editor.test.tsx
git commit -m "feat(mstd): 审批编辑器支持删条目/恢复（全删禁批走驳回）"
```

---

### Task 8: 前端断线自动重连（seq 跟踪 + sinceSeq 续传）

**Files:**
- Modify: `mstd-ui/src/api/job-stream.ts`
- Test: `mstd-ui/src/test/job-stream.test.ts`（追加）

**Interfaces:**
- Modifies: `parseSseBlock` 识别 `id:` 行，产出 `JobStreamEvent = { event, data, seq?: number }`。
- Modifies: `openJobStream(jobId, { onEvent, onDone, onError, signal, isTerminal? })`：网络中断/流意外关闭时自动重连（最多 5 次，1s/2s/3s/4s/5s 退避），重连 URL 带 `?sinceSeq=<lastSeq>`；`isTerminal` 默认 `(e) => e.event === "message_done"`（保持现行为），`error` 事件恒为终止。Task 9 依赖 `isTerminal`。

- [ ] **Step 1: 失败测试**

```ts
it("parseSseBlock 解析 id 行为 seq", () => {
  const evt = parseSseBlock("id: 7\nevent: tool_start\ndata: {\"toolName\":\"lark_read\"}");
  expect(evt).toEqual({ event: "tool_start", data: { toolName: "lark_read" }, seq: 7 });
});

it("流中断后自动带 sinceSeq 重连并续传到终止", async () => {
  const urls: string[] = [];
  // 第一次连接：吐 seq=1 的事件后异常断流；第二次连接：吐 message_done
  mockFetchSequence(urls, [
    { blocks: ["id: 1\nevent: tool_start\ndata: {}"], abort: true },
    { blocks: ["id: 2\nevent: message_done\ndata: {}"] },
  ]);
  const seen: string[] = [];
  await openJobStream("j1", { onEvent: (e) => seen.push(e.event), onDone: () => seen.push("DONE"), onError: () => seen.push("ERR") });
  expect(urls[1]).toContain("sinceSeq=1");
  expect(seen).toEqual(["tool_start", "message_done", "DONE"]);
});
```

（`mockFetchSequence` 是测试内辅助：`vi.stubGlobal("fetch", ...)` 依次返回手工构造的 `ReadableStream`，第一段在写完 blocks 后 `controller.error(new Error("net"))` 模拟断流。该文件已有手写 stream 的 mock 套路，照抄扩展。）

- [ ] **Step 2: 跑测试确认失败** → `cd mstd-ui && npx vitest run src/test/job-stream.test.ts`

- [ ] **Step 3: 实现**（`job-stream.ts` 全量替换）

```ts
import { authHeaders } from "./auth";

export type JobStreamEvent = { event: string; data: Record<string, unknown>; seq?: number };

export function parseSseBlock(block: string): JobStreamEvent | null {
  let event = "message";
  let seq: number | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) { const n = Number(line.slice(3).trim()); if (Number.isFinite(n)) seq = n; }
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const evt: JobStreamEvent = { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  if (seq !== undefined) evt.seq = seq;
  return evt;
}

const MAX_RETRIES = 5;

export async function openJobStream(
  jobId: string,
  { onEvent, onDone, onError, signal, isTerminal = (e: JobStreamEvent) => e.event === "message_done" }: {
    onEvent: (e: JobStreamEvent) => void;
    onDone: () => void;
    onError: (err: Error) => void;
    signal?: AbortSignal;
    isTerminal?: (e: JobStreamEvent) => boolean;
  }
): Promise<void> {
  let lastSeq = -1;
  let attempt = 0;
  for (;;) {
    try {
      const qs = lastSeq >= 0 ? `?sinceSeq=${lastSeq}` : "";
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stream${qs}`, {
        headers: { Accept: "text/event-stream", ...authHeaders() },
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream 打开失败 (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const evt = parseSseBlock(block);
          if (!evt) continue;
          if (evt.seq !== undefined) lastSeq = evt.seq;
          attempt = 0; // 有数据 = 连接健康，重置退避
          onEvent(evt);
          if (evt.event === "error") {
            await reader.cancel().catch(() => undefined);
            onError(new Error(String(evt.data.text ?? evt.data.raw ?? "error")));
            return;
          }
          if (isTerminal(evt)) {
            await reader.cancel().catch(() => undefined);
            onDone();
            return;
          }
        }
      }
      throw new Error("stream 意外关闭"); // 服务端不主动关流；关了就当断线重连
    } catch (err) {
      if (signal?.aborted) { onError(new Error("aborted")); return; }
      attempt += 1;
      if (attempt > MAX_RETRIES) { onError(err instanceof Error ? err : new Error(String(err))); return; }
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
}
```

- [ ] **Step 4: 全量测试 + Commit**

Run: `cd mstd-ui && npx vitest run` → 全绿（既有 job-stream 用例若依赖"读尽即 onDone"的旧行为，按新契约改为以 `message_done` 收尾的流）。

```bash
git add mstd-ui/src/api/job-stream.ts mstd-ui/src/test/job-stream.test.ts
git commit -m "feat(mstd): 前端 SSE 断线自动重连（seq 跟踪 + sinceSeq 续传 + 退避）"
```

---

### Task 9: 中止按钮 + 写阶段实时跟踪（approve 后继续看流直到 done/partial_failed）

**Files:**
- Modify: `mstd-ui/src/api/jobs.ts`（`postDecision` 返回类型）
- Modify: `mstd-ui/src/App.tsx`（onApprove 接写阶段流、onAbort）
- Modify: `mstd-ui/src/views/WorkspaceView.tsx`（中止按钮）
- Test: `mstd-ui/src/test/workspace.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 3 的 decision 响应 `{ ok, status: "running_write" }` / `{ ok, status: "approved", writeGated: true }`；Task 8 的 `isTerminal` 选项。
- Produces: `WorkspaceView` 新 props `onAbort: () => void`（`running` 时显示"中止"按钮）。

- [ ] **Step 1: 失败测试**

```tsx
it("running 时显示中止按钮并回调 onAbort", () => {
  const onAbort = vi.fn();
  render(<WorkspaceView {...baseProps} running={true} onAbort={onAbort} />);
  fireEvent.click(screen.getByRole("button", { name: "中止" }));
  expect(onAbort).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败** → `cd mstd-ui && npx vitest run src/test/workspace.test.tsx`

- [ ] **Step 3: 实现**

`jobs.ts`：

```ts
export const postDecision = (
  id: string,
  body: { approve: boolean; edited_items?: unknown[]; note?: string; decision_token: string }
) => apiFetch<{ ok: boolean; status: string; writeGated?: boolean }>(
  `/api/jobs/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(body) });
```

`WorkspaceView.tsx`：props 加 `onAbort: () => void;`，触发按钮旁加：

```tsx
{running && <button className="ghost" type="button" onClick={onAbort}>中止</button>}
```

`App.tsx` 的 `onApprove` 改为：

```tsx
const WRITE_TERMINAL = new Set(["done", "partial_failed", "failed", "aborted"]);

async function onApprove(edited: ActionDraft[]) {
  if (!activeJobId || !approvalToken) return;
  const jobId = activeJobId;
  const edited_items = edited.map((a) => ({
    owner_name: String(a.payload.owner_name ?? "负责人"),
    task: String(a.payload.title ?? a.payload.task ?? ""),
    due: (a.payload.due as string | null) ?? null,
    suggested_open_id: (a.payload.assignee_open_id as string | null) ?? a.target_open_id,
    confidence: a.requires_open_id ? "low" : "high",
  }));
  const res = await postDecision(jobId, { approve: true, edited_items, decision_token: approvalToken });
  setDraft(null);
  setActions([]);
  refreshJobs();
  if (res.status === "running_write" && !res.writeGated) {
    setRunning(true);
    await openJobStream(jobId, {
      onEvent: (e) => setLog((prev) => reduceJobEvent(prev, e as SseEvent)),
      isTerminal: (e) => e.event === "job_status" && WRITE_TERMINAL.has(String((e.data as { status?: string }).status)),
      onDone: () => { setRunning(false); refreshJobs(); },
      onError: () => { setRunning(false); refreshJobs(); },
    });
  }
}
```

`App.tsx` 加：

```tsx
async function onAbort() {
  if (!activeJobId) return;
  try { await abortJob(activeJobId); } finally { setRunning(false); refreshJobs(); }
}
```

（`abortJob` 从 `./api/jobs` 补进 import；`WorkspaceView` 传 `onAbort={() => { void onAbort(); }}`。）

注意：中止后服务端发布 `job_status: aborted`（带 seq，会被写进 `job_events`），读阶段流的默认 `isTerminal` 是 `message_done`——被 abort 的 Pi 不会发 `message_done`，流靠 `onAbort` 里 `setRunning(false)` 收场即可；写阶段流的 `WRITE_TERMINAL` 已含 `aborted`。

- [ ] **Step 4: 全量测试 + Commit**

Run: `cd mstd-ui && npx vitest run` → 全绿。

```bash
git add mstd-ui/src/api/jobs.ts mstd-ui/src/App.tsx mstd-ui/src/views/WorkspaceView.tsx mstd-ui/src/test/workspace.test.tsx
git commit -m "feat(mstd): 中止按钮 + 审批后实时跟踪写阶段至终态"
```

---

### Task 10: `orch_events` 迁移（migrate 多文件化）+ 触发事件幂等存储

**Files:**
- Modify: `mstd-orchestrator/server/db/index.mjs`（migrate 扫描目录）
- Create: `mstd-orchestrator/server/db/migrations/002_orch_events.sql`
- Create: `mstd-orchestrator/server/triggers/ingest.mjs`
- Test: `mstd-orchestrator/test/trigger-ingest.test.mjs`（新建）

**Interfaces:**
- Produces: 表 `orch_events(id PK, event_key, event_id UNIQUE, dedupe_key UNIQUE, job_id, payload_json, ts)`。
- Produces: `recordTriggerEvent(db, { eventKey, eventId, dedupeKey, payloadJson?, ts? }) -> { fresh: boolean }`（`event_id` 或 `dedupe_key` 任一撞 UNIQUE 即 `fresh:false`）；`bindTriggerJob(db, eventId, jobId)`。Task 11/12/13 依赖。

- [ ] **Step 1: 失败测试**

```js
import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { recordTriggerEvent, bindTriggerJob } from "../server/triggers/ingest.mjs";

describe("trigger ingest 幂等", () => {
  it("同 event_id 二次插入 fresh=false；同 dedupe_key 不同 event_id 也 fresh=false", () => {
    const db = openDb(":memory:"); migrate(db);
    const a = recordTriggerEvent(db, { eventKey: "minutes.minute.generated_v1", eventId: "e1", dedupeKey: "minutes:m1" });
    const b = recordTriggerEvent(db, { eventKey: "minutes.minute.generated_v1", eventId: "e1", dedupeKey: "minutes:m1" });
    const c = recordTriggerEvent(db, { eventKey: "minutes.minute.generated_v1", eventId: "e2", dedupeKey: "minutes:m1" });
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(false);
    expect(c.fresh).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run test/trigger-ingest.test.mjs`

- [ ] **Step 3: 实现**

`002_orch_events.sql`：

```sql
CREATE TABLE IF NOT EXISTS orch_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_id TEXT UNIQUE,
  dedupe_key TEXT UNIQUE,
  job_id TEXT REFERENCES orch_jobs(id),
  payload_json TEXT,
  ts BIGINT NOT NULL
);
```

`db/index.mjs` 的 `migrate` 改为：

```js
import { readdirSync } from "node:fs";
export function migrate(db) {
  const dir = join(HERE, "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
}
```

（迁移全部 `IF NOT EXISTS`，天然可重放，v1 不建 bookkeeping 表。）

`server/triggers/ingest.mjs`：

```js
import { randomUUID } from "node:crypto";

// ON CONFLICT DO NOTHING（无目标列）同时覆盖 event_id / dedupe_key 两个 UNIQUE，SQLite ≥3.24 与 Postgres 语法一致。
export function recordTriggerEvent(db, { eventKey, eventId, dedupeKey, payloadJson = null, ts = Date.now() }) {
  const r = db.prepare(
    "INSERT INTO orch_events (id, event_key, event_id, dedupe_key, job_id, payload_json, ts) VALUES (?,?,?,?,NULL,?,?) ON CONFLICT DO NOTHING"
  ).run(randomUUID(), eventKey, eventId, dedupeKey, payloadJson, ts);
  return { fresh: r.changes === 1 };
}

export function bindTriggerJob(db, eventId, jobId) {
  db.prepare("UPDATE orch_events SET job_id = ? WHERE event_id = ?").run(jobId, eventId);
}
```

- [ ] **Step 4: 全量测试 + Commit**

```bash
git add mstd-orchestrator/server/db/index.mjs mstd-orchestrator/server/db/migrations/002_orch_events.sql mstd-orchestrator/server/triggers/ingest.mjs mstd-orchestrator/test/trigger-ingest.test.mjs
git commit -m "feat(mstd): orch_events 幂等事件表 + migrate 多文件化"
```

---

### Task 11: job 启动器抽取（launcher）——手动路由与自动触发共用一条入队/并发路径

**Files:**
- Create: `mstd-orchestrator/server/jobs/launcher.mjs`
- Modify: `mstd-orchestrator/server/jobs/routes.mjs`（改用 launcher）
- Modify: `mstd-orchestrator/server/app.mjs` + `mstd-orchestrator/server/index.mjs`（组装传递）
- Test: `mstd-orchestrator/test/launcher.test.mjs`（新建）

**Interfaces:**
- Produces: `createJobLauncher({ db, config, startPi, semaphore, bus, buffer, registry, extensions, piCwd, now }) -> { submit({ templateId, params?, createdBy?, title? }) -> jobRow, queueLength }`。`submit` 语义与现 `POST /api/jobs` 完全一致（并发满 → `queued` 入队，释放时 pump）。Task 12/13 依赖 `submit`。
- Modifies: `mountJobRoutes` 兼容旧 ctx：`const launcher = ctx.launcher ?? createJobLauncher(ctx);`（既有测试零改动）。

- [ ] **Step 1: 失败测试**

```js
it("submit 超并发入队，release 后自动 pump", async () => {
  const sem = createSemaphore(1);
  const ran = [];
  const startPi = () => fakePiClient(ran); // 复用 jobs-routes 测试里的 fake（记录跑过的 job，立即完成）
  const launcher = createJobLauncher({ db, config: { pi: {} }, startPi, semaphore: sem, bus, buffer, registry, extensions: [] });
  const j1 = launcher.submit({ templateId: "meeting_to_task", params: {} });
  const j2 = launcher.submit({ templateId: "meeting_to_task", params: {} });
  expect(j1.status).toBe("running_readonly");
  expect(j2.status).toBe("queued");
  await waitFor(() => db.prepare("SELECT status FROM orch_jobs WHERE id = ?").get(j2.id).status !== "queued");
});

it("未知模板抛错", () => {
  expect(() => launcher.submit({ templateId: "nope" })).toThrow(/未知模板/);
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run test/launcher.test.mjs`

- [ ] **Step 3: 实现 `launcher.mjs`**

```js
import { createJob, getJobRow } from "../store/jobs.mjs";
import { runReadonlyPhase } from "./orchestrator.mjs";
import { TEMPLATES } from "./templates.mjs";

export function createJobLauncher({ db, config, startPi, semaphore, bus, buffer, registry, extensions = [], piCwd, now = () => Date.now() }) {
  const queue = [];

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
  function submit({ templateId, params = {}, createdBy = null, title = null }) {
    if (!TEMPLATES[templateId]) throw new Error(`未知模板: ${templateId}`);
    const canRun = semaphore.tryAcquire();
    const status = canRun ? "running_readonly" : "queued";
    const job = createJob(db, {
      templateId,
      title: title ?? params.title ?? TEMPLATES[templateId].title,
      paramsJson: JSON.stringify(params), status, createdBy,
    }, now());
    if (canRun) launch(job.id).catch(() => { /* 内部已落 failed */ });
    else queue.push(job.id);
    return job;
  }
  return { submit, get queueLength() { return queue.length; } };
}
```

- [ ] **Step 4: routes 改用 launcher**（`routes.mjs` 删掉本地 `queue/launch/pump`，`mountJobRoutes` 开头改）

```js
import { createJobLauncher } from "./launcher.mjs";
// mountJobRoutes 内：
const launcher = ctx.launcher ?? createJobLauncher(ctx);
```

`POST /api/jobs` 主体改为：

```js
app.post("/api/jobs", requireUser, (req, res) => {
  const { templateId, params = {} } = req.body ?? {};
  if (!TEMPLATES[templateId]) return res.status(400).json({ error: `未知模板: ${templateId}` });
  const job = launcher.submit({ templateId, params, createdBy: req.user.id });
  res.status(201).json({ jobId: job.id, status: job.status });
});
```

`return { queue }` 改为 `return { launcher }`。`index.mjs` 建一个共享 launcher（与 createApp 同一组依赖）传入 `createApp({ ..., launcher })`，`app.mjs` 透传 `launcher: deps.launcher`——同一个实例后续给 Task 12/13 用。

- [ ] **Step 5: 全量测试 + Commit**

Run: `cd mstd-orchestrator && npx vitest run` → 全绿（jobs-routes 既有用例经 `ctx.launcher ?? createJobLauncher(ctx)` 兼容不动）。

```bash
git add mstd-orchestrator/server/jobs/launcher.mjs mstd-orchestrator/server/jobs/routes.mjs mstd-orchestrator/server/app.mjs mstd-orchestrator/server/index.mjs mstd-orchestrator/test/launcher.test.mjs
git commit -m "refactor(mstd): 抽取 job launcher，手动触发与事件触发共用并发/入队路径"
```

---

### Task 12: 妙记事件消费 daemon（`minutes.minute.generated_v1` 自动建 job）

已真机核实：`lark-cli event consume minutes.minute.generated_v1 --as user` 输出 NDJSON，每行含 `event_id`（官方注明 safe for deduplication）、`minute_token`、`title`；需应用后台开通该事件 + scope `minutes:minutes.basic:read`（profile `user613148` 既有链路已验证过妙记读取）。

**Files:**
- Create: `mstd-orchestrator/server/triggers/minutes-consumer.mjs`
- Modify: `mstd-orchestrator/server/config.mjs`（`enableTrigger`）
- Modify: `mstd-orchestrator/server/index.mjs`（启动消费）
- Test: `mstd-orchestrator/test/minutes-consumer.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 10 `recordTriggerEvent/bindTriggerJob`；Task 11 `launcher.submit`。
- Produces: `startMinutesConsumer({ db, launcher, larkCli, profile, spawnFn?, restartDelayMs?, now?, log? }) -> { stop(), handleLine(line) }`（`handleLine` 导出供测试直接灌行）。
- Produces: config 新字段 `enableTrigger: env.MSTD_ENABLE_TRIGGER === "1"`。

- [ ] **Step 1: 失败测试**

```js
import { describe, it, expect, vi } from "vitest";
import { startMinutesConsumer } from "../server/triggers/minutes-consumer.mjs";

function fakeSpawn() { // 不产出任何行的假子进程，测试用 handleLine 直接灌
  return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {} };
}

describe("minutes consumer", () => {
  it("同 event_id / 同 minute_token 只建一个 job；坏行不炸", () => {
    const db = freshDb(); // openDb(':memory:') + migrate
    const submitted = [];
    const launcher = { submit: (o) => { const j = { id: `job${submitted.length + 1}` }; submitted.push(o); return j; } };
    const c = startMinutesConsumer({ db, launcher, larkCli: "lark-cli", spawnFn: fakeSpawn, log: () => {} });
    c.handleLine(JSON.stringify({ event_id: "e1", minute_token: "m1", title: "周会" }));
    c.handleLine(JSON.stringify({ event_id: "e1", minute_token: "m1", title: "周会" })); // 重复事件
    c.handleLine(JSON.stringify({ event_id: "e2", minute_token: "m1", title: "周会" })); // 同妙记重推
    c.handleLine("not json {{{");                                                      // 坏行
    expect(submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({ templateId: "meeting_to_task", params: { minute_token: "m1" } });
    const bound = db.prepare("SELECT job_id FROM orch_events WHERE event_id = 'e1'").get();
    expect(bound.job_id).toBe("job1");
    c.stop();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run test/minutes-consumer.test.mjs`

- [ ] **Step 3: 实现 `minutes-consumer.mjs`**

```js
import { spawn } from "node:child_process";
import { recordTriggerEvent, bindTriggerJob } from "./ingest.mjs";

export const MINUTES_EVENT_KEY = "minutes.minute.generated_v1";

export function startMinutesConsumer({ db, launcher, larkCli, profile = "", spawnFn = spawn, restartDelayMs = 5000, now = () => Date.now(), log = console.error }) {
  let stopped = false;
  let child = null;
  let timer = null;

  function handleLine(line) {
    const s = line.trim();
    if (!s) return;
    let evt;
    try { evt = JSON.parse(s); } catch { log(`[trigger] 无法解析事件行: ${s.slice(0, 200)}`); return; }
    const minuteToken = evt.minute_token;
    const eventId = evt.event_id;
    if (!minuteToken || !eventId) return;
    const { fresh } = recordTriggerEvent(db, {
      eventKey: MINUTES_EVENT_KEY, eventId, dedupeKey: `minutes:${minuteToken}`, payloadJson: s, ts: now(),
    });
    if (!fresh) return;
    try {
      const job = launcher.submit({ templateId: "meeting_to_task", params: { minute_token: minuteToken }, title: `[自动] ${evt.title ?? minuteToken}` });
      bindTriggerJob(db, eventId, job.id);
      log(`[trigger] 妙记 ${minuteToken} → job ${job.id}`);
    } catch (e) {
      log(`[trigger] 建 job 失败: ${e?.message ?? e}`);
    }
  }

  function run() {
    if (stopped) return;
    const args = [];
    if (profile) args.push("--profile", profile);
    args.push("event", "consume", MINUTES_EVENT_KEY, "--as", "user", "--quiet");
    child = spawnFn(larkCli, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on("data", (d) => log(`[trigger-stderr] ${String(d).trimEnd()}`));
    child.on("error", (e) => log(`[trigger] spawn 失败: ${e}`));
    child.on("close", (code) => {
      if (stopped) return;
      log(`[trigger] consumer 退出(code=${code})，${restartDelayMs}ms 后重启`);
      timer = setTimeout(run, restartDelayMs);
      if (timer.unref) timer.unref();
    });
  }

  run();
  return {
    handleLine,
    stop() { stopped = true; if (timer) clearTimeout(timer); try { child?.kill("SIGTERM"); } catch { /* 已退出 */ } },
  };
}
```

- [ ] **Step 4: config + index 接线**

`config.mjs` 返回对象加：`enableTrigger: String(env.MSTD_ENABLE_TRIGGER ?? "") === "1",`。

`index.mjs`（launcher 建好后）：

```js
import { startMinutesConsumer } from "./triggers/minutes-consumer.mjs";
import { DEFAULT_LARK_CLI } from "./execute/run-lark.mjs";
// ...
if (config.enableTrigger && config.larkProfile) {
  startMinutesConsumer({ db, launcher, larkCli: DEFAULT_LARK_CLI, profile: config.larkProfile });
  console.error(`[mstd] trigger consumer on (${config.larkProfile})`);
}
```

- [ ] **Step 5: 全量测试 + Commit**

```bash
git add mstd-orchestrator/server/triggers/minutes-consumer.mjs mstd-orchestrator/server/config.mjs mstd-orchestrator/server/index.mjs mstd-orchestrator/test/minutes-consumer.test.mjs
git commit -m "feat(mstd): 妙记生成事件长连接消费，event_id/minute_token 双幂等自动建 job"
```

---

### Task 13: 断档回扫（启动时补扫漏掉的妙记）

**Files:**
- Create: `mstd-orchestrator/server/triggers/backfill.mjs`
- Modify: `mstd-orchestrator/server/config.mjs`（`backfill`）+ `mstd-orchestrator/server/index.mjs`
- Test: `mstd-orchestrator/test/backfill.test.mjs`（新建）

**Interfaces:**
- Consumes: `recordTriggerEvent`（合成 `event_id = "backfill:<minute_token>"`，稳定值——重复回扫自身也幂等；`dedupe_key` 与实时事件同为 `minutes:<token>`，故两条来源互斥不重复建 job）、`launcher.submit`、`makeRunLark`。
- Produces: `backfillMinutes({ db, launcher, runLark, limit?, now?, log? }) -> Promise<{created: number}>`。

- [ ] **Step 1: 失败测试**

```js
it("回扫为未见过的妙记建 job，已消费过的（同 dedupe_key）跳过", async () => {
  const db = freshDb();
  // 预置：m1 已被实时事件消费过
  recordTriggerEvent(db, { eventKey: MINUTES_EVENT_KEY, eventId: "e1", dedupeKey: "minutes:m1" });
  const submitted = [];
  const launcher = { submit: (o) => { submitted.push(o); return { id: `j${submitted.length}` }; } };
  const runLark = async () => ({ exitCode: 0, stdout: JSON.stringify({ items: [
    { minute_token: "m1", title: "老会" }, { minute_token: "m2", title: "新会" },
  ] }), stderr: "" });
  const out = await backfillMinutes({ db, launcher, runLark, log: () => {} });
  expect(out.created).toBe(1);
  expect(submitted[0].params.minute_token).toBe("m2");
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run test/backfill.test.mjs`

- [ ] **Step 3: 真机核实 `minutes +search` 输出字段**（编码前置——不许猜 JSON 形状）

Run: `~/.hermes/node/bin/lark-cli --profile user613148 minutes +search --owner-ids me --as user | head -40`
记录真实字段名（`minute_token` 还是 `token`、列表键是不是 `items`）。**若与下面代码假设不符，按真机结果改 `backfill.mjs` 的解析行与测试 fixture**，并把真实样例（脱敏）留在测试文件注释里。

- [ ] **Step 4: 实现 `backfill.mjs`**

```js
import { recordTriggerEvent, bindTriggerJob } from "./ingest.mjs";
import { MINUTES_EVENT_KEY } from "./minutes-consumer.mjs";

export async function backfillMinutes({ db, launcher, runLark, limit = 10, now = () => Date.now(), log = console.error }) {
  const r = await runLark(["minutes", "+search", "--owner-ids", "me", "--as", "user"]);
  if (r.exitCode !== 0) { log(`[backfill] minutes 搜索失败: ${r.stderr.slice(0, 300)}`); return { created: 0 }; }
  let items = [];
  try {
    const parsed = JSON.parse(r.stdout || "{}");
    items = Array.isArray(parsed.items) ? parsed.items : []; // 字段名以 Step 3 真机核实为准
  } catch { log("[backfill] 输出非 JSON，跳过"); return { created: 0 }; }
  let created = 0;
  for (const it of items.slice(0, limit)) {
    const token = it.minute_token ?? it.token;
    if (!token) continue;
    const eventId = `backfill:${token}`;
    const { fresh } = recordTriggerEvent(db, {
      eventKey: MINUTES_EVENT_KEY, eventId, dedupeKey: `minutes:${token}`,
      payloadJson: JSON.stringify(it), ts: now(),
    });
    if (!fresh) continue;
    const job = launcher.submit({ templateId: "meeting_to_task", params: { minute_token: token }, title: `[回扫] ${it.title ?? token}` });
    bindTriggerJob(db, eventId, job.id);
    created += 1;
  }
  if (created > 0) log(`[backfill] 回扫补建 ${created} 个 job`);
  return { created };
}
```

- [ ] **Step 5: config + index 接线**

`config.mjs` 加：`backfill: String(env.MSTD_BACKFILL ?? "") === "1",`。
`index.mjs`（trigger 启动后）：

```js
import { backfillMinutes } from "./triggers/backfill.mjs";
if (config.enableTrigger && config.backfill && config.larkProfile) {
  backfillMinutes({ db, launcher, runLark: bootLark }).catch((e) => console.error(`[backfill] ${e}`));
}
```

- [ ] **Step 6: 全量测试 + Commit**

```bash
git add mstd-orchestrator/server/triggers/backfill.mjs mstd-orchestrator/server/config.mjs mstd-orchestrator/server/index.mjs mstd-orchestrator/test/backfill.test.mjs
git commit -m "feat(mstd): 启动断档回扫（backfill:<token> 合成事件，双幂等不重建）"
```

---

### Task 14: lark profile 健康检查 + 告警（`auth status` 定时探测）

已核实 `lark-cli auth status` 存在（"View current auth status"）。凭据管理本身仍归 lark-cli（完整 token manager 属服务器迁移计划 Phase 3，见非目标）；本任务只做**失效及时发现 + 告警**。

**Files:**
- Create: `mstd-orchestrator/server/health/lark-profile.mjs`
- Modify: `mstd-orchestrator/server/app.mjs`（`GET /api/health/lark`）
- Modify: `mstd-orchestrator/server/config.mjs`（`alertOpenId`）+ `mstd-orchestrator/server/index.mjs`
- Test: `mstd-orchestrator/test/lark-health.test.mjs`（新建）

**Interfaces:**
- Produces: `startLarkHealth({ runLark, intervalMs?, alert?, log?, setIntervalFn? }) -> { checkOnce(now?) -> Promise<{ok, ts, detail}>, last, stop() }`；只在 ok→fail 的**边沿**触发一次 alert（不重复轰炸）。
- Produces: `makeDmAlert({ runLark, openId }) -> (detail) => Promise<void>`（`im +messages-send --as bot` 发提醒；`MSTD_ALERT_OPEN_ID` 未配则为 null 不发）。
- Produces: `GET /api/health/lark -> { ok, ts, detail }`（免登录，同 `/api/health`）。

- [ ] **Step 1: 失败测试**

```js
import { describe, it, expect, vi } from "vitest";
import { startLarkHealth } from "../server/health/lark-health-import-fix.mjs"; // 路径见下，实际为 ../server/health/lark-profile.mjs

describe("lark health", () => {
  it("auth status 失败 → last.ok=false，且仅在边沿告警一次", async () => {
    const alert = vi.fn(async () => {});
    let healthy = true;
    const runLark = async () => healthy
      ? { exitCode: 0, stdout: "logged in", stderr: "" }
      : { exitCode: 1, stdout: "", stderr: "token expired" };
    const h = startLarkHealth({ runLark, alert, log: () => {}, setIntervalFn: () => ({ unref() {} }) });
    await h.checkOnce();
    expect(h.last.ok).toBe(true);
    healthy = false;
    await h.checkOnce();
    await h.checkOnce(); // 连续失败第二次
    expect(h.last.ok).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1); // 只在 ok→fail 边沿发一次
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run test/lark-health.test.mjs`

- [ ] **Step 3: 实现 `server/health/lark-profile.mjs`**

```js
export function startLarkHealth({ runLark, intervalMs = 10 * 60 * 1000, alert = null, log = console.error, setIntervalFn = setInterval }) {
  let last = { ok: null, ts: 0, detail: "" };
  async function checkOnce(now = Date.now()) {
    const r = await runLark(["auth", "status"]);
    const text = `${r.stdout}\n${r.stderr}`;
    const ok = r.exitCode === 0 && !/expired|unauthorized|not logged in|invalid/i.test(text);
    const wasOk = last.ok;
    last = { ok, ts: now, detail: ok ? "" : text.trim().slice(0, 500) };
    if (!ok && wasOk !== false) { // 边沿触发：首查即坏(null→false)或 ok→fail
      log(`[health] lark profile 异常: ${last.detail}`);
      if (alert) await alert(last.detail).catch((e) => log(`[health] 告警发送失败: ${e}`));
    }
    if (ok && wasOk === false) log("[health] lark profile 已恢复");
    return last;
  }
  const timer = setIntervalFn(() => { checkOnce().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
  return { checkOnce, get last() { return last; }, stop() { clearInterval(timer); } };
}

export function makeDmAlert({ runLark, openId }) {
  if (!openId) return null;
  return async (detail) => {
    await runLark([
      "im", "+messages-send", "--as", "bot", "--user-id", openId,
      "--msg-type", "text", "--content", JSON.stringify({ text: `⚠️ mstd：lark profile 健康检查失败\n${detail}` }),
    ]);
  };
}
```

（发送前先真机 `--dry-run` 核实 `im +messages-send` 的 `--content` text 格式；若与 `{"text":...}` 假设不符按真机改。）

- [ ] **Step 4: 接线**

`config.mjs` 加：`alertOpenId: String(env.MSTD_ALERT_OPEN_ID ?? "").trim(),`。

`index.mjs`：

```js
import { startLarkHealth, makeDmAlert } from "./health/lark-profile.mjs";
let larkHealth = null;
if (config.larkProfile) {
  larkHealth = startLarkHealth({
    runLark: bootLark,
    alert: makeDmAlert({ runLark: bootLark, openId: config.alertOpenId }),
  });
  larkHealth.checkOnce().catch(() => {});
}
```

`app.mjs` 在 `/api/health` 旁加：

```js
app.get("/api/health/lark", (_req, res) => {
  const h = deps.larkHealth?.last ?? { ok: null, ts: 0, detail: "未启用（无 larkProfile）" };
  res.json(h);
});
```

（`index.mjs` 把 `larkHealth` 放进 createApp deps。注意该路由要放在 `bearerAuth` 之前或与 `/api/health` 同段——健康检查免登录。）

- [ ] **Step 5: 全量测试 + Commit**

```bash
git add mstd-orchestrator/server/health/lark-profile.mjs mstd-orchestrator/server/app.mjs mstd-orchestrator/server/config.mjs mstd-orchestrator/server/index.mjs mstd-orchestrator/test/lark-health.test.mjs
git commit -m "feat(mstd): lark profile 定时健康检查 + 失效边沿飞书 DM 告警"
```

---

### Task 15: 生产配置收口（session secret fail-fast、.env.example、OAuth 端点核实、README）

**Files:**
- Modify: `mstd-orchestrator/server/index.mjs`（fail-fast）
- Modify: `mstd-orchestrator/.env.example`
- Modify: `mstd-orchestrator/server/auth/feishu-oauth.mjs`（核实后改注释）
- Modify: `mstd-orchestrator/README.md`（待办勾选 + 运行说明）
- Test: 无新测试（fail-fast 是启动逻辑；用手工验证步骤）

- [ ] **Step 1: fail-fast**（`index.mjs`，`loadServerConfig` 之后）

```js
if (config.enableWrite && !process.env.MSTD_SESSION_SECRET) {
  console.error("[mstd] 致命：MSTD_ENABLE_WRITE=1 时必须配置 MSTD_SESSION_SECRET（否则重启丢会话且审批链不可信）");
  process.exit(1);
}
```

手工验证：`MSTD_ENABLE_WRITE=1 node server/index.mjs` 无 secret 时退出码 1；配上后正常监听。

- [ ] **Step 2: `.env.example` 全量补齐**

```bash
# CZ 聚合网关 (api.cz900212.com) —— 两个 provider 的 key 分离
CZ_CLAUDE_KEY=sk-...        # Claude 分组 key（draft_zh 用）
CZ_GPT_KEY=sk-...           # GPT-5.5 分组 key（主脑）
DEEPSEEK_KEY=sk-...         # 备用主脑（可留空）

# 飞书 lark-cli profile（已在本机授权的服务账号）
LARK_PROFILE=user613148

# 服务端
PORT=8787
MSTD_SESSION_SECRET=        # 必填（enableWrite 时强制）：openssl rand -hex 32
MSTD_DB_PATH=               # 默认 db/mstd.sqlite

# 飞书 OAuth（应用后台需配 redirect URI）
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=
FEISHU_REDIRECT_URI=http://localhost:8787/api/auth/feishu/callback

# 真写四道锁之总闸 + 测试白名单（v1 只允许写测试目标）
MSTD_ENABLE_WRITE=0
MSTD_TEST_OPEN_IDS=         # 逗号分隔 ou_...
MSTD_TEST_TASKLIST_GUID=

# 触发层
MSTD_ENABLE_TRIGGER=0       # 1=启动 minutes.minute.generated_v1 长连接消费
MSTD_BACKFILL=0             # 1=启动时回扫最近妙记补建 job

# 运维
MSTD_ALERT_OPEN_ID=         # profile 健康检查失败时 DM 告警的接收人
MSTD_MAX_CONCURRENT_PI=2
```

- [ ] **Step 3: OAuth 端点真机核实**

配好 `.env` 的 FEISHU_* 后跑一次真实扫码登录（`node server/index.mjs` + 浏览器走 `/api/auth/feishu/login`）。登录成功 = 三个默认端点（`accounts.feishu.cn/open-apis/authen/v1/authorize`、`open-apis/authen/v2/oauth/token`、`authen/v1/user_info`）核实通过 → 把 `feishu-oauth.mjs` 首行注释改为：

```js
// 端点已于 2026-07-09 经真实 OAuth 登录核实（authorize/v1 + oauth/token/v2 + user_info/v1）；仍可用 env 覆盖。
```

若登录失败，按飞书返回的错误修正端点/scope，再改注释。

- [ ] **Step 4: README 更新**

`mstd-orchestrator/README.md`「待办」一节：勾掉 guard hook（→ 已由 `lark_read` 白名单 + `lark_execute_approved_action` 四道锁取代）、状态层（→ server/db 已落地 SQLite）、触发层（→ `MSTD_ENABLE_TRIGGER=1`）；补一段「运行完整闭环」：

```markdown
## 运行完整闭环（本地）

set -a; . ./.env; set +a
node server/index.mjs            # 触发层/写层按 .env 开关
# 另开终端：cd ../mstd-ui && npx vite   # UI 开发模式（代理 /api 到 :8787）
# 流程：飞书扫码登录 → 触发/等妙记事件 → 时间线看第①段 → 审批（可编辑/删条目）→ 自动真写（仅测试白名单）→ 看板对账
```

- [ ] **Step 5: Commit**

```bash
git add mstd-orchestrator/server/index.mjs mstd-orchestrator/.env.example mstd-orchestrator/server/auth/feishu-oauth.mjs mstd-orchestrator/README.md
git commit -m "chore(mstd): 生产配置收口（secret fail-fast、env 清单、OAuth 端点核实、README）"
```

---

### Task 16: 真机端到端验证（收官）

**Files:** 无代码改动（发现 bug 则回相应任务修）。

- [ ] **Step 1: 双套件全绿基线**

Run: `cd mstd-orchestrator && npx vitest run && cd ../mstd-ui && npx vitest run`
Expected: 全绿（服务端应为 199+ 用例，前端 34+）。

- [ ] **Step 2: 起服务（写开、触发开、只打测试目标）**

```bash
cd mstd-orchestrator
set -a; . ./.env; set +a
MSTD_ENABLE_WRITE=1 MSTD_ENABLE_TRIGGER=1 MSTD_SESSION_SECRET=$(openssl rand -hex 32) \
MSTD_TEST_OPEN_IDS=<自己的测试 ou_> node server/index.mjs
```

确认启动日志含 boot reconcile 结果、trigger consumer on、listening。

- [ ] **Step 3: 浏览器全流程（用 Claude-in-Chrome 插件，不用 Playwright）**

① 飞书扫码登录 → ② 工作台触发"会议→建任务"（指定一条真实 minute_token）→ ③ 时间线实时滚动（中途刷新页面验证断线续传：关键事件回来、流程继续）→ ④ 审批卡出现：删一条、补一个低置信 open_id（填测试 ou_）→ ⑤ 批准 → 状态走 `running_write` → `done`，时间线出现写阶段事件 → ⑥ 看板核对 decisions/actions/事件回放。

- [ ] **Step 4: 飞书侧核对真写结果**

```bash
~/.hermes/node/bin/lark-cli --profile user613148 task +list --as user | head -30
```

确认任务已建、且只建了批准的条数（被删条目没有建）；重复批准被 409（token 单次消费）。

- [ ] **Step 5: 事件触发验证**

真实路径：开一场带妙记的短会（或等一条真实妙记生成），观察服务日志 `[trigger] 妙记 ... → job ...`，UI 看板出现 `[自动]` job。若短期内无真会，用单测已覆盖的 `handleLine` 路径替代，并在收官报告里注明"真实事件路径待首次真会验证"。

- [ ] **Step 6: 崩溃恢复演练**

写阶段进行中 `kill -9` server 进程 → 重启 → 日志 boot reconcile 把 `executing` 残留对账（外部已建 → `succeeded`；未建 → `failed` 可重试），`running_write` job 收敛为 `done/partial_failed`。

- [ ] **Step 7: 收官 commit（若有修补）+ 汇报**

汇报内容：闭环各环节验证结果、遗留项（如真实事件路径是否已真会验证）、下一步指向既有迁移计划（Postgres/上海服务器/token manager Phase 3）。

---

## 非目标（本计划不做，归属既有迁移计划）

- 完整 token manager（refresh 滚动/加密落库/全局锁）——迁移计划 Phase 3；当前凭据仍托管于 lark-cli profile，本计划只做健康检查+告警（Task 14）。
- Postgres / 上海服务器部署 / systemd。
- 多任务模板、组织本体建模、负载状态图（第二层起点）。
- 敏感会议排除机制（依赖模板/组织配置，随多模板一起做）。

## Self-Review 记录

- 差距清单覆盖检查：审批→写接线(T3)、lark_read 接线(T5)、reconcile 接线(T4)、Pi 驱动写真实 spawnPi(T3)、删条目(T6/7)、abort UI(T9)、断线续传(T1/2/8)、事件触发+幂等(T10/11/12)、断档回扫(T13)、profile 健康告警(T14)、OAuth 端点核实+secret fail-fast(T15)、providers 过期注释+draft_zh 未挂载(T5)——全部有对应任务。
- 类型/签名一致性：`runLark` 统一 `(argv) => Promise<{exitCode, stdout, stderr}>`（与既有 `execute-action.mjs` 消费一致）；`launcher.submit` 在 T11 定义、T12/13 消费同签名；`JobStreamEvent.seq` 在 T8 定义、T9 消费；`writeDeps` 在 T3 定义并被 T3 Step 6/7 同构消费。
- 已知真机前置：Task 13 Step 3（`minutes +search` JSON 字段）与 Task 14 Step 3（DM content 格式）显式标注了"编码前先真机核实"，不是占位符而是防猜措施。
