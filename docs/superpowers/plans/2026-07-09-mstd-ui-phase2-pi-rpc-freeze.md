# mstd UI · Phase 2（Pi RPC 冻结）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冻结 Pi RPC 事件协议，产出经真机 fixture 覆盖的**纯函数**："Pi 事件 → 前端 SSE 翻译器" + "JSONL 解析 / 终止判定 / env 白名单"，并据此**加固 `supervisor/pi-client.mjs`**，让 Phase 3 的后端能可靠、可审计地驱动 Pi。

**Architecture:** 把 pi-client 现在缠在 spawn 回调里的解析/判完成/翻译逻辑**抽成可单测的纯函数**（`server/pi/*`），spawn 壳只做进程管理。所有事件形状取自**已实测验证**的类型（`pi-agent-core/dist/types.d.ts`、`modes/rpc/rpc-types.d.ts`）与真机 fixture，不猜。真正 spawn Pi 只在一个**手动只读 smoke**里跑（不进单测），单测全部走 fixture。

**Tech Stack:** Node ESM `.mjs` · vitest · 无新增依赖（`server/pi` 纯函数）· 事件源为 Pi 0.80.3 RPC(`--mode rpc`) 的 JSONL-over-stdio。

**上位 spec：** `docs/superpowers/specs/2026-07-09-mstd-ui-reuse-design.md`（见「Pi RPC 契约」段 + 附录 A 的实测事件协议）。前置：Phase 0+1 安全内核已完成（`docs/superpowers/plans/2026-07-09-mstd-ui-phase0-1-safety-core.md`）。

## Global Constraints

- **事件真身（已实测，不可臆造）**：顶层事件 `agent_start / turn_start / message_start / message_update / message_end / turn_end / tool_execution_start{toolCallId,toolName,args} / tool_execution_update / tool_execution_end{toolCallId,toolName,result:{content,details},isError} / agent_end{messages,willRetry}`；RPC ack `{id,type:"response",command,success}`。
- **`message_update.assistantMessageEvent.type` 九种（已实测）**：`text_start/text_delta/text_end`、`thinking_start/thinking_delta/thinking_end`、`toolcall_start/toolcall_delta/toolcall_end`；`*_delta` 带 `delta`（增量串），`*_end` 带 `content`（定稿），`*_start` 带 `partial`。**增量正文取 `text_delta.delta`**。
- **终止判定**：唯一终止是 `agent_end` 且 `willRetry` 为假；**`agent_idle`/`idle` 不存在**（现 pi-client:73 是幻象，必须删）；重试用 `auto_retry_start/end`。
- **correlation id 原生**：命令与 response 均带 `id?`；流式事件不带 id（每 job 一进程，完成靠终止事件）。
- **stderr 非 Pi 事件**：Pi 的 stdout 事件流里没有 stderr；由 supervisor 侧捕获 child.stderr 合成 `{type:"stderr",text}` 注入监听流。
- **env 白名单**：spawn Pi 的 env 只透 `PATH/HOME/LANG/TZ` + `CZ_GPT_KEY/CZ_CLAUDE_KEY/DEEPSEEK_KEY` + `LARK_*` + `PI_*` + 显式 overrides；不再 `{...process.env}` 全继承。
- **纯函数可测**：翻译器/解析/终止/env 全部纯函数，单测走 fixture；真 spawn 只手动 smoke。
- TDD：先失败测试 → 跑挂 → 最小实现 → 跑过 → commit。非 git 提交按现分支约定（当前工作在 `fix/phase0-1-safety-hardening` 之后的新分支上，见执行说明）。

---

## File Structure

```
mstd-orchestrator/
  test/fixtures/pi-events.jsonl        # 新建：PII-free 忠实 fixture（覆盖全部事件+边界）
  server/pi/
    rpc-protocol.mjs                   # 新建：parseRpcLine / isTerminalEvent / buildPiEnv（纯）
    event-translator.mjs               # 新建：translatePiEvent（纯）
    stream-processor.mjs               # 新建：makeStreamProcessor（纯，喂行→回调翻译事件/终止）
  supervisor/pi-client.mjs             # 修改：用上述纯函数；加 runJob；修 prompt 终止；stderr；env 白名单
  supervisor/pi-smoke.mjs              # 新建：手动只读真机 smoke（不进单测）
  test/
    pi-rpc-protocol.test.mjs           # 新建
    pi-event-translator.test.mjs       # 新建
    pi-stream-processor.test.mjs       # 新建
```

---

## Task 1: 冻结事件 fixture（PII-free，忠实真机形状）

**Files:**
- Create: `mstd-orchestrator/test/fixtures/pi-events.jsonl`
- Test: `mstd-orchestrator/test/pi-fixture.test.mjs`

**Interfaces:**
- Produces: 一份原始 Pi stdout JSONL fixture，覆盖全部事件类型 + 边界（malformed 行、未知事件、`agent_end willRetry:true` 后接 `willRetry:false`）。后续 Task 2-4 均以它为准。

- [ ] **Step 1: 写 fixture 文件**

`mstd-orchestrator/test/fixtures/pi-events.jsonl`（逐行 JSON；含一条故意非法行与一条未知事件；无任何真实业务数据）:
```jsonl
{"id":"job-1","type":"response","command":"prompt","success":true}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[]}}
{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0,"partial":{"role":"assistant","content":[]}}}
{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"分析","partial":{}}}
{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"分析完成","partial":{}}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"partial":{}}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\"args\"","partial":{}}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"name":"lark"},"partial":{}}}
{"type":"tool_execution_start","toolCallId":"tc_1","toolName":"lark","args":{"args":["minutes","+search"]}}
{"type":"tool_execution_end","toolCallId":"tc_1","toolName":"lark","result":{"content":[{"type":"text","text":"(ok)"}],"details":{"exitCode":0}},"isError":false}
{"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[]}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[]}}
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0,"partial":{}}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"结果是","partial":{}}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"三条","partial":{}}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"结果是三条","partial":{}}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"结果是三条"}]}}
this is not valid json
{"type":"some_future_event","foo":1}
{"type":"agent_end","willRetry":true,"messages":[]}
{"type":"agent_end","willRetry":false,"messages":[{"role":"assistant","content":[{"type":"text","text":"结果是三条"}]}]}
```

- [ ] **Step 2: 写测试确认 fixture 可读且覆盖关键事件**

`mstd-orchestrator/test/pi-fixture.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "pi-events.jsonl");

describe("pi-events fixture", () => {
  it("has one intentionally-malformed line and covers key event types", () => {
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
    let malformed = 0;
    const types = new Set();
    const amTypes = new Set();
    for (const l of lines) {
      let m;
      try { m = JSON.parse(l); } catch { malformed++; continue; }
      types.add(m.type);
      if (m.type === "message_update") amTypes.add(m.assistantMessageEvent.type);
    }
    expect(malformed).toBe(1);
    for (const t of ["agent_start", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "agent_end", "some_future_event"]) {
      expect(types).toContain(t);
    }
    for (const t of ["text_delta", "thinking_delta", "toolcall_start"]) expect(amTypes).toContain(t);
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/pi-fixture.test.mjs`
Expected: PASS —— 1 passed。

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/pi-events.jsonl test/pi-fixture.test.mjs
git commit -m "test(mstd-ui): freeze PII-free Pi RPC event fixture (verified shapes)"
```

---

## Task 2: RPC 协议纯函数（解析 / 终止 / env 白名单）

**Files:**
- Create: `mstd-orchestrator/server/pi/rpc-protocol.mjs`
- Test: `mstd-orchestrator/test/pi-rpc-protocol.test.mjs`

**Interfaces:**
- Produces:
  - `parseRpcLine(line) -> { ok:true, msg } | { ok:false, kind:"empty" } | { ok:false, kind:"parse_error", raw }`（剥尾 `\r`；空行 → empty；非法 JSON → parse_error，**不静默丢**）
  - `isTerminalEvent(evt) -> boolean`（`evt.type==="agent_end" && !evt.willRetry`）
  - `buildPiEnv(baseEnv, overrides = {}) -> object`（只保留白名单键 + `PI_*` + overrides）

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/pi-rpc-protocol.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { parseRpcLine, isTerminalEvent, buildPiEnv } from "../server/pi/rpc-protocol.mjs";

describe("parseRpcLine", () => {
  it("parses a valid line and strips trailing CR", () => {
    const r = parseRpcLine('{"type":"agent_start"}\r');
    expect(r.ok).toBe(true);
    expect(r.msg.type).toBe("agent_start");
  });
  it("flags empty lines", () => {
    expect(parseRpcLine("   ").ok).toBe(false);
    expect(parseRpcLine("   ").kind).toBe("empty");
  });
  it("flags malformed JSON as parse_error (not silently dropped)", () => {
    const r = parseRpcLine("this is not json");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("parse_error");
    expect(r.raw).toBe("this is not json");
  });
});

describe("isTerminalEvent", () => {
  it("agent_end with willRetry false is terminal", () => {
    expect(isTerminalEvent({ type: "agent_end", willRetry: false })).toBe(true);
  });
  it("agent_end with willRetry true is NOT terminal", () => {
    expect(isTerminalEvent({ type: "agent_end", willRetry: true })).toBe(false);
  });
  it("phantom idle/agent_idle are NOT terminal", () => {
    expect(isTerminalEvent({ type: "agent_idle" })).toBe(false);
    expect(isTerminalEvent({ type: "idle" })).toBe(false);
  });
});

describe("buildPiEnv", () => {
  it("keeps allowlisted keys + PI_*, drops secrets, applies overrides", () => {
    const base = { PATH: "/bin", HOME: "/h", CZ_GPT_KEY: "g", LARK_PROFILE: "p", PI_TELEMETRY: "x", AWS_SECRET_ACCESS_KEY: "leak", RANDOM: "no" };
    const env = buildPiEnv(base, { PI_TELEMETRY: "0", LARK_ALLOW_WRITE: "1" });
    expect(env.PATH).toBe("/bin");
    expect(env.CZ_GPT_KEY).toBe("g");
    expect(env.LARK_PROFILE).toBe("p");
    expect(env.PI_TELEMETRY).toBe("0");        // override wins
    expect(env.LARK_ALLOW_WRITE).toBe("1");    // override injected
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RANDOM).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/pi-rpc-protocol.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/pi/rpc-protocol.mjs`:
```js
const ENV_ALLOW = ["PATH", "HOME", "LANG", "TZ", "CZ_GPT_KEY", "CZ_CLAUDE_KEY", "DEEPSEEK_KEY"];

export function parseRpcLine(line) {
  let s = line;
  if (s.endsWith("\r")) s = s.slice(0, -1);
  if (!s.trim()) return { ok: false, kind: "empty" };
  try {
    return { ok: true, msg: JSON.parse(s) };
  } catch {
    return { ok: false, kind: "parse_error", raw: s };
  }
}

export function isTerminalEvent(evt) {
  return !!evt && evt.type === "agent_end" && !evt.willRetry;
}

export function buildPiEnv(baseEnv, overrides = {}) {
  const out = {};
  for (const k of ENV_ALLOW) if (baseEnv[k] !== undefined) out[k] = baseEnv[k];
  for (const k of Object.keys(baseEnv)) if (k.startsWith("LARK_") || k.startsWith("PI_")) out[k] = baseEnv[k];
  return { ...out, ...overrides };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/pi-rpc-protocol.test.mjs`
Expected: PASS —— 全部通过。

- [ ] **Step 5: Commit**

```bash
git add server/pi/rpc-protocol.mjs test/pi-rpc-protocol.test.mjs
git commit -m "feat(mstd-ui): Pi RPC protocol primitives (parse/terminal/env-allowlist)"
```

---

## Task 3: 事件翻译器（Pi 事件 → 前端 SSE，纯函数）

**Files:**
- Create: `mstd-orchestrator/server/pi/event-translator.mjs`
- Test: `mstd-orchestrator/test/pi-event-translator.test.mjs`

**Interfaces:**
- Produces: `translatePiEvent(evt) -> { event, data } | null`。`null` 表示该 Pi 事件不面向前端（边界事件/被忽略）。映射见实现。
- Consumes: 无（纯）。被 Task 4 的 stream-processor 调用。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/pi-event-translator.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { translatePiEvent } from "../server/pi/event-translator.mjs";

const amEvt = (type, extra = {}) => ({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra } });

describe("translatePiEvent", () => {
  it("text_delta -> assistant_delta with the incremental text", () => {
    expect(translatePiEvent(amEvt("text_delta", { delta: "三条" }))).toEqual({ event: "assistant_delta", data: { text: "三条" } });
  });
  it("thinking_delta -> thinking_status", () => {
    expect(translatePiEvent(amEvt("thinking_delta", { delta: "想" })).event).toBe("thinking_status");
  });
  it("toolcall_* and text_start/end are ignored (null)", () => {
    expect(translatePiEvent(amEvt("toolcall_delta", { delta: "x" }))).toBeNull();
    expect(translatePiEvent(amEvt("text_start"))).toBeNull();
    expect(translatePiEvent(amEvt("text_end", { content: "结果是三条" }))).toBeNull();
  });
  it("tool_execution_start -> tool_start", () => {
    expect(translatePiEvent({ type: "tool_execution_start", toolCallId: "tc_1", toolName: "lark", args: { a: 1 } }))
      .toEqual({ event: "tool_start", data: { toolCallId: "tc_1", toolName: "lark", args: { a: 1 } } });
  });
  it("tool_execution_end -> tool_result", () => {
    const r = translatePiEvent({ type: "tool_execution_end", toolCallId: "tc_1", toolName: "lark", result: { content: [], details: {} }, isError: false });
    expect(r.event).toBe("tool_result");
    expect(r.data.isError).toBe(false);
  });
  it("agent_end willRetry:false -> message_done; willRetry:true -> null", () => {
    expect(translatePiEvent({ type: "agent_end", willRetry: false, messages: [] })).toEqual({ event: "message_done", data: {} });
    expect(translatePiEvent({ type: "agent_end", willRetry: true, messages: [] })).toBeNull();
  });
  it("auto_retry_start/end -> retry_status", () => {
    expect(translatePiEvent({ type: "auto_retry_start" }).event).toBe("retry_status");
    expect(translatePiEvent({ type: "auto_retry_end" }).event).toBe("retry_status");
  });
  it("boundary events (agent_start/turn_*/message_start/message_end) -> null", () => {
    for (const type of ["agent_start", "turn_start", "turn_end", "message_start", "message_end"]) {
      expect(translatePiEvent({ type })).toBeNull();
    }
  });
  it("response ack -> null", () => {
    expect(translatePiEvent({ id: "job-1", type: "response", command: "prompt", success: true })).toBeNull();
  });
  it("synthesized stderr/parse_error -> error", () => {
    expect(translatePiEvent({ type: "stderr", text: "boom" })).toEqual({ event: "error", data: { level: "stderr", text: "boom" } });
    expect(translatePiEvent({ type: "parse_error", raw: "xx" }).event).toBe("error");
  });
  it("unknown top-level event -> unknown (surfaced, not dropped)", () => {
    expect(translatePiEvent({ type: "some_future_event", foo: 1 })).toEqual({ event: "unknown", data: { type: "some_future_event" } });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/pi-event-translator.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/pi/event-translator.mjs`:
```js
const IGNORED_TOP = new Set(["agent_start", "turn_start", "turn_end", "message_start", "message_end", "response"]);

function translateMessageUpdate(am) {
  if (!am) return null;
  const t = am.type;
  if (t === "text_delta") return { event: "assistant_delta", data: { text: am.delta ?? "" } };
  if (t === "thinking_delta" || t === "thinking_start" || t === "thinking_end") {
    return { event: "thinking_status", data: { text: am.delta ?? am.content ?? "" } };
  }
  // text_start/text_end 与 toolcall_*：边界/消息内工具拼装，前端时间线由顶层 tool_execution_* 驱动 → 忽略
  return null;
}

export function translatePiEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  const t = evt.type;
  if (t === "message_update") return translateMessageUpdate(evt.assistantMessageEvent);
  if (t === "tool_execution_start") return { event: "tool_start", data: { toolCallId: evt.toolCallId, toolName: evt.toolName, args: evt.args } };
  if (t === "tool_execution_end") return { event: "tool_result", data: { toolCallId: evt.toolCallId, toolName: evt.toolName, result: evt.result, isError: evt.isError } };
  if (t === "agent_end") return evt.willRetry ? null : { event: "message_done", data: {} };
  if (t === "auto_retry_start") return { event: "retry_status", data: { retrying: true } };
  if (t === "auto_retry_end") return { event: "retry_status", data: { retrying: false } };
  if (t === "stderr") return { event: "error", data: { level: "stderr", text: evt.text } };
  if (t === "parse_error") return { event: "error", data: { level: "parse_error", raw: evt.raw } };
  if (t === "error" || t === "extension_error") return { event: "error", data: { level: t, ...evt } };
  if (IGNORED_TOP.has(t)) return null;
  return { event: "unknown", data: { type: t } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/pi-event-translator.test.mjs`
Expected: PASS —— 全部通过。

- [ ] **Step 5: Commit**

```bash
git add server/pi/event-translator.mjs test/pi-event-translator.test.mjs
git commit -m "feat(mstd-ui): Pi event -> SSE translator (grounded in verified shapes)"
```

---

## Task 4: 流处理器（喂行 → 翻译事件 + 终止 + 最终文本，纯）

**Files:**
- Create: `mstd-orchestrator/server/pi/stream-processor.mjs`
- Test: `mstd-orchestrator/test/pi-stream-processor.test.mjs`

**Interfaces:**
- Consumes: `parseRpcLine`, `isTerminalEvent`（Task 2）；`translatePiEvent`（Task 3）。
- Produces: `makeStreamProcessor({ onEvent, onDone }) -> { pushLine(line), pushStderr(text) }`
  - `pushLine`：解析一行 → parse_error 也作为事件（`{type:"parse_error",raw}`）经翻译器 → `onEvent`；累积最后一条 assistant 文本（从 `message_end` / `agent_end.messages` 的 text 块）；命中终止事件时调 `onDone({ finalText })`（只一次）。
  - `pushStderr`：把 `{type:"stderr",text}` 经翻译器 → `onEvent`。

- [ ] **Step 1: 写失败测试（喂真 fixture）**

`mstd-orchestrator/test/pi-stream-processor.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeStreamProcessor } from "../server/pi/stream-processor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "pi-events.jsonl");

function runFixture() {
  const events = [];
  let done = null;
  const proc = makeStreamProcessor({ onEvent: (e) => events.push(e), onDone: (d) => { done = d; } });
  for (const line of readFileSync(FIXTURE, "utf8").split("\n")) proc.pushLine(line);
  return { events, done };
}

describe("makeStreamProcessor over the frozen fixture", () => {
  it("emits assistant_delta for text_delta lines with the incremental text", () => {
    const { events } = runFixture();
    const deltas = events.filter((e) => e.event === "assistant_delta").map((e) => e.data.text);
    expect(deltas).toEqual(["结果是", "三条"]);
  });
  it("emits tool_start then tool_result", () => {
    const { events } = runFixture();
    const toolEvents = events.filter((e) => e.event === "tool_start" || e.event === "tool_result").map((e) => e.event);
    expect(toolEvents).toEqual(["tool_start", "tool_result"]);
  });
  it("surfaces the malformed line as an error event (not silently dropped)", () => {
    const { events } = runFixture();
    expect(events.some((e) => e.event === "error" && e.data.level === "parse_error")).toBe(true);
  });
  it("surfaces the unknown future event", () => {
    const { events } = runFixture();
    expect(events.some((e) => e.event === "unknown" && e.data.type === "some_future_event")).toBe(true);
  });
  it("does NOT finish on agent_end willRetry:true; finishes on willRetry:false with final text", () => {
    const { events, done } = runFixture();
    expect(done).not.toBeNull();
    expect(done.finalText).toBe("结果是三条");
    // message_done 只应出现一次（willRetry:true 那条不产生 message_done）
    expect(events.filter((e) => e.event === "message_done")).toHaveLength(1);
  });
  it("pushStderr surfaces an error event", () => {
    const events = [];
    const proc = makeStreamProcessor({ onEvent: (e) => events.push(e), onDone: () => {} });
    proc.pushStderr("boom");
    expect(events).toEqual([{ event: "error", data: { level: "stderr", text: "boom" } }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/pi-stream-processor.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/pi/stream-processor.mjs`:
```js
import { parseRpcLine, isTerminalEvent } from "./rpc-protocol.mjs";
import { translatePiEvent } from "./event-translator.mjs";

function textOfMessage(m) {
  if (!m || !Array.isArray(m.content)) return "";
  return m.content.filter((b) => b && b.type === "text").map((b) => b.text).join("");
}

export function makeStreamProcessor({ onEvent, onDone }) {
  let lastAssistant = "";
  let finished = false;

  function handle(evt) {
    // 累积最后一条 assistant 文本（供最终产出）
    if (evt.type === "message_end") {
      const txt = textOfMessage(evt.message);
      if (txt) lastAssistant = txt;
    } else if (evt.type === "agent_end" && !evt.willRetry && Array.isArray(evt.messages)) {
      const last = [...evt.messages].reverse().find((m) => m && m.role === "assistant");
      const txt = textOfMessage(last);
      if (txt) lastAssistant = txt;
    }
    const sse = translatePiEvent(evt);
    if (sse) onEvent(sse);
    if (!finished && isTerminalEvent(evt)) {
      finished = true;
      onDone({ finalText: lastAssistant });
    }
  }

  return {
    pushLine(line) {
      const r = parseRpcLine(line);
      if (r.ok) return handle(r.msg);
      if (r.kind === "parse_error") return handle({ type: "parse_error", raw: r.raw });
      // empty → 忽略
    },
    pushStderr(text) {
      handle({ type: "stderr", text });
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/pi-stream-processor.test.mjs`
Expected: PASS —— 全部通过。

- [ ] **Step 5: Commit**

```bash
git add server/pi/stream-processor.mjs test/pi-stream-processor.test.mjs
git commit -m "feat(mstd-ui): Pi stdout stream processor (fixture-tested, terminal on agent_end!willRetry)"
```

---

## Task 5: 加固 pi-client.mjs（集成纯函数 + runJob + stderr + env）+ 真机 smoke

**Files:**
- Modify: `mstd-orchestrator/supervisor/pi-client.mjs`
- Create: `mstd-orchestrator/supervisor/pi-smoke.mjs`（手动只读真机验证；不进单测）

**Interfaces:**
- Consumes: `server/pi/rpc-protocol.mjs`（`buildPiEnv`）、`server/pi/stream-processor.mjs`（`makeStreamProcessor`）。
- Produces（`startPi(...)` 返回对象新增/修正）：
  - `runJob(promptText, { id = "job", images, onEvent, timeoutMs = 240000 }) -> Promise<{ finalText }>`：发 `{id,type:"prompt",message}`，把每条翻译事件回调 `onEvent`，`agent_end(!willRetry)` 或超时收尾。
  - `prompt(message, opts)`：**修正终止判定**为 `isTerminalEvent`（删幻象 `agent_idle/idle`）。
  - spawn env 改为 `buildPiEnv(process.env, { PI_TELEMETRY:"0", PI_SKIP_VERSION_CHECK:"1", ...env })`。
  - child.stderr **始终**捕获并经 `pushStderr` 注入（不再仅 debug）。

- [ ] **Step 1: 改 `supervisor/pi-client.mjs`**

在 `startPi` 内：把 `child.stdout.on("data")` 的手写切行/`JSON.parse`/累积逻辑替换为一个 per-run 的 `makeStreamProcessor`；env 用 `buildPiEnv`；stderr 始终捕获。示例（关键片段——保留现有 `spawn`/`send`/`on`/`close`/`seenTypes` 对外形状，替换内部）：
```js
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildPiEnv } from "../server/pi/rpc-protocol.mjs";
import { makeStreamProcessor } from "../server/pi/stream-processor.mjs";
import { parseRpcLine, isTerminalEvent } from "../server/pi/rpc-protocol.mjs";

const PI_BIN = join(homedir(), ".hermes", "node", "bin", "pi");

export function startPi({ provider, model, extensions = [], thinking, cwd, env, debug = false } = {}) {
  const args = ["--mode", "rpc", "-a", "--no-session"];
  for (const e of extensions) args.push("-e", e);
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);

  const child = spawn(PI_BIN, args, {
    cwd: cwd || process.cwd(),
    env: buildPiEnv(process.env, { PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...(env || {}) }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  const listeners = new Set();          // 原始事件监听（供 on() 订阅，保持兼容）
  const seenTypes = new Set();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      const r = parseRpcLine(line);
      if (r.ok) { seenTypes.add(r.msg.type); for (const l of listeners) l(r.msg); }
      else if (r.kind === "parse_error") { for (const l of listeners) l({ type: "parse_error", raw: r.raw }); }
    }
  });
  const stderrListeners = new Set();
  child.stderr.on("data", (d) => { const text = d.toString(); if (debug) process.stderr.write(`[pi-stderr] ${text}`); for (const l of stderrListeners) l(text); });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  function runJob(message, { id = "job", images, onEvent = () => {}, timeoutMs = 240000 } = {}) {
    return new Promise((resolve, reject) => {
      const proc = makeStreamProcessor({ onEvent, onDone: ({ finalText }) => { cleanup(); resolve({ finalText }); } });
      const offEvt = on((msg) => proc.pushLine(JSON.stringify(msg)));   // 复用 processor：把已解析事件回灌
      const offErr = (() => { stderrListeners.add(proc.pushStderr); return () => stderrListeners.delete(proc.pushStderr); })();
      const timer = setTimeout(() => { cleanup(); reject(new Error("pi runJob timeout")); }, timeoutMs);
      function cleanup() { clearTimeout(timer); offEvt(); offErr(); }
      send(images ? { id, type: "prompt", message, images } : { id, type: "prompt", message });
    });
  }

  function prompt(message, { images, timeoutMs = 240000 } = {}) {
    return new Promise((resolve, reject) => {
      let lastAssistant = "";
      const timer = setTimeout(() => { off(); reject(new Error("pi prompt timeout")); }, timeoutMs);
      const off = on((msg) => {
        if ((msg.type === "message_end" || msg.type === "message") && msg.message?.role === "assistant" && Array.isArray(msg.message.content)) {
          const txt = msg.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""); if (txt) lastAssistant = txt;
        }
        if (isTerminalEvent(msg)) { clearTimeout(timer); off(); resolve(lastAssistant); }
      });
      send(images ? { type: "prompt", message, images } : { type: "prompt", message });
    });
  }

  function close() {
    return new Promise((res) => { child.on("close", () => res()); try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill(); } catch {}; res(); }, 3000); });
  }

  return { child, send, on, runJob, prompt, close, seenTypes };
}
```
> 注：`runJob` 把 `on()` 收到的（已解析）事件重新 `JSON.stringify` 回灌给 `pushLine`，是为了复用同一条经 fixture 验证的处理路径；性能足够（事件量小），且保证"单测走的处理逻辑"与"运行时"完全一致。

- [ ] **Step 2: 全量单测确认无回归**

Run: `cd mstd-orchestrator && npm test`
Expected: PASS —— Phase 0+1 全部 + Task 1-4 的 Pi 单测全绿（pi-client 的改动不被单测直接覆盖，由下一步真机 smoke 验证）。

- [ ] **Step 3: 写手动只读真机 smoke**

`mstd-orchestrator/supervisor/pi-smoke.mjs`（跑真 Pi，只读 `minutes +search`，打印翻译后的 SSE 事件序列与最终文本）:
```js
import { join } from "node:path";
import { startPi } from "./pi-client.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const client = startPi({
  provider: "cz-gpt", model: "gpt-5.5", thinking: "medium", cwd: ROOT,
  extensions: [join(ROOT, "pi-ext", "providers.ts"), join(ROOT, "pi-ext", "lark.ts")],
});
const seen = [];
const { finalText } = await client.runJob(
  '只读：调用一次 lark 工具执行 args=["minutes","+search","--owner-ids","me","--as","user"]，取第一条标题用一句话回我。严禁任何写操作。',
  { id: "smoke-1", onEvent: (e) => { seen.push(e.event); process.stderr.write(`[sse] ${e.event}${e.data?.text ? " " + JSON.stringify(e.data.text) : ""}\n`); }, timeoutMs: 150000 }
);
console.error(`\n[smoke] SSE event sequence: ${seen.join(", ")}`);
console.log(`[smoke] finalText: ${finalText}`);
await client.close();
```

- [ ] **Step 4: 跑真机 smoke 验证（人工，需 .env 已加载）**

Run: `cd mstd-orchestrator && set -a; . ./.env; set +a && node supervisor/pi-smoke.mjs`
Expected: 打印出翻译后的 SSE 事件序列（应含 `tool_start`、`tool_result`、`assistant_delta`… 以 `message_done` 收尾），最终文本非空；全程无飞书写（只读 `minutes +search`）。若与 fixture 行为一致即验证通过。

- [ ] **Step 5: Commit**

```bash
git add supervisor/pi-client.mjs supervisor/pi-smoke.mjs
git commit -m "feat(mstd-ui): harden pi-client (runJob, env-allowlist, stderr, agent_end!willRetry terminal)"
```

---

## Self-Review

**Spec 覆盖（Phase 2 范围）**：
- 「修 pi-client：原生 id / agent_end&!willRetry 终止 / 删幻象 idle / stderr 进事件 / parse-error 显式 / env allowlist」→ Task 2（终止/env/parse）+ Task 5（id/stderr/prompt 修正）✓
- 「录真实 Pi JSONL fixture → 冻结事件集合」→ Task 1（PII-free 忠实 fixture）✓
- 「据 fixture 建并测 SSE 翻译器」→ Task 3（翻译器）+ Task 4（流处理器，喂 fixture 断言序列）✓
- 事件映射表（spec）→ Task 3 逐条实现并测，取值全部来自实测（text_delta.delta、tool_execution_*、agent_end.willRetry、auto_retry_*）✓
- 真机验证 → Task 5 手动只读 smoke（对齐 spec「先冻结再翻译」与 verify 纪律）✓

**Placeholder 扫描**：无 TBD/TODO；每个 code step 给完整可运行代码与测试。pi-client 改动的运行时正确性由 Task 5 真机 smoke 承接（已说明单测不直接覆盖 spawn）。

**类型一致性**：`translatePiEvent` 产出 `{event,data}` 在 Task 3 定义、Task 4/5 消费一致；`isTerminalEvent`/`parseRpcLine`/`buildPiEnv` 单一来源（rpc-protocol）；`makeStreamProcessor({onEvent,onDone})` 契约在 Task 4 定义、Task 5 `runJob` 消费一致；SSE 事件名（assistant_delta/thinking_status/tool_start/tool_result/message_done/retry_status/error/unknown）与 spec「Pi 事件→前端 SSE 映射」表一致。
