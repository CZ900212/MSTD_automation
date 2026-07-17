# mstd UI · Phase 4（前端 mstd-ui + 打开真写）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **凡涉及真写飞书的步骤（Task 4.10/4.11/4.13）：只打测试群/测试任务清单 + 先 `--dry-run` 预检 + 走对账 reconcile；真机写验证必须人工确认后再跑。**

**Goal:** 给 mstd 装上用户 UI 入口并**打开第②段真写**：新建 `mstd-ui`（Vite+React+TS）SPA，从 `rsh-pricing-app` **抽取渲染原子**、重建 job/event 状态机；飞书 OAuth 登录；消费 Phase 2/3 冻结的 SSE 事件协议；Workspace（触发→流式看第①段→原地审批）+ Board（任务/审批队列/详情审计）；服务端权威执行器 `executeApprovedAction` 用 Phase 1 `buildWriteArgs` + 原生 `--idempotency-key` + **先 `--dry-run` 零副作用预检** + action-store 状态机 + 对账；`lark_execute_approved_action` 工具给第②段 Pi（服务端可 fallback 直执）。

**Architecture:** 前端 `mstd-ui/` 是纯静态 SPA（Vite 打包，`server/` 或 nginx 托管），**表现层组件全部走 props 注入**（网络/流在 `api/` + hook 层，组件本身纯 → `@testing-library/react` 可无网络断言）。抽的原子从 pricing `src/main.tsx` 按模块搬（改 import、去品牌串），CSS token 从 pricing `src/styles.css` 抽。**`chat-state.ts` 整体与 `streamApi`(POST 聊天流) 不搬、重建**：我们自己的 SSE 客户端消费 Phase 2 冻结事件集（`assistant_delta/thinking_status/tool_start/tool_result/message_done/retry_status/error/unknown`），`JobEventLog` reducer 类型化到 job/event 模型。后端真写落在 `mstd-orchestrator/server/execute/`：`executeApprovedAction` 是唯一权威执行器（Pi 与 fallback 直执共用它 + 同一套幂等 key）。

**Tech Stack:**
- 前端 `mstd-ui`：Vite 5 · React 18 · TypeScript 5 · vitest + jsdom + `@testing-library/react` + `@testing-library/jest-dom` · `react-markdown` + `remark-gfm`（`MarkdownContent` 依赖，pricing 同款）。
- 后端 `mstd-orchestrator/server/execute`：Node ≥22 ESM `.mjs` · vitest · 复用 Phase 1 `server/safety/*.mjs`（`buildWriteArgs`/`canonicalizeActions`/`stableHash`/`isValidOpenId`/`deriveIdempotencyKey`/`recordActions`/`actionsToExecute`/`markStatus`）· 复用 Phase 2 `supervisor/pi-client.mjs`（`startPi`/`runJob`）· lark-cli 经注入的 `runLark` 执行（单测不 spawn）。
- 第②段 Pi 扩展 `pi-ext/lark-execute.ts`：`ExtensionAPI.registerTool` + `typebox` `Type`（与既有 `pi-ext/lark.ts` 同款 API）。

**上位 spec：** `docs/superpowers/specs/2026-07-09-mstd-ui-reuse-design.md`（前端 mstd-ui 段的"只抽原子/全部重建"清单、两视图、S2/S3/S6、错误处理、脱敏、非目标、复用总账）。
**前置（必须已完成）：**
- Phase 0+1 安全内核 `docs/superpowers/plans/2026-07-09-mstd-ui-phase0-1-safety-core.md`（本计划**消费**其纯函数与 DB schema）。
- Phase 2 Pi RPC 冻结 `docs/superpowers/plans/2026-07-09-mstd-ui-phase2-pi-rpc-freeze.md`（本计划前端 SSE 事件名 = 其 `event-translator.mjs` 冻结集；第②段 Pi 用其 `startPi/runJob`）。
- Phase 3 Server 基座（OAuth 端点 + jobs API + SSE + 持久化 + decision 落库）——**Phase 3 计划文件尚未落地**，故本计划对端点/DB 列的引用以 **spec「后端 server · 端点」段 + Phase 1 真实 `001_init.sql` 列名**为准（下方 Global Constraints 固化契约）。

## Global Constraints

- **信任边界**：模型永不可信；写操作形状由服务端 `buildWriteArgs` 确定，第②段 Pi 只能"选执行哪个 `action_id`"，改不了 payload/收件人/flag。
- **前端表现层纯组件**：view 组件只吃 `data props + callback props`，不在组件内 `fetch`；网络在 `src/api/*` + `App`/hook 层。→ 组件测试用 `@testing-library/react` 断言渲染与交互，零网络。
- **冻结 SSE 事件名（Phase 2 `event-translator.mjs`，不可臆造）**：前端只认 `assistant_delta{text}` / `thinking_status{text}` / `tool_start{toolCallId,toolName,args}` / `tool_result{toolCallId,toolName,result,isError}` / `message_done{}` / `retry_status{retrying}` / `error{level,text?|raw?}` / `unknown{type}`。**终止 = `message_done`（或 `error`）**，不认幻象 `idle`。
- **Phase 3 端点契约（spec「后端 server」段）**：`GET /api/auth/feishu/login`（→authorize URL 带 state/nonce）· `GET /api/auth/feishu/callback` · `GET /api/me` · `GET /api/templates` · `POST /api/jobs {templateId,params}→{jobId}` · `GET /api/jobs?status=&mine=` · `GET /api/jobs/:id`（events+draft+actions+decisions）· `GET /api/jobs/:id/stream`（SSE，15s 心跳）· `POST /api/jobs/:id/decision {approve,edited_items?,note,decision_token}` · `POST /api/jobs/:id/abort`。
- **Job 状态集（真实 `001_init.sql` + spec）**：`queued / running_readonly / awaiting_approval / needs_attention / running_write / done / partial_failed / failed / rejected / aborted`。
- **审批门禁对齐 Phase 1 `requires_open_id` 语义**：`canonicalizeActions` 里 `requires_open_id = item.confidence === "low" || !isValidOpenId(assignee_open_id)`；前端审批编辑器**对 `requires_open_id` 为真的条目强制人工补齐 `ou_` 开头 open_id 才可批**，判定用与后端同一条规则 `/^ou_/`。
- **真写四道闸（Task 4.10/4.11）**：① 先 `lark-cli … --dry-run` 零副作用预检 argv（spec/Phase 1 已核实 `task +create` 支持 `--dry-run`，打印请求不执行）；② `buildWriteArgs` 内置 fail-closed（非 `ou_` open_id 直接抛，不构造 argv）；③ 原生 `--idempotency-key = <job_id>:<action_key>` 主防重；④ 执行前校验**当前 `payload_hash == 批准时 hash`**（hash 漂移 → `failed(hash_mismatch)`）。
- **只打测试目标**：v1 真写经 `assertTestTarget` 白名单闸——`assignee_open_id`/收件人必须在配置的测试 open_id 允许集内、任务落配置的测试清单，否则 fail-closed。
- **服务端权威 + Pi 可兜底（spec S6）**：默认第②段 Pi 逐条驱动（审计连续）；Pi 起不来/`agent_end` 异常/输出跑偏/超时 → 服务端直接顺序调 `executeApprovedAction`。两路共用同一执行器 + 同一幂等 key，结果一致。
- **脱敏与 TTL（spec 数据脱敏段，Phase 4 落地加固）**：`send_dm` 用服务端**固定卡片模板渲染 + 转义**（非裸 `{ref}`）；每 job **绝对工作目录**，`read_file` 限定在该目录内（路径穿越 fail-closed）；导出物（`./out` transcript）设 TTL 清理。
- 每次改动走 TDD：先写失败测试 → 跑挂 → 最小实现 → 跑过 → commit。仓库已 git 化（见 Phase 2 分支约定）；commit 步骤照写，本计划文档编写者不执行提交。

---

## File Structure

```
mstd-ui/                                    # ★新建 SPA（Vite+React+TS）
  package.json  vite.config.ts  tsconfig.json  index.html
  src/
    main.tsx                                # React 根挂载
    App.tsx                                 # 壳：侧栏(job 列表)+main；workspace/board 切换；网络接线
    styles.css                             # 抽自 pricing styles.css:17-176 的 CSS token + 布局骨架
    atoms/                                  # ★抽原子（改 import/去品牌串）
      Icon.tsx                             # Icon + ICON_PATHS（源 main.tsx:200-359，原样）
      hooks.ts                             # useMediaQuery / useProcessingClock（源 main.tsx:383-408，原样）
      MarkdownContent.tsx                  # 源 main.tsx:987-1003，原样
      ToolDetailItem.tsx                   # 复用 main.tsx:1005-1026 外观，喂我们的 ToolActivity 模型
    api/
      auth.ts                              # setAuthToken/authHeaders/apiFetch(401→onAuthInvalid)/feishuLogin/bootstrap
      jobs.ts                              # createJob/listJobs/getJob/postDecision/abortJob（Phase 3 端点）
      job-stream.ts                        # parseSseBlock（纯）+ openJobStream（我们的 SSE 客户端，非 streamApi drop-in）
    state/
      job-event-log.ts                     # ★重建：类型化 SSE 事件 + reduceJobEvent（替代 chat-state.ts）
    views/
      LoginFeishu.tsx                      # 复用 login-shell 分屏布局；表单换飞书扫码/OAuth
      Timeline.tsx                         # 渲染 JobEventLog（thinking/tools/assistant/retry/error）
      ApprovalActionEditor.tsx             # 动作清单编辑器（open_id + 置信度徽标 + requires_open_id 门禁）
      WorkspaceView.tsx                    # 模板选择器 + 触发表单 + Timeline + 原地审批卡
      BoardView.tsx                        # 任务表 + 审批队列 + 详情（回放+动作结果+决策审计）
    test/
      setup.ts
      icon.test.tsx  hooks.test.tsx  markdown.test.tsx  tool-detail.test.tsx
      auth.test.ts  job-stream.test.ts  job-event-log.test.ts
      login.test.tsx  timeline.test.tsx  approval-editor.test.tsx
      workspace.test.tsx  board.test.tsx

mstd-orchestrator/                          # 后端真写（复用 Phase 1/2）
  server/
    execute/
      write-target.mjs                     # assertTestTarget（测试目标白名单闸）
      render-card.mjs                      # renderNotifyCard（固定卡片模板 + 转义）
      job-workdir.mjs                      # jobWorkdir / resolveInsideWorkdir / sweepExpiredExports
      execute-action.mjs                   # executeApprovedAction + reconcileAction + loadApprovedHashes
      write-phase.mjs                      # runWritePhase（默认 Pi 驱动 → 异常 fallback 直执）
  pi-ext/
    lark-execute.ts                        # lark_execute_approved_action（第②段唯一写工具，薄壳）
  test/
    write-target.test.mjs  render-card.test.mjs  job-workdir.test.mjs
    execute-action.test.mjs  write-phase.test.mjs
```

---

## Task 4.1: `mstd-ui` 脚手架（Vite+React+TS + vitest + testing-library）

**Files:**
- Create: `mstd-ui/package.json`, `mstd-ui/vite.config.ts`, `mstd-ui/tsconfig.json`, `mstd-ui/index.html`
- Create: `mstd-ui/src/main.tsx`, `mstd-ui/src/test/setup.ts`
- Test: `mstd-ui/src/test/smoke.test.tsx`

**Interfaces:**
- Produces: `npm test` 跑 vitest（jsdom 环境）；`@testing-library/react` 可渲染并断言；`npm run build` 产出静态包。
- Consumes: 无。

- [ ] **Step 1: 写失败的冒烟测试**

`mstd-ui/src/test/smoke.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

function Hello() {
  return <h1>mstd-ui</h1>;
}

describe("smoke", () => {
  it("renders with @testing-library/react + jsdom", () => {
    render(<Hello />);
    expect(screen.getByRole("heading", { name: "mstd-ui" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败（无脚手架）**

Run: `cd mstd-ui && npm test`
Expected: FAIL —— 依赖/配置不存在（`vitest`/`@testing-library/react` 未装）。

- [ ] **Step 3: 建脚手架**

`mstd-ui/package.json`:
```json
{
  "name": "mstd-ui",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^9.0.1",
    "remark-gfm": "^4.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "vitest": "^4.0.15"
  }
}
```

`mstd-ui/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发期把 /api 代理到本地 Phase 3 server（默认 3001）
    proxy: { "/api": "http://localhost:3001" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
} as never);
```
> `as never`：vitest 的 `test` 字段合并进 Vite 配置的类型技巧（与 pricing 同款做法）；执行时由 vitest 读取。

`mstd-ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

`mstd-ui/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>MSTD 自动化工作台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`mstd-ui/src/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`mstd-ui/src/main.tsx`（占位根，后续 Task 接线 App）:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function Boot() {
  return <div id="mstd-boot">mstd-ui</div>;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<React.StrictMode><Boot /></React.StrictMode>);
```
> `styles.css` 在 Task 4.2 建；本步先建空文件 `mstd-ui/src/styles.css`（内容 `/* tokens in 4.2 */`）以让 `main.tsx` 的 import 可解析。

然后安装：Run `cd mstd-ui && npm install`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npm test`
Expected: PASS —— 1 passed（smoke）。

- [ ] **Step 5: Commit**

```bash
cd mstd-ui
git add package.json package-lock.json vite.config.ts tsconfig.json index.html src/main.tsx src/styles.css src/test/setup.ts src/test/smoke.test.tsx
git commit -m "chore(mstd-ui): scaffold Vite+React+TS + vitest/jsdom/testing-library"
```

---

## Task 4.2: 抽原子 — CSS token + hooks + Icon

**Files:**
- Create: `mstd-ui/src/styles.css`（覆盖 Task 4.1 占位）
- Create: `mstd-ui/src/atoms/hooks.ts`, `mstd-ui/src/atoms/Icon.tsx`
- Test: `mstd-ui/src/test/hooks.test.tsx`, `mstd-ui/src/test/icon.test.tsx`

**Interfaces:**
- Produces:
  - CSS design tokens `:root` / `[data-theme="dark"]` + 布局骨架类（`.app-shell/.app-sidebar/.app-main/.login-shell/.login-copy/.login-card/.login-preview/.tool-detail/.timeline`）。
  - `useMediaQuery(query: string) -> boolean`、`useProcessingClock(active: boolean) -> number`（源 `main.tsx:383-408`，逻辑原样）。
  - `Icon({ name, className?, style? })` + `IconName` 联合类型 + `ICON_PATHS`（源 `main.tsx:200-359`，原样）。
- Consumes: 无（纯前端原子）。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/hooks.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "../atoms/hooks";

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

describe("useMediaQuery", () => {
  beforeEach(() => mockMatchMedia(true));
  it("reflects the initial match", () => {
    const { result } = renderHook(() => useMediaQuery("(max-width: 760px)"));
    expect(result.current).toBe(true);
  });
});
```

`mstd-ui/src/test/icon.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Icon } from "../atoms/Icon";

describe("Icon", () => {
  it("renders an svg with the icon-svg class and merges extra className", () => {
    const { container } = render(<Icon name="send" className="composer-send" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toBe("icon-svg composer-send");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/hooks.test.tsx src/test/icon.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现（抽自 pricing）**

`mstd-ui/src/atoms/hooks.ts`（源 `main.tsx:383-408`，逻辑原样）:
```ts
import { useEffect, useState } from "react";

export function useProcessingClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches
  );
  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQuery.matches);
    updateMatches();
    mediaQuery.addEventListener("change", updateMatches);
    return () => mediaQuery.removeEventListener("change", updateMatches);
  }, [query]);
  return matches;
}
```

`mstd-ui/src/atoms/Icon.tsx`（源 `main.tsx:200-359`，`ICON_PATHS` 全部路径原样搬；此处示删节，实现时逐条照抄）:
```tsx
import React from "react";

export type IconName =
  | "clock" | "sun" | "settings" | "users" | "key" | "status" | "danger"
  | "plus" | "send" | "stop" | "chevron" | "search" | "close" | "globe"
  | "info" | "logout" | "menu" | "more" | "sidebar-arrow";

export const ICON_PATHS: Record<IconName, React.ReactNode> = {
  // ↓↓↓ 从 rsh-pricing-app/src/main.tsx:221-336 原样搬（19 个键的 <path>/<circle>），此处仅示 3 例
  send: <path d="M22 2l-7 20-4-9-9-4 20-7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  close: (<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>),
  // …其余 16 键实现时补全（clock/sun/settings/users/key/status/danger/plus/chevron/search/globe/info/logout/menu/more/sidebar-arrow）
} as Record<IconName, React.ReactNode>;

export const Icon = ({
  name, className, style, ...rest
}: { name: IconName; className?: string; style?: React.CSSProperties } & Omit<React.SVGProps<SVGSVGElement>, "name">) => (
  <svg
    className={className ? `icon-svg ${className}` : "icon-svg"}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    style={style} {...rest}
  >
    {ICON_PATHS[name]}
  </svg>
);
```
> 实现时：把 `main.tsx:221-336` 的 `ICON_PATHS` 全 19 个键**逐字复制**进来（无品牌串，可原样）。测试只断言 `send` 一键即可代表 `Icon` 外壳正确；不需要为每个路径写测试。

`mstd-ui/src/styles.css`（`:root` + `[data-theme="dark"]` token 块**逐字**抽自 `rsh-pricing-app/src/styles.css:17-176`；再加最小布局骨架）:
```css
/* === design tokens：逐字抽自 rsh-pricing-app/src/styles.css:17-176（去掉 login-copy 品牌标题相关无关规则）=== */
:root {
  color: var(--ink);
  background: var(--canvas);
  color-scheme: light;
  font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif;
  --ink: #1c2438; --body: #30394f; --muted: #69758f;
  --canvas: #e2e8f2; --soft: #d5deee; --card: #cbd6e9; --line: #bdc9df;
  --surface: #f8fbff; --surface-soft: #eef4fb; --surface-line: #c9d4e8;
  --coral: #5b6fa9; --coral-dark: #4c609a; --on-dark: #ffffff; --on-dark-soft: #e2e8f2;
  --danger: #c64545; --focus: #2f7de1; --link: #2f6fcf;
  --success-fg: #22643c; --success-bg: #edf9f0; --success-border: #b8e2c1;
  --warn-fg: #6d5a1d; --warn-bg: #f5edcf; --warn-border: #ded09d;
  --error-fg: #7e2525; --error-bg: #f7e8e4; --error-border: #e5b8ae;
  --paper-card: #ffffff; --paper-line: #dbe3ef; --code-bg: rgba(28,36,56,0.08);
  --app-viewport-height: 100dvh;
  /* …其余 token（层级 z-*、glass rgb、fade-* 等）实现时按 styles.css:44-102 补全 */
}
[data-theme="dark"] {
  color-scheme: dark;
  --ink: #e8edf8; --body: #c6d0e2; --muted: #909cb8;
  --canvas: #12161f; --soft: #232c40; --card: #1a2130; --line: #303b52;
  --surface: #1c2434; --surface-soft: #171e2b; --surface-line: #2a3448;
  --coral: #5e73b4; --coral-dark: #54689f; --danger: #e26b6b; --focus: #6ea3f0; --link: #8fb0f2;
  --success-fg: #93d9ac; --success-bg: #17301f; --success-border: #2f5c3d;
  --warn-fg: #e3cc82; --warn-bg: #33290f; --warn-border: #5e4f1f;
  --error-fg: #f0a8a0; --error-bg: #35211d; --error-border: #63362e;
  --paper-card: #1d2536; --paper-line: #2c374d; --code-bg: rgba(255,255,255,0.07);
  /* …其余深色覆盖按 styles.css:105-176 补全 */
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--canvas); color: var(--body); }

/* === 布局骨架（App 壳：侧栏 + main；移动端单列）=== */
.app-shell { display: grid; grid-template-columns: 280px 1fr; height: var(--app-viewport-height); }
.app-sidebar { border-right: 1px solid var(--line); background: var(--surface-soft); overflow-y: auto; }
.app-main { overflow-y: auto; padding: 24px; }
@media (max-width: 760px) { .app-shell { grid-template-columns: 1fr; } .app-sidebar { display: none; } }

/* === login 分屏（复用 pricing 类名，见 styles.css:300-540）=== */
.login-shell { display: grid; grid-template-columns: 1fr 1fr; min-height: var(--app-viewport-height); }
.login-copy { display: flex; flex-direction: column; justify-content: center; gap: 24px; padding: 8vw; }
.login-card { display: flex; flex-direction: column; gap: 16px; background: var(--paper-card); border: 1px solid var(--paper-line); border-radius: 16px; padding: 28px; }
.login-preview { background: var(--soft); }
.login-preview img { width: 100%; height: 100%; object-fit: cover; }
@media (max-width: 760px) { .login-shell { grid-template-columns: 1fr; } .login-preview { display: none; } }

/* === 工具活动 + 时间线（复用 pricing tool-detail 外观，见 styles.css）=== */
.timeline { display: flex; flex-direction: column; gap: 12px; }
.tool-detail { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.tool-detail.running { border-color: var(--focus); }
.tool-detail.error { border-color: var(--error-border); background: var(--error-bg); }
.tool-detail-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--coral); margin-top: 6px; flex: 0 0 auto; }
.markdown-content { line-height: 1.6; }
.confidence-badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.confidence-badge.low { color: var(--warn-fg); background: var(--warn-bg); border: 1px solid var(--warn-border); }
.confidence-badge.high { color: var(--success-fg); background: var(--success-bg); border: 1px solid var(--success-border); }
.open-id-input.invalid { border-color: var(--danger); }
```
> token 块：实现时把 `styles.css:17-176` 完整 `:root`/`[data-theme="dark"]` **逐字复制**（本步只示核心子集 + 注释指明补全范围）；布局骨架类为净新增（pricing 的 App 壳/login CSS 参考 `styles.css:300-540`，但我们用更小的骨架子集）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/hooks.test.tsx src/test/icon.test.tsx`
Expected: PASS —— 2 passed。

- [ ] **Step 5: Commit**

```bash
git add src/styles.css src/atoms/hooks.ts src/atoms/Icon.tsx src/test/hooks.test.tsx src/test/icon.test.tsx
git commit -m "feat(mstd-ui): extract atoms — CSS tokens + useMediaQuery/useProcessingClock + Icon set"
```

---

## Task 4.3: 抽原子 — MarkdownContent + ToolDetailItem 外观

**Files:**
- Create: `mstd-ui/src/atoms/MarkdownContent.tsx`, `mstd-ui/src/atoms/ToolDetailItem.tsx`
- Test: `mstd-ui/src/test/markdown.test.tsx`, `mstd-ui/src/test/tool-detail.test.tsx`

**Interfaces:**
- Produces:
  - `MarkdownContent({ text, pending? })`（源 `main.tsx:987-1003`，原样：`React.memo` + `ReactMarkdown` + `remarkGfm`，链接 `target="_blank"`）。
  - `ToolActivity` 类型 + `ToolDetailItem({ tool })`：**复用 pricing `main.tsx:1005-1026` 的 DOM/className 外观**（`.tool-detail ${status}`、`.tool-detail-dot`、`<b>` 标题 + `<small>` 参数），但吃我们的 `ToolActivity` 模型（来自 Phase 2 `tool_start/tool_result`），不搬 pricing 的 `ToolRun`/`webSearchResults`。
- Consumes: `react-markdown`/`remark-gfm`（Task 4.1 dep）。`ToolActivity` 由 Task 4.6 复用同一定义（此处先声明，4.6 import）。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/markdown.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "../atoms/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders markdown to html", () => {
    render(<MarkdownContent text={"**粗体** 和 [链接](https://x.test)"} />);
    expect(screen.getByText("粗体").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "链接" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "https://x.test");
  });
  it("renders pending text as plain paragraph", () => {
    const { container } = render(<MarkdownContent text="加载中" pending />);
    expect(container.querySelector("p.pending-text")?.textContent).toBe("加载中");
  });
});
```

`mstd-ui/src/test/tool-detail.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolDetailItem } from "../atoms/ToolDetailItem";

describe("ToolDetailItem", () => {
  it("shows running state with dot + label", () => {
    const { container } = render(
      <ToolDetailItem tool={{ toolCallId: "tc1", toolName: "lark", status: "running", args: { op: "search_minutes" } }} />
    );
    expect(container.querySelector(".tool-detail.running")).not.toBeNull();
    expect(container.querySelector(".tool-detail-dot")).not.toBeNull();
    expect(screen.getByText(/lark/)).toBeInTheDocument();
    expect(screen.getByText(/search_minutes/)).toBeInTheDocument();
  });
  it("shows error state when isError result arrives", () => {
    const { container } = render(
      <ToolDetailItem tool={{ toolCallId: "tc1", toolName: "lark", status: "error", args: {}, isError: true }} />
    );
    expect(container.querySelector(".tool-detail.error")).not.toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/markdown.test.tsx src/test/tool-detail.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-ui/src/atoms/MarkdownContent.tsx`（源 `main.tsx:987-1003`，原样）:
```tsx
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const MarkdownContent = React.memo(function MarkdownContent(
  { text, pending }: { text: string; pending?: boolean }
) {
  if (pending) return <p className="pending-text">{text}</p>;
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
```

`mstd-ui/src/atoms/ToolDetailItem.tsx`（复用 pricing 外观，喂我们的模型）:
```tsx
import React from "react";

export type ToolStatus = "running" | "done" | "error";
export type ToolActivity = {
  toolCallId: string;
  toolName: string;
  status: ToolStatus;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

// 复用 pricing compactJson 思路（main.tsx:954-961）：把 args 压成一行可读串
function compactJson(value: unknown) {
  if (!value) return "";
  try {
    return JSON.stringify(value).replace(/[{}"]/g, "").replace(/,/g, "，").slice(0, 120);
  } catch {
    return "";
  }
}

function toolLabel(tool: ToolActivity) {
  if (tool.status === "running") return `${tool.toolName}：执行中`;
  if (tool.status === "error") return `${tool.toolName}：失败`;
  return `${tool.toolName}：已完成`;
}

export function ToolDetailItem({ tool }: { tool: ToolActivity }) {
  return (
    <div className={`tool-detail ${tool.status}`} key={tool.toolCallId}>
      <span className="tool-detail-dot" aria-hidden="true" />
      <div>
        <b>{toolLabel(tool)}</b>
        {tool.args ? <small>参数：{compactJson(tool.args)}</small> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/markdown.test.tsx src/test/tool-detail.test.tsx`
Expected: PASS —— 4 passed。

- [ ] **Step 5: Commit**

```bash
git add src/atoms/MarkdownContent.tsx src/atoms/ToolDetailItem.tsx src/test/markdown.test.tsx src/test/tool-detail.test.tsx
git commit -m "feat(mstd-ui): extract atoms — MarkdownContent + ToolDetailItem (our tool model)"
```

---

## Task 4.4: Auth 客户端 + 飞书 OAuth 登录页（分屏）+ bootstrap

**Files:**
- Create: `mstd-ui/src/api/auth.ts`, `mstd-ui/src/views/LoginFeishu.tsx`
- Test: `mstd-ui/src/test/auth.test.ts`, `mstd-ui/src/test/login.test.tsx`

**Interfaces:**
- Produces（`api/auth.ts`，复用 pricing `main.tsx:440-449,662-689` 的 token/header/401 套路）:
  - `setAuthToken(token: string) -> void` / `authToken() -> string` / `authHeaders() -> Record<string,string>`（`localStorage`，key `mstd-token`）。
  - `setOnAuthInvalid(fn: () => void) -> void`（登录态失效回调，401 触发）。
  - `apiFetch<T>(url, options?) -> Promise<T>`：带 `Authorization: Bearer`；`401 → onAuthInvalid()` 并抛 `Error("鉴权失效，请重新登录")`。
  - `feishuLogin(redirectAfter?: string) -> Promise<void>`：`GET /api/auth/feishu/login?redirect=<...>` 拿 `{ authorizeUrl }` → `window.location.assign(authorizeUrl)`（state/nonce 由 Phase 3 服务端签发落 `auth_challenges`）。
  - `bootstrap() -> Promise<Me | null>`：`GET /api/me`；401 或无 token → `null`（→ 显示登录页）。`Me = { open_id: string; name: string; avatar?: string; role: "admin"|"user" }`。
- Produces（`views/LoginFeishu.tsx`）：`LoginFeishu({ onStart })` —— 复用 `login-shell/login-copy/login-card/login-preview` 分屏骨架，右栏预览图，左栏卡片一个"飞书扫码登录"按钮 → 点击调 `onStart`。
- Consumes: 无（`onStart` 由 App 注入 `() => feishuLogin()`，便于组件测试）。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/auth.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setAuthToken, authHeaders, apiFetch, setOnAuthInvalid, bootstrap, feishuLogin } from "../api/auth";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("auth token/header", () => {
  it("stores token and builds bearer header", () => {
    setAuthToken("t123");
    expect(authHeaders()).toEqual({ Authorization: "Bearer t123" });
  });
  it("no header without token", () => {
    expect(authHeaders()).toEqual({});
  });
});

describe("apiFetch 401 -> onAuthInvalid", () => {
  it("fires the invalid callback and throws on 401", async () => {
    const onInvalid = vi.fn();
    setOnAuthInvalid(onInvalid);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    ));
    await expect(apiFetch("/api/me")).rejects.toThrow(/重新登录/);
    expect(onInvalid).toHaveBeenCalledOnce();
  });
});

describe("bootstrap", () => {
  it("returns null when unauthenticated (401)", async () => {
    setOnAuthInvalid(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    expect(await bootstrap()).toBeNull();
  });
  it("returns Me when authenticated", async () => {
    setAuthToken("t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ open_id: "ou_x", name: "张三", role: "user" }), { status: 200 })
    ));
    expect(await bootstrap()).toEqual({ open_id: "ou_x", name: "张三", role: "user" });
  });
});

describe("feishuLogin", () => {
  it("navigates to the authorize url from the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorizeUrl: "https://open.feishu.cn/authorize?state=s" }), { status: 200 })
    ));
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    await feishuLogin("/board");
    expect(assign).toHaveBeenCalledWith("https://open.feishu.cn/authorize?state=s");
  });
});
```

`mstd-ui/src/test/login.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginFeishu } from "../views/LoginFeishu";

describe("LoginFeishu", () => {
  it("renders split-screen shell and triggers onStart on click", async () => {
    const onStart = vi.fn();
    const { container } = render(<LoginFeishu onStart={onStart} />);
    expect(container.querySelector(".login-shell")).not.toBeNull();
    expect(container.querySelector(".login-preview")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /飞书.*登录/ }));
    expect(onStart).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/auth.test.ts src/test/login.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-ui/src/api/auth.ts`:
```ts
const TOKEN_KEY = "mstd-token";
let onAuthInvalid: (() => void) | null = null;

export function setOnAuthInvalid(fn: () => void) { onAuthInvalid = fn; }
export function authToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setAuthToken(token: string) {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export function authHeaders(): Record<string, string> {
  const token = authToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type Me = { open_id: string; name: string; avatar?: string; role: "admin" | "user" };

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
  });
  if (response.status === 401) {
    setAuthToken("");
    onAuthInvalid?.();
    throw new Error("鉴权失效，请重新登录");
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error((data as { error?: string }).error || "请求失败");
  return data as T;
}

export async function feishuLogin(redirectAfter = "/") {
  const { authorizeUrl } = await apiFetch<{ authorizeUrl: string }>(
    `/api/auth/feishu/login?redirect=${encodeURIComponent(redirectAfter)}`
  );
  window.location.assign(authorizeUrl);
}

export async function bootstrap(): Promise<Me | null> {
  if (!authToken()) return null;
  try {
    return await apiFetch<Me>("/api/me");
  } catch {
    return null;
  }
}
```
> 回调页 `/api/auth/feishu/callback`（Phase 3）校 state/nonce（Task 1.6 `consumeAuthChallenge`）→ 换 `user_access_token` → 签会话 token → 302 回前端并把 token 交给前端（query 或 set-cookie 后 `/api/me` 拿；实现时按 Phase 3 落地方式取，前端 `setAuthToken` 存下）。本任务只负责发起登录 + bootstrap，不含回调服务端逻辑（Phase 3）。

`mstd-ui/src/views/LoginFeishu.tsx`:
```tsx
import React from "react";

export function LoginFeishu({ onStart }: { onStart: () => void }) {
  return (
    <main className="login-shell">
      <section className="login-copy">
        <h1>MSTD<br />自动化工作台。</h1>
        <div className="login-card">
          <p>用飞书账号登录，身份即你的飞书 open_id（发起 / 审批 / 派活对象）。</p>
          <button className="primary" type="button" onClick={onStart}>飞书扫码登录</button>
        </div>
      </section>
      <aside className="login-preview" aria-label="工作台预览图">
        <img src="/mstd-hero.jpg" alt="MSTD 工作台展示图" />
      </aside>
    </main>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/auth.test.ts src/test/login.test.tsx`
Expected: PASS —— 全部通过（含 401→重登、bootstrap、feishuLogin 跳转、分屏渲染）。

- [ ] **Step 5: Commit**

```bash
git add src/api/auth.ts src/views/LoginFeishu.tsx src/test/auth.test.ts src/test/login.test.tsx
git commit -m "feat(mstd-ui): auth client (token/401→relogin/bootstrap) + Feishu OAuth login (split-screen)"
```

---

## Task 4.5: 我们自己的 SSE 客户端（消费 Phase 2/3 事件协议）

**Files:**
- Create: `mstd-ui/src/api/job-stream.ts`
- Test: `mstd-ui/src/test/job-stream.test.ts`

**Interfaces:**
- Produces:
  - `parseSseBlock(block: string) -> { event: string; data: Record<string, unknown> } | null`（纯：解析一个 `event:`/`data:` 块；无 data 行 → `null`；心跳注释块 `: ping` → `null`）。
  - `openJobStream(jobId, { onEvent, onDone, onError, signal? }) -> Promise<void>`：`GET /api/jobs/:id/stream` 带 `Authorization`；用 `ReadableStream` reader + `\n\n` 分块；**终止条件 = 收到 `message_done` 或 `error`**（我们的协议，非 pricing `streamApi` 的 drop-in）；断线/超时经 `onError`。
- 说明：**不搬 pricing `streamApi`**（那是 POST 聊天流、缠 `result/estimate`）；借 `consumeBlock`（`main.tsx:730-745`）的分块思路，传输改 GET SSE、事件集换 Phase 2 冻结集。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/job-stream.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { parseSseBlock, openJobStream } from "../api/job-stream";

describe("parseSseBlock", () => {
  it("parses event + data json", () => {
    expect(parseSseBlock("event: assistant_delta\ndata: {\"text\":\"三条\"}"))
      .toEqual({ event: "assistant_delta", data: { text: "三条" } });
  });
  it("defaults event to 'message' when only data present", () => {
    expect(parseSseBlock('data: {"x":1}')).toEqual({ event: "message", data: { x: 1 } });
  });
  it("returns null for heartbeat/comment blocks", () => {
    expect(parseSseBlock(": ping")).toBeNull();
    expect(parseSseBlock("")).toBeNull();
  });
});

function streamFromChunks(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("openJobStream", () => {
  it("emits events in order and finishes on message_done", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamFromChunks([
      "event: tool_start\ndata: {\"toolCallId\":\"tc1\",\"toolName\":\"lark\"}\n\n",
      "event: assistant_delta\ndata: {\"text\":\"结果是\"}\n\n",
      "event: assistant_delta\ndata: {\"text\":\"三条\"}\n\n",
      "event: message_done\ndata: {}\n\n",
    ])));
    const events: string[] = [];
    let done = false;
    await openJobStream("job1", { onEvent: (e) => events.push(e.event), onDone: () => { done = true; }, onError: () => {} });
    expect(events).toEqual(["tool_start", "assistant_delta", "assistant_delta", "message_done"]);
    expect(done).toBe(true);
  });

  it("calls onError and stops on an error event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamFromChunks([
      "event: error\ndata: {\"level\":\"stderr\",\"text\":\"boom\"}\n\n",
    ])));
    const onError = vi.fn();
    await openJobStream("job1", { onEvent: () => {}, onDone: () => {}, onError });
    expect(onError).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/job-stream.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-ui/src/api/job-stream.ts`:
```ts
import { authHeaders } from "./auth";

export type JobStreamEvent = { event: string; data: Record<string, unknown> };

export function parseSseBlock(block: string): JobStreamEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // 心跳注释
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
}

export async function openJobStream(
  jobId: string,
  { onEvent, onDone, onError, signal }: {
    onEvent: (e: JobStreamEvent) => void;
    onDone: () => void;
    onError: (err: Error) => void;
    signal?: AbortSignal;
  }
): Promise<void> {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stream`, {
      headers: { Accept: "text/event-stream", ...authHeaders() },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream 打开失败 (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal = false;
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const evt = parseSseBlock(block);
        if (!evt) continue;
        onEvent(evt);
        if (evt.event === "error") { onError(new Error(String(evt.data.text ?? evt.data.raw ?? "error"))); terminal = true; break; }
        if (evt.event === "message_done") { terminal = true; break; }
      }
    }
    await reader.cancel().catch(() => undefined);
    if (terminal) onDone();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
```
> 断线补齐（spec 错误处理段）：`onError` 后由 App 层调 `GET /api/jobs/:id`（Task 4.7 `getJob`）从落库关键事件重水合，再决定是否重连。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/job-stream.test.ts`
Expected: PASS —— 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/api/job-stream.ts src/test/job-stream.test.ts
git commit -m "feat(mstd-ui): own SSE client (GET job stream, frozen event set, message_done terminal)"
```

---

## Task 4.6: 类型化 JobEventLog 状态机（重建，不搬 chat-state.ts）

**Files:**
- Create: `mstd-ui/src/state/job-event-log.ts`
- Test: `mstd-ui/src/test/job-event-log.test.ts`

**Interfaces:**
- Produces:
  - `SseEvent` 判别联合（**精确对齐 Phase 2 冻结事件名**）：`assistant_delta{text}` / `thinking_status{text}` / `tool_start{toolCallId,toolName,args}` / `tool_result{toolCallId,toolName,result,isError}` / `message_done{}` / `retry_status{retrying}` / `error{level,text?,raw?}` / `unknown{type}`。
  - `JobEventLog = { assistantText, thinkingText, tools: ToolActivity[], retrying, errors: {level,text}[], done }`。
  - `emptyLog() -> JobEventLog`。
  - `reduceJobEvent(log, evt) -> JobEventLog`（纯：`assistant_delta` 累加正文；`thinking_status` 更新思考；`tool_start` push 一条 `running` ToolActivity（按 `toolCallId` 去重）；`tool_result` 合并进匹配的 tool（`isError?"error":"done"`）；`retry_status` 置 `retrying`；`error` 追加；`message_done` 置 `done`；`unknown` 忽略但计一条软告警）。
- Consumes: `ToolActivity`（Task 4.3）。**替代** pricing `chat-state.ts`（不搬）。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/job-event-log.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { emptyLog, reduceJobEvent, type SseEvent } from "../state/job-event-log";

function run(events: SseEvent[]) {
  return events.reduce(reduceJobEvent, emptyLog());
}

describe("reduceJobEvent", () => {
  it("accumulates assistant_delta into assistantText", () => {
    const log = run([
      { event: "assistant_delta", data: { text: "结果是" } },
      { event: "assistant_delta", data: { text: "三条" } },
    ]);
    expect(log.assistantText).toBe("结果是三条");
  });

  it("tracks thinking status (latest wins)", () => {
    const log = run([{ event: "thinking_status", data: { text: "分析中" } }]);
    expect(log.thinkingText).toBe("分析中");
  });

  it("tool_start then tool_result merges by toolCallId", () => {
    const log = run([
      { event: "tool_start", data: { toolCallId: "tc1", toolName: "lark", args: { op: "search_minutes" } } },
      { event: "tool_result", data: { toolCallId: "tc1", toolName: "lark", result: { ok: true }, isError: false } },
    ]);
    expect(log.tools).toHaveLength(1);
    expect(log.tools[0].status).toBe("done");
    expect(log.tools[0].result).toEqual({ ok: true });
  });

  it("isError tool_result flips status to error", () => {
    const log = run([
      { event: "tool_start", data: { toolCallId: "tc1", toolName: "lark", args: {} } },
      { event: "tool_result", data: { toolCallId: "tc1", toolName: "lark", result: {}, isError: true } },
    ]);
    expect(log.tools[0].status).toBe("error");
  });

  it("retry_status toggles retrying; message_done finishes; error collected", () => {
    const log = run([
      { event: "retry_status", data: { retrying: true } },
      { event: "error", data: { level: "stderr", text: "boom" } },
      { event: "retry_status", data: { retrying: false } },
      { event: "message_done", data: {} },
    ]);
    expect(log.retrying).toBe(false);
    expect(log.errors).toEqual([{ level: "stderr", text: "boom" }]);
    expect(log.done).toBe(true);
  });

  it("unknown event does not throw and does not corrupt text", () => {
    const log = run([{ event: "unknown", data: { type: "some_future_event" } }]);
    expect(log.assistantText).toBe("");
    expect(log.done).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/job-event-log.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-ui/src/state/job-event-log.ts`:
```ts
import type { ToolActivity } from "../atoms/ToolDetailItem";

export type SseEvent =
  | { event: "assistant_delta"; data: { text: string } }
  | { event: "thinking_status"; data: { text: string } }
  | { event: "tool_start"; data: { toolCallId: string; toolName: string; args?: unknown } }
  | { event: "tool_result"; data: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean } }
  | { event: "message_done"; data: Record<string, never> }
  | { event: "retry_status"; data: { retrying: boolean } }
  | { event: "error"; data: { level: string; text?: string; raw?: string } }
  | { event: "unknown"; data: { type: string } };

export type JobEventLog = {
  assistantText: string;
  thinkingText: string;
  tools: ToolActivity[];
  retrying: boolean;
  errors: { level: string; text: string }[];
  done: boolean;
};

export function emptyLog(): JobEventLog {
  return { assistantText: "", thinkingText: "", tools: [], retrying: false, errors: [], done: false };
}

export function reduceJobEvent(log: JobEventLog, evt: SseEvent): JobEventLog {
  switch (evt.event) {
    case "assistant_delta":
      return { ...log, assistantText: log.assistantText + (evt.data.text ?? "") };
    case "thinking_status":
      return { ...log, thinkingText: evt.data.text ?? "" };
    case "tool_start": {
      if (log.tools.some((t) => t.toolCallId === evt.data.toolCallId)) return log;
      const tool: ToolActivity = { toolCallId: evt.data.toolCallId, toolName: evt.data.toolName, status: "running", args: evt.data.args };
      return { ...log, tools: [...log.tools, tool] };
    }
    case "tool_result": {
      const tools = log.tools.map((t) =>
        t.toolCallId === evt.data.toolCallId
          ? { ...t, status: (evt.data.isError ? "error" : "done") as ToolActivity["status"], result: evt.data.result, isError: evt.data.isError }
          : t
      );
      return { ...log, tools };
    }
    case "retry_status":
      return { ...log, retrying: evt.data.retrying };
    case "error":
      return { ...log, errors: [...log.errors, { level: evt.data.level, text: evt.data.text ?? evt.data.raw ?? "error" }] };
    case "message_done":
      return { ...log, done: true };
    case "unknown":
    default:
      return log;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/job-event-log.test.ts`
Expected: PASS —— 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/state/job-event-log.ts src/test/job-event-log.test.ts
git commit -m "feat(mstd-ui): typed JobEventLog reducer over frozen SSE events (rebuild of chat-state)"
```

---

## Task 4.7: Jobs API 客户端 + Timeline + Workspace 视图

**Files:**
- Create: `mstd-ui/src/api/jobs.ts`, `mstd-ui/src/views/Timeline.tsx`, `mstd-ui/src/views/WorkspaceView.tsx`
- Test: `mstd-ui/src/test/timeline.test.tsx`, `mstd-ui/src/test/workspace.test.tsx`

**Interfaces:**
- Produces（`api/jobs.ts`，Phase 3 端点）：
  - `JobStatus`（10 态联合，见 Global Constraints）、`JobSummary`、`JobDetail`（`{ job, events, draft, actions, decisions }`）、`Template`、`ActionDraft`（对齐 Phase 1 `canonicalizeActions` 产出：`{ action_key, kind, payload, payload_hash, target_open_id, ordinal, requires_open_id }`）。
  - `listTemplates()` `GET /api/templates`；`createJob(templateId, params)` `POST /api/jobs → {jobId}`；`listJobs(filter)` `GET /api/jobs?status=&mine=`；`getJob(id)` `GET /api/jobs/:id`；`postDecision(id, body)` `POST /api/jobs/:id/decision`；`abortJob(id)` `POST /api/jobs/:id/abort`。
- Produces（`Timeline.tsx`）：`Timeline({ log })` —— 渲染 `thinkingText`（pending 样式）+ `tools`（`ToolDetailItem`）+ `assistantText`（`MarkdownContent`）+ `retrying` 横幅 + `errors`。
- Produces（`WorkspaceView.tsx`）：**纯表现组件**，吃 `{ templates, selectedTemplateId, onSelectTemplate, params, onChangeParams, onTrigger, running, log, draft, actions, onApprove, onReject }`。v1 模板选择器只列"会议→建任务"；触发表单（自动/指定妙记 token）；下方 `Timeline`；当 `draft` 存在（`awaiting_approval`）→ 原地展开审批卡（`draft.card_text` + `ApprovalActionEditor`，Task 4.8）。
- Consumes: `JobEventLog`（4.6）、`Timeline`、`ApprovalActionEditor`（4.8）、`MarkdownContent`（4.3）。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/timeline.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Timeline } from "../views/Timeline";
import { emptyLog } from "../state/job-event-log";

describe("Timeline", () => {
  it("renders tools, assistant text, and error", () => {
    const log = {
      ...emptyLog(),
      thinkingText: "分析中",
      tools: [{ toolCallId: "tc1", toolName: "lark", status: "done" as const, args: { op: "search_minutes" } }],
      assistantText: "已找到 **3** 条妙记",
      errors: [{ level: "stderr", text: "warn" }],
    };
    render(<Timeline log={log} />);
    expect(screen.getByText(/lark/)).toBeInTheDocument();
    expect(screen.getByText("3").tagName).toBe("STRONG");
    expect(screen.getByText(/warn/)).toBeInTheDocument();
  });
});
```

`mstd-ui/src/test/workspace.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceView } from "../views/WorkspaceView";
import { emptyLog } from "../state/job-event-log";

const templates = [{ id: "meeting_to_task", name: "会议纪要 → 建任务" }];

function baseProps(over = {}) {
  return {
    templates, selectedTemplateId: "meeting_to_task",
    onSelectTemplate: vi.fn(), params: { minuteToken: "" }, onChangeParams: vi.fn(),
    onTrigger: vi.fn(), running: false, log: emptyLog(),
    draft: null, actions: [], onApprove: vi.fn(), onReject: vi.fn(),
    ...over,
  };
}

describe("WorkspaceView", () => {
  it("lists only the v1 template and triggers a run", async () => {
    const onTrigger = vi.fn();
    render(<WorkspaceView {...baseProps({ onTrigger })} />);
    expect(screen.getByText("会议纪要 → 建任务")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /触发/ }));
    expect(onTrigger).toHaveBeenCalledOnce();
  });

  it("shows the approval card once a draft arrives", () => {
    render(<WorkspaceView {...baseProps({
      draft: { card_text: "请确认以下待办" },
      actions: [{ action_key: "k1", kind: "create_task", payload: { title: "写周报", assignee_open_id: "ou_a" }, payload_hash: "h", target_open_id: "ou_a", ordinal: 0, requires_open_id: false }],
    })} />);
    expect(screen.getByText("请确认以下待办")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /批准/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/timeline.test.tsx src/test/workspace.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-ui/src/api/jobs.ts`:
```ts
import { apiFetch } from "./auth";

export type JobStatus =
  | "queued" | "running_readonly" | "awaiting_approval" | "needs_attention"
  | "running_write" | "done" | "partial_failed" | "failed" | "rejected" | "aborted";

export type Template = { id: string; name: string };
export type ActionDraft = {
  action_key: string;
  kind: "create_task" | "send_dm";
  payload: Record<string, unknown>;
  payload_hash: string;
  target_open_id: string | null;
  ordinal: number;
  requires_open_id: boolean;
};
export type JobSummary = { id: string; template_id: string; title: string | null; status: JobStatus; created_by: string | null; created_at: number };
export type JobDetail = {
  job: JobSummary;
  events: { seq: number; phase: string; type: string; payload_json: string; ts: number }[];
  draft: { card_text: string; items_json: string } | null;
  actions: (ActionDraft & { status: string; result_json: string | null })[];
  decisions: { decided_by: string; decision: string; note: string | null; ts: number }[];
};

export const listTemplates = () => apiFetch<Template[]>("/api/templates");
export const createJob = (templateId: string, params: Record<string, unknown>) =>
  apiFetch<{ jobId: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ templateId, params }) });
export const listJobs = (filter: { status?: JobStatus; mine?: boolean } = {}) => {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.mine) q.set("mine", "1");
  return apiFetch<JobSummary[]>(`/api/jobs?${q.toString()}`);
};
export const getJob = (id: string) => apiFetch<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
export const postDecision = (
  id: string,
  body: { approve: boolean; edited_items?: unknown[]; note?: string; decision_token: string }
) => apiFetch<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(body) });
export const abortJob = (id: string) => apiFetch<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/abort`, { method: "POST" });
```

`mstd-ui/src/views/Timeline.tsx`:
```tsx
import React from "react";
import { MarkdownContent } from "../atoms/MarkdownContent";
import { ToolDetailItem } from "../atoms/ToolDetailItem";
import type { JobEventLog } from "../state/job-event-log";

export function Timeline({ log }: { log: JobEventLog }) {
  return (
    <div className="timeline">
      {log.retrying && <div className="retry-banner">正在重试…</div>}
      {log.thinkingText && <MarkdownContent text={log.thinkingText} pending />}
      {log.tools.map((tool) => <ToolDetailItem tool={tool} key={tool.toolCallId} />)}
      {log.assistantText && <MarkdownContent text={log.assistantText} />}
      {log.errors.map((e, i) => (
        <div className="tool-detail error" key={`err-${i}`}>
          <span className="tool-detail-dot" aria-hidden="true" />
          <div><b>{e.level}</b><small>{e.text}</small></div>
        </div>
      ))}
    </div>
  );
}
```

`mstd-ui/src/views/WorkspaceView.tsx`:
```tsx
import React from "react";
import { Timeline } from "./Timeline";
import { ApprovalActionEditor } from "./ApprovalActionEditor";
import type { JobEventLog } from "../state/job-event-log";
import type { ActionDraft, Template } from "../api/jobs";

export function WorkspaceView({
  templates, selectedTemplateId, onSelectTemplate, params, onChangeParams,
  onTrigger, running, log, draft, actions, onApprove, onReject,
}: {
  templates: Template[];
  selectedTemplateId: string;
  onSelectTemplate: (id: string) => void;
  params: { minuteToken: string };
  onChangeParams: (p: { minuteToken: string }) => void;
  onTrigger: () => void;
  running: boolean;
  log: JobEventLog;
  draft: { card_text: string } | null;
  actions: ActionDraft[];
  onApprove: (edited: ActionDraft[]) => void;
  onReject: (note: string) => void;
}) {
  return (
    <div className="workspace">
      <section className="trigger-panel">
        <label>
          模板
          <select value={selectedTemplateId} onChange={(e) => onSelectTemplate(e.target.value)}>
            {templates.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label>
          妙记 token（留空=自动选最近）
          <input
            value={params.minuteToken}
            onChange={(e) => onChangeParams({ ...params, minuteToken: e.target.value })}
            placeholder="可选：指定妙记 minute_token"
          />
        </label>
        <button className="primary" type="button" disabled={running} onClick={onTrigger}>触发</button>
      </section>

      <Timeline log={log} />

      {draft && (
        <section className="approval-card">
          <h3>审批：确认将真跑的动作</h3>
          <div className="draft-card-text"><p>{draft.card_text}</p></div>
          <ApprovalActionEditor actions={actions} onApprove={onApprove} onReject={onReject} />
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/timeline.test.tsx src/test/workspace.test.tsx`
Expected: PASS —— 全部通过（Timeline 渲染；Workspace 触发 + 审批卡出现）。

- [ ] **Step 5: Commit**

```bash
git add src/api/jobs.ts src/views/Timeline.tsx src/views/WorkspaceView.tsx src/test/timeline.test.tsx src/test/workspace.test.tsx
git commit -m "feat(mstd-ui): jobs API client + Timeline + Workspace (trigger→stream→inline approval)"
```

---

## Task 4.8: 审批动作清单编辑器（open_id + 置信度 + `requires_open_id` 门禁）

**Files:**
- Create: `mstd-ui/src/views/ApprovalActionEditor.tsx`
- Test: `mstd-ui/src/test/approval-editor.test.tsx`

**Interfaces:**
- Produces: `ApprovalActionEditor({ actions, onApprove, onReject })`：每条 todo 显示 `payload.title` + 负责人 `assignee_open_id` 可编辑输入 + **置信度徽标**（`requires_open_id ? "low" : "high"` 外观）；
  - **门禁（对齐 Phase 1 `requires_open_id` 语义）**：对 `requires_open_id === true` 的条目，**必须人工补齐合法 `ou_` 开头 open_id**（判定 `/^ou_/`，与后端 `isValidOpenId` 同规则）才允许"批准"；任一必填未补齐 → 批准按钮 `disabled`。
  - 批准 → `onApprove(editedActions)`（把编辑后的 `assignee_open_id` 回填进 payload；服务端会重规范化 + 重算 hash）；驳回 → `onReject(note)`。
- Consumes: `ActionDraft`（Task 4.7）。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/approval-editor.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalActionEditor } from "../views/ApprovalActionEditor";
import type { ActionDraft } from "../api/jobs";

const highOk: ActionDraft = { action_key: "k1", kind: "create_task", payload: { title: "写周报", assignee_open_id: "ou_a" }, payload_hash: "h1", target_open_id: "ou_a", ordinal: 0, requires_open_id: false };
const lowMissing: ActionDraft = { action_key: "k2", kind: "create_task", payload: { title: "订会议室", assignee_open_id: null }, payload_hash: "h2", target_open_id: null, ordinal: 1, requires_open_id: true };

describe("ApprovalActionEditor", () => {
  it("blocks approve while a requires_open_id item lacks a valid ou_ open_id", () => {
    render(<ApprovalActionEditor actions={[highOk, lowMissing]} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText(/低置信/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /批准/ })).toBeDisabled();
  });

  it("still blocks on an invalid (non ou_) open_id", async () => {
    render(<ApprovalActionEditor actions={[lowMissing]} onApprove={vi.fn()} onReject={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/负责人 open_id/), "u_wrong");
    expect(screen.getByRole("button", { name: /批准/ })).toBeDisabled();
  });

  it("enables approve after a valid ou_ open_id is filled, and emits edited actions", async () => {
    const onApprove = vi.fn();
    render(<ApprovalActionEditor actions={[lowMissing]} onApprove={onApprove} onReject={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/负责人 open_id/), "ou_filled");
    const approve = screen.getByRole("button", { name: /批准/ });
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(onApprove).toHaveBeenCalledWith([
      expect.objectContaining({ action_key: "k2", payload: expect.objectContaining({ assignee_open_id: "ou_filled" }) }),
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/approval-editor.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-ui/src/views/ApprovalActionEditor.tsx`:
```tsx
import React, { useMemo, useState } from "react";
import type { ActionDraft } from "../api/jobs";

// 与后端 server/safety/action-dsl.mjs 的 isValidOpenId 同一条规则
const isValidOpenId = (v: unknown): v is string => typeof v === "string" && /^ou_/.test(v);

function assigneeOf(a: ActionDraft): string {
  const v = a.payload.assignee_open_id ?? a.payload.to_open_id ?? a.target_open_id;
  return typeof v === "string" ? v : "";
}

export function ApprovalActionEditor({
  actions, onApprove, onReject,
}: {
  actions: ActionDraft[];
  onApprove: (edited: ActionDraft[]) => void;
  onReject: (note: string) => void;
}) {
  const [openIds, setOpenIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(actions.map((a) => [a.action_key, assigneeOf(a)]))
  );
  const [note, setNote] = useState("");

  const canApprove = useMemo(
    () => actions.every((a) => !a.requires_open_id || isValidOpenId(openIds[a.action_key])),
    [actions, openIds]
  );

  function submitApprove() {
    const edited = actions.map((a) => ({
      ...a,
      target_open_id: openIds[a.action_key] || a.target_open_id,
      payload: { ...a.payload, assignee_open_id: openIds[a.action_key] || a.payload.assignee_open_id },
    }));
    onApprove(edited);
  }

  return (
    <div className="approval-editor">
      <ul className="action-list">
        {actions.map((a) => {
          const value = openIds[a.action_key] ?? "";
          const invalid = a.requires_open_id && !isValidOpenId(value);
          return (
            <li key={a.action_key} className="action-item">
              <div className="action-head">
                <b>{String(a.payload.title ?? a.kind)}</b>
                <span className={`confidence-badge ${a.requires_open_id ? "low" : "high"}`}>
                  {a.requires_open_id ? "低置信 · 需人工补齐" : "高置信"}
                </span>
              </div>
              <label>
                负责人 open_id
                <input
                  className={`open-id-input ${invalid ? "invalid" : ""}`}
                  value={value}
                  placeholder="ou_ 开头"
                  onChange={(e) => setOpenIds((prev) => ({ ...prev, [a.action_key]: e.target.value }))}
                />
              </label>
              {invalid && <small className="hint">必须补齐合法 ou_ open_id 才可批准</small>}
            </li>
          );
        })}
      </ul>
      <textarea placeholder="审批备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="approval-actions">
        <button type="button" className="primary" disabled={!canApprove} onClick={submitApprove}>批准并真写</button>
        <button type="button" className="ghost" onClick={() => onReject(note)}>驳回</button>
      </div>
    </div>
  );
}
```
> 批准把编辑后的 `assignee_open_id` 交给 Phase 3 `POST /api/jobs/:id/decision`；服务端**重新 `canonicalizeActions` + 重算 `payload_hash`**，并在 `decisions` 落 `approved_action_keys_json`（含每条批准时 hash，供 Task 4.10 执行前比对）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/approval-editor.test.tsx`
Expected: PASS —— 全部通过（门禁：缺失/非法 open_id → 批准禁用；合法 ou_ → 启用并回填）。

- [ ] **Step 5: Commit**

```bash
git add src/views/ApprovalActionEditor.tsx src/test/approval-editor.test.tsx
git commit -m "feat(mstd-ui): approval action editor with requires_open_id gate (ou_ enforced)"
```

---

## Task 4.9: Board 视图（任务表 + 审批队列 + 详情审计）

**Files:**
- Create: `mstd-ui/src/views/BoardView.tsx`
- Test: `mstd-ui/src/test/board.test.tsx`

**Interfaces:**
- Produces: `BoardView({ jobs, selected, onSelect })` —— **纯表现组件**：
  - 任务表：状态 / 模板 / 时间 / 发起人；
  - 审批队列：筛 `status === "awaiting_approval"` 的子表；
  - 详情（`selected: JobDetail | null`）：`job_events` 回放（按 `seq`）+ 动作清单（每条 `status` + `result_json` 摘要）+ 决策审计（`decisions`：谁批了什么 + note + 时间）。
- Consumes: `JobSummary` / `JobDetail`（Task 4.7）。

- [ ] **Step 1: 写失败测试**

`mstd-ui/src/test/board.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardView } from "../views/BoardView";
import type { JobSummary, JobDetail } from "../api/jobs";

const jobs: JobSummary[] = [
  { id: "j1", template_id: "meeting_to_task", title: "周会", status: "awaiting_approval", created_by: "ou_a", created_at: 1 },
  { id: "j2", template_id: "meeting_to_task", title: "复盘", status: "done", created_by: "ou_b", created_at: 2 },
];

const detail: JobDetail = {
  job: jobs[1],
  events: [{ seq: 1, phase: "readonly", type: "tool_execution_start", payload_json: "{}", ts: 1 }],
  draft: { card_text: "待办", items_json: "[]" },
  actions: [{ action_key: "k1", kind: "create_task", payload: { title: "写周报" }, payload_hash: "h", target_open_id: "ou_a", ordinal: 0, requires_open_id: false, status: "succeeded", result_json: "{\"task_id\":\"t1\"}" }],
  decisions: [{ decided_by: "ou_a", decision: "approve", note: "ok", ts: 3 }],
};

describe("BoardView", () => {
  it("renders the jobs table and an approval queue filtered to awaiting_approval", () => {
    render(<BoardView jobs={jobs} selected={null} onSelect={vi.fn()} />);
    const queue = screen.getByTestId("approval-queue");
    expect(within(queue).getByText("周会")).toBeInTheDocument();
    expect(within(queue).queryByText("复盘")).toBeNull();
  });

  it("selecting a job calls onSelect", async () => {
    const onSelect = vi.fn();
    render(<BoardView jobs={jobs} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByText("复盘"));
    expect(onSelect).toHaveBeenCalledWith("j2");
  });

  it("renders detail: events replay + action result + decision audit", () => {
    render(<BoardView jobs={jobs} selected={detail} onSelect={vi.fn()} />);
    expect(screen.getByText(/tool_execution_start/)).toBeInTheDocument();
    expect(screen.getByText(/写周报/)).toBeInTheDocument();
    expect(screen.getByText(/succeeded/)).toBeInTheDocument();
    expect(screen.getByText(/approve/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-ui && npx vitest run src/test/board.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-ui/src/views/BoardView.tsx`:
```tsx
import React from "react";
import type { JobSummary, JobDetail } from "../api/jobs";

function JobsTable({ jobs, onSelect, caption }: { jobs: JobSummary[]; onSelect: (id: string) => void; caption: string }) {
  return (
    <table className="jobs-table">
      <caption>{caption}</caption>
      <thead><tr><th>状态</th><th>模板</th><th>标题</th><th>时间</th><th>发起人</th></tr></thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} onClick={() => onSelect(j.id)} style={{ cursor: "pointer" }}>
            <td>{j.status}</td><td>{j.template_id}</td>
            <td>{j.title || "(未命名)"}</td>
            <td>{new Date(j.created_at).toLocaleString()}</td>
            <td>{j.created_by || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BoardView({
  jobs, selected, onSelect,
}: {
  jobs: JobSummary[];
  selected: JobDetail | null;
  onSelect: (id: string) => void;
}) {
  const queue = jobs.filter((j) => j.status === "awaiting_approval");
  return (
    <div className="board">
      <JobsTable jobs={jobs} onSelect={onSelect} caption="任务" />
      <div data-testid="approval-queue">
        <JobsTable jobs={queue} onSelect={onSelect} caption="审批队列（awaiting_approval）" />
      </div>

      {selected && (
        <section className="job-detail">
          <h3>详情 · {selected.job.title || selected.job.id}</h3>
          <div className="detail-events">
            <h4>事件回放</h4>
            <ol>{selected.events.map((e) => <li key={e.seq}>#{e.seq} [{e.phase}] {e.type}</li>)}</ol>
          </div>
          <div className="detail-actions">
            <h4>动作清单 + 写结果</h4>
            <ul>{selected.actions.map((a) => (
              <li key={a.action_key}>
                <b>{String(a.payload.title ?? a.kind)}</b> — <span>{a.status}</span>
                {a.result_json && <small>结果：{a.result_json}</small>}
              </li>
            ))}</ul>
          </div>
          <div className="detail-decisions">
            <h4>决策审计</h4>
            <ul>{selected.decisions.map((d, i) => (
              <li key={i}>{d.decided_by} · {d.decision} · {d.note || ""} · {new Date(d.ts).toLocaleString()}</li>
            ))}</ul>
          </div>
        </section>
      )}
    </div>
  );
}
```
> App 层接线：`onSelect(id)` → `getJob(id)`（Task 4.7）→ 传回 `selected`。列表由 `listJobs`；审批队列可用 `listJobs({ status: "awaiting_approval" })` 或前端筛（此处组件内前端筛，便于测试）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-ui && npx vitest run src/test/board.test.tsx`
Expected: PASS —— 全部通过。

- [ ] **Step 5: 全量前端测试确认无回归 + Commit**

Run: `cd mstd-ui && npm test`
Expected: PASS —— Task 4.1-4.9 全绿。
```bash
git add src/views/BoardView.tsx src/test/board.test.tsx
git commit -m "feat(mstd-ui): Board view (jobs table + approval queue + detail replay/audit)"
```

> **App 接线（非独立任务，随本 Phase 尾声在 `App.tsx` 完成，逻辑已被上面各纯组件 + api 单测覆盖）**：`App.tsx` 组合 `bootstrap()`→(未登录)`LoginFeishu`；(已登录) `.app-shell`（侧栏 job 列表 + Workspace/Board 切换）；`onTrigger`=`createJob`→`openJobStream`（`reduceJobEvent` 累积 `log`）；轮询/流结束后 `getJob` 取 `draft/actions`；`onApprove`=`postDecision`；`setOnAuthInvalid(()=>setMe(null))` 实现 401→重登。

---

## Task 4.10: 服务端权威执行器 `executeApprovedAction`（第②段真写）

> **真写任务：只打测试群/测试清单 + 先 `--dry-run` 预检 + 走对账；单测用注入的 `runLark` mock，零飞书副作用。真机写在 Task 4.13 人工确认后跑。**

**Files:**
- Create: `mstd-orchestrator/server/execute/write-target.mjs`, `mstd-orchestrator/server/execute/execute-action.mjs`
- Test: `mstd-orchestrator/test/write-target.test.mjs`, `mstd-orchestrator/test/execute-action.test.mjs`

**Interfaces:**
- Produces（`write-target.mjs`）：`assertTestTarget(action, { allowOpenIds, allowTasklist }) -> void`——v1 fail-closed：`create_task` 的 `assignee_open_id` 必须 ∈ `allowOpenIds`；`send_dm` 的 `to_open_id` 必须 ∈ `allowOpenIds`；不满足抛 `Error("非测试目标，v1 拒绝真写")`。测试目标从 env 读（`MSTD_TEST_OPEN_IDS` 逗号分隔、`MSTD_TEST_TASKLIST_GUID`）。
- Produces（`execute-action.mjs`）：
  - `loadApprovedHashes(db, jobId) -> Map<action_key, payload_hash>`（读最新一条 `decisions` 的 `approved_action_keys_json`，形如 `[{action_key, payload_hash}]`）。
  - `reconcileAction(db, { action, runLark }) -> Promise<{ reconciled: boolean }>`（对 `executing`/`unknown` 条目：靠 `--idempotency-key` + 指纹回查飞书；已成功则 `markStatus(succeeded)`）。
  - `executeApprovedAction(db, { actionId, approvedHash, runLark, testTarget, now }) -> Promise<{ ok, reason?, status }>`：
    1. 查 `job_actions` 行；`status==="succeeded"` → 直接 `{ok:true, status:"succeeded"}`（幂等短路）。
    2. **hash 漂移校验**：`approvedHash != null && action.payload_hash !== approvedHash` → `markStatus(failed,{error:"hash_mismatch"})` → `{ok:false, reason:"hash_mismatch"}`。
    3. `assertTestTarget`（只打测试目标）。
    4. `buildWriteArgs({kind,payload}, action.idempotency_key)`（Phase 1；内置非 `ou_` fail-closed）。
    5. **`--dry-run` 预检**：`runLark([...argv, "--dry-run"])`，exit≠0 → `markStatus(failed)` 返回；零副作用验证 argv 被接受。
    6. `markStatus(executing)` → `runLark(argv)`（带原生 `--idempotency-key`）→ exit0 `markStatus(succeeded, result)` / 否则 `markStatus(failed)`。
- Consumes: Phase 1 `buildWriteArgs`（`server/safety/write-args.mjs`）、`markStatus`（`server/safety/action-store.mjs`）；`runLark(argv) -> {exitCode, stdout, stderr}` **注入**（生产实现 spawn `~/.hermes/node/bin/lark-cli` 带 `--profile`，Phase 2 `pi-client` 同款进程管理）。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/write-target.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { assertTestTarget } from "../server/execute/write-target.mjs";

const allow = { allowOpenIds: new Set(["ou_test1", "ou_test2"]), allowTasklist: "tl_test" };

describe("assertTestTarget", () => {
  it("passes create_task to an allowed test open_id", () => {
    expect(() => assertTestTarget({ kind: "create_task", payload: { assignee_open_id: "ou_test1" } }, allow)).not.toThrow();
  });
  it("rejects create_task to a non-test open_id (fail-closed)", () => {
    expect(() => assertTestTarget({ kind: "create_task", payload: { assignee_open_id: "ou_prod" } }, allow)).toThrow(/非测试目标/);
  });
  it("rejects send_dm to a non-test recipient", () => {
    expect(() => assertTestTarget({ kind: "send_dm", payload: { to_open_id: "ou_prod" } }, allow)).toThrow(/非测试目标/);
  });
});
```

`mstd-orchestrator/test/execute-action.test.mjs`:
```js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { executeApprovedAction, reconcileAction } from "../server/execute/execute-action.mjs";

let db;
const testTarget = { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "tl_test" };

beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('job1','meeting_to_task','running_write',1,1)").run();
  const actions = canonicalizeActions({ jobId: "job1", items: [
    { owner_name: "张三", task: "写周报", due: "2026-07-15", suggested_open_id: "ou_test1", confidence: "high" },
  ] });
  recordActions(db, "job1", actions);
});

function row() { return actionsToExecute(db, "job1")[0]; }

describe("executeApprovedAction", () => {
  it("dry-runs then executes, records succeeded + idempotency key present", async () => {
    const seen = [];
    const runLark = vi.fn(async (argv) => { seen.push(argv); return { exitCode: 0, stdout: JSON.stringify({ task_id: "t1" }), stderr: "" }; });
    const r = row();
    const out = await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    expect(out.ok).toBe(true);
    expect(out.status).toBe("succeeded");
    // 第一次调用是 --dry-run 预检
    expect(seen[0]).toContain("--dry-run");
    expect(seen[1]).toContain("--idempotency-key");
    expect(seen[1]).toContain("job1:" + r.action_key);
    // dry-run 不带 --dry-run 的真执行是第二次
    expect(seen[1]).not.toContain("--dry-run");
  });

  it("rejects on hash drift without ever calling lark", async () => {
    const runLark = vi.fn();
    const r = row();
    const out = await executeApprovedAction(db, { actionId: r.id, approvedHash: "STALE_HASH", runLark, testTarget });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("hash_mismatch");
    expect(runLark).not.toHaveBeenCalled();
    expect(actionsToExecute(db, "job1").find((x) => x.id === r.id).status).toBe("failed");
  });

  it("fails closed on a non-test target (never executes)", async () => {
    // 重录一个非测试 open_id 的动作
    const bad = canonicalizeActions({ jobId: "job1", items: [
      { owner_name: "x", task: "y", due: null, suggested_open_id: "ou_prod", confidence: "high" },
    ] });
    recordActions(db, "job1", bad);
    const target = actionsToExecute(db, "job1").find((x) => JSON.parse(x.canonical_payload_json).assignee_open_id === "ou_prod");
    const runLark = vi.fn();
    const out = await executeApprovedAction(db, { actionId: target.id, approvedHash: target.payload_hash, runLark, testTarget });
    expect(out.ok).toBe(false);
    expect(runLark).not.toHaveBeenCalled();
  });

  it("marks failed when the real exec exits non-zero (dry-run passed)", async () => {
    const runLark = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "(dry ok)", stderr: "" })  // dry-run
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "boom" });     // real
    const r = row();
    const out = await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("failed");
  });

  it("is idempotent: a succeeded action short-circuits (no lark call)", async () => {
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const r = row();
    await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    runLark.mockClear();
    const again = await executeApprovedAction(db, { actionId: r.id, approvedHash: r.payload_hash, runLark, testTarget });
    expect(again.status).toBe("succeeded");
    expect(runLark).not.toHaveBeenCalled();
  });
});

describe("reconcileAction", () => {
  it("marks succeeded if the fingerprint is found externally", async () => {
    const r = row();
    db.prepare("UPDATE job_actions SET status='executing' WHERE id=?").run(r.id);
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ items: [{ idempotency_key: r.idempotency_key, task_id: "t9" }] }), stderr: "" }));
    const out = await reconcileAction(db, { action: { ...r, status: "executing" }, runLark });
    expect(out.reconciled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/write-target.test.mjs test/execute-action.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/execute/write-target.mjs`:
```js
// v1 fail-closed：只允许写到配置的测试 open_id / 测试清单。
export function assertTestTarget(action, { allowOpenIds, allowTasklist } = {}) {
  const target = action.kind === "send_dm" ? action.payload?.to_open_id : action.payload?.assignee_open_id;
  if (!allowOpenIds || !allowOpenIds.has(target)) {
    throw new Error(`非测试目标，v1 拒绝真写: ${JSON.stringify(target)}（仅允许测试 open_id）`);
  }
  // create_task 的清单归属由服务端在拼 argv 时固定为 allowTasklist（见 write-phase 生产实现）；此处仅做收件人闸。
  void allowTasklist;
}

export function testTargetFromEnv(env = process.env) {
  const ids = (env.MSTD_TEST_OPEN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { allowOpenIds: new Set(ids), allowTasklist: env.MSTD_TEST_TASKLIST_GUID || "" };
}
```

`mstd-orchestrator/server/execute/execute-action.mjs`:
```js
import { buildWriteArgs } from "../safety/write-args.mjs";
import { markStatus } from "../safety/action-store.mjs";
import { assertTestTarget } from "./write-target.mjs";

export function loadApprovedHashes(db, jobId) {
  const row = db.prepare(
    `SELECT approved_action_keys_json FROM decisions WHERE job_id = ? AND decision = 'approve' ORDER BY ts DESC LIMIT 1`
  ).get(jobId);
  const map = new Map();
  if (!row || !row.approved_action_keys_json) return map;
  try {
    for (const e of JSON.parse(row.approved_action_keys_json)) {
      if (e && e.action_key) map.set(e.action_key, e.payload_hash);
    }
  } catch { /* 空 map = 无批准记录 */ }
  return map;
}

export async function executeApprovedAction(db, { actionId, approvedHash, runLark, testTarget, now = Date.now() }) {
  const action = db.prepare(`SELECT * FROM job_actions WHERE id = ?`).get(actionId);
  if (!action) return { ok: false, reason: "unknown action", status: "unknown" };
  if (action.status === "succeeded") return { ok: true, status: "succeeded" };

  const payload = JSON.parse(action.canonical_payload_json);

  // ② hash 漂移：批准后动作被改 → 拒绝，零执行
  if (approvedHash != null && action.payload_hash !== approvedHash) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "hash_mismatch", now }));
    return { ok: false, reason: "hash_mismatch", status: "failed" };
  }

  // 只打测试目标（fail-closed）
  try {
    assertTestTarget({ kind: action.kind, payload }, testTarget);
  } catch (e) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: String(e.message || e) }));
    return { ok: false, reason: "non_test_target", status: "failed" };
  }

  // buildWriteArgs 内置非 ou_ open_id fail-closed
  let argv;
  try {
    argv = buildWriteArgs({ kind: action.kind, payload }, action.idempotency_key);
  } catch (e) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: String(e.message || e) }));
    return { ok: false, reason: "build_args_rejected", status: "failed" };
  }

  // ① --dry-run 零副作用预检
  const dry = await runLark([...argv, "--dry-run"]);
  if (dry.exitCode !== 0) {
    markStatus(db, action.id, "failed", JSON.stringify({ error: "dry_run_failed", stderr: dry.stderr }));
    return { ok: false, reason: "dry_run_failed", status: "failed" };
  }

  markStatus(db, action.id, "executing");
  const res = await runLark(argv);
  if (res.exitCode === 0) {
    markStatus(db, action.id, "succeeded", JSON.stringify({ stdout: res.stdout }));
    return { ok: true, status: "succeeded" };
  }
  markStatus(db, action.id, "failed", JSON.stringify({ error: "exec_failed", exitCode: res.exitCode, stderr: res.stderr }));
  return { ok: false, reason: "exec_failed", status: "failed" };
}

// executing/unknown 先对账：靠 idempotency_key 指纹回查外部是否已成功
export async function reconcileAction(db, { action, runLark }) {
  const res = await runLark(["task", "+list", "--as", "user"]); // 生产按真实回查命令；关键是用 idempotency_key 指纹匹配
  let found = false;
  try {
    const parsed = JSON.parse(res.stdout || "{}");
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    found = items.some((it) => it && it.idempotency_key === action.idempotency_key);
  } catch { found = false; }
  if (found) { markStatus(db, action.id, "succeeded", JSON.stringify({ reconciled: true })); return { reconciled: true }; }
  return { reconciled: false };
}
```
> `reconcileAction` 的回查命令按真实 lark-cli 支持在生产实现时定稿（关键是拿 `--idempotency-key` 指纹匹配"外部已成功但本地未记账"）；单测用注入 `runLark` 断言"命中指纹→succeeded"路径。**恢复演练**（spec S4）："server 写完 lark-cli 但落库前崩溃"→重启对 `executing`/`unknown` 跑 `reconcileAction` 再决定是否重执。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/write-target.test.mjs test/execute-action.test.mjs`
Expected: PASS —— 全部通过（dry-run 先于真执行、hash 漂移零执行、非测试目标 fail-closed、真执行失败落 failed、succeeded 幂等短路、对账命中）。

- [ ] **Step 5: Commit**

```bash
cd mstd-orchestrator
git add server/execute/write-target.mjs server/execute/execute-action.mjs test/write-target.test.mjs test/execute-action.test.mjs
git commit -m "feat(mstd-ui): authoritative executeApprovedAction (dry-run precheck + hash-guard + idempotency + reconcile, test-target only)"
```

---

## Task 4.11: `lark_execute_approved_action` 工具（第②段 Pi）+ 服务端 fallback 直执

> **真写任务：第②段 Pi 与 fallback 共用 Task 4.10 执行器 + 同一幂等 key；只打测试群/清单；真机在 Task 4.13 人工确认后跑。**

**Files:**
- Create: `mstd-orchestrator/pi-ext/lark-execute.ts`（第②段唯一写工具，薄壳）
- Create: `mstd-orchestrator/server/execute/write-phase.mjs`（`runWritePhase`：默认 Pi 驱动 → 异常 fallback 直执）
- Test: `mstd-orchestrator/test/write-phase.test.mjs`

**Interfaces:**
- Produces（`pi-ext/lark-execute.ts`）：`registerTool({ name: "lark_execute_approved_action", parameters: Type.Object({ action_id: Type.String() }), execute })` —— **薄壳**：按 `action_id` 调服务端 `executeApprovedAction`（经进程内 HTTP/IPC 到 server；本地验证版直接 import 执行器 + 打开同一 DB），回报每条结果 `{content:[{type:"text",text}], details}`。**不挂 `lark_read`、不挂自由 `lark` 写工具**；只在第②段进程（`LARK_ALLOW_WRITE=1`）加载。
- Produces（`write-phase.mjs`）：`runWritePhase(db, jobId, { spawnPi, runLark, testTarget, timeoutMs }) -> Promise<{ mode:"pi"|"fallback", results }>`：
  - 默认 `spawnPi()` 起第②段 Pi 逐条驱动（审计连续）；
  - **Pi 起不来 / `agent_end` 异常 / 输出跑偏 / 超时 → 服务端直接顺序 `executeApprovedAction`**（spec S6 fallback），对 `actionsToExecute(db, jobId)`（pending/failed）逐条执行；`executing/unknown` 先 `reconcileAction`。
- Consumes: Task 4.10 执行器；Phase 1 `actionsToExecute`；Phase 2 `startPi`（生产 `spawnPi` 用它，extensions=`[providers.ts, lark-execute.ts]`、env 加 `LARK_ALLOW_WRITE=1`）。

- [ ] **Step 1: 写失败测试（fallback 路径，注入 spawnPi/runLark）**

`mstd-orchestrator/test/write-phase.test.mjs`:
```js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { runWritePhase } from "../server/execute/write-phase.mjs";

let db;
const testTarget = { allowOpenIds: new Set(["ou_test1"]), allowTasklist: "tl_test" };

beforeEach(() => {
  db = openDb(); migrate(db);
  db.prepare("INSERT INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES ('job1','meeting_to_task','running_write',1,1)").run();
  const actions = canonicalizeActions({ jobId: "job1", items: [
    { owner_name: "张三", task: "写周报", due: null, suggested_open_id: "ou_test1", confidence: "high" },
  ] });
  recordActions(db, "job1", actions);
  // 落一条批准决策，携带每条批准时 hash（Phase 3 decision writer 契约）
  const a = actionsToExecute(db, "job1")[0];
  db.prepare(
    "INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, ts) VALUES ('d1','job1','ou_test1','approve',?,1)"
  ).run(JSON.stringify([{ action_key: a.action_key, payload_hash: a.payload_hash }]));
});

describe("runWritePhase", () => {
  it("falls back to direct sequential execution when Pi cannot start", async () => {
    const spawnPi = vi.fn(async () => { throw new Error("pi spawn failed"); });
    const calls = [];
    const runLark = vi.fn(async (argv) => { calls.push(argv); return { exitCode: 0, stdout: "{}", stderr: "" }; });
    const out = await runWritePhase(db, "job1", { spawnPi, runLark, testTarget });
    expect(out.mode).toBe("fallback");
    expect(out.results[0].ok).toBe(true);
    // 每条都先 dry-run 后真执行
    expect(calls[0]).toContain("--dry-run");
    expect(calls[1]).toContain("--idempotency-key");
    // 执行后不再有 pending/failed
    expect(actionsToExecute(db, "job1")).toHaveLength(0);
  });

  it("uses Pi mode when spawnPi resolves cleanly", async () => {
    const spawnPi = vi.fn(async () => ({ ok: true }));
    const runLark = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    const out = await runWritePhase(db, "job1", { spawnPi, runLark, testTarget });
    expect(out.mode).toBe("pi");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/write-phase.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/execute/write-phase.mjs`:
```js
import { actionsToExecute } from "../safety/action-store.mjs";
import { executeApprovedAction, reconcileAction, loadApprovedHashes } from "./execute-action.mjs";

async function directExecute(db, jobId, { runLark, testTarget }) {
  const approved = loadApprovedHashes(db, jobId);
  const results = [];
  for (const action of actionsToExecute(db, jobId)) {
    // executing/unknown 先对账（此处 actionsToExecute 只返回 pending/failed；executing/unknown 由恢复流程单独对账）
    const approvedHash = approved.get(action.action_key) ?? null;
    const r = await executeApprovedAction(db, { actionId: action.id, approvedHash, runLark, testTarget });
    results.push({ action_key: action.action_key, ...r });
  }
  return results;
}

export async function runWritePhase(db, jobId, { spawnPi, runLark, testTarget, timeoutMs = 240000 }) {
  try {
    // 默认走 Pi 驱动（审计连续）；spawnPi 内部用 Phase 2 startPi + runJob 逐条调 lark_execute_approved_action
    await Promise.race([
      spawnPi(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("write phase timeout")), timeoutMs)),
    ]);
    // Pi 驱动结束后仍可能残留 pending/failed（部分失败）→ 直执兜底补齐
    const remaining = actionsToExecute(db, jobId);
    if (remaining.length > 0) {
      const results = await directExecute(db, jobId, { runLark, testTarget });
      return { mode: "pi", results };
    }
    return { mode: "pi", results: [] };
  } catch {
    // Pi 起不来 / agent_end 异常 / 输出跑偏 / 超时 → fallback 直执（spec S6）
    const results = await directExecute(db, jobId, { runLark, testTarget });
    return { mode: "fallback", results };
  }
}

// void reconcileAction —— 恢复流程（executing/unknown）在重启对账里引用
void reconcileAction;
```

`mstd-orchestrator/pi-ext/lark-execute.ts`（第②段唯一写工具；薄壳调服务端执行器）:
```ts
/**
 * Pi 扩展（仅第②段加载）：lark_execute_approved_action
 * 模型不能改 payload/收件人/flag，只能按 action_id "选执行哪一条已批准动作"。
 * 权威执行在服务端 executeApprovedAction（buildWriteArgs + --dry-run + --idempotency-key + hash 校验 + 只打测试目标）。
 * 本地验证版：直接 import 执行器 + 打开同一 DB；生产版改 IPC/HTTP 到 server 进程。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db/index.mjs";
import { executeApprovedAction, loadApprovedHashes } from "../server/execute/execute-action.mjs";
import { testTargetFromEnv } from "../server/execute/write-target.mjs";

const LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");

function runLark(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const profile = process.env.LARK_PROFILE;
    const finalArgs = profile ? ["--profile", profile, ...argv] : argv;
    const child = spawn(LARK_CLI, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("close", (code) => resolve({ exitCode: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lark_execute_approved_action",
    label: "Execute Approved Action",
    description:
      "执行一条【已批准】的飞书写动作。只接受 action_id；不得重新判断、不得改内容、只回报每条结果。" +
      "权威执行在服务端（dry-run 预检 + 幂等 key + hash 校验 + 只打测试目标）。",
    parameters: Type.Object({
      action_id: Type.String({ description: "已批准动作的 action_id" }),
    }),
    async execute(_id, params) {
      const dbPath = process.env.MSTD_DB_PATH || "./mstd.db";
      const db = openDb(dbPath);
      try {
        const action = db.prepare("SELECT job_id FROM job_actions WHERE id = ?").get(params.action_id) as { job_id?: string } | undefined;
        if (!action?.job_id) {
          return { content: [{ type: "text", text: `未知 action_id: ${params.action_id}` }], details: { ok: false } };
        }
        const approved = loadApprovedHashes(db, action.job_id);
        const key = db.prepare("SELECT action_key FROM job_actions WHERE id = ?").get(params.action_id) as { action_key: string };
        const out = await executeApprovedAction(db, {
          actionId: params.action_id,
          approvedHash: approved.get(key.action_key) ?? null,
          runLark,
          testTarget: testTargetFromEnv(),
        });
        return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
      } finally {
        db.close();
      }
    },
  });
}
```
> 生产 `spawnPi()`（在 server 里）用 Phase 2 `startPi({ provider:"cz-gpt", model:"gpt-5.5", thinking:"medium", extensions:[providers.ts, lark-execute.ts], env:{ LARK_ALLOW_WRITE:"1", MSTD_DB_PATH, MSTD_TEST_OPEN_IDS, MSTD_TEST_TASKLIST_GUID } })` + `runJob(执行器 prompt, { onEvent })`；执行器 prompt 塞已批准 `action_id` 列表 + 死命令"逐条调 `lark_execute_approved_action`，不重判、不改、只回报"。工具本身的 spawn 正确性由 Task 4.13 真机 smoke 验证（单测不 spawn Pi）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/write-phase.test.mjs`
Expected: PASS —— fallback 直执（Pi 失败→逐条 dry-run+真执行→无残留 pending/failed）；Pi 模式路径。

- [ ] **Step 5: Commit**

```bash
git add server/execute/write-phase.mjs pi-ext/lark-execute.ts test/write-phase.test.mjs
git commit -m "feat(mstd-ui): lark_execute_approved_action tool + runWritePhase (Pi-driven with server fallback)"
```

---

## Task 4.12: 加固落地 — 固定通知卡片模板 + 绝对工作目录/read_file 限定 + 导出 TTL

**Files:**
- Create: `mstd-orchestrator/server/execute/render-card.mjs`, `mstd-orchestrator/server/execute/job-workdir.mjs`
- Test: `mstd-orchestrator/test/render-card.test.mjs`, `mstd-orchestrator/test/job-workdir.test.mjs`

**Interfaces:**
- Produces（`render-card.mjs`）：`renderNotifyCard(cardText) -> object`（`send_dm` 用；把 `draft_zh` 文案**转义**后塞进**服务端固定 interactive 卡片模板**，模型碰不到 card JSON 结构；正文经 `escapeLarkText` 去除 `{{}}`/控制字符）。**替换** Phase 1 `write-args.mjs` `sendDmArgs` 里裸 `JSON.stringify({ ref })` 的临时做法（`send_dm` v1 默认关，本模块为其显式开启时的安全渲染兜底）。
- Produces（`job-workdir.mjs`）：
  - `jobWorkdir(baseDir, jobId) -> string`（**绝对路径**：`resolve(baseDir, jobId)`）。
  - `resolveInsideWorkdir(workdir, requestedPath) -> string`（把 `read_file` 请求路径归一到 workdir 内；越界（`../` 逃逸）抛 `Error` fail-closed）。
  - `sweepExpiredExports(baseDir, ttlMs, now) -> string[]`（删 workdir 下 mtime 超 TTL 的导出文件，返回已删列表）。
- Consumes: `node:path` / `node:fs`。

- [ ] **Step 1: 写失败测试**

`mstd-orchestrator/test/render-card.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import { renderNotifyCard, escapeLarkText } from "../server/execute/render-card.mjs";

describe("renderNotifyCard", () => {
  it("wraps draft text in a fixed card structure, escaping injection", () => {
    const card = renderNotifyCard("任务已建 {{malicious}}  end");
    expect(card.config).toBeDefined();
    expect(card.elements).toBeInstanceOf(Array);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("{{malicious}}");
    expect(serialized).not.toContain("  ");
  });
  it("escapeLarkText strips template braces, control chars, collapses whitespace", () => {
    expect(escapeLarkText("a{{b}}c")).toBe("abc");
    expect(escapeLarkText("xy  z")).toBe("xy z");
  });
});
```

`mstd-orchestrator/test/job-workdir.test.mjs`:
```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { jobWorkdir, resolveInsideWorkdir, sweepExpiredExports } from "../server/execute/job-workdir.mjs";

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "mstd-wd-")); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe("jobWorkdir", () => {
  it("returns an absolute per-job dir", () => {
    const wd = jobWorkdir(base, "job1");
    expect(isAbsolute(wd)).toBe(true);
    expect(wd.endsWith("job1")).toBe(true);
  });
});

describe("resolveInsideWorkdir", () => {
  it("resolves a file inside the workdir", () => {
    const wd = jobWorkdir(base, "job1");
    expect(resolveInsideWorkdir(wd, "out/transcript.txt").startsWith(wd)).toBe(true);
  });
  it("rejects path traversal escaping the workdir (fail-closed)", () => {
    const wd = jobWorkdir(base, "job1");
    expect(() => resolveInsideWorkdir(wd, "../../etc/passwd")).toThrow(/越界|outside/i);
  });
});

describe("sweepExpiredExports", () => {
  it("removes files older than the TTL", () => {
    const wd = jobWorkdir(base, "job1");
    const { mkdirSync } = require("node:fs");
    mkdirSync(wd, { recursive: true });
    const f = join(wd, "old.txt");
    writeFileSync(f, "x");
    const old = (Date.now() - 3600_000) / 1000;
    utimesSync(f, old, old);
    const removed = sweepExpiredExports(base, 60_000, Date.now());
    expect(removed).toContain(f);
    expect(existsSync(f)).toBe(false);
  });
});
```
> 注：测试里 `require` 在 ESM 下用 `import { mkdirSync } from "node:fs"` 顶部引入替代；实现时把 `mkdirSync` 并入顶部 import（此处示意，最终测试文件用顶部 import）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/render-card.test.mjs test/job-workdir.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 最小实现**

`mstd-orchestrator/server/execute/render-card.mjs`:
```js
// 去掉飞书模板占位 {{ }} 与控制字符，防注入（正文来自 draft_zh，不可信）
export function escapeLarkText(text) {
  return String(text ?? "")
    .replace(/\{\{|\}\}/g, "")        // 去模板占位符
    .replace(/[\u0000-\u001f\u007f]/g, "") // 去控制字符
    .replace(/\s+/g, " ")                  // 折叠连续空白
    .trim();
}

// 服务端固定 interactive 卡片模板：模型只提供正文文本，碰不到结构
export function renderNotifyCard(cardText) {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: escapeLarkText(cardText) } },
    ],
  };
}
```

`mstd-orchestrator/server/execute/job-workdir.mjs`:
```js
import { resolve, sep } from "node:path";
import { readdirSync, statSync, rmSync, existsSync } from "node:fs";

export function jobWorkdir(baseDir, jobId) {
  return resolve(baseDir, String(jobId));
}

export function resolveInsideWorkdir(workdir, requestedPath) {
  const abs = resolve(workdir, String(requestedPath));
  const root = resolve(workdir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`路径越界（outside workdir）: ${requestedPath}`);
  }
  return abs;
}

export function sweepExpiredExports(baseDir, ttlMs, now = Date.now()) {
  const root = resolve(baseDir);
  if (!existsSync(root)) return [];
  const removed = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (now - st.mtimeMs > ttlMs) { rmSync(p, { force: true }); removed.push(p); }
    }
  };
  walk(root);
  return removed;
}
```
> 接线：第①段 Pi 的 `read_file`（Phase 1 `lark_read` 的 `get_transcript` 导出到 `./out`）落到 `jobWorkdir(base, jobId)`，`read_file` 参数经 `resolveInsideWorkdir` 归一（越界拒）；导出物由定时 `sweepExpiredExports(base, TTL, now)` 清理。`send_dm`（默认关）显式开启时，`buildWriteArgs` 的 `--content` 改用 `JSON.stringify(renderNotifyCard(cardText))`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mstd-orchestrator && npx vitest run test/render-card.test.mjs test/job-workdir.test.mjs`
Expected: PASS —— 全部通过（卡片转义、路径穿越 fail-closed、TTL 清理）。

- [ ] **Step 5: 全量后端测试确认无回归 + Commit**

Run: `cd mstd-orchestrator && npm test`
Expected: PASS —— Phase 0/1/2 全部 + Task 4.10/4.11/4.12 后端新测全绿。
```bash
git add server/execute/render-card.mjs server/execute/job-workdir.mjs test/render-card.test.mjs test/job-workdir.test.mjs
git commit -m "feat(mstd-ui): hardening — fixed notify card template + workdir confinement + export TTL sweep"
```

---

## Task 4.13: 真机验证（Browser 插件：触发→看流→审批→真写）

> **不用 Playwright（本项目约定默认走 Browser 插件 Claude-in-Chrome）。真写步骤只打测试群/测试任务清单 + 先 `--dry-run` + 走对账；启用第②段前必须人工确认。**

**Files:**
- Create: `mstd-orchestrator/supervisor/write-smoke.mjs`（手动第②段直执 smoke，只打测试清单；不进单测）
- Modify: `mstd-ui/src/App.tsx`（接线收尾：`bootstrap`/`LoginFeishu`/`.app-shell`/`WorkspaceView`/`BoardView`/`openJobStream`/`postDecision`/`setOnAuthInvalid`）——逻辑已被 Task 4.4-4.9 纯组件 + api 单测覆盖，本步只做组合装配。

**Interfaces:**
- Produces: 一条可人工跑的第②段直执 smoke（绕过 Pi，用 `runWritePhase` 的 fallback 直执，只打配置的测试 open_id/清单，验证 `--dry-run`→真写→`job_actions.succeeded`→对账）；一份 Browser 插件真机走查记录（触发→SSE 时间线→审批编辑→批准→真写→Board 看结果）。
- Consumes: Task 4.10/4.11 执行器；`mcp__claude-in-chrome__*`（`navigate`/`read_page`/`computer`/`get_page_text`/`read_network_requests`）。

- [ ] **Step 1: 装配 `App.tsx`（组合已测组件）**

`mstd-ui/src/App.tsx`（关键装配；各子件已单测，此处只接线）:
```tsx
import React, { useEffect, useState } from "react";
import { bootstrap, feishuLogin, setOnAuthInvalid, type Me } from "./api/auth";
import { LoginFeishu } from "./views/LoginFeishu";
import { WorkspaceView } from "./views/WorkspaceView";
import { BoardView } from "./views/BoardView";
import { createJob, listJobs, getJob, listTemplates, postDecision, type JobSummary, type JobDetail, type Template, type ActionDraft } from "./api/jobs";
import { openJobStream } from "./api/job-stream";
import { emptyLog, reduceJobEvent, type JobEventLog, type SseEvent } from "./state/job-event-log";
import { useMediaQuery } from "./atoms/hooks";

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<"workspace" | "board">("workspace");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selected, setSelected] = useState<JobDetail | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [params, setParams] = useState({ minuteToken: "" });
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<JobEventLog>(emptyLog());
  const [draft, setDraft] = useState<{ card_text: string } | null>(null);
  const [actions, setActions] = useState<ActionDraft[]>([]);
  const isMobile = useMediaQuery("(max-width: 760px)");

  useEffect(() => {
    setOnAuthInvalid(() => setMe(null));
    bootstrap().then((m) => { setMe(m); setReady(true); });
  }, []);
  useEffect(() => { if (me) { listTemplates().then(setTemplates); listJobs({ mine: true }).then(setJobs); } }, [me]);

  async function onTrigger() {
    setRunning(true); setLog(emptyLog()); setDraft(null); setActions([]);
    const { jobId: id } = await createJob("meeting_to_task", params);
    setJobId(id);
    await openJobStream(id, {
      onEvent: (e) => setLog((prev) => reduceJobEvent(prev, e as SseEvent)),
      onDone: async () => {
        const detail = await getJob(id);
        setRunning(false);
        if (detail.draft) setDraft({ card_text: detail.draft.card_text });
        setActions(detail.actions);
        listJobs({ mine: true }).then(setJobs);
      },
      onError: async () => { setRunning(false); const d = await getJob(id); setActions(d.actions); },
    });
  }

  async function onApprove(edited: ActionDraft[]) {
    if (!jobId) return;
    // decision_token 由 Phase 3 在 GET /api/jobs/:id 时下发（一次性）；此处从 selected/detail 带上
    const token = (await getJob(jobId)) as unknown as { decision_token?: string };
    await postDecision(jobId, { approve: true, edited_items: edited, decision_token: token.decision_token || "" });
    listJobs({ mine: true }).then(setJobs);
  }

  if (!ready) return <div>加载中…</div>;
  if (!me) return <LoginFeishu onStart={() => feishuLogin(tab === "board" ? "/board" : "/")} />;

  return (
    <div className="app-shell">
      {!isMobile && (
        <aside className="app-sidebar">
          <button onClick={() => setTab("workspace")}>工作台</button>
          <button onClick={() => setTab("board")}>看板</button>
          <ul>{jobs.map((j) => <li key={j.id} onClick={() => getJob(j.id).then(setSelected)}>{j.title || j.id} · {j.status}</li>)}</ul>
        </aside>
      )}
      <main className="app-main">
        {tab === "workspace" ? (
          <WorkspaceView
            templates={templates} selectedTemplateId="meeting_to_task" onSelectTemplate={() => {}}
            params={params} onChangeParams={setParams} onTrigger={onTrigger} running={running}
            log={log} draft={draft} actions={actions} onApprove={onApprove} onReject={() => {}}
          />
        ) : (
          <BoardView jobs={jobs} selected={selected} onSelect={(id) => getJob(id).then(setSelected)} />
        )}
      </main>
    </div>
  );
}
```
把 `mstd-ui/src/main.tsx` 的 `Boot` 换成 `import App` 并渲染 `<App />`。

- [ ] **Step 2: 前端构建冒烟**

Run: `cd mstd-ui && npm run build`
Expected: `tsc -b` 类型通过 + `vite build` 产出 `dist/`（无 TS 报错；接线不破坏类型）。

- [ ] **Step 3: 第①段真机（只读，天然安全）——先验触发→看流→审批卡**

（前置：Phase 3 server 已起、飞书 OAuth 可登录、`.env` 就绪）用 **Browser 插件**：
- `mcp__claude-in-chrome__navigate` 打开 `http://localhost:3001`（server 托管的 SPA 或 `vite dev`）。
- `mcp__claude-in-chrome__computer` 点"飞书扫码登录"→ 完成 OAuth → 回到工作台。
- 选"会议纪要→建任务"→"触发"→ `mcp__claude-in-chrome__read_page` / `get_page_text` 观察 SSE 时间线（应见 `tool_start`(lark)→`tool_result`→`assistant_delta`→审批卡出现），`read_network_requests` �authorize `/api/jobs/:id/stream` 事件序列以 `message_done` 收尾。
- 断言审批卡展示 `draft.card_text` + 动作清单；低置信条目高亮、批准按钮在补齐合法 `ou_` 前 `disabled`。
Expected: 第①段**全程零飞书写**（只读 `minutes +search`/`+detail`），审批卡与动作清单正确。

- [ ] **Step 4: 第②段真写（★人工确认后再跑；只打测试群/测试清单 + dry-run + 对账）**

> **STOP：本步真写飞书。执行前必须人工确认：(a) `.env`/env 已设 `MSTD_TEST_OPEN_IDS` 只含测试账号、`MSTD_TEST_TASKLIST_GUID` 为测试清单；(b) 目标是测试群/测试任务清单；(c) `LARK_ALLOW_WRITE=1` 仅在第②段进程。确认前不要运行。**

先跑无 UI 的直执 smoke（绕过 Pi，验证执行器 + 只打测试目标）：
`mstd-orchestrator/supervisor/write-smoke.mjs`（手动；`runWritePhase` fallback 直执一条测试动作）:
```js
import { openDb, migrate } from "../server/db/index.mjs";
import { canonicalizeActions } from "../server/safety/action-dsl.mjs";
import { recordActions, actionsToExecute } from "../server/safety/action-store.mjs";
import { runWritePhase } from "../server/execute/write-phase.mjs";
import { testTargetFromEnv } from "../server/execute/write-target.mjs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const LARK_CLI = join(homedir(), ".hermes", "node", "bin", "lark-cli");
const runLark = (argv) => new Promise((res) => {
  const p = process.env.LARK_PROFILE; const args = p ? ["--profile", p, ...argv] : argv;
  const c = spawn(LARK_CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
  const out = []; const err = [];
  c.stdout.on("data", (d) => out.push(d)); c.stderr.on("data", (d) => err.push(d));
  c.on("close", (code) => res({ exitCode: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
});

const db = openDb(process.env.MSTD_DB_PATH || "./mstd.db"); migrate(db);
const jobId = "smoke-write-1";
db.prepare("INSERT OR IGNORE INTO orch_jobs (id, template_id, status, created_at, updated_at) VALUES (?, 'meeting_to_task','running_write',?,?)").run(jobId, Date.now(), Date.now());
const testOpenId = (process.env.MSTD_TEST_OPEN_IDS || "").split(",")[0];
const actions = canonicalizeActions({ jobId, items: [{ owner_name: "测试", task: "【smoke】幂等真写验证", due: null, suggested_open_id: testOpenId, confidence: "high" }] });
recordActions(db, jobId, actions);
const a = actionsToExecute(db, jobId)[0];
db.prepare("INSERT INTO decisions (id, job_id, decided_by, decision, approved_action_keys_json, ts) VALUES (?,?,?,?,?,?)")
  .run("d-smoke", jobId, testOpenId, "approve", JSON.stringify([{ action_key: a.action_key, payload_hash: a.payload_hash }]), Date.now());
const out = await runWritePhase(db, jobId, { spawnPi: async () => { throw new Error("force fallback"); }, runLark, testTarget: testTargetFromEnv() });
console.log("[write-smoke]", JSON.stringify(out, null, 2));
console.log("[write-smoke] 再跑一次应幂等（不重复建）");
const out2 = await runWritePhase(db, jobId, { spawnPi: async () => { throw new Error("force fallback"); }, runLark, testTarget: testTargetFromEnv() });
console.log("[write-smoke] 第二次:", JSON.stringify(out2, null, 2));
db.close();
```
Run（人工确认后）: `cd mstd-orchestrator && set -a; . ./.env; set +a && MSTD_TEST_OPEN_IDS=ou_你的测试号 MSTD_TEST_TASKLIST_GUID=tl_测试清单 node supervisor/write-smoke.mjs`
Expected: 第一次 `results[0].ok=true status=succeeded`（先 `--dry-run` 后真写，带 `--idempotency-key job:action`）；**第二次因原生幂等 key 不重复建**（飞书侧幂等/对账命中）。到测试清单核对只有 1 条任务。

- [ ] **Step 5: 第②段真写（经 Pi + UI，Browser 插件）**

人工确认后，用 Browser 插件在 UI 上：补齐低置信 open_id（用测试 open_id）→ 点"批准并真写"→ 观察 job 转 `running_write`→`done`；到 Board 详情看每条 `job_actions.status=succeeded` + `result_json` + 决策审计（谁批的、note、时间）。再到飞书测试清单核对任务真的建了、且只 1 条（幂等）。
Expected: 全链 触发→流→审批→真写→对账 通过；真写只落测试清单；Board 审计完整。用 `verify` skill 收尾（观察真实行为，非仅 UI 截图）。

- [ ] **Step 6: Commit**

```bash
cd mstd-orchestrator && git add supervisor/write-smoke.mjs && git commit -m "test(mstd-ui): manual phase-2 write smoke (test-target only, dry-run + idempotency + reconcile)"
cd ../mstd-ui && git add src/App.tsx src/main.tsx && git commit -m "feat(mstd-ui): wire App shell (login/workspace/board/stream/approve) + browser-plugin verification"
```

---

## Self-Review

**Spec 覆盖（Phase 4 范围）：**
- 新建 `mstd-ui`（Vite+React+TS）+ vitest → Task 4.1 ✓
- **抽原子**（改 import/去品牌串）：`MarkdownContent`(4.3)、`Icon`/`ICON_PATHS`(4.2)、CSS tokens(4.2)、`useMediaQuery`/`useProcessingClock`(4.2)、`ToolDetailItem` 外观(4.3)、Login 分屏布局(4.4) ✓——均引用 pricing `main.tsx` 真实行号（200-359/383-408/707-745/804-846/987-1026）与 `styles.css:17-176` 真实 token 块。
- 飞书扫码/OAuth 登录 + token/bootstrap（`/api/auth/feishu/*` + `/api/me`；401→重登）→ Task 4.4 ✓
- **我们自己的 SSE 客户端**（消费 Phase 2/3 事件协议，不 drop-in `streamApi`）→ Task 4.5；类型化 `JobEventLog` 状态机（重建，不搬 `chat-state.ts`）→ Task 4.6 ✓——事件名精确对齐 Phase 2 `event-translator.mjs` 冻结集（`assistant_delta/thinking_status/tool_start/tool_result/message_done/retry_status/error/unknown`）。
- Workspace（模板选择器 v1 仅"会议→建任务" + 触发表单 → 流式时间线 → 原地审批卡）→ Task 4.7；审批动作清单编辑器（open_id + 置信度徽标 + `requires_open_id` 强制补 `ou_`）→ Task 4.8 ✓——门禁规则 `/^ou_/` 与 Phase 1 `action-dsl.mjs isValidOpenId`、`requires_open_id = confidence==="low" || !isValidOpenId(...)` 一致。
- Board（任务表 + 审批队列筛 `awaiting_approval` + 详情回放/动作结果/决策审计）→ Task 4.9 ✓。
- **打开真写（第②段）**：`executeApprovedAction`（Phase 1 `buildWriteArgs` + 原生 `--idempotency-key` + **先 `--dry-run` 预检** + action-store 状态机 + 对账）→ Task 4.10；`lark_execute_approved_action` 薄壳 + 服务端 fallback 直执（spec S6）→ Task 4.11 ✓——只打测试群/清单（`assertTestTarget` fail-closed）。
- 加固（审查 defer 到 Phase 4）：`send_dm` 固定卡片模板 + 转义(4.12)、每 job 绝对工作目录 + `read_file` 限定 + 导出 TTL(4.12) ✓。
- 收尾：Browser 插件真机验证（触发→流→审批→真写；不用 Playwright；真写人工确认后跑）→ Task 4.13 ✓。

**对 Phase 1/2/3 引用准确性（已读真实文件核对）：**
- Phase 1（真实 `.mjs`）：`buildWriteArgs(action, idempotencyKey)`（非 `ou_` fail-closed）、`canonicalizeActions({jobId,items,enableNotify})` 产 `{action_key,kind,payload,payload_hash,target_open_id,ordinal,requires_open_id}`、`isValidOpenId`、`deriveIdempotencyKey=`${jobId}:${actionKey}``、`recordActions`/`actionsToExecute`(pending/failed by ordinal)/`markStatus`、`consumeApprovalToken({token,jobId,operatorOpenId})`——全部按真实签名消费。DB 列名对齐真实 `001_init.sql`（`job_actions` 含 `ordinal`/`external_ref`；`decisions` 含 `approved_action_keys_json`/`payload_hash_at_decision`；时间戳 `BIGINT` epoch ms）。
- Phase 2（真实计划）：前端 SSE 事件名 = `event-translator.mjs` 冻结集；第②段 Pi 用 `startPi({provider,model,thinking,extensions,cwd,env})` + `runJob(message,{id,onEvent,timeoutMs})`；`buildPiEnv` env 白名单 + 第②段 `LARK_ALLOW_WRITE=1`。
- Phase 3（计划未落地）：端点/DB 列引用以 **spec「后端 server」段 + 真实 `001_init.sql`** 为准，已在 Global Constraints 固化契约；`decision_token`（Task 1.5 `issueApprovalToken/consumeApprovalToken`）、`auth_challenges`（Task 1.6）由 Phase 3 接线，前端只发起/消费。
- Pi 扩展 API：`lark-execute.ts` 用 `pi.registerTool({name,label,description,parameters:Type.Object(...),execute})` + `typebox`，与真实 `pi-ext/lark.ts` 同款。

**Placeholder 扫描：** 无 TBD/TODO。每个 code step 给完整可运行代码 + `@testing-library/react`/vitest 组件测试或 `.mjs` 单测。两处**显式标注"实现时补全"**（非占位空缺）：① `Icon.tsx` 的 `ICON_PATHS` 只示 3 键、注明"从 `main.tsx:221-336` 逐字复制全 19 键"（纯搬运，无逻辑）；② `styles.css` token 块只示核心子集、注明"从 `styles.css:17-176` 逐字复制完整 `:root`/`[data-theme=dark]`"（纯搬运）。二者均为机械复制、无设计决策，不影响可运行性与测试。`reconcileAction` 的真实回查命令标注"生产实现时按真实 lark-cli 支持定稿"（单测走注入 `runLark` 验证指纹命中路径）。

**从 pricing app 实际确认可抽的原子（已读 `main.tsx`/`styles.css` 核对存在）：** `ICON_PATHS`(221)+`Icon`(338)、`useProcessingClock`(383)、`useMediaQuery`(394)、`MarkdownContent`(987, `React.memo`)、`ToolDetailItem`(1005, 外观复用喂我们模型)、`Login` 分屏(804, `login-shell/login-copy/login-card/login-preview`)、`setAuthToken`(443)/`authHeaders`(446)/`api` 401 处理(662-675) 套路、`consumeBlock`(730, 借分块思路重建为 GET SSE)、CSS `:root`/`[data-theme="dark"]` tokens(17-176)。**明确不搬**：`chat-state.ts` 整体、`streamApi` drop-in(707)、`ResultCard`/`HistoryCards`/`RuleCards` 等 pricing 结果卡。

**类型/契约一致性：** `ToolActivity`（4.3 定义）被 4.6/Timeline 消费一致；`SseEvent` 判别联合（4.6）事件名与 Phase 2 冻结集逐一对应；`ActionDraft`（4.7）字段与 Phase 1 `canonicalizeActions` 产出一致（含 `requires_open_id`/`payload_hash`/`ordinal`）；`executeApprovedAction` 的 `runLark({exitCode,stdout,stderr})` 契约在 4.10 定义、4.11 `runWritePhase` 与 4.13 smoke 共用；幂等 key `${job_id}:${action_key}` 单一来源（Phase 1 `deriveIdempotencyKey`，经 `job_actions.idempotency_key` 落库、`buildWriteArgs` 透传 `--idempotency-key`）。
