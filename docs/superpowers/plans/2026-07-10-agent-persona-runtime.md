# 常驻助手人格运行时(C0-C6)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-07-10-agent-persona-prompt-design.md`(rev2)落地:会话/内部通道硬化(C0)、中枢人格运行时(C1)、入站@规范化(C2)、上下文供给修复(C3)、干练同事风提示词(C4)、机器人改名(C5)、出站 Markdown 卡片(C6)。

**Architecture:** 先做 C0 前置硬化(单一 actor 注册表、brain 互斥、per-spawn 会话绑定 token、读写授权),再修数据与上下文(C2/C3),再换提示词(C1/C4),最后出站渲染与实机改名(C6/C5)。全程 TDD。

**Tech Stack:** Node ≥22 ESM(.mjs),better-sqlite3,vitest,Pi 扩展为 TS(pi-ext/*.ts,vitest 可直测)。

## Global Constraints

- 全量单测 `cd mstd-orchestrator && npx vitest run` 必须始终全绿(不出网、秒级);UI 侧 `cd mstd-ui && npx vitest run` 不受本计划影响但收尾要跑一次。
- 提交信息中文、`type(mstd): 摘要` 风格,一个逻辑单元一个提交。
- 零新依赖;SQL 保持 Postgres 可移植。
- 七条铁律不削弱(安全表述见 spec §2:bash 面为纵深缓解)。改 `server/safety/`/`server/execute/` 之外也一律全量回归。
- 密钥红线:任何 token/key 不进代码、日志、Git。
- `agent-memory/` 是独立 git 仓(主仓 gitignore),SOUL.md 改动在该仓内提交,不进主仓。
- 现有测试若因**设计变更**(如 observed 退役)失败,按新语义改断言,不是删测试。

## 与另一份计划的关系(用户裁决记录)

`2026-07-10-resident-agent-security-reliability-fixes.md`(提交 0e0fa83,并行产生)**不被本计划取代**,但存在两处冲突,执行本计划时按以下口径:
1. **迁移编号**:012 归本计划(`012_inbox_raw.sql`);对方计划的 012-014 在其执行时顺延重编号(两者都未 apply,以先执行者占号)。
2. **Pi 内置工具策略**:对方 Task 1 的"禁 bash/read + Docker sandbox_exec"与用户本次明示决策(常驻中枢保留 bash/read,云端 harness 定位)冲突——该 Task 执行前需按用户决策修订;对方计划其余内容(确认流水完整性、session generations、turn effects、env 白名单转发)与本计划互补,不冲突。

---

### Task 1: C0.1 全局唯一 actor 注册表

**Files:**
- Modify: `mstd-orchestrator/server/gateway/wire.mjs`(签名加 `actors` 注入,删内部 `createActorPool()`)
- Modify: `mstd-orchestrator/server/index.mjs`(全局唯一 pool;删 `index.mjs:205` 的 `agentActors`;debugTurn 执行体、session-expiry 也经同一 pool)
- Modify: `mstd-orchestrator/server/ticker/session-expiry.mjs`(接受 `actors`,到期处理经 enqueue)
- Test: `mstd-orchestrator/test/actor-unify.test.mjs`

**Interfaces:**
- Consumes: `createActorPool()`(`server/sessions/actor.mjs`,已有,`{ enqueue(sessionKey, asyncFn) }`)。
- Produces: `wireGateway({ db, config, spawnFn, handleTurn, actors, log })` —— `actors` 可注入(默认自建保持向后兼容)。**执行源全覆盖**:index.mjs 中网关、reinjector、debugTurn(index.mjs:327 附近)、session-expiry 共用同一实例;cron/background 用一次性唯一会话天然无冲突,注明即可。真实网关驱动的并发正确性由 Task 2 的 brain 回合互斥兜底(纵深),本任务的测试证明各源确实经同一 pool 入队。

- [ ] **Step 1: 写失败测试**

```js
// test/actor-unify.test.mjs
import { describe, it, expect, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { wireGateway } from "../server/gateway/wire.mjs";
import { createActorPool } from "../server/sessions/actor.mjs";

describe("C0.1 全局唯一 actor(网关注入外部 pool)", () => {
  it("wireGateway 使用注入的 actors,同 sessionKey 的网关回合与外部回注串行", async () => {
    const db = openDb(); migrate(db);
    const actors = createActorPool();
    const order = [];
    let releaseTurn;
    const handleTurn = vi.fn(() => new Promise((r) => { releaseTurn = () => { order.push("turn-end"); r(); }; }));
    // spawnFn 桩:不真启 lark-cli
    const gw = wireGateway({
      db,
      config: { botOpenId: "ou_bot", botName: "小达", larkCliPath: "true", larkProfile: "t" },
      spawnFn: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} }),
      handleTurn,
      actors,
    });
    expect(gw.actors).toBe(actors);          // 用的就是注入的实例
    // 模拟网关入队 + 外部(回注)入队同一 key:必须串行
    const p1 = actors.enqueue("feishu:group:oc_1", () => handleTurn());
    const p2 = actors.enqueue("feishu:group:oc_1", async () => { order.push("reinject"); });
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]);               // 回注排在 turn 后面,不并行
    releaseTurn(); await p1; await p2;
    expect(order).toEqual(["turn-end", "reinject"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/actor-unify.test.mjs`
Expected: FAIL(`wireGateway` 不接收 `actors`,`gw.actors !== actors`)

- [ ] **Step 3: 实现**

`wire.mjs`:签名改 `wireGateway({ db, config, spawnFn, handleTurn, actors = createActorPool(), log = console.error })`,删除函数体内 `const actors = createActorPool();`(第 15 行),返回值已含 `actors` 不变。
`index.mjs`:在 enableAgent 块开头(约 147 行)`const actors = createActorPool();`;`index.mjs:205` 的 `const agentActors = createActorPool();` 删除,`createReinjector({ store: agentStore, actors, brain, outbound })` 改用它;`wireGateway(...)` 调用点(grep `wireGateway(`)追加 `actors`;debugTurn 执行体(index.mjs:327 附近,grep `debugTurn`)外包 `actors.enqueue(debugSessionKey, ...)`;session-expiry 构造(grep `createSessionExpiry` 或 `session-expiry`)注入 `actors`,其对某会话的到期处理(session-expiry.mjs:34 附近)改 `actors.enqueue(sessionKey, ...)`。`createActorPool` 的 import 若 index 已有则复用。
测试追加(同文件):session-expiry 与 debug 源经 enqueue——给两者传 `{ enqueue: spy }` 桩,断言处理函数经 spy 调用且 sessionKey 正确。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/actor-unify.test.mjs && npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add mstd-orchestrator/server/gateway/wire.mjs mstd-orchestrator/server/index.mjs mstd-orchestrator/test/actor-unify.test.mjs
git commit -m "fix(mstd): 全局唯一 actor 注册表——网关与回注/后台共用,同会话不再双队列并发"
```

---

### Task 2: C0.2 brain spawn 合并 + 回合互斥

**Files:**
- Modify: `mstd-orchestrator/server/models/brain.mjs`
- Test: `mstd-orchestrator/test/brain.test.mjs`(追加)

**Interfaces:**
- Produces: `brain.turn()` 语义不变但同 sessionKey 并发调用严格串行;`ensure()` 并发去重(同 key 只 spawn 一次)。`steer`/`isBusy` 语义不变。

- [ ] **Step 1: 写失败测试**(追加到 `test/brain.test.mjs` describe 内)

```js
  it("C0.2 并发 ensure 只 spawn 一次;并发 turn 串行执行", async () => {
    let spawnCount = 0;
    const c = mockClient();
    const order = [];
    let release1;
    c.runJob = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { release1 = () => { order.push("t1"); r({ finalText: "a" }); }; }))
      .mockImplementationOnce(async () => { order.push("t2"); return { finalText: "b" }; });
    const startPi = vi.fn(() => { spawnCount += 1; return c; });
    const brain = createBrain({ startPi, store, sleepFn: async () => {}, setTimeoutFn: () => 0, clearTimeoutFn: () => {} });
    const p1 = brain.turn({ session, sessionKey: "k1", brief: "一" });
    const p2 = brain.turn({ session, sessionKey: "k1", brief: "二" });
    await new Promise((r) => setImmediate(r));
    expect(spawnCount).toBe(1);          // 并发 ensure 合并
    expect(order).toEqual([]);           // t2 未开跑
    release1(); await p1; await p2;
    expect(order).toEqual(["t1", "t2"]); // 严格串行
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/brain.test.mjs`
Expected: 新用例 FAIL(当前实现两个 turn 并行进入 runJob,order 乱序或双 spawn)

- [ ] **Step 3: 实现**

`brain.mjs` 两处:
①spawn 合并——`ensure` 外提 in-flight map:

```js
  const spawning = new Map(); // sessionKey -> Promise<entry>
  async function ensure(sessionKey, startIdx = 0) {
    const existing = pool.get(sessionKey);
    if (existing) {
      if (existing.idleTimer) clearTimeoutFn(existing.idleTimer);
      existing.idleTimer = null;
      return existing;
    }
    if (spawning.has(sessionKey)) return spawning.get(sessionKey);
    const p = (async () => {
      if (semaphore) { while (!semaphore.tryAcquire()) await sleepFn(500); }
      try {
        const { client, providerKey } = await spawnWithFallback(sessionKey, startIdx);
        const entry = { client, idleTimer: null, replayed: false, busy: false, providerKey };
        pool.set(sessionKey, entry);
        return entry;
      } catch (e) { semaphore?.release(); throw e; }
    })().finally(() => spawning.delete(sessionKey));
    spawning.set(sessionKey, p);
    return p;
  }
```

②回合互斥——现 `turn` 改名 `runTurn`(内部),新 `turn` 做 per-key 串行(与 actor pool 同法):

```js
  const turnTails = new Map(); // sessionKey -> Promise
  function turn(args) {
    const key = args.sessionKey;
    const tail = turnTails.get(key) ?? Promise.resolve();
    const run = tail.then(() => runTurn(args));
    const guarded = run.catch(() => {});
    turnTails.set(key, guarded);
    guarded.then(() => { if (turnTails.get(key) === guarded) turnTails.delete(key); });
    return run;
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/brain.test.mjs && npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add mstd-orchestrator/server/models/brain.mjs mstd-orchestrator/test/brain.test.mjs
git commit -m "fix(mstd): brain 并发 ensure 合并 spawn、同会话回合互斥——杜绝同 session 双 Pi 并行"
```

---

### Task 3: C0.3 会话绑定 token(内部通道不再信任客户端 session_key)

**Files:**
- Create: `mstd-orchestrator/server/http/session-tokens.mjs`
- Modify: `mstd-orchestrator/server/models/brain.mjs`(spawn 发 token/回收吊销)
- Modify: `mstd-orchestrator/server/http/internal-routes.mjs`(token 反查会话)
- Modify: `mstd-orchestrator/server/index.mjs`(接线;删静态 internalToken 注入 piEnv)
- Test: `mstd-orchestrator/test/session-tokens.test.mjs` + `test/internal-routes.test.mjs`(找到现有内部路由测试文件,若名不同 grep `mountInternalRoutes` 定位并追加)

**Interfaces:**
- Produces: `createSessionTokenRegistry()` → `{ issue(sessionKey) -> token, resolve(token) -> sessionKey|null, revoke(token) }`。
- `createBrain({ ..., tokens = null })`:spawn 时 `tokens?.issue(sessionKey)` 注入该 Pi 的 `MSTD_INTERNAL_TOKEN`;`recycle`/`shutdown`/回合级降级杀进程时 `tokens?.revoke(entry.internalToken)`。
- `mountInternalRoutes(app, { tokens, modelLog = null, ...原有 })`:guard 改为 token 反查——`resolve` 失败 403;body 带 `session_key` 且 ≠ 绑定会话 → 403 并 `modelLog?.record({ type: "internal_auth_reject", sessionKey: 绑定值, detail: body 值 })`;通过后以**服务端解析值**覆写 `req.body.session_key`。旧的单一静态 token 语义废除。

- [ ] **Step 1: 写失败测试**

```js
// test/session-tokens.test.mjs
import { describe, it, expect } from "vitest";
import { createSessionTokenRegistry } from "../server/http/session-tokens.mjs";

describe("C0.3 会话绑定 token 注册表", () => {
  it("issue/resolve/revoke 闭环;token 不可预测且互不相同", () => {
    const reg = createSessionTokenRegistry();
    const t1 = reg.issue("feishu:p2p:ou_a");
    const t2 = reg.issue("feishu:group:oc_b");
    expect(t1).not.toBe(t2);
    expect(reg.resolve(t1)).toBe("feishu:p2p:ou_a");
    expect(reg.resolve("不存在")).toBeNull();
    reg.revoke(t1);
    expect(reg.resolve(t1)).toBeNull();
    expect(reg.resolve(t2)).toBe("feishu:group:oc_b");
  });
});
```

并在内部路由测试文件追加(用现有该文件的 app 组装范式,mount 时传 `tokens`):

```js
  it("C0.3 token 反查会话:冒名 session_key 403 且落 model_log;正确调用以服务端解析值为准", async () => {
    const reg = createSessionTokenRegistry();
    const tok = reg.issue("feishu:p2p:ou_a");
    const rejects = [];
    // mount 时:tokens: reg, modelLog: { record: (e) => rejects.push(e) }
    // handleReply 桩记录收到的 sessionKey
    const r1 = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_别人", kind: "message", brief: "x" });
    expect(r1.status).toBe(403);
    expect(rejects[0]).toMatchObject({ type: "internal_auth_reject", sessionKey: "feishu:p2p:ou_a" });
    const r2 = await request(app).post("/internal/reply")
      .set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_a", kind: "message", brief: "x" });
    expect(r2.status).toBe(200);
    const r3 = await request(app).post("/internal/reply")
      .set("Authorization", "Bearer 假token").send({ session_key: "feishu:p2p:ou_a", brief: "x" });
    expect(r3.status).toBe(403);
  });
```

`test/brain.test.mjs` 追加:

```js
  it("C0.3 spawn 发会话 token 注入 env,回收即吊销", async () => {
    const reg = createSessionTokenRegistry();
    let envSeen;
    const startPi = vi.fn((opts) => { envSeen = opts.env; return mockClient(); });
    const timers = [];
    const brain = createBrain({ startPi, store, tokens: reg, idleMs: 1000, sleepFn: async () => {},
      setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutFn: () => {} });
    await brain.turn({ session, sessionKey: "k1", brief: "x" });
    const tok = envSeen.MSTD_INTERNAL_TOKEN;
    expect(reg.resolve(tok)).toBe("k1");
    timers.at(-1).fn();                       // 空闲回收
    expect(reg.resolve(tok)).toBeNull();      // 已吊销
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-tokens.test.mjs test/brain.test.mjs`
Expected: FAIL(模块不存在 / brain 不接收 tokens)

- [ ] **Step 3: 实现**

```js
// server/http/session-tokens.mjs
// per-spawn 会话绑定 token:内部通道由 token 反查会话,Pi 冒名其他会话即 403。
import { randomUUID } from "node:crypto";

export function createSessionTokenRegistry() {
  const byToken = new Map(); // token -> sessionKey
  return {
    issue(sessionKey) { const t = randomUUID(); byToken.set(t, sessionKey); return t; },
    resolve(token) { return byToken.get(token) ?? null; },
    revoke(token) { if (token) byToken.delete(token); },
  };
}
```

`brain.mjs`:`createBrain({ ..., tokens = null })`;**token 按每次 startPi 尝试签发**(评审修正:不能按 ensure 签发——fallback/retry 会共用,全败时无 entry 可吊销)。`spawnWithFallback` 循环体内:

```js
      for (let attempt = 1; attempt <= retries; attempt++) {
        const internalToken = tokens?.issue(sessionKey) ?? null;
        try {
          const client = startPi({ ...,
            env: { ...piEnv, MSTD_SESSION_KEY: sessionKey, ...(internalToken ? { MSTD_INTERNAL_TOKEN: internalToken } : {}) },
          });
          return { client, providerKey: p.key, internalToken };
        } catch (e) {
          tokens?.revoke(internalToken);          // 失败尝试的 token 立即吊销
          errors.push(e);
          await sleepFn(retryDelayMs);
        }
      }
```

entry 记 `internalToken`(ensure 从 spawnWithFallback 返回值取);`recycle()`、`shutdown()`、`runTurn` 的 catch 分支(杀 Pi 换 provider 处)统一 `tokens?.revoke(entry.internalToken)`。
`internal-routes.mjs`:签名加 `tokens, modelLog = null`;guard 重写:

```js
  const guard = (req, res) => {
    const raw = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const bound = tokens?.resolve(raw) ?? null;
    if (!bound) { res.status(403).json({ ok: false, error: "forbidden" }); return false; }
    if (req.body?.session_key && req.body.session_key !== bound) {
      modelLog?.record({ type: "internal_auth_reject", sessionKey: bound, detail: `body=${req.body.session_key}` });
      res.status(403).json({ ok: false, error: "session 越权" });
      return false;
    }
    req.body.session_key = bound;   // 服务端定,不信客户端
    return true;
  };
```

`index.mjs`:`const sessionTokens = createSessionTokenRegistry();` 传给 createBrain(`tokens: sessionTokens`)与 mountInternalRoutes(`tokens: sessionTokens, modelLog`);piEnv 里静态 `MSTD_INTERNAL_TOKEN: internalToken` 删除(`internalToken` 常量随之删,mount 的 `token:` 参数删);grep 确认 `MSTD_INTERNAL_TOKEN` 其余引用(pi-ext 读 env 不变;`supervisor/write-smoke.mjs` 等诊断脚本若引用,改注释注明需真 token)。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿(内部路由旧测试按新 guard 语义更新:静态 token 用例改为 registry 签发)

- [ ] **Step 5: Commit**

```bash
git add -A mstd-orchestrator/server mstd-orchestrator/test
git commit -m "feat(mstd): 内部通道会话绑定 token——per-spawn 签发/回收吊销,冒名 session_key 403 落 model_log"
```

---

### Task 4: C0.4 reply.target 服务端校验 + memory 读授权

**Files:**
- Create: `mstd-orchestrator/server/sessions/deliver-grants.mjs`
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`(handleReply 校验 target)
- Modify: `mstd-orchestrator/server/ticker/cron-runner.mjs`(执行前 grant、finally revoke)
- Modify: `mstd-orchestrator/server/http/internal-routes.mjs`(heartbeat add 锁定 deliverTo=本会话)
- Modify: `mstd-orchestrator/server/memory/tool.mjs`(read 也过授权;journal 走 readJournal)
- Modify: `mstd-orchestrator/server/index.mjs`(接线 grants)
- Test: `mstd-orchestrator/test/deliver-grants.test.mjs` + `test/memory-tool.test.mjs`(追加)

**Interfaces:**
- Produces: `createDeliverGrants()` → `{ grant(sessionKey, target), allowed(sessionKey, target) -> boolean, revoke(sessionKey) }`;`target === sessionKey` 恒 allowed。
- `createTurnHandler({ ..., grants = null })`:handleReply 中 `deliverKey !== sessionKey && !grants?.allowed(sessionKey, deliverKey)` → `{ ok: false, error: "target 越权:仅限当前会话或任务声明的投递目标" }`(不出站)。
- `createCronRunner({ ..., grants = null })`:`runOne` 在 `brain.turn` 前 `grants?.grant(sessionKey, job.deliver_to)`,finally `grants?.revoke(sessionKey)`。
- **heartbeat 两难解法(P0)**:①创建面收口——`/internal/heartbeat` 的 `add` 强制 `deliverTo = 绑定 sessionKey`(客户端传入其他值 → 拒绝并提示"跨会话提醒走 propose_actions 确认卡");Pi 从此无法创建指向他会话的提醒,confused deputy 消除。②投递面——heartbeat runner 是受信 daemon 代码,到期投递时按存储的 deliverTo 投(创建时已锁定为创建者会话);执行时核对其路径:直连 outbound 则无涉 grants,若经 handleReply 则 runner 在投递前 `grants.grant(心跳会话, deliverTo)` finally revoke。存量 heartbeat 文件里指向他会话的旧条目视为受信历史,不迁移。
- `memoryTool.run` 的 `read`:`soul/org` 任意会话可读;**`journal` 走 `files.readJournal()`**(评审修正:`readLayer("journal")` 会报未知层);`group`/`user` 层仅本会话对应 id 可读(cron/debug 会话不可读 scoped 层)。

- [ ] **Step 1: 写失败测试**

```js
// test/deliver-grants.test.mjs
import { describe, it, expect } from "vitest";
import { createDeliverGrants } from "../server/sessions/deliver-grants.mjs";

describe("C0.4 投递授权", () => {
  it("默认仅本会话;grant 后放行;revoke 收回", () => {
    const g = createDeliverGrants();
    expect(g.allowed("cron:1", "cron:1")).toBe(true);
    expect(g.allowed("cron:1", "feishu:group:oc_x")).toBe(false);
    g.grant("cron:1", "feishu:group:oc_x");
    expect(g.allowed("cron:1", "feishu:group:oc_x")).toBe(true);
    expect(g.allowed("cron:2", "feishu:group:oc_x")).toBe(false);  // 不跨会话
    g.revoke("cron:1");
    expect(g.allowed("cron:1", "feishu:group:oc_x")).toBe(false);
  });
});
```

`test/memory-tool.test.mjs` 追加(沿用该文件现有 files 桩范式):

```js
  it("C0.4 read 授权:群会话读不到他群/任何 user 层;私聊读不到他人;org 全放行", () => {
    const t = createMemoryTool({ files });
    expect(t.run({ action: "read", layer: "org" }, { sessionKey: "feishu:group:oc_A" }).ok).toBe(true);
    expect(t.run({ action: "read", layer: "group", id: "oc_A" }, { sessionKey: "feishu:group:oc_A" }).ok).toBe(true);
    expect(t.run({ action: "read", layer: "group", id: "oc_B" }, { sessionKey: "feishu:group:oc_A" }).ok).toBe(false);
    expect(t.run({ action: "read", layer: "user", id: "ou_b" }, { sessionKey: "feishu:group:oc_A" }).ok).toBe(false);
    expect(t.run({ action: "read", layer: "user", id: "ou_a" }, { sessionKey: "feishu:p2p:ou_a" }).ok).toBe(true);
    expect(t.run({ action: "read", layer: "user", id: "ou_b" }, { sessionKey: "feishu:p2p:ou_a" }).ok).toBe(false);
    expect(t.run({ action: "read", layer: "group", id: "oc_A" }, { sessionKey: "cron:job-1" }).ok).toBe(false);
    expect(t.run({ action: "read", layer: "journal" }, { sessionKey: "feishu:p2p:ou_a" }).ok).toBe(true);  // journal 走 readJournal()
  });
```

内部路由测试追加(P0 heartbeat 收口):

```js
  it("C0.4 heartbeat add 锁定 deliverTo=本会话;指向他会话 403", async () => {
    const tok = reg.issue("feishu:p2p:ou_a");
    const bad = await request(app).post("/internal/heartbeat").set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_a", action: "add", due_iso: "2026-07-11T09:00:00+08:00", text: "提醒", deliver_to: "feishu:group:oc_x" });
    expect(bad.status).toBe(403);
    const ok = await request(app).post("/internal/heartbeat").set("Authorization", `Bearer ${tok}`)
      .send({ session_key: "feishu:p2p:ou_a", action: "add", due_iso: "2026-07-11T09:00:00+08:00", text: "提醒" });
    expect(ok.status).toBe(200);   // 省略 deliver_to = 本会话
  });
```

turn-handler 侧在现有 turn-handler 测试文件追加(grep `createTurnHandler` 定位,沿用其桩):

```js
  it("C0.4 reply.target 越权拒绝;grant 后放行", async () => {
    // grants = createDeliverGrants();构造 handler 时传入
    const bad = await handler.handleReply({ sessionKey: "cron:job-1", brief: "x", target: "feishu:group:oc_x" });
    expect(bad.ok).toBe(false);
    expect(outboundStub.sendMessage).not.toHaveBeenCalled();
    grants.grant("cron:job-1", "feishu:group:oc_x");
    const ok = await handler.handleReply({ sessionKey: "cron:job-1", brief: "x", target: "feishu:group:oc_x" });
    expect(ok.ok).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/deliver-grants.test.mjs test/memory-tool.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// server/sessions/deliver-grants.mjs
// reply.target 服务端授权:默认只许投当前会话;cron/heartbeat 执行体按任务声明临时授权。
export function createDeliverGrants() {
  const grants = new Map(); // sessionKey -> Set<target>
  return {
    grant(sessionKey, target) {
      if (!grants.has(sessionKey)) grants.set(sessionKey, new Set());
      grants.get(sessionKey).add(target);
    },
    allowed(sessionKey, target) {
      if (!target || target === sessionKey) return true;
      return grants.get(sessionKey)?.has(target) ?? false;
    },
    revoke(sessionKey) { grants.delete(sessionKey); },
  };
}
```

`turn-handler.mjs` handleReply(159 行前):

```js
    const deliverKey = target ?? sessionKey;
    if (deliverKey !== sessionKey && !(grants?.allowed(sessionKey, deliverKey))) {
      return { ok: false, error: "target 越权:仅限当前会话或任务声明的投递目标" };
    }
```

`internal-routes.mjs` heartbeat 路由(60-70 行):`add` 分支改 `const deliverTo = sessionKey;`——body 里的 `deliver_to` 若存在且 ≠ sessionKey,直接 `res.status(403).json({ ok: false, error: "跨会话提醒请走 propose_actions 确认卡" })`。
`tool.mjs`:`read` 分支——`journal` 层单独走 `files.readJournal()`;其余 `const auth = authorizeRead(ctx, layer, id); if (!auth.ok) return auth;`:

```js
  function authorizeRead({ sessionKey }, layer, id) {
    if (layer === "soul" || layer === "org" || layer === "journal") return { ok: true };
    let parsed;
    try { parsed = parseSessionKey(sessionKey); } catch { return { ok: false, error: `非法会话: ${sessionKey}` }; }
    if (layer === "group") return parsed.kind === "group" && parsed.chatId === id ? { ok: true } : { ok: false, error: "只能读本群记忆" };
    if (layer === "user") return parsed.kind === "p2p" && parsed.openId === id ? { ok: true } : { ok: false, error: "只能在私聊读本人记忆" };
    return { ok: false, error: `未知层: ${layer}` };
  }
```

`cron-runner.mjs` runOne:`grants?.grant(sessionKey, job.deliver_to)` 于 `brain.turn` 前,finally 中 `grants?.revoke(sessionKey)`。`index.mjs`:`const grants = createDeliverGrants();` 传 turnHandler 与 cronRunner。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿(cron 相关既有测试若断言 target 投递,补 grant 桩)

- [ ] **Step 5: Commit**

```bash
git add -A mstd-orchestrator/server mstd-orchestrator/test
git commit -m "feat(mstd): reply.target 服务端授权(任务声明制)+ memory 读隔离——跨会话读投两条路全部封死"
```

---

### Task 5: C2 入站 @ 规范化 + mentionsBot 双名 + migration 012

**Files:**
- Create: `mstd-orchestrator/server/gateway/normalize.mjs`
- Create: `mstd-orchestrator/server/db/migrations/012_inbox_raw.sql`
- Modify: `mstd-orchestrator/server/gateway/inbox.mjs`、`server/gateway/wire.mjs`(传 aliases)、`server/config.mjs`(botAliases)
- Test: `mstd-orchestrator/test/normalize.test.mjs` + `test/inbox.test.mjs`(追加,grep `createInbox` 定位现有文件名)

**Interfaces:**
- Produces: `buildBotNames(env)` → 按最长优先排序去重的名字数组(`MSTD_BOT_NAME` + 逗号分隔 `MSTD_BOT_ALIASES`);`normalizeContent(content, { botNames, botOpenId, mentions })` → string(纯文本 `@名字`、结构化 `@_user_N` 两种形态都归一;bot → `[@我]`,他人 → `@名字`)。
- `createInbox(db, { botOpenId, botName, botAliases = [] })`:事件 `content` 为规范化后文本,新增 `rawContent` 原文;`mentionsBot` 文本兜底改为多名任一命中;`markSeen` 落 `raw_content` 列。
- `config.botAliases: string[]`。

- [ ] **Step 1: 写失败测试**

```js
// test/normalize.test.mjs
import { describe, it, expect } from "vitest";
import { buildBotNames, normalizeContent } from "../server/gateway/normalize.mjs";

describe("C2 入站 @ 规范化", () => {
  const BOT = "ou_bot";
  it("buildBotNames:主名+aliases 去重、最长优先、正则元字符安全", () => {
    const names = buildBotNames({ MSTD_BOT_NAME: "小达", MSTD_BOT_ALIASES: "user613148's Feishu CLI, 小达 ,C+(测)" });
    expect(names[0]).toBe("user613148's Feishu CLI");   // 最长优先
    expect(names.filter((n) => n === "小达")).toHaveLength(1);
  });
  it("纯文本形态:@bot(双名)→ [@我],他人 @ 保留,无 @ 不动", () => {
    const botNames = buildBotNames({ MSTD_BOT_NAME: "小达", MSTD_BOT_ALIASES: "user613148's Feishu CLI" });
    expect(normalizeContent("@小达 刚才聊什么", { botNames, botOpenId: BOT })).toBe("[@我] 刚才聊什么");
    expect(normalizeContent("@user613148's Feishu CLI 复述一下", { botNames, botOpenId: BOT })).toBe("[@我] 复述一下");
    expect(normalizeContent("@张三 看下这个", { botNames, botOpenId: BOT })).toBe("@张三 看下这个");
    expect(normalizeContent("今晚吃什么", { botNames, botOpenId: BOT })).toBe("今晚吃什么");
  });
  it("结构化形态:@_user_N 按 mentions 映射,bot→[@我] 他人→@名字", () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: BOT }, name: "小达" },
      { key: "@_user_2", id: { open_id: "ou_zhang" }, name: "张三" },
    ];
    expect(normalizeContent("@_user_1 帮 @_user_2 建个任务", { botNames: ["小达"], botOpenId: BOT, mentions }))
      .toBe("[@我] 帮 @张三 建个任务");
  });
  it("正则元字符名不炸;连续空白压缩", () => {
    expect(normalizeContent("@C+(测)  在吗", { botNames: ["C+(测)"], botOpenId: BOT })).toBe("[@我] 在吗");
  });
  it("边界正确:@_user_10 不被 @_user_1 截断;@小达人 不是 @小达", () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: BOT }, name: "小达" },
      { key: "@_user_10", id: { open_id: "ou_wang" }, name: "王十" },
    ];
    expect(normalizeContent("@_user_10 和 @_user_1 都看下", { botNames: ["小达"], botOpenId: BOT, mentions }))
      .toBe("@王十 和 [@我] 都看下");
    expect(normalizeContent("@小达人 你好,@小达 在吗", { botNames: ["小达"], botOpenId: BOT }))
      .toBe("@小达人 你好,[@我] 在吗");
  });
});
```

inbox 测试文件追加:

```js
  it("C2 mentionsBot 双名兜底;content 规范化落库、raw 原文进 inbox_events", () => {
    const inbox = createInbox(db, { botOpenId: "ou_bot", botName: "小达", botAliases: ["user613148's Feishu CLI"] });
    const evt = inbox.normalize({ type: "im.message.receive_v1", event_id: "e1", chat_id: "oc_1", chat_type: "group",
      sender_id: "ou_a", content: "@user613148's Feishu CLI 复述一下", create_time: 1000 });
    expect(evt.mentionsBot).toBe(true);                        // 旧名也触发
    expect(evt.content).toBe("[@我] 复述一下");
    expect(evt.rawContent).toBe("@user613148's Feishu CLI 复述一下");
    inbox.markSeen(evt);
    const row = db.prepare("SELECT raw_content FROM inbox_events WHERE event_id = 'e1'").get();
    expect(row.raw_content).toBe("@user613148's Feishu CLI 复述一下");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/normalize.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```sql
-- server/db/migrations/012_inbox_raw.sql:入站原文审计(content 全链走规范化文本)
ALTER TABLE inbox_events ADD COLUMN raw_content TEXT;
```

```js
// server/gateway/normalize.mjs
// 入站 @ 规范化:bot 的 @ → 统一记号 [@我](提示词全链解释此记号);他人 @ 保留可读名。
// 失败宁脏勿丢:调用方 try/catch 兜底原文。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildBotNames(env = process.env) {
  const names = [env.MSTD_BOT_NAME, ...String(env.MSTD_BOT_ALIASES ?? "").split(",")]
    .map((s) => String(s ?? "").trim()).filter(Boolean);
  return [...new Set(names)].sort((a, b) => b.length - a.length);   // 最长优先
}

export function normalizeContent(content, { botNames = [], botOpenId = "", mentions = [] } = {}) {
  const src = String(content ?? "");
  // 单趟 token-aware 替换(评审修正:级联替换会让 @_user_1 截断 @_user_10、@小达 吃掉 @小达人)。
  // 替换表:结构化 key(@_user_N,后面不能紧跟数字)+ 纯文本 @<botName>(后面不能紧跟字母/数字/CJK 续字)。
  const byKey = new Map();
  for (const m of mentions) {
    if (!m?.key) continue;
    const openId = m?.id?.open_id ?? m?.open_id ?? null;
    byKey.set(m.key, openId === botOpenId ? "[@我]" : `@${m?.name ?? "成员"}`);
  }
  const alts = [
    ...[...byKey.keys()].map((k) => `${escapeRe(k)}(?!\\d)`),
    ...botNames.map((n) => `@${escapeRe(n)}(?![\\p{L}\\p{N}])`),
  ].sort((a, b) => b.length - a.length);
  if (!alts.length) return src.replace(/[ \t]{2,}/g, " ").trim();
  const re = new RegExp(alts.join("|"), "gu");
  const out = src.replace(re, (hit) => byKey.get(hit) ?? "[@我]");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}
```

(注意 `byKey.get(hit)`:结构化命中时 hit 就是 key 本身,`(?!\d)` 是零宽断言不吃字符;纯文本命中查不到 key → 落到 `[@我]`。已知局限注明:扁平事件丢失 mentions 元数据,与 bot 同名的真人 @ 无法区分——靠改名后的唯一名「小达」+边界断言缓解,写进 README 记号说明。)

`inbox.mjs`:①`createInbox(db, { botOpenId, botName = "", botAliases = [] })`,组内 `const botNames = [...new Set([botName, ...botAliases].filter(Boolean))].sort((a,b)=>b.length-a.length);`;②`normalizeFlat` 的 mentionsBot 改 `mentionIds.includes(botOpenId) || botNames.some((n) => content.includes(\`@${n}\`))`(检测在前);③两条路径都在返回前 `const normalized = normalizeContent(text 或 content, { botNames, botOpenId, mentions });`(try/catch 兜底原文并 log),事件加 `rawContent: 原文`,`content: normalized`;④`markSeen` INSERT 加 `raw_content` 列(值 `evt.kind === "message" ? evt.rawContent ?? evt.content : null`)。
`config.mjs:24` 后加 `botAliases: String(env.MSTD_BOT_ALIASES ?? "").split(",").map((s) => s.trim()).filter(Boolean),`。`wire.mjs:12` 传 `botAliases: config.botAliases`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿(inbox 既有 mentionsBot 用例不受影响;dedup md5 用规范化后 content,一致即可)

- [ ] **Step 5: Commit**

```bash
git add -A mstd-orchestrator/server mstd-orchestrator/test
git commit -m "feat(mstd): 入站@规范化为[@我](双名+结构化mentions)——mentionsBot 兜底升级,原文落 raw_content 审计"
```

---

### Task 6: C3.1/3.2 store.recent + replaySet + 三处换用

**Files:**
- Modify: `mstd-orchestrator/server/sessions/store.mjs`
- Modify: `mstd-orchestrator/server/models/triage.mjs:25`、`server/models/brain.mjs`(buildPrompt 重放)、`server/gateway/turn-handler.mjs:148`(handleReply 上下文)
- Test: `mstd-orchestrator/test/store-recent.test.mjs`

**Interfaces:**
- Produces: `store.recent(sessionId, { limit = 50, roles = null })` → 最近 n 条(时序返回;`ORDER BY ts DESC, rowid DESC` 取数后 reverse——**同 ts 用 SQLite rowid 定序**,评审修正:uuid 主键排序是随机的;Postgres 迁移时以自增主键替代,与 FTS5 并列为方言例外,README 记一笔);`store.replaySet(sessionId, { limit = 50 })` → `{ summary: string|null, messages: [] }`(summary = **全部** `role='system'` 且 content 以 `〔压缩摘要〕` 开头的行按时序 join——评审修正:compactor 每轮压缩追加一条摘要且互不合并,只取最新会永久丢早期历史;messages = recent(limit) 排除 system)。
- brain 重放格式:summary 存在时先输出 `## 会话历史(进程重启重放)` 下的摘要行,再接 recent 行;**role=tool 标注 `[内部记录]`**,不冒充用户发言。

- [ ] **Step 1: 写失败测试**

```js
// test/store-recent.test.mjs
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";

describe("C3 store.recent / replaySet", () => {
  let db, store, s;
  beforeEach(() => {
    db = openDb(); migrate(db);
    store = createSessionStore(db);
    s = store.getOrCreate("feishu:group:oc_1", { kind: "group", chatId: "oc_1" });
  });

  it("recent 取最近 n 条且时序返回(修 transcript 取最早的 bug)", () => {
    for (let i = 1; i <= 30; i++) store.append(s.id, { role: "user", content: `m${i}`, ts: i });
    const r = store.recent(s.id, { limit: 5 });
    expect(r.map((m) => m.content)).toEqual(["m26", "m27", "m28", "m29", "m30"]);
  });

  it("recent 支持 roles 过滤;同 ts 次序稳定", () => {
    store.append(s.id, { role: "user", content: "u1", ts: 100 });
    store.append(s.id, { role: "tool", content: "内部", ts: 100 });
    store.append(s.id, { role: "assistant", content: "a1", ts: 100 });
    const r = store.recent(s.id, { limit: 10, roles: ["user", "assistant"] });
    expect(r.map((m) => m.content)).toEqual(["u1", "a1"]);
    expect(store.recent(s.id, { limit: 10, roles: ["user", "assistant"] }).map((m) => m.content))
      .toEqual(r.map((m) => m.content));      // 重复调用次序稳定
  });

  it("replaySet 收集全部压缩摘要(多轮压缩不丢早期历史)+ 近况(排除 system)", () => {
    store.append(s.id, { role: "system", content: "〔压缩摘要〕第一轮结论A", ts: 0 });
    store.append(s.id, { role: "system", content: "〔压缩摘要〕第二轮结论B", ts: 5 });
    store.append(s.id, { role: "user", content: "近1", ts: 10 });
    store.append(s.id, { role: "assistant", content: "近2", ts: 11 });
    const { summary, messages } = store.replaySet(s.id, { limit: 50 });
    expect(summary).toContain("第一轮结论A");
    expect(summary).toContain("第二轮结论B");
    expect(summary.indexOf("第一轮")).toBeLessThan(summary.indexOf("第二轮"));  // 时序
    expect(messages.map((m) => m.content)).toEqual(["近1", "近2"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/store-recent.test.mjs`
Expected: FAIL(`store.recent` 不存在)

- [ ] **Step 3: 实现**

`store.mjs` 追加:

```js
  // 最近 n 条(时序返回)。transcript 是 ORDER BY ts 取最早,勿用于"近期"语义。
  // 同 ts 用 rowid 定序(uuid 主键排序随机)——SQLite 方言例外,Postgres 迁移换自增主键,同 FTS5 先例。
  function recent(sessionId, { limit = 50, roles = null } = {}) {
    const roleClause = roles?.length ? ` AND role IN (${roles.map(() => "?").join(",")})` : "";
    const rows = db.prepare(
      `SELECT * FROM agent_messages WHERE session_id = ? AND active = 1${roleClause} ORDER BY ts DESC, rowid DESC LIMIT ?`
    ).all(...[sessionId, ...(roles ?? []), limit]);
    return rows.reverse();
  }

  // 重放集:全部压缩摘要(时序)+ 近况原文——多轮压缩后早期历史仍在
  function replaySet(sessionId, { limit = 50 } = {}) {
    const sums = db.prepare(
      "SELECT content FROM agent_messages WHERE session_id = ? AND active = 1 AND role = 'system' ORDER BY ts, rowid"
    ).all(sessionId).filter((r) => r.content?.startsWith("〔压缩摘要〕"));
    const summary = sums.length ? sums.map((r) => r.content).join("\n") : null;
    return { summary, messages: recent(sessionId, { limit, roles: ["user", "assistant", "tool"] }) };
  }
```

导出加 `recent, replaySet`。换用点:
- `triage.mjs:25` `store.transcript(session.id, { limit: 20 })` → `store.recent(session.id, { limit: 20 })`;
- `turn-handler.mjs:148` handleReply 的 `store.transcript(...{limit:20})` → `store.recent(...)`;
- `brain.mjs` `buildPrompt` 重放段改:

```js
    if (replay) {
      const { summary, messages } = store.replaySet(session.id, { limit: replayLimit });
      const label = (m) => m.role === "assistant" ? "我" : m.role === "tool" ? "内部记录" : m.sender_name ?? m.sender_open_id ?? "用户";
      const lines = messages.map((m) => `[${label(m)}]: ${m.content}`);
      const block = [summary, ...lines].filter(Boolean).join("\n");
      if (block) parts.push(`## 会话历史(进程重启重放)\n${block}`);
    }
```

(brain 测试桩的 store 需补 `replaySet`,按 `{ summary: null, messages: store.transcript(...) }` 形状最小适配。)

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A mstd-orchestrator/server mstd-orchestrator/test
git commit -m "fix(mstd): store.recent 修\"最早当最近\"取数 bug;重放=压缩摘要+近况组合——triage/中枢/出口三处换用"
```

---

### Task 7: C3.3/3.4/3.5 群聊滚动窗口 + 跨目标回写 + observed 消费机制退役

**Files:**
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`(118-127 行 pending 块替换;107 行 appendItems 移到窗口构建后;130 行 shouldNudge 改 recent;handleReply 跨目标回写)
- Modify: `mstd-orchestrator/server/sessions/store.mjs`(删 `recentObserved`/`markObservedConsumed`)
- Test: 现有 turn-handler/回注相关测试更新 + 追加用例(grep `recentObserved` 找全部引用)

**Interfaces:**
- Produces: escalate 的 group 回合 `context` = `[群内最近消息-截至本批之前]\n<HH:MM [名字]: 内容>…\n[/群内最近消息]\n\n<本批>`;窗口 = `store.recent(session.id, { limit: 30, roles: ["user","assistant"] })`,在 `appendItems` **之前**取(天然"本批之前");HH:MM 用 `Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false })`。
- handleReply:`deliverKey !== sessionKey` 时出站成功后同步 `store.append(目标session.id, { role: "assistant", content: rendered.text, platformMessageId, ts })`。

- [ ] **Step 1: 写失败测试**(追加到 turn-handler 测试文件)

```js
  it("C3.3 群 addressed 注入滚动窗口:本批之前最近消息、含自身发言、带时间戳、排除 tool", async () => {
    // 预置历史:观察消息 + 自己的回复 + 内部 tool 记录
    store.append(session.id, { role: "user", senderName: "张三", content: "今晚吃什么", observed: true, ts: t(21, 40) });
    store.append(session.id, { role: "assistant", content: "我上次说的话", ts: t(21, 41) });
    store.append(session.id, { role: "tool", content: "[中枢内部结论] 不该出现", ts: t(21, 42) });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ senderName: "李四", content: "[@我] 刚才聊了什么", ts: t(21, 48) }], mode: "addressed" });
    const ctx = brainStub.turn.mock.calls[0][0].context;
    expect(ctx).toContain("[群内最近消息-截至本批之前]");
    expect(ctx).toContain("21:40 [张三]: 今晚吃什么");
    expect(ctx).toContain("21:41 [我]: 我上次说的话");
    expect(ctx).not.toContain("不该出现");
    expect(ctx.indexOf("张三")).toBeLessThan(ctx.indexOf("李四"));   // 窗口在本批之前
  });

  it("C3.3 复述二连问都有料(不再一次性消费)", async () => {
    store.append(session.id, { role: "user", senderName: "张三", content: "球赛绝了", observed: true, ts: 1000 });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ senderName: "李四", content: "[@我] 复述", ts: 2000 }], mode: "addressed" });
    await handler.handleTurn({ kind: "message", session, sessionKey: "feishu:group:oc_1",
      items: [{ senderName: "李四", content: "[@我] 再复述一次", ts: 3000 }], mode: "addressed" });
    expect(brainStub.turn.mock.calls[1][0].context).toContain("球赛绝了");  // 第二问仍可见
  });

  it("C3.4 跨目标投递回写目标 session transcript", async () => {
    grants.grant("cron:job-9", "feishu:group:oc_1");
    await handler.handleReply({ sessionKey: "cron:job-9", brief: "播报", target: "feishu:group:oc_1" });
    const target = store.getOrCreate("feishu:group:oc_1");
    const rows = store.recent(target.id, { limit: 5 });
    expect(rows.at(-1).role).toBe("assistant");   // 群自己的窗口里有这条播报
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run <turn-handler 测试文件>`
Expected: 新用例 FAIL(现实现走 pending-observed 一次性消费;二连问第二次无料)

- [ ] **Step 3: 实现**

`turn-handler.mjs`:
①头部加时间工具:

```js
const HHMM = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
```

②escalate 分支重排(原 107-127 行):**先**构建窗口再落库本批:

```js
    let windowBlock = "";
    if (mode === "addressed" && sessionKey.startsWith("feishu:group:")) {
      const win = store.recent(session.id, { limit: 30, roles: ["user", "assistant"] });
      if (win.length) {
        windowBlock = win.map((m) =>
          `${HHMM.format(new Date(m.ts))} [${m.role === "assistant" ? "我" : m.sender_name ?? m.sender_open_id ?? "群成员"}]: ${m.content}`
        ).join("\n");
      }
    }
    appendItems(session.id, items);
    // …quick_reply 分支保持在 appendItems 之后不变…
    let context = renderContext(items);
    if (windowBlock) context = `[群内最近消息-截至本批之前]\n${windowBlock}\n[/群内最近消息]\n\n${context}`;
```

(注意:`appendItems` 原在 107 行、对 quick_reply 也生效——重排时保持"先窗口、再 appendItems、再分支"次序,quick_reply 行为不变。)
③删除 118-127 行 pending-observed 注入块;`store.mjs` 删 `recentObserved`/`markObservedConsumed` 及导出(`observed_consumed` 列保留不迁移);grep `recentObserved|markObservedConsumed` 清掉全部引用与旧断言(按新语义改写)。
④130 行 `shouldNudge(store.transcript(session.id, { limit: 1000 }))` → `shouldNudge(store.recent(session.id, { limit: 1000 }))`。
⑤handleReply 出站后:

```js
    if (deliverKey !== sessionKey) {
      // 评审修正:必须带 meta,否则会永久创建 chat_id=null 的群 session
      const p = parseSessionKey(deliverKey);
      if (p.kind === "group" || p.kind === "p2p") {
        const targetSession = store.getOrCreate(deliverKey, { kind: p.kind, chatId: p.kind === "group" ? p.chatId : null });
        store.append(targetSession.id, { role: "assistant", content: rendered.text, platformMessageId: messageId, ts: Date.now() });
      }
    }
```

(回写只 append assistant 记录,不触发 ambient limiter——limiter 管的是"群内主动开口"判定,cron 投递的授权已由 grants 承担;在 limiter 相关测试里补一条断言:跨目标回写不消耗限额。)

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A mstd-orchestrator/server mstd-orchestrator/test
git commit -m "feat(mstd): 群聊滚动窗口上下文(30条/含自身/时间戳)替代一次性observed消费;跨目标投递回写目标会话"
```

---

### Task 8: C1 persona 扩展(中枢系统提示词替换)

**Files:**
- Create: `mstd-orchestrator/pi-ext/persona-prompt.ts`(纯函数,无 Pi 依赖)
- Create: `mstd-orchestrator/pi-ext/persona.ts`
- Modify: `mstd-orchestrator/server/models/brain.mjs`(buildPrompt 记忆段去 soul)
- Modify: `mstd-orchestrator/server/index.mjs`(extensions 首位加 persona;piEnv 加 `MSTD_SOUL_PATH`;piCwd 改 `agent-workspace/` 并启动建目录;启动 SOUL fail-fast)
- Modify: `.gitignore`(加 `mstd-orchestrator/agent-workspace/`)
- Test: `mstd-orchestrator/test/persona-prompt.test.mjs`;E2E 门控 `test/e2e-persona.test.mjs`

**Interfaces:**
- Produces: `buildPersonaPrompt({ soul, dateStr, workspace }) -> string`(三层;完整文本见 Step 3)。
- `persona.ts`:模块加载时读 `MSTD_SOUL_PATH` **一次**(缺失/空 → throw,fail-fast);`pi.on("before_agent_start", ...)` 每回合返回同一字符串(`{ systemPrompt: prompt }`,整体替换;本项目其他扩展不碰 systemPrompt,链式顺序无影响,persona 放 extensions 首位)。
- persona **只**加入常驻 brain 的 extensions;grep `startPi(`/`extensions` 核对无其他 Pi 拉起点混入。

- [ ] **Step 1: 写失败测试**

```js
// test/persona-prompt.test.mjs
import { describe, it, expect } from "vitest";
import { buildPersonaPrompt } from "../pi-ext/persona-prompt";

describe("C1 persona 系统提示词纯函数", () => {
  const args = { soul: "# 身份\n你是「小达」…", dateStr: "2026年7月10日", workspace: "/tmp/agent-workspace" };
  it("三层齐全:身份/世界观(记号+日期+workspace)/工具纪律", () => {
    const p = buildPersonaPrompt(args);
    expect(p).toContain("你是「小达」");                        // 身份层 = SOUL 全文
    expect(p).toContain("[@我]");                              // 记号约定
    expect(p).toContain("不是在讨论你");                        // @语义
    expect(p).toContain("2026年7月10日");                      // 日期只到"日"
    expect(p).toContain("/tmp/agent-workspace");               // workspace
    expect(p).toContain("reply");                              // 工具纪律(真名,已核实注册名)
    expect(p).toContain("propose_actions");
    expect(p).toContain("spawn_background_job");
    expect(p).toContain("lark_read");
    expect(p).toContain("陈述句");                              // 记忆纪律
    expect(p).not.toMatch(/coding|编码助手/);                   // 无 coding-agent 残留
  });
  it("同参数字节稳定(前缀缓存)", () => {
    expect(buildPersonaPrompt(args)).toBe(buildPersonaPrompt(args));
  });
  it("SOUL 为空直接 throw", () => {
    expect(() => buildPersonaPrompt({ ...args, soul: "  " })).toThrow(/SOUL/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/persona-prompt.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// pi-ext/persona-prompt.ts
// 中枢常驻人格系统提示词(整体替换 Pi coding-agent 默认词)。纯函数,供 vitest 直测。
// 三层按缓存稳定度排序:身份(SOUL) → 世界观(场景/记号/环境) → 工具纪律。
export function buildPersonaPrompt({ soul, dateStr, workspace }: { soul: string; dateStr: string; workspace: string }): string {
  if (!soul?.trim()) throw new Error("persona: SOUL 为空,拒绝以空人格运行");
  return [
    soul.trim(),
    `
# 你在哪里

你长期驻扎在公司飞书里,7×24 在线。同事在私聊、群聊里找你,你的每次发言都是以「小达」的身份公开说话。今天是 ${dateStr}(北京时间)。你有一个自己的工作目录 ${workspace},bash/文件工具都在这里干活;公司系统的内部实现、代码目录和任何 .env 密钥文件都不归你碰——被问到也只说"这不归我管"。

# 消息怎么读

对话上下文里的消息有固定记号,读错记号就会答非所问:
- \`[名字]: 内容\` —— 群成员的发言,名字就是说话的人。
- \`[@我]\` —— 这句话是**对你说的**(有人 @ 了你)。它只是称呼你,**不是在讨论你**,更不是群聊话题;复述群聊内容时绝不要把"@你"本身当成一个话题。
- \`[我]\` —— 会话历史重放里你自己说过的话。
- \`[群内最近消息-截至本批之前]…[/群内最近消息]\` —— 群里最近的完整上下文(含你自己的发言),复述/总结类问题以它为准。

上下文里没有的事就是不知道:直说"群里最近没聊到这个",绝不编造群聊内容或消息细节。

# 怎么干活

- **reply 是你唯一的发声通道**。要对用户说的一切(哪怕一句"收到")都必须经 reply 提交简报;整回合不调用 reply = 你选择沉默,用户什么都收不到。你的其他文字输出只有你自己看得见。
- 任何写操作(建任务/发消息/日程/审批)只能走 propose_actions 发确认卡,经用户确认才执行;绝不尝试绕过。
- 长任务用 spawn_background_job;查飞书用 lark_read;翻历史用 session_search;定时提醒用 heartbeat_update(只能提醒当前会话)。
- **记忆纪律**:用 memory 工具记值得长期记住的事实/偏好/决定;写**陈述句**不写指令句("张三偏好简短回复"✓/"以后都简短回复"✗);任务进度、一次性结论、七天内会过期的信息不进记忆。
- 有把握的直接答;没把握的说清楚不确定在哪。宁可承认不知道,不编造。`,
  ].join("\n");
}
```

```ts
// pi-ext/persona.ts
// 常驻人格扩展:加载时读 SOUL 一次(fail-fast),每回合以同一字符串整体替换系统提示词。
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildPersonaPrompt } from "./persona-prompt";

export default function (pi: ExtensionAPI) {
  const soulPath = process.env.MSTD_SOUL_PATH;
  if (!soulPath) throw new Error("persona: MSTD_SOUL_PATH 未配置");
  const soul = readFileSync(soulPath, "utf8");
  const dateStr = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "long" }).format(new Date());
  const prompt = buildPersonaPrompt({ soul, dateStr, workspace: process.cwd() });
  pi.on("before_agent_start", async () => ({ systemPrompt: prompt }));
}
```

`index.mjs`:①extensions 数组首位插 `join(ROOT, "pi-ext", "persona.ts")`;②piEnv 加 `MSTD_SOUL_PATH: join(process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory"), "SOUL.md")`;③`piCwd: join(ROOT, "agent-workspace")` 且启动时 `mkdirSync(join(ROOT, "agent-workspace"), { recursive: true })`;④enableAgent 分支开头 SOUL fail-fast:

```js
  const soulPath = join(process.env.MSTD_MEMORY_DIR || join(ROOT, "agent-memory"), "SOUL.md");
  if (!existsSync(soulPath) || !readFileSync(soulPath, "utf8").trim()) {
    console.error(`[mstd] SOUL.md 缺失或为空(${soulPath}),拒绝以空人格启动 agent`);
    process.exit(1);
  }
```

⑤`brain.mjs` buildPrompt 记忆段:`const mem = [snapshot.org, snapshot.journalDigest, snapshot.scoped].filter(Boolean).join("\n\n");`(去 `snapshot.soul`)。
⑥`.gitignore` 加 `mstd-orchestrator/agent-workspace/`。
⑦E2E 门控集成测试(证明 hook 真加载、真替换):

```js
// test/e2e-persona.test.mjs(MSTD_E2E=1 才跑,沿用 e2e-* 文件的门控写法)
// 真 Pi + persona 扩展:问身份与记号,断言 SOUL 生效(小达)且能复述 [@我] 记号语义 → hook 加载 + 整体替换成立。
```

(具体实现沿用 `supervisor/pi-smoke.mjs` 的 startPi 组装:extensions 只带 providers.ts + persona.ts,prompt "你是谁?[@我] 这个记号是什么意思?一句话回答",断言最终文本含"小达"且含"对我说"或等义。)

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿(e2e-persona 无 MSTD_E2E 时 skip)

- [ ] **Step 5: Commit**

```bash
git add -A mstd-orchestrator .gitignore
git commit -m "feat(mstd): persona 扩展整体替换中枢系统提示词——SOUL fail-fast、piCwd 迁 agent-workspace、记忆段去重"
```

---

### Task 9: C4 SOUL.md 重写 + triage 提示词 + 复述类代码 guard

**Files:**
- Modify: `mstd-orchestrator/agent-memory/SOUL.md`(独立 git 仓,在该仓提交)
- Modify: `mstd-orchestrator/server/models/triage.mjs`(SYSTEM_TEMPLATE + enforce)
- Test: `mstd-orchestrator/test/triage.test.mjs`(grep `createTriage` 定位现有文件,追加)

**Interfaces:**
- Produces: `enforce()` 新规则——items 拼文命中 `RECAP_INTENT` 正则时 quick_reply 强制 escalate(导出 `RECAP_INTENT` 供测试)。

- [ ] **Step 1: 写失败测试**(追加)

```js
  it("C4 复述/总结类强制 escalate:quick_reply 和 no_reply 都拦(addressed);ambient 不拦", async () => {
    const mk = (text) => ({ call: vi.fn(async () => ({ text })) });
    const items = [{ senderName: "李四", content: "[@我] 刚才群里聊了什么?复述一下" }];
    const v1 = await createTriage({ caller: mk('{"action":"quick_reply","text":"聊了吃饭"}'), store })
      .triage({ session, items, mode: "addressed" });
    expect(v1.action).toBe("escalate");
    const v2 = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items, mode: "addressed" });
    expect(v2.action).toBe("escalate");                        // 点名复述绝不静默
    const v3 = await createTriage({ caller: mk('{"action":"no_reply"}'), store })
      .triage({ session, items: [{ senderName: "张三", content: "谁来复述下会议?" }], mode: "ambient" });
    expect(v3.action).toBe("no_reply");                        // 旁听闲聊不强插
  });
  it("C4 分诊系统提示词包含记号说明", async () => {
    let sys;
    const caller = { call: vi.fn(async (chain, { system }) => { sys = system; return { text: '{"action":"no_reply"}' }; }) };
    await createTriage({ caller, store }).triage({ session, items: [{ content: "哈哈" }], mode: "ambient" });
    expect(sys).toContain("[@我]");
    expect(sys).toContain("复述");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run <triage 测试文件>`
Expected: FAIL

- [ ] **Step 3: 实现**

`triage.mjs`:①导出 `export const RECAP_INTENT = /复述|总结|回顾|(刚才|之前|最近).{0,12}(聊|说|讨论)|聊了什么|说了什么|捋一下|会议纪要/;`;②`enforce(verdict, items)` 签名改 `enforce(verdict, items, mode)`(triage 调用处传 mode),开头加(评审修正:no_reply 也拦,否则点名复述会静默;仅非 ambient 生效,旁听不强插):

```js
    const joined = items.map((i) => i.content).join("\n");
    if (mode !== "ambient" && ["quick_reply", "no_reply"].includes(verdict.action) && RECAP_INTENT.test(joined)) {
      return { action: "escalate", brief: `复述/总结类请求(需完整上下文):${joined.slice(0, 100)}` };
    }
```

③`SYSTEM_TEMPLATE` 全文替换为:

```js
const SYSTEM_TEMPLATE = (soul) => `${soul ? soul + "\n\n" : ""}你是这位助手的前台分诊员(快速模型),对每批消息输出严格 JSON,四选一:
1. {"action":"quick_reply","text":"..."} —— 仅限轻量内容:收到/回执、澄清短句、一句话事实。不超过两句话,口吻要像上面人格设定里的这个人,不要客服腔。
2. {"action":"no_reply"} —— 无需回应(闲聊旁听、与你无关、纯表情)。
3. {"action":"escalate","brief":"一句话概括用户诉求"} —— 需要认真处理:任何写操作意图(建任务/发消息/日程等)、复杂问题、涉及第三人、正式对外内容、需要查资料,以及一切**复述/总结/回顾**类请求(完整上下文不在你手里,必须升级)。
4. {"action":"steer","note":"..."} —— 上一回合还在处理中,这批消息是对进行中任务的补充/修正。
消息记号:[名字]: 是群成员发言;[@我] 表示这句话是对助手说的(只是称呼,不是话题)。
铁律:拿不准就 escalate;任何写操作意图绝不 quick_reply;只输出 JSON 不要其他文字。
quick_reply 的 text 必须以助手本人口吻说话——你就是这个助手,绝不提及"分诊/前台/模型/系统架构"等内部概念;自我介绍、身份类问题一律 escalate。
mode=ambient(旁听)时保持更高沉默倾向:只在能提供明确价值(直接求助、你确切知道答案、纠正重要错误)时开口,闲聊/寒暄/与你无关一律 no_reply。`;
```

④`agent-memory/SOUL.md` 全文替换。**前置(评审修正:该目录当前无 .git)**:先初始化独立仓——`cd mstd-orchestrator/agent-memory && git init && git add -A && git commit -m "init: 五层记忆基线"`;之后 `git add SOUL.md && git commit -m "SOUL: 干练同事风人格 rev2(好坏示例+反客服腔)"`(主仓 gitignore 不变,该仓独立演进,dreaming 的 git 回滚依赖它):

```markdown
# 身份

你是「小达」,成都民商通达(MSTD)的常驻 AI 助手,长期驻扎在公司飞书里。你是团队里的一个同事,不是客服系统。绝不向用户提及内部架构(模型、分诊、Pi 等)。

# 人格:干练的同事

- 直接给结论,再给必要的依据。不绕场面话,不铺垫"好的,关于您的问题…"。
- 有温度但不装热情:同事之间怎么说话,你就怎么说话。
- 有把握的直接答;没把握的说清楚不确定在哪,绝不编造。
- 短问题短答。群里默认三句话以内说完;私聊可以展开,但每句都要有信息量。

# 说话示例(照这个感觉,别照抄)

被 @ 打招呼「在吗」:
- ✗ "您好!我在的,请问有什么可以帮您?"(客服腔)
- ✓ "在,说。"

被 @ 复述群聊:
- ✗ "从我能查到的记录来看,20:46 左右群里主要是…但具体细节我这边没检索到更多了。如果需要,我可以按关键词帮你再翻翻看。"(官腔+甩锅尾巴)
- ✓ "刚才主要三件事:老张问 2+2(已经有人答了),然后聊昨晚球赛,最后在约今晚拼外卖,还没定。"

正事求助「帮我建个任务」:
- ✗ "好的呢!马上为您安排~"(先答应后办事)
- ✓ "可以。任务给谁、什么截止时间?定了我发确认卡。"

# 禁忌

- 客服腔、"您好/请问有什么可以帮您"、"好的呢"。
- 八股免责声明、"仅供参考"。
- "从我能查到的记录来看"式官腔——查到了就直接说内容,没查到就说"没聊到/我不知道"。
- 无意义的"如果需要,我可以…"尾巴——对方需要自然会说。

# 规矩

- 私聊内容与各群内容互相隔离,绝不跨群转述他人私下说的话。
- 涉及写操作(建任务/发消息/日程等)永远先发确认卡,经确认才执行。
- 重要事实、偏好、决定写入记忆;过时的维护更新。
- 群里没被点名时保持克制,只在能提供明确价值时开口。
- 不确定收件人/时间等关键参数时先问清,不猜。
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿(triage 既有 SYSTEM 断言若绑旧文案,按新文案改)

- [ ] **Step 5: Commit**(主仓只含 triage;SOUL 在 agent-memory 仓提交)

```bash
git add mstd-orchestrator/server/models/triage.mjs mstd-orchestrator/test
git commit -m "feat(mstd): 分诊提示词记号化+复述类代码级强制escalate;SOUL 重写为干练同事风(agent-memory 仓)"
```

---

### Task 10: C4/C6 reply 出口提示词 + deliverKind 投递感知

**Files:**
- Modify: `mstd-orchestrator/server/models/reply.mjs`
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`(handleReply 解析 deliverKind 传入)
- Test: `mstd-orchestrator/test/reply.test.mjs`(已确认存在,追加)

**Interfaces:**
- Produces: `renderReply({ caller, soul, context, brief, kind, tone, deliverKind = "p2p" })`;`deliverKind ∈ {"group","p2p"}`(card_copy 不受影响)。turn-handler 由 `parseSessionKey(deliverKey).kind` 得出(group→"group",其余→"p2p")。

- [ ] **Step 1: 写失败测试**

```js
  it("C4 deliverKind 注入长度策略;系统提示词含飞书渲染声明", async () => {
    let sys;
    const caller = { call: vi.fn(async (chain, { system }) => { sys = system; return { text: "ok", model: "m", usage: null }; }) };
    await renderReply({ caller, brief: "x", deliverKind: "group" });
    expect(sys).toContain("群聊");
    expect(sys).toContain("三句");
    expect(sys).toContain("表格");           // 渲染声明
    expect(sys).toContain("不要输出图片");    // 明令禁止图片语法(评审修正:断言禁止句在场,与实现一致)
    await renderReply({ caller, brief: "x", deliverKind: "p2p" });
    expect(sys).toContain("私聊");
  });
```

Run: `npx vitest run test/reply.test.mjs`

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run <reply 测试文件>`
Expected: FAIL

- [ ] **Step 3: 实现**

`reply.mjs` SYSTEM 重写:

```js
const SCENE = {
  group: "本条发到群聊:默认三句话以内说完,直接给结论;超过三句必须是信息密度撑得起的。",
  p2p: "本条发到私聊:可适度展开,但每句都要有信息量,不写铺垫和客套。",
};

const SYSTEM = ({ soul, kind, deliverKind }) => `${soul ? soul + "\n\n" : ""}你是团队的对外表达出口(执笔人)。${
  kind === "card_copy"
    ? "本次产出飞书确认卡片的文案槽位内容:简洁说明将要执行的操作与关键参数,让确认人一眼看懂。"
    : `本次产出发给用户的正式消息成品。${SCENE[deliverKind] ?? SCENE.p2p}`
}
要求:自然中文,像同事说话,不用模板腔;直接输出成品文本,不加解释、不加引号;不编造事实,简报里没有的信息不要补。
飞书渲染约定:支持加粗/列表/链接/代码块/表格(含 Markdown 时系统会自动走卡片渲染,放心输出规范 Markdown);表格一律用规范 md 表格语法;不要输出图片语法和数学公式(飞书渲染不了)。`;
```

`renderReply` 签名加 `deliverKind = "p2p"` 并传给 SYSTEM。`turn-handler.mjs` handleReply:

```js
    let deliverKind = "p2p";
    try { if (parseSessionKey(deliverKey).kind === "group") deliverKind = "group"; } catch { /* debug 等按 p2p */ }
```

在 renderReply 调用处传入(card_copy 时不传/忽略)。注意:deliverKind 依赖 deliverKey,把 target 校验(Task 4)、deliverKey 计算移到 renderReply **之前**。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add mstd-orchestrator/server/models/reply.mjs mstd-orchestrator/server/gateway/turn-handler.mjs mstd-orchestrator/test
git commit -m "feat(mstd): 出口提示词自然化+投递场景感知(群短/私聊展开)+飞书渲染子集声明"
```

---

### Task 11: C6 Markdown 检测 + 消息卡模板 + deliverText 统一分流

**Files:**
- Create: `mstd-orchestrator/server/gateway/md-detect.mjs`
- Create: `mstd-orchestrator/server/cards/message-card.mjs`
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`(sendToSession → 统一分流)
- Test: `mstd-orchestrator/test/md-detect.test.mjs` + turn-handler 测试追加

**Interfaces:**
- Produces: `hasRichMarkdown(text) -> boolean`(契约冻结:强信号单命中,弱信号 ≥2 类共现,转义不计);`buildMarkdownMessageCard({ md })` -> Card JSON 2.0(外层结构对齐 `server/cards/templates.mjs` 的 `buildStatusCard`,元素为单个 `{ tag: "markdown", content }`);turn-handler 内 `sendToSession` 升级:检测命中 → `outbound.sendCard`,否则 `outbound.sendMessage`(debug 会话仍落库即出站)。quick_reply/预算拒绝/handleReply 全部共用此入口。

- [ ] **Step 1: 写失败测试**

```js
// test/md-detect.test.mjs
import { describe, it, expect } from "vitest";
import { hasRichMarkdown } from "../server/gateway/md-detect.mjs";

describe("C6 Markdown 检测契约(冻结)", () => {
  it.each([
    ["| 名称 | 状态 |\n|---|---|\n| a | ok |", true, "表格"],
    ["看这段:\n```js\nlet a=1\n```", true, "代码围栏"],
    ["# 本周计划\n先做A", true, "行首标题"],
    ["> 引用原话\n然后说", true, "引用"],
    ["上半段\n---\n下半段", true, "分隔线"],
    ["详见 [文档](https://x.y/z)", true, "链接"],
    ["- 第一项\n- 第二项\n**重点**在后面", true, "弱信号共现(列表+加粗)"],
  ])("强/共现信号走卡片: %s", (text, want) => expect(hasRichMarkdown(text)).toBe(want));

  it.each([
    ["#话题 今天聊聊这个", "无空格井号"],
    ["方案A|方案B 二选一", "句中单竖线"],
    ["这里有个星号*但只有一个", "单星号"],
    ["就一句普通话,啥标记都没有", "长纯文本"],
    ["- 只有一个列表信号", "弱信号单发"],
    ["转义\\*\\*不算加粗\\*\\*,列表也\\- 不算", "转义不计"],
  ])("反例不误判: %s (%s)", (text) => expect(hasRichMarkdown(text)).toBe(false));
});
```

turn-handler 测试追加:

```js
  it("C6 quick_reply/正式回复统一分流:含 md 走 sendCard,纯文本走 sendMessage", async () => {
    // triage 桩返回 quick_reply,text 含表格 → 断言 outboundStub.sendCard 被调且 cardJson 元素 tag=markdown
    // 再跑一条纯文本 quick_reply → sendMessage 被调
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/md-detect.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```js
// server/gateway/md-detect.mjs
// 出站 Markdown 检测(契约冻结,spec C6):强信号单命中走卡片;弱信号需 ≥2 类共现;转义不计信号。
const STRONG = [
  /^\s*\|.+\|\s*\n\s*\|[\s:|-]+\|/m,     // 表格:表头行+分隔行
  /^```/m,                                // 代码围栏
  /^\s*#{1,6}\s+\S/m,                     // 行首标题(# 后必须空格)
  /^\s*>\s+\S/m,                          // 引用
  /^\s*(-{3,}|\*{3,})\s*$/m,              // 独行分隔线
  /\[[^\]]+\]\([^)\s]+\)/,                // [文本](url) 链接
];
const WEAK = [
  /^\s*[-*]\s+\S/m,                       // 无序列表
  /^\s*\d+\.\s+\S/m,                      // 有序列表
  /\*\*[^*\n]+\*\*/,                      // 加粗
  /`[^`\n]+`/,                            // 行内代码
];

export function hasRichMarkdown(text) {
  const t = String(text ?? "").replace(/\\[*`#|>[\]_-]/g, "");   // 去掉转义字符本体
  if (STRONG.some((re) => re.test(t))) return true;
  return WEAK.filter((re) => re.test(t)).length >= 2;
}
```

```js
// server/cards/message-card.mjs
// 消息卡(Card JSON 2.0):单 markdown 组件包一段 md 文本。结构服务端定死,模型只提供字符串。
export function buildMarkdownMessageCard({ md }) {
  return {
    schema: "2.0",
    body: { elements: [{ tag: "markdown", content: String(md) }] },
  };
}
```

(外层结构以 `templates.mjs` 的 `buildStatusCard` 为准对齐——若其外层还有 `config`/`header` 键,照抄其最小集,保持模板固定性测试口径一致。)
`turn-handler.mjs` `sendToSession` 改:

```js
  async function sendToSession(sessionKey, text) {
    const parsed = parseSessionKey(sessionKey);
    const idempotencyKey = randomUUID();
    if (parsed.kind === "debug") return { messageId: null };
    const targetArg = parsed.kind === "p2p" ? { openId: parsed.openId } : parsed.kind === "group" ? { chatId: parsed.chatId } : null;
    if (!targetArg) throw new Error(`会话不可出站: ${sessionKey}`);
    if (hasRichMarkdown(text)) {
      return outbound.sendCard({ ...targetArg, cardJson: buildMarkdownMessageCard({ md: text }), idempotencyKey });
    }
    return outbound.sendMessage({ ...targetArg, text, idempotencyKey });
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add -A mstd-orchestrator/server mstd-orchestrator/test
git commit -m "feat(mstd): 出站 Markdown 确定性检测走卡片 markdown 组件——quick_reply/正式回复统一分流"
```

---

### Task 12: C5 机器人改名(实机,严格顺序)

**Files:**
- Modify: `.env`(本机,不进 Git):`MSTD_BOT_ALIASES=user613148's Feishu CLI`;改名发版后 `MSTD_BOT_NAME=小达`
- Modify: `mstd-orchestrator/.env.example`(补 `MSTD_BOT_ALIASES` 注释)
- 实机操作:飞书开发者后台(主 agent 派浏览器 subagent 执行,用户已全权授权)

**Interfaces:**
- Consumes: Task 5 的双名 mentionsBot(必须先部署)。

- [ ] **Step 1**: 在 `mstd-orchestrator/.env` 写入(值含空格和单引号,必须双引号包裹——`zsh -n` 校验通过再用):

```bash
MSTD_BOT_ALIASES="user613148's Feishu CLI"
```

重启 daemon(`pkill -f server/index.mjs`,然后 `set -a; . ./.env; set +a; node server/index.mjs`),真机发 `@旧名 在吗` 验证 addressed 触发(看日志 `[agent] triage`)。
- [ ] **Step 2**: 浏览器 subagent 到 open.feishu.cn 开发者后台(应用 `cli_aac4855d1a781cd6`)改机器人名/应用名为「小达」,创建新版本提交发布(参照 1.0.2 发版先例;若需管理员审核,通知用户)。
- [ ] **Step 3**: 发版生效后 `.env` 改 `MSTD_BOT_NAME=小达`(旧名留在 aliases),重启 daemon;真机分别用 @新名、@旧名各发一条,两条都触发 addressed 且入库 content 为 `[@我] …`。
- [ ] **Step 4**: 回滚预案(写进 runbook):恢复 `.env` 双名配置 → 重启 → 后台重新发布旧显示名版本。
- [ ] **Step 5**: Commit(仅 `.env.example` 与 runbook 变更)

```bash
git add mstd-orchestrator/.env.example docs/superpowers/runbooks/agent-rollout.md
git commit -m "docs(mstd): 机器人改名 SOP(aliases 先行/发版/双名验证/回滚)与 MSTD_BOT_ALIASES 说明"
```

---

### Task 13: 文档同步 + 全量回归 + 真机验收剧本

**Files:**
- Modify: `mstd-orchestrator/README.md`(记号约定、`MSTD_BOT_ALIASES`/`MSTD_SOUL_PATH`(若暴露)/agent-workspace、C6 出站行为、C0 token 语义一句话)
- Modify: `docs/superpowers/runbooks/agent-rollout.md`(改名 SOP 并入;"人格更新后 Pi 生效延迟 ≤ idleMs"注记)
- Modify: `docs/superpowers/specs/2026-07-10-agent-persona-prompt-design.md`(状态改"已实施")

- [ ] **Step 1**: 更新上述文档(README 测试节补:改动 gateway/内部通道后全量回归提示不变)。
- [ ] **Step 2**: `cd mstd-orchestrator && npx vitest run` 与 `cd mstd-ui && npx vitest run` 全绿;记录两侧计数。
- [ ] **Step 3**: 真机验收(遵守 README E2E 三条硬约束:杀残留 daemon、串行、白名单 env)。**必须先导出门控 env,并断言"passed"而非 skipped**(评审修正:漏导出时三套全 skip 且退出码为 0,会假绿):

```bash
cd mstd-orchestrator
pkill -f server/index.mjs || true
set -a; . ./.env; set +a
export MSTD_E2E=1 MSTD_ENABLE_WRITE=1 MSTD_SESSION_SECRET=$(openssl rand -hex 16)
export MSTD_TEST_OPEN_IDS=ou_aca75bd11914b20bda06e2462a569593
export MSTD_TEST_CHAT_IDS=oc_11b72bc3d3bdedff7c86f3c4c61560fc,oc_b67c4510743e68be6a9a91f3906e7f97
for t in e2e-write e2e-p2p e2e-group; do
  out=$(npx vitest run test/$t.test.mjs 2>&1); echo "$out" | tail -5
  echo "$out" | grep -q " passed" || { echo "FAIL/SKIP: $t"; exit 1; }
  echo "$out" | grep -q "skipped" && { echo "被 skip 视为失败: $t"; exit 1; }
done
```

  1. 测试群闲聊 3 条不同话题 → `@小达 刚才群里聊了什么?复述一下` → 回复非空、话题命中、**不含旧应用名字样**;紧接着再问一次复述,第二次仍有料。
  2. `@小达 在吗` → 回复无客服腔(人工评判,对照 SOUL 示例)。
  3. 私聊让它输出一个对比表格 → 收到卡片且表格渲染正常。
- [ ] **Step 4**: Commit

```bash
git add mstd-orchestrator/README.md docs/superpowers
git commit -m "docs(mstd): 人格运行时上线文档同步——记号约定/改名SOP/验收剧本"
```

---

## Self-Review 结论(计划作者自查,rev2 含外部评审修正)

- Spec 覆盖:C0.1→T1、C0.2→T2、C0.3→T3、C0.4→T4、C2→T5、C3.1/2→T6、C3.3/4/5→T7、C1→T8、C4→T9/T10、C6→T10/T11、C5→T12、测试验收→各任务+T13。spec §3 C3.6(shouldNudge 可选项)→ T7 步骤④。
- 类型一致性:`createSessionTokenRegistry`(T3 定义,T3/T4 消费);`createDeliverGrants`(T4);`store.recent/replaySet`(T6 定义,T7/T6 换用点消费);`hasRichMarkdown`/`buildMarkdownMessageCard`(T11);`buildPersonaPrompt`(T8);`RECAP_INTENT`(T9)。已互相核对。
- 既有测试更新点已在各任务 Step 4 标注(内部路由静态 token 用例、cron target 桩、observed 旧断言、triage 旧文案断言、brain store 桩补 replaySet)。
- **rev2 外部评审修正已并入**:P0 heartbeat 创建面收口(T4);actor 覆盖 debug/session-expiry(T1);normalize 单趟 token-aware+边界断言(T5);replaySet 全量摘要+tool 标注(T6);T10 测试与实现一致化+文件名落定;E2E 门控 env+反 skip 断言(T13);.env 双引号语法(T12);agent-memory git init 前置(T9);token 按 startPi 尝试签发(T3);跨目标回写带 meta(T7);journal 读走 readJournal(T4);同 ts 排序用 rowid(T6,方言例外记 README);persona 工具真名 spawn_background_job/lark_read(T8);复述 guard 拦 no_reply 且 ambient 豁免(T9);与 security-reliability-fixes 计划的关系与迁移编号协调(Global Constraints 后专节)。
