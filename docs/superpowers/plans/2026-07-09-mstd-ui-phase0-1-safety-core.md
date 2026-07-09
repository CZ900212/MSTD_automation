# mstd UI · Phase 0（基座）+ Phase 1（安全内核）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mstd UI 打好可测试的**安全地基**——纯逻辑 + DB 原语（deny-by-default 只读白名单、意图 schema、action DSL 规范化+hash、审批/OAuth 挑战、幂等状态机），无 UI、不真写飞书，全部单测覆盖。

**Architecture:** 在 `mstd-orchestrator/` 下新建 `server/`（Node ESM `.mjs`，与既有 `supervisor/pi-client.mjs` 同风格，**无 TS 构建步骤**）。安全内核是一组**纯函数** + **better-sqlite3 支撑的挑战/动作状态表**。所有"写飞书"的形状由服务端函数确定（模型永不可信）；本计划只产出并单测这些确定性构造件，真正 spawn 写留到 Phase 4。

**Tech Stack:** Node ≥22 ESM（`.mjs`）· better-sqlite3（本地，schema 保持 Postgres 可移植）· vitest · node:crypto（hash / token）· lark-cli 参数由纯函数构造（已核实真实 flag）。

**上位 spec：** `docs/superpowers/specs/2026-07-09-mstd-ui-reuse-design.md`（Phase 2 Pi RPC 冻结、Phase 3 server+OAuth、Phase 4 UI+真写 各自独立成计划）。

## Global Constraints

- **信任边界**：模型永不可信；写操作形状由服务端确定，模型只能"选执行哪条已批准动作"。
- **只读白名单 deny-by-default**：第①段只允许具名只读操作，**参数是具名参数不是自由 `args[]`**；任何非白名单操作/参数一律拒。
- **幂等主防重 = lark-cli 原生 `--idempotency-key`**（已核实 `task +create`/`im +messages-send` 均支持），值 = `<job_id>:<action_key>`；描述指纹仅辅助对账。
- **审批/OAuth 挑战必须有状态落库**：token 只存**哈希**、绑定 job/操作人、单次消费（`used_at`/`consumed_at`）、带 `expires_at`；登录会话 token 才是无状态 HMAC（本计划不含登录，Phase 3）。
- **schema Postgres 可移植**：显式主键（TEXT/UUID）、无 `AUTOINCREMENT`、时间戳存 epoch 毫秒 `INTEGER`、布尔用 `INTEGER` 0/1、JSON 存 `TEXT`（应用层序列化）。
- **`send_dm` v1 默认关**：类型保留，`canonicalizeActions` 默认不产出，除非显式 `enableNotify:true`。
- **不真写**：本计划零飞书副作用；所有写-argv 只构造+单测，不 spawn。
- **已核实真实 lark-cli flag**：搜人用 `contact +search-user --query`（`--user-ids` 是 open_id 反查）；`task +create` 用显式 `--summary/--description/--due/--assignee/--idempotency-key/--as user`。
- 每次改动走 TDD：先写失败测试 → 跑挂 → 最小实现 → 跑过 → commit。

---

## File Structure

```
mstd-orchestrator/
  package.json                       # 修改：加 better-sqlite3(dep) + vitest(devDep) + test 脚本
  vitest.config.mjs                  # 新建
  server/
    db/
      index.mjs                      # openDb(path) / migrate(db)
      migrations/001_init.sql        # v1 全量 schema（Postgres 可移植）
    safety/
      lark-read.mjs                  # buildLarkReadArgs(op, params) -> string[]
      intent-schema.mjs              # validateIntent(raw) -> { card_text, items[] }
      action-dsl.mjs                 # canonicalJson / stableHash / canonicalizeActions
      write-args.mjs                 # buildWriteArgs(action, idempotencyKey) -> string[]
      approval.mjs                   # issueApprovalToken / consumeApprovalToken
      auth-challenge.mjs             # createAuthChallenge / consumeAuthChallenge
      action-store.mjs               # deriveIdempotencyKey / recordActions / actionsToExecute / markStatus
  test/
    smoke.test.mjs  db.test.mjs  lark-read.test.mjs  intent-schema.test.mjs
    action-dsl.test.mjs  write-args.test.mjs  approval.test.mjs
    auth-challenge.test.mjs  action-store.test.mjs
```

---

## Phase 0 · 基座

### Task 0.1: 运行/测试基座（deps + vitest 冒烟）

**Files:**
- Modify: `mstd-orchestrator/package.json`
- Create: `mstd-orchestrator/vitest.config.mjs`
- Test: `mstd-orchestrator/test/smoke.test.mjs`

**Interfaces:**
- Produces: `npm test` 跑 vitest；`better-sqlite3` 可 `import` 并开内存库。

- [ ] **Step 1: 写失败的冒烟测试**

`mstd-orchestrator/test/smoke.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

describe("smoke", () => {
  it("vitest runs", () => {
    expect(1 + 1).toBe(2);
  });
  it("better-sqlite3 opens an in-memory db", () => {
    const db = new Database(":memory:");
    const row = db.prepare("SELECT 1 AS n").get();
    expect(row.n).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败（依赖未装）**

Run: `cd mstd-orchestrator && npm test`
Expected: FAIL —— `Cannot find package 'vitest'` 或 `better-sqlite3` 未安装。

- [ ] **Step 3: 加依赖与脚本**

修改 `mstd-orchestrator/package.json`：在 `"devDependencies"` 加 `"vitest": "^4.0.15"`；新增顶层 `"dependencies": { "better-sqlite3": "^12.2.0" }`；在（新增）`"scripts"` 加：
```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```
创建 `mstd-orchestrator/vitest.config.mjs`:
```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",
  },
});
```
然后安装：Run `cd mstd-orchestrator && npm install`
Expected: 装上 vitest + better-sqlite3（better-sqlite3 会本地编译，macOS 需 Xcode CLT）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npm test`
Expected: PASS —— 2 passed。

- [ ] **Step 5: Commit**

```bash
cd mstd-orchestrator
git add package.json package-lock.json vitest.config.mjs test/smoke.test.mjs 2>/dev/null || \
  echo "(非 git 仓库则跳过 git；见 spec 依赖：待 git init)"
git commit -m "chore(mstd-ui): add vitest + better-sqlite3 runtime foundation" 2>/dev/null || true
```
> 注：`MSTD_automation` 当前非 git 仓库（见 spec 前置依赖）。若尚未 `git init`，本计划所有 commit 步骤先记录预期改动，待版本管理就绪后统一纳入。

---

### Task 0.2: DB 模块 + v1 全量 schema（Postgres 可移植）

**Files:**
- Create: `mstd-orchestrator/server/db/index.mjs`
- Create: `mstd-orchestrator/server/db/migrations/001_init.sql`
- Test: `mstd-orchestrator/test/db.test.mjs`

**Interfaces:**
- Produces:
  - `openDb(path = ":memory:") -> Database`（better-sqlite3 实例，已开 `PRAGMA foreign_keys=ON`）
  - `migrate(db) -> void`（幂等地建全部 v1 表）
- Consumes: better-sqlite3（Task 0.1）。

- [ ] **Step 1: 写失败测试（表存在 + UNIQUE 生效）**

`mstd-orchestrator/test/db.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";

const TABLES = [
  "users", "orch_jobs", "job_events", "job_draft",
  "decisions", "job_actions", "auth_challenges", "approval_tokens",
];

describe("db migrate", () => {
  it("creates all v1 tables", () => {
    const db = openDb();
    migrate(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    db.close();
  });

  it("migrate is idempotent", () => {
    const db = openDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it("job_actions enforces UNIQUE(job_id, action_key)", () => {
    const db = openDb();
    migrate(db);
    const ins = db.prepare(
      `INSERT INTO job_actions (id, job_id, action_key, kind, canonical_payload_json, payload_hash, idempotency_key, status, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run("a1", "job1", "k1", "create_task", "{}", "h", "job1:k1", "pending", 1);
    expect(() =>
      ins.run("a2", "job1", "k1", "create_task", "{}", "h", "job1:k1", "pending", 2)
    ).toThrow(/UNIQUE/i);
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/db.test.mjs`
Expected: FAIL —— `Cannot find module '../server/db/index.mjs'`。

- [ ] **Step 3: 写 migration SQL**

`mstd-orchestrator/server/db/migrations/001_init.sql`（Postgres 可移植：TEXT 主键、epoch ms INTEGER、JSON→TEXT、bool→INTEGER）:
```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  feishu_open_id TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orch_jobs (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  title TEXT,
  params_json TEXT,
  status TEXT NOT NULL,
  created_by TEXT,
  thread_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_draft (
  job_id TEXT PRIMARY KEY,
  card_text TEXT,
  items_json TEXT,
  action_set_json TEXT,
  raw_output TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decision TEXT NOT NULL,
  edited_items_json TEXT,
  approved_action_keys_json TEXT,
  payload_hash_at_decision TEXT,
  approval_token_id TEXT,
  note TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_open_id TEXT,
  canonical_payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  external_ref TEXT,
  result_json TEXT,
  ts INTEGER NOT NULL,
  UNIQUE (job_id, action_key)
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  redirect_after TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS approval_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  job_id TEXT NOT NULL,
  issued_to_open_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
```

- [ ] **Step 4: 写 DB 模块**

`mstd-orchestrator/server/db/index.mjs`:
```js
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ":memory:") {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db) {
  const sql = readFileSync(join(HERE, "migrations", "001_init.sql"), "utf8");
  db.exec(sql);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/db.test.mjs`
Expected: PASS —— 3 passed（含 UNIQUE 抛错）。

- [ ] **Step 6: Commit**

```bash
git add server/db/index.mjs server/db/migrations/001_init.sql test/db.test.mjs
git commit -m "feat(mstd-ui): v1 db schema (Postgres-portable) + migrate"
```

---

## Phase 1 · 安全内核

### Task 1.1: `lark_read` deny-by-default 只读白名单（纯函数）

**Files:**
- Create: `mstd-orchestrator/server/safety/lark-read.mjs`
- Test: `mstd-orchestrator/test/lark-read.test.mjs`

**Interfaces:**
- Produces: `buildLarkReadArgs(op, params = {}) -> string[]`。合法 `op` ∈ `{ "search_minutes", "get_transcript", "search_user" }`；未知 op 或缺必填参数抛 `Error`。产出的 argv **永不含写动词**。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/lark-read.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { buildLarkReadArgs } from "../server/safety/lark-read.mjs";

describe("buildLarkReadArgs", () => {
  it("search_minutes -> minutes +search read argv", () => {
    expect(buildLarkReadArgs("search_minutes")).toEqual([
      "minutes", "+search", "--owner-ids", "me", "--as", "user",
    ]);
  });

  it("get_transcript requires minute_token and maps to +detail", () => {
    expect(buildLarkReadArgs("get_transcript", { minute_token: "mt_1" })).toEqual([
      "minutes", "+detail", "--minute-tokens", "mt_1",
      "--transcript", "--as", "user", "--output-dir", "./out",
    ]);
  });

  it("search_user uses --query (name search), not --user-ids", () => {
    const argv = buildLarkReadArgs("search_user", { query: "张三" });
    expect(argv).toEqual([
      "contact", "+search-user", "--query", "张三", "--as", "user",
    ]);
    expect(argv).not.toContain("--user-ids");
  });

  it("rejects unknown op (deny-by-default)", () => {
    expect(() => buildLarkReadArgs("delete_everything")).toThrow(/unknown|不允许/i);
  });

  it("rejects missing required param", () => {
    expect(() => buildLarkReadArgs("get_transcript")).toThrow(/minute_token/);
  });

  it("never produces write verbs", () => {
    for (const op of ["search_minutes", "search_user", "get_transcript"]) {
      const params = op === "get_transcript" ? { minute_token: "x" } : { query: "x" };
      const joined = buildLarkReadArgs(op, params).join(" ");
      expect(joined).not.toMatch(/\+create|messages-send|--yes|delete|recall/);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/lark-read.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/safety/lark-read.mjs`:
```js
// deny-by-default：只有下列具名只读操作被允许；参数是具名参数，绝不接受自由 args[]。
const READ_OPS = {
  search_minutes: () => [
    "minutes", "+search", "--owner-ids", "me", "--as", "user",
  ],
  get_transcript: (p) => {
    if (!p.minute_token) throw new Error("get_transcript 缺少必填参数 minute_token");
    return [
      "minutes", "+detail", "--minute-tokens", String(p.minute_token),
      "--transcript", "--as", "user", "--output-dir", "./out",
    ];
  },
  search_user: (p) => {
    if (!p.query) throw new Error("search_user 缺少必填参数 query");
    return ["contact", "+search-user", "--query", String(p.query), "--as", "user"];
  },
};

export function buildLarkReadArgs(op, params = {}) {
  const build = READ_OPS[op];
  if (!build) throw new Error(`unknown/不允许的只读操作: ${op}`);
  return build(params);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/lark-read.test.mjs`
Expected: PASS —— 6 passed。

- [ ] **Step 5: Commit**

```bash
git add server/safety/lark-read.mjs test/lark-read.test.mjs
git commit -m "feat(mstd-ui): deny-by-default lark_read allowlist (named read ops)"
```

---

### Task 1.2: 意图 schema 校验器（第①段"不可信草稿"契约）

**Files:**
- Create: `mstd-orchestrator/server/safety/intent-schema.mjs`
- Test: `mstd-orchestrator/test/intent-schema.test.mjs`

**Interfaces:**
- Produces:
  - `validateIntent(raw) -> { card_text: string, items: Item[] }`，`Item = { owner_name: string, task: string, due: string|null, suggested_open_id: string|null, confidence: "high"|"low" }`。
  - 校验失败抛 `IntentValidationError`（`class`，带 `.reason`）。
- 说明：模型产出**不可信**，必过此校验才进审批；不猜、不硬解析。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/intent-schema.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { validateIntent, IntentValidationError } from "../server/safety/intent-schema.mjs";

const good = {
  card_text: "请确认以下待办",
  items: [
    { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" },
    { owner_name: "小李", task: "订会议室", due: null, suggested_open_id: null, confidence: "low" },
  ],
};

describe("validateIntent", () => {
  it("accepts a well-formed intent and normalizes", () => {
    const out = validateIntent(good);
    expect(out.card_text).toBe("请确认以下待办");
    expect(out.items).toHaveLength(2);
    expect(out.items[1].suggested_open_id).toBeNull();
  });

  it("rejects non-object", () => {
    expect(() => validateIntent(null)).toThrow(IntentValidationError);
  });

  it("rejects missing card_text", () => {
    expect(() => validateIntent({ items: [] })).toThrow(/card_text/);
  });

  it("rejects item missing task", () => {
    const bad = { card_text: "x", items: [{ owner_name: "a", confidence: "high" }] };
    expect(() => validateIntent(bad)).toThrow(/task/);
  });

  it("rejects invalid confidence enum", () => {
    const bad = { card_text: "x", items: [{ owner_name: "a", task: "t", confidence: "maybe" }] };
    expect(() => validateIntent(bad)).toThrow(/confidence/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/intent-schema.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/safety/intent-schema.mjs`:
```js
export class IntentValidationError extends Error {
  constructor(reason) {
    super(`意图校验失败: ${reason}`);
    this.name = "IntentValidationError";
    this.reason = reason;
  }
}

function isStr(v) { return typeof v === "string" && v.length > 0; }

export function validateIntent(raw) {
  if (!raw || typeof raw !== "object") throw new IntentValidationError("不是对象");
  if (!isStr(raw.card_text)) throw new IntentValidationError("缺少 card_text");
  if (!Array.isArray(raw.items)) throw new IntentValidationError("items 必须是数组");

  const items = raw.items.map((it, i) => {
    if (!it || typeof it !== "object") throw new IntentValidationError(`items[${i}] 不是对象`);
    if (!isStr(it.owner_name)) throw new IntentValidationError(`items[${i}] 缺少 owner_name`);
    if (!isStr(it.task)) throw new IntentValidationError(`items[${i}] 缺少 task`);
    if (it.confidence !== "high" && it.confidence !== "low") {
      throw new IntentValidationError(`items[${i}] confidence 必须是 high|low`);
    }
    const due = it.due == null ? null : String(it.due);
    const openId = it.suggested_open_id == null ? null : String(it.suggested_open_id);
    return { owner_name: it.owner_name, task: it.task, due, suggested_open_id: openId, confidence: it.confidence };
  });

  return { card_text: raw.card_text, items };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/intent-schema.test.mjs`
Expected: PASS —— 5 passed。

- [ ] **Step 5: Commit**

```bash
git add server/safety/intent-schema.mjs test/intent-schema.test.mjs
git commit -m "feat(mstd-ui): intent schema validator (untrusted model draft contract)"
```

---

### Task 1.3: Action DSL 规范化 + 稳定 hash

**Files:**
- Create: `mstd-orchestrator/server/safety/action-dsl.mjs`
- Test: `mstd-orchestrator/test/action-dsl.test.mjs`

**Interfaces:**
- Produces:
  - `canonicalJson(value) -> string`（递归排序对象键的确定性 JSON）
  - `stableHash(value) -> string`（对 `canonicalJson` 取 sha256 hex）
  - `canonicalizeActions({ jobId, items, enableNotify = false }) -> Action[]`
    - `Action = { action_key, kind: "create_task"|"send_dm", payload, payload_hash, requires_open_id: boolean }`
    - v1 每个 item 产 1 条 `create_task`；`enableNotify` 为真才追加 `send_dm`（v1 默认关，见 Global Constraints）。
    - `payload_hash = stableHash(payload)`；`action_key = stableHash({ jobId, kind, payload })`。
- Consumes: `validateIntent` 的 `Item`（Task 1.2）。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/action-dsl.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { canonicalJson, stableHash, canonicalizeActions } from "../server/safety/action-dsl.mjs";

const items = [
  { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_a", confidence: "high" },
  { owner_name: "小李", task: "订会议室", due: null, suggested_open_id: null, confidence: "low" },
];

describe("canonicalJson / stableHash", () => {
  it("orders keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it("stableHash is deterministic and change-sensitive", () => {
    const h1 = stableHash({ a: 1, b: 2 });
    expect(h1).toBe(stableHash({ b: 2, a: 1 }));
    expect(h1).not.toBe(stableHash({ a: 1, b: 3 }));
  });
});

describe("canonicalizeActions", () => {
  it("produces one create_task per item, no send_dm by default", () => {
    const actions = canonicalizeActions({ jobId: "job1", items });
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.kind === "create_task")).toBe(true);
    expect(actions[0].payload).toEqual({
      title: "写周报", description: "", due_date: "2026-07-15", assignee_open_id: "ou_a",
    });
  });

  it("flags requires_open_id when assignee is null", () => {
    const actions = canonicalizeActions({ jobId: "job1", items });
    expect(actions[0].requires_open_id).toBe(false);
    expect(actions[1].requires_open_id).toBe(true);
  });

  it("same input -> same action_key/hash; edit -> different", () => {
    const a1 = canonicalizeActions({ jobId: "job1", items })[0];
    const a2 = canonicalizeActions({ jobId: "job1", items })[0];
    expect(a1.action_key).toBe(a2.action_key);
    const edited = canonicalizeActions({
      jobId: "job1",
      items: [{ ...items[0], task: "写月报" }],
    })[0];
    expect(edited.action_key).not.toBe(a1.action_key);
  });

  it("action_key is job-scoped", () => {
    const a = canonicalizeActions({ jobId: "jobA", items })[0];
    const b = canonicalizeActions({ jobId: "jobB", items })[0];
    expect(a.action_key).not.toBe(b.action_key);
  });

  it("appends send_dm only when enableNotify", () => {
    const actions = canonicalizeActions({ jobId: "job1", items, enableNotify: true });
    expect(actions.some((a) => a.kind === "send_dm")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/action-dsl.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/safety/action-dsl.mjs`:
```js
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

export function stableHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function createTaskAction(jobId, item) {
  const payload = {
    title: item.task,
    description: "",
    due_date: item.due ?? null,
    assignee_open_id: item.suggested_open_id ?? null,
  };
  const kind = "create_task";
  return {
    action_key: stableHash({ jobId, kind, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    requires_open_id: payload.assignee_open_id == null,
  };
}

function notifyAction(jobId, item) {
  const payload = { to_open_id: item.suggested_open_id ?? null, card_ref: `${jobId}:notify` };
  const kind = "send_dm";
  return {
    action_key: stableHash({ jobId, kind, payload }),
    kind,
    payload,
    payload_hash: stableHash(payload),
    requires_open_id: payload.to_open_id == null,
  };
}

export function canonicalizeActions({ jobId, items, enableNotify = false }) {
  const actions = [];
  for (const item of items) {
    actions.push(createTaskAction(jobId, item));
    if (enableNotify) actions.push(notifyAction(jobId, item));
  }
  return actions;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/action-dsl.test.mjs`
Expected: PASS —— 7 passed。

- [ ] **Step 5: Commit**

```bash
git add server/safety/action-dsl.mjs test/action-dsl.test.mjs
git commit -m "feat(mstd-ui): action DSL canonicalization + stable hashing"
```

---

### Task 1.4: 写-argv 确定性构造（含原生幂等 key）

**Files:**
- Create: `mstd-orchestrator/server/safety/write-args.mjs`
- Test: `mstd-orchestrator/test/write-args.test.mjs`

**Interfaces:**
- Produces: `buildWriteArgs(action, idempotencyKey) -> string[]`
  - `create_task` → 显式 flag（已核实真实 lark-cli）：`["task","+create","--as","user","--summary",<title>,"--description",<desc>,"--due",<due?>,"--assignee",<open_id>,"--idempotency-key",<key>]`（`--due` 仅在有值时出现）。
  - `send_dm` → `["im","+messages-send","--as","bot","--user-id",<to>,"--msg-type","interactive","--content",<json>,"--idempotency-key",<key>]`。
  - 未知 kind 抛 `Error`。**不 spawn，仅构造。**
- Consumes: `Action`（Task 1.3）。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/write-args.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { buildWriteArgs } from "../server/safety/write-args.mjs";

const createTask = {
  kind: "create_task",
  payload: { title: "写周报", description: "", due_date: "2026-07-15", assignee_open_id: "ou_a" },
};

describe("buildWriteArgs", () => {
  it("create_task uses explicit flags + idempotency-key", () => {
    const argv = buildWriteArgs(createTask, "job1:k1");
    expect(argv).toEqual([
      "task", "+create", "--as", "user",
      "--summary", "写周报",
      "--description", "",
      "--due", "2026-07-15",
      "--assignee", "ou_a",
      "--idempotency-key", "job1:k1",
    ]);
  });

  it("omits --due when due_date is null", () => {
    const noDue = { kind: "create_task", payload: { title: "t", description: "", due_date: null, assignee_open_id: "ou_a" } };
    expect(buildWriteArgs(noDue, "k").includes("--due")).toBe(false);
  });

  it("always carries the idempotency key", () => {
    expect(buildWriteArgs(createTask, "job1:k1")).toContain("--idempotency-key");
    expect(buildWriteArgs(createTask, "job1:k1")).toContain("job1:k1");
  });

  it("throws on unknown kind", () => {
    expect(() => buildWriteArgs({ kind: "drop_db", payload: {} }, "k")).toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/write-args.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/safety/write-args.mjs`:
```js
function createTaskArgs(payload, key) {
  const argv = ["task", "+create", "--as", "user", "--summary", String(payload.title), "--description", String(payload.description ?? "")];
  if (payload.due_date != null) argv.push("--due", String(payload.due_date));
  argv.push("--assignee", String(payload.assignee_open_id), "--idempotency-key", key);
  return argv;
}

function sendDmArgs(payload, key) {
  const content = JSON.stringify({ ref: payload.card_ref });
  return ["im", "+messages-send", "--as", "bot", "--user-id", String(payload.to_open_id), "--msg-type", "interactive", "--content", content, "--idempotency-key", key];
}

export function buildWriteArgs(action, idempotencyKey) {
  if (action.kind === "create_task") return createTaskArgs(action.payload, idempotencyKey);
  if (action.kind === "send_dm") return sendDmArgs(action.payload, idempotencyKey);
  throw new Error(`unknown action kind: ${action.kind}`);
}
```
> Phase 4 真写前，用 `lark-cli task +create ... --dry-run`（已核实支持，打印请求不执行）对真实 argv 做零副作用验证；`--content` 卡片模板正文在 Phase 4 定稿。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/write-args.test.mjs`
Expected: PASS —— 4 passed。

- [ ] **Step 5: Commit**

```bash
git add server/safety/write-args.mjs test/write-args.test.mjs
git commit -m "feat(mstd-ui): deterministic write-argv builder with native idempotency-key"
```

---

### Task 1.5: 审批挑战 token（预签发/校验/单次/防重放/过期）

**Files:**
- Create: `mstd-orchestrator/server/safety/approval.mjs`
- Test: `mstd-orchestrator/test/approval.test.mjs`

**Interfaces:**
- Produces:
  - `issueApprovalToken(db, { jobId, issuedToOpenId, ttlMs, now }) -> { token }`（返回明文 token 一次；DB 只存 sha256 哈希）
  - `consumeApprovalToken(db, { token, jobId, now }) -> { ok: boolean, reason?: string, issuedToOpenId?: string }`
    - 校验：哈希命中、未过期、`used_at` 为空、`job_id` 匹配；成功即写 `used_at`（单次）。
- Consumes: `openDb/migrate`（Task 0.2）；`node:crypto`。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/approval.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { issueApprovalToken, consumeApprovalToken } from "../server/safety/approval.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

describe("approval token", () => {
  it("issues and consumes once", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", now: 2000 });
    expect(r.ok).toBe(true);
    expect(r.issuedToOpenId).toBe("ou_a");
  });

  it("rejects replay (already used)", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    consumeApprovalToken(db, { token, jobId: "job1", now: 2000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", now: 3000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/used|已使用/i);
  });

  it("rejects expired", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 1000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "job1", now: 5000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired|过期/i);
  });

  it("rejects wrong job binding", () => {
    const { token } = issueApprovalToken(db, { jobId: "job1", issuedToOpenId: "ou_a", ttlMs: 60000, now: 1000 });
    const r = consumeApprovalToken(db, { token, jobId: "jobX", now: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/job|绑定/i);
  });

  it("rejects unknown token", () => {
    const r = consumeApprovalToken(db, { token: "nope", jobId: "job1", now: 2000 });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/approval.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/safety/approval.mjs`:
```js
import { randomBytes, randomUUID, createHash } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function issueApprovalToken(db, { jobId, issuedToOpenId, ttlMs, now = Date.now() }) {
  const token = randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO approval_tokens (id, token_hash, job_id, issued_to_open_id, issued_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).run(randomUUID(), sha256(token), jobId, issuedToOpenId, now, now + ttlMs);
  return { token };
}

export function consumeApprovalToken(db, { token, jobId, now = Date.now() }) {
  const row = db.prepare(`SELECT * FROM approval_tokens WHERE token_hash = ?`).get(sha256(token));
  if (!row) return { ok: false, reason: "unknown token" };
  if (row.used_at != null) return { ok: false, reason: "token already used (已使用)" };
  if (now > row.expires_at) return { ok: false, reason: "token expired (过期)" };
  if (row.job_id !== jobId) return { ok: false, reason: "job binding mismatch (绑定不符)" };
  db.prepare(`UPDATE approval_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`).run(now, row.id);
  return { ok: true, issuedToOpenId: row.issued_to_open_id };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/approval.test.mjs`
Expected: PASS —— 5 passed。

- [ ] **Step 5: Commit**

```bash
git add server/safety/approval.mjs test/approval.test.mjs
git commit -m "feat(mstd-ui): single-use, job-bound, expiring approval tokens (hash-stored)"
```

---

### Task 1.6: OAuth 挑战（state/nonce 防 CSRF/重放）

**Files:**
- Create: `mstd-orchestrator/server/safety/auth-challenge.mjs`
- Test: `mstd-orchestrator/test/auth-challenge.test.mjs`

**Interfaces:**
- Produces:
  - `createAuthChallenge(db, { redirectAfter, ttlMs, now }) -> { state, nonce }`
  - `consumeAuthChallenge(db, { state, nonce, now }) -> { ok: boolean, reason?: string, redirectAfter?: string }`
    - 校验：state 存在、nonce 匹配、未过期、未消费；成功即写 `consumed_at`（单次）。
- Consumes: `openDb/migrate`（Task 0.2）；`node:crypto`。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/auth-challenge.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { createAuthChallenge, consumeAuthChallenge } from "../server/safety/auth-challenge.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

describe("oauth challenge", () => {
  it("creates and consumes once with matching nonce", () => {
    const { state, nonce } = createAuthChallenge(db, { redirectAfter: "/board", ttlMs: 60000, now: 1000 });
    const r = consumeAuthChallenge(db, { state, nonce, now: 2000 });
    expect(r.ok).toBe(true);
    expect(r.redirectAfter).toBe("/board");
  });

  it("rejects replay", () => {
    const { state, nonce } = createAuthChallenge(db, { redirectAfter: "/", ttlMs: 60000, now: 1000 });
    consumeAuthChallenge(db, { state, nonce, now: 2000 });
    const r = consumeAuthChallenge(db, { state, nonce, now: 3000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/used|consumed|已/i);
  });

  it("rejects nonce mismatch", () => {
    const { state } = createAuthChallenge(db, { redirectAfter: "/", ttlMs: 60000, now: 1000 });
    const r = consumeAuthChallenge(db, { state, nonce: "wrong", now: 2000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nonce/i);
  });

  it("rejects expired", () => {
    const { state, nonce } = createAuthChallenge(db, { redirectAfter: "/", ttlMs: 1000, now: 1000 });
    const r = consumeAuthChallenge(db, { state, nonce, now: 5000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired|过期/i);
  });

  it("rejects unknown state", () => {
    const r = consumeAuthChallenge(db, { state: "nope", nonce: "x", now: 2000 });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/auth-challenge.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/safety/auth-challenge.mjs`:
```js
import { randomBytes } from "node:crypto";

export function createAuthChallenge(db, { redirectAfter = "/", ttlMs, now = Date.now() }) {
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  db.prepare(
    `INSERT INTO auth_challenges (state, nonce, redirect_after, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(state, nonce, redirectAfter, now, now + ttlMs);
  return { state, nonce };
}

export function consumeAuthChallenge(db, { state, nonce, now = Date.now() }) {
  const row = db.prepare(`SELECT * FROM auth_challenges WHERE state = ?`).get(state);
  if (!row) return { ok: false, reason: "unknown state" };
  if (row.consumed_at != null) return { ok: false, reason: "already consumed (已消费)" };
  if (now > row.expires_at) return { ok: false, reason: "expired (过期)" };
  if (row.nonce !== nonce) return { ok: false, reason: "nonce mismatch" };
  db.prepare(`UPDATE auth_challenges SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL`).run(now, state);
  return { ok: true, redirectAfter: row.redirect_after };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/auth-challenge.test.mjs`
Expected: PASS —— 5 passed。

- [ ] **Step 5: Commit**

```bash
git add server/safety/auth-challenge.mjs test/auth-challenge.test.mjs
git commit -m "feat(mstd-ui): OAuth state/nonce challenge store (single-use, expiring)"
```

---

### Task 1.7: 动作状态机 + 幂等落库 + 重试选择

**Files:**
- Create: `mstd-orchestrator/server/safety/action-store.mjs`
- Test: `mstd-orchestrator/test/action-store.test.mjs`

**Interfaces:**
- Produces:
  - `deriveIdempotencyKey(jobId, actionKey) -> string`（= `${jobId}:${actionKey}`）
  - `recordActions(db, jobId, actions) -> void`（插 `job_actions`，status=`pending`，`idempotency_key` 由上函数派生；重复 `action_key` 由 UNIQUE 挡，重录忽略已存在）
  - `actionsToExecute(db, jobId) -> Row[]`（**只返回 status ∈ {pending, failed}**，排除 succeeded/executing/unknown）
  - `markStatus(db, actionId, status, resultJson = null) -> void`
- 状态：`pending / executing / succeeded / failed / unknown`。
- Consumes: `Action`（Task 1.3）；`openDb/migrate`（Task 0.2）。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/action-store.test.mjs`:
```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { deriveIdempotencyKey, recordActions, actionsToExecute, markStatus } from "../server/safety/action-store.mjs";

let db;
beforeEach(() => { db = openDb(); migrate(db); });

const actions = [
  { action_key: "k1", kind: "create_task", payload: { title: "a" }, payload_hash: "h1", target_open_id: "ou_a" },
  { action_key: "k2", kind: "create_task", payload: { title: "b" }, payload_hash: "h2", target_open_id: "ou_b" },
];

describe("action-store", () => {
  it("derives idempotency key", () => {
    expect(deriveIdempotencyKey("job1", "k1")).toBe("job1:k1");
  });

  it("records actions as pending with idempotency key", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    expect(rows).toHaveLength(2);
    expect(rows[0].idempotency_key).toBe("job1:k1");
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("recording is idempotent on (job_id, action_key)", () => {
    recordActions(db, "job1", actions);
    expect(() => recordActions(db, "job1", actions)).not.toThrow();
    const count = db.prepare("SELECT COUNT(*) AS n FROM job_actions WHERE job_id='job1'").get().n;
    expect(count).toBe(2);
  });

  it("actionsToExecute returns only pending and failed", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    markStatus(db, rows[0].id, "succeeded", JSON.stringify({ task_id: "t1" }));
    markStatus(db, rows[1].id, "failed");
    const retry = actionsToExecute(db, "job1");
    expect(retry.map((r) => r.action_key)).toEqual(["k2"]); // succeeded 排除、failed 保留
  });

  it("excludes executing/unknown from retry set", () => {
    recordActions(db, "job1", actions);
    const rows = actionsToExecute(db, "job1");
    markStatus(db, rows[0].id, "executing");
    markStatus(db, rows[1].id, "unknown");
    expect(actionsToExecute(db, "job1")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/action-store.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/safety/action-store.mjs`:
```js
import { randomUUID } from "node:crypto";

export function deriveIdempotencyKey(jobId, actionKey) {
  return `${jobId}:${actionKey}`;
}

export function recordActions(db, jobId, actions, now = Date.now()) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO job_actions
       (id, job_id, action_key, kind, target_open_id, canonical_payload_json, payload_hash, idempotency_key, status, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  const tx = db.transaction((items) => {
    for (const a of items) {
      stmt.run(
        randomUUID(), jobId, a.action_key, a.kind, a.target_open_id ?? null,
        JSON.stringify(a.payload), a.payload_hash, deriveIdempotencyKey(jobId, a.action_key), now
      );
    }
  });
  tx(actions);
}

export function actionsToExecute(db, jobId) {
  return db.prepare(
    `SELECT * FROM job_actions WHERE job_id = ? AND status IN ('pending','failed') ORDER BY ts, id`
  ).all(jobId);
}

export function markStatus(db, actionId, status, resultJson = null) {
  db.prepare(`UPDATE job_actions SET status = ?, result_json = ? WHERE id = ?`).run(status, resultJson, actionId);
}
```
> 注：`INSERT OR IGNORE` 是 SQLite 语法；迁 Postgres 时改 `ON CONFLICT (job_id, action_key) DO NOTHING`（Global Constraints 的可移植性在此处以 DB 方言适配层承接，Phase 3 抽 `db` 适配时统一）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/action-store.test.mjs`
Expected: PASS —— 5 passed。

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `cd mstd-orchestrator && npm test`
Expected: PASS —— 全部（smoke/db/lark-read/intent/action-dsl/write-args/approval/auth-challenge/action-store）通过。

- [ ] **Step 6: Commit**

```bash
git add server/safety/action-store.mjs test/action-store.test.mjs
git commit -m "feat(mstd-ui): idempotent action store + retry selection (pending/failed only)"
```

---

## 后续 Phase（各自独立成计划）

本计划交付**安全地基**（Phase 0+1，可完整单测、零副作用）。以下各自开工时用 `superpowers:writing-plans` 展开：

- **Phase 2 · Pi RPC 冻结**：升级 `supervisor/pi-client.mjs`（原生 `id`、`agent_end`&`!willRetry` 终止、`agent_idle/idle` 幻象删除、stderr 合成事件、parse-error 显式、env allowlist）；把首份 fixture 转正式；建并测 Pi 事件→SSE 翻译器。**依赖本计划**（安全内核）+ spec 附录 A 的实测事件协议。
- **Phase 3 · Server 基座**：Express jobs API、SSE、飞书 OAuth（用 Task 1.6 挑战 + Task 1.5 审批 token）、持久化批量写、DB 方言适配（SQLite↔Postgres）。
- **Phase 4 · UI + 打开真写**：mstd-ui（抽定价 app 原子 + 重建状态机）、审批动作清单编辑器；第②段执行器 `executeApprovedAction`（用 Task 1.4 `buildWriteArgs` + `--dry-run` 预检 + Task 1.7 状态机/对账），只打测试群/测试清单；`verify` 收尾走 Browser 插件。

---

## Self-Review

**Spec 覆盖（Phase 0+1 范围内）**：
- S1 只读白名单 → Task 1.1 ✓；S3 意图 schema → Task 1.2 ✓；S2 action DSL+hash → Task 1.3 ✓；写-argv+原生幂等 key（S2/S4）→ Task 1.4 ✓；S5 审批 token → Task 1.5 ✓、OAuth 挑战 → Task 1.6 ✓；S4 幂等状态机+重试选择 → Task 1.7 ✓；数据模型 → Task 0.2 ✓；基座 → Task 0.1 ✓。
- 超出 Phase 0+1 的（Pi 适配、OAuth 端点、真写执行、UI）已明确归入后续 Phase 计划，非本计划遗漏。

**Placeholder 扫描**：无 TBD/TODO；每个 code step 给了完整可运行代码与测试；`--content` 卡片正文与飞书 `--data` 细节标注在 Phase 4 定稿（本计划的 `send_dm` 默认关、不执行，不阻塞）。

**类型一致性**：`Action` 的字段（`action_key/kind/payload/payload_hash/target_open_id/requires_open_id`）在 Task 1.3 产出、Task 1.4/1.7 消费一致；`stableHash`/`canonicalJson` 单一来源（action-dsl）；`deriveIdempotencyKey` 在 Task 1.7 定义并被 write 流程引用；DB 列名与 `001_init.sql` 一致（`idempotency_key`/`payload_hash`/`action_key`/`used_at`/`consumed_at`）。
