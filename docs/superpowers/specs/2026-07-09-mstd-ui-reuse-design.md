# mstd UI 入口设计（复用 rsh-pricing-app 壳 + Pi 大脑）

> **For agentic workers:** 本文是**设计 spec**（brainstorming 产物），非逐任务 TDD 清单。它锁定架构、信任边界、数据模型与分阶段边界；各 Phase 开工时再用 `superpowers:writing-plans` 展开成子计划、用 `superpowers:subagent-driven-development` 执行。与既有 `docs/superpowers/plans/2026-07-08-pi-orchestrator-migration.md`（迁移路线图）互补：那份讲"Pi 常驻大脑 + bid-browse 合并"，本份专讲**给 mstd 装一个用户 UI 入口**该怎么复用定价 app 并安全落地"触发→审批→真写"。

## Goal

给 `mstd-orchestrator`（已本地端到端跑通的 Pi 驱动飞书自动化，无 UI）装一个**用户 UI 入口**：用户能在浏览器里**触发**自动化任务（v1：会议纪要→建任务）、**实时看** Pi 一步步跑、**审批/编辑** draft_zh 拟的飞书卡片与动作清单、批准后**真的**发飞书消息 / 建任务，并在**看板**里管理历史与审计。复用同级 `rsh-pricing-app` 的**前端壳**与若干模式，避免从零搭 UI。

## 与既有迁移计划的对齐

既有计划的安全红线已明确："每个副作用工具走 `tool_call` hook 门禁 + 人在环路卡片确认；敏感动作（派活/回价/审批）必须真人确认"，以及状态/审计入 `orch_jobs/decisions/events`。**本 spec 是这条红线在 UI 场景下的具体实现**，并把"只读阶段真只读、审批对象是服务端 action DSL、写幂等+对账"补全到可开工粒度。数据层：v1 本地验证用 better-sqlite3，**schema 保持 Postgres 可移植**，迁服务器时切既有计划 D3 的本地 Postgres。

## 塑形决策（已与用户确认）

1. **交互形态 = 对话式工作台 + 任务看板**（两者都要）。
2. **大脑 = 保留 Pi**；新后端只做薄适配，不重写编排。
3. **前端 = 新建 `mstd-ui`**，从定价 app **拆分式抽取原子**（非整体 fork）。
4. **登录 = 飞书扫码/OAuth**；身份即飞书用户（open_id）。
5. **v1 范围 = 完整闭环真写**；先跑通"会议→建任务"一个模板。
6. **生命周期 = 方案 B（两段式，第②段再起写权限 Pi）**——但写路径类型化+hash 绑定（见下）。

## 核心原则：信任边界

大脑（Pi 里的 gpt-5.5）要读**会议逐字稿**——**不可信输入**（提示注入面）。地基原则：

> **模型永远不可信。写操作的形状必须由服务端确定；模型只能在服务端划定的选项里"选择执行哪一条"，改不了 payload、收件人、命令 flag。**

这化解了"用户选 B（Pi 执行写）"与"review 要求不许模型自由拼 args"的张力：**B 保留（Pi 驱动第②段执行），但第②段的写工具从自由 `lark(args[])` 换成类型化、hash 校验的 `lark_execute_approved_action`。**

---

## 架构

### 部署形态（单 Node 主机；后续迁上海服务器）

mstd 必须自托管：要 `spawn` Pi + lark-cli 两个本地子进程（~1GB/进程，依赖 Hermes 本地授权 profile），Cloudflare Workers 跑不了子进程 → **定价 app 的 D1/Pages Functions 边缘那套整体不用**，只复用 Express 侧模式 + 前端原子。

### 目录

```
MSTD_automation/
  mstd-orchestrator/            # 大脑层（已有）
    pi-ext/
      providers.ts              # 已有，微调（env allowlist 相关）
      lark.ts                   # ★拆分：lark_read（只读白名单）
      lark-execute.ts           # ★新增：lark_execute_approved_action（类型化、hash 校验）
      draft.ts                  # 已有
    supervisor/pi-client.mjs    # ★升级：id 关联 / stderr 进事件 / parse-error 显式 / resolve 认匹配 agent_end
    server/                     # ★新增 后端：OAuth、jobs API、SSE、两段编排、action DSL、DB
      db/                       # migrations + better-sqlite3（本地）；schema 保持 Postgres 可移植
    demo/run-meeting-job.mjs    # 已有；作为第①段 fixture 来源
  mstd-ui/                      # ★新增 SPA（Vite+React），壳原子从定价 app 抽取
```

### 进程与职责

- **mstd-ui**：静态 SPA，由 `server/` 或 nginx 托管。
- **server/**：① 飞书 OAuth 登录 + 会话 token（复用定价 `auth.js` 的 HMAC 签发）；② REST（建/列/详情/审批/模板）；③ 每个跑动任务一条 SSE 流，代理 Pi 事件；④ 按两段式编排 Pi；⑤ **action DSL 规范化/hash/审批绑定**；⑥ 持久化（批量写）。
- **Pi + lark-cli**：被 `server/` 按需 spawn 的子进程。

---

## 两段式生命周期（方案 B，类型化写）

```
[触发] 工作台选"会议→建任务"模板(+可选指定妙记) → 建 orch_job(status=running_readonly)
   │  server spawn 第①段 Pi：cz-gpt/gpt-5.5/medium
   │    扩展 = providers + lark_read(只读白名单) + draft_zh
   │    ★第①段挂载的工具里【没有】任何写能力
[第①段·只读] 搜妙记 → 导逐字稿 → 抽 action items(负责人+事项+置信度, 建议 open_id) → draft_zh 卡文案
   │  事件实时流给 UI 时间线 + 关键事件落 job_events
   │  agent_end：模型产出【意图】(不可信草稿) → server 用 typed schema 校验
   │    通过 → server【确定性生成】canonical action_set + 每条 payload_hash → job_draft；status=awaiting_approval
   │    不通过 → status=needs_attention（展示原始产出，不猜）；Pi 退出
[审批] 任务进"看板·审批队列"。审批人看：draft_zh 卡文案 + 【将真跑的 canonical action_set】
   │  可编辑（改低置信度负责人 open_id / 改任务内容 / 删条目）→ 编辑后 server 重新规范化+重算 hash
   │  批准 → 落 decisions{operator_open_id, approved_action_keys[], payload_hash_at_decision,
   │                        decision_token(一次性), expires_at}
[第②段·写] 批准后 spawn 第②段 Pi：env 加 LARK_ALLOW_WRITE=1
   │  扩展 = providers + lark_execute-only（不挂 lark_read/写-args 工具）
   │  执行器 prompt：塞入已批准 action_id 列表 + 死命令"逐条调 lark_execute_approved_action，
   │                  不重新判断、不改内容、只回报每条结果"
   │  工具实现：按 action_id 查 canonical action → 校验当前 hash == 批准时 hash（不一致直接拒）
   │            → server 构造 argv spawn lark-cli → 结果落 job_actions
   │  status = done / partial_failed；Pi 退出
```

按次授权 = 人的批准决定"第②段起不起、带哪些 `action_id`、按哪个 hash"，取代粗粒度 `LARK_ALLOW_WRITE` 环境开关（该 flag 仅作为第②段进程级纵深开关，真正门禁是 hash 绑定）。

---

## 安全内核（Phase 1 的核心交付，先于 UI）

### S1. `lark_read` — deny-by-default 只读白名单

现状（已核实 `pi-ext/lark.ts:24`）：`isBlockedWrite` 只拦 `--yes / delete / logout / recall / messages delete`，`task +create` / `im +messages-send` **畅通**，工具描述还教模型写 → "不给 LARK_ALLOW_WRITE = 只读"**是假的**。

改：第①段只挂 `lark_read`，**允许清单驱动**，参数是**具名参数不是自由 `args[]`**：

| 具名操作 | 映射 lark-cli | 参数 |
|---|---|---|
| `search_minutes` | `minutes +search --owner-ids me --as user` | （无 / 分页）|
| `get_transcript` | `minutes +detail --minute-tokens <t> --transcript --as user --output-dir ./out` | `minute_token` |
| `search_user` | `contact +search-user --query <q> --as user`（多名批量用 `--queries a,b,张三`；收窄可加 `--has-chatted --exclude-external-users`）| `query` / `queries[]` |
| `read_file` | 读 `./out` 下导出的 transcript | `path`（限定在 job 工作目录内）|

⚠️ **已核实（本地 `lark-cli contact +search-user --help`）**：按人名/关键词搜人用 `--query`（≤50 字）或 `--queries`（多名并行，返回 `matched_query`）；`--user-ids` 是**按 open_id 反查**、不是按名字搜。负责人解析（口语名→open_id）应走 `--queries` 批量 + 同名收窄 `--has-chatted/--exclude-external-users`。

任何不在白名单的操作/参数 → 拒。第①段进程**根本不挂**任何能写飞书的工具。

### S2. Action DSL（服务端定义，模型只提意图）

模型第①段输出 = **意图**（typed schema，见 S3）。服务端把意图**确定性映射**成 canonical action_set，类型封闭：

```
create_task  { title, description?, due_date?, assignee_open_id }     # v1 核心
send_dm      { to_open_id, card_ref }     # v1 可选：建完通知；card_ref → 服务端存的 draft_zh 文案，塞进【固定卡片模板】渲染转义
```

**人在环路位置（消歧）**：原 demo 是"发飞书卡片给主持人、在**飞书里**确认后再建任务"。本设计把人在环路**上移到 web 审批队列**——**web 审批即取代飞书确认卡**，不做"web + 飞书"双重确认。故 v1 第②段核心动作是 `create_task`；`send_dm` 仅作**建完通知**（如通知负责人"任务已建"/回执主持人）。

**`send_dm` v1 默认关闭（已定）**：`send_dm` 保留在 Action DSL 类型里作扩展位，但 **UI 默认不生成、不审批、不执行**，除非模板显式开启（`template.enable_notify=true`）。v1 只保证 `create_task` 闭环，不扩大首版写路径。

- 卡片正文来自 draft_zh，但**结构由服务端固定模板**产出，模型碰不到 card JSON 结构 → 无法注入额外字段/收件人/flag。
- 每条 action：`action_key = stable_hash(job_id, type, normalized_payload)`；`payload_hash = hash(canonical_payload)`。
- 审批 UI 展示的就是 canonical action_set（所见即将执行）。

### S3. 意图 schema（第①段产出的"不可信草稿"契约）

现状（已核实 `demo/run-meeting-job.mjs:22`）：第①段只输出卡片文案，无结构化 actions → 契约今天没有实现基础。

改：第①段 JOB prompt 要求模型除卡文案外，输出结构化意图 JSON：

```json
{
  "card_text": "<draft_zh 卡文案>",
  "items": [
    { "owner_name": "张三", "task": "…", "due": "2026-07-15",
      "suggested_open_id": "ou_xxx|null", "confidence": "high|low" }
  ]
}
```

- **必过 typed schema 校验**才进审批；不过 → `needs_attention`，**不猜、不硬解析**。
- canonical action_set 由**服务端**从 `items` 生成（模型提意图、服务端定动作）。低置信度 / `suggested_open_id=null` 的条目在审批 UI 强制人工补齐 open_id 才可批。

### S4. 幂等 + 崩溃恢复

- `job_actions` 有稳定 `action_key` + `UNIQUE(job_id, action_key)`。
- 状态：`pending / executing / succeeded / failed / unknown`。
- **主防重 = lark-cli 原生 `--idempotency-key`**（已核实 `task +create` / `im +messages-send` 均支持）：每条写命令**必须**传 `--idempotency-key <job_id:action_key>`，飞书侧保证重复 key 不重复建/发。任务描述里埋 `job_id:action_key` **仅作辅助对账指纹**，不是主防重机制。
- 重试**只碰 `pending` 与 `failed`**；`executing` / `unknown` 先走**对账（reconcile）**：靠幂等 key + 指纹回查飞书确认"是否外部已成功但本地未记账"，再决定跑不跑。
- **专门的恢复演练**："server 在写完 lark-cli 但落库前崩溃" → 重启 reconciler 靠外部指纹回查，避免重复建任务。

### S5. 审批与登录绑定（有状态挑战存储）

真正的写执行器是**服务端函数** `executeApprovedAction(action_id)`（查 canonical action → 校验 hash → 拼 argv → spawn lark-cli，带 `--idempotency-key`）。防重放/防伪造靠 DB 挑战表，不能只靠无状态 token：

- **OAuth**：`state` + `nonce` 存 `auth_challenges` 表（预签发→回调校验→消费），防 CSRF/重放。
- **审批**：预签发一次性 `decision_token`，DB 只存其**哈希**，绑定 `job_id` + `issued_to_open_id` + `expires_at`，消费时写 `used_at`（单次）。第②段执行前校验：token 哈希命中、未过期、`used_at` 为空、`job_id`/操作人匹配。
- **登录会话 token**：无状态 HMAC + `exp`（复用定价 `auth.js`）——**仅指登录态**，不建 sessions 表；但上面两类**挑战**必须落库（下节数据模型有表）。

### S6. 第②段执行 = 服务端权威，Pi 仅审计/驱动层（B 的 de-risk）

方案 B 保留（Pi 驱动第②段），但**权威执行在服务端**：`lark_execute_approved_action` 工具的实现就是薄壳，内部调 `executeApprovedAction(action_id)`。因模型已不能改 payload、只能选 action_id，第②段 Pi 的价值仅剩"逐条驱动 + 审计留痕"。故规定：

> **服务端必须能 fallback 为直接顺序执行已批准 actions**——当第②段 Pi 起不来 / `agent_end` 异常 / 输出格式跑偏 / 超时，服务端直接调 `executeApprovedAction` 逐条完成写，**真写链路不被 Pi 卡死**。默认走 Pi（审计连续），异常兜底走直执。两条路径共用同一个执行器函数与同一套幂等 key，结果一致。

---

## Pi RPC 契约（Phase 2：先冻结再翻译）

> ✅ **已本地实测验证（2026-07-09，pi 0.80.3，cz-gpt/gpt-5.5，一次只读跑 16.5s）**。事件类型与结构键取自 `node_modules/.../pi-agent-core/dist/types.d.ts` + `modes/rpc/rpc-types.d.ts` 并经真跑 fixture 双确认（fixture 见 scratchpad，Phase 2 落成正式 fixture）。

现状（已核实 `supervisor/pi-client.mjs`）：`prompt` 未用 `id`（:56）；遇**任意** `agent_end/idle` 就 resolve（:73）；JSON parse error 被吞（:44 `catch { continue }`）；stderr 默认不进事件（:50 仅 debug）；子进程 `{...process.env}` 全继承（:27）。

**实测校正（推翻现有代码的两处错误假设）**：
- **`agent_end` 带 `willRetry` 字段** → **仅当 `willRetry` 为假才是真终止**；现 pi-client 认任意 `agent_end` 会在重试边界提前 resolve（bug）。
- **`agent_idle`/`idle` 事件不存在**（类型联合体 + 真跑均无）→ 现 pi-client 认它们是**幻象**。真实终止只有 `agent_end{messages, willRetry:false}`。重试态用真实的 `auto_retry_start/end`。
- **correlation `id` 是 RPC 原生的**（每条 `RpcCommand`/`RpcResponse` 带 `id?`；实测 `response{command:prompt}` 回显了 `id`）——但**流式事件不带 id**。每 job 一进程，故完成判定靠 `agent_end`，无需跨 job 关联；`id` 用于对齐"命令→ack"。

改（Phase 2 先做，UI 依赖它）：
1. `send({id, type:'prompt', message})` 用**原生 `id`** 对齐 ack；完成判定 = **`agent_end` 且 `willRetry` 为假**（不再认幻象 `idle`）。
2. **stderr 进事件流**（supervisor 侧合成 `{type:'stderr', text}`，Pi 事件本身无 stderr），不再只 debug。
3. **parse-error 显式化**：不 silent `continue`，发 `{type:'parse_error', raw}`；未知事件发 `{type:'unknown', raw}`。
4. 暴露 `runJob({phase, ..., onEvent})`：每条事件回调，`agent_end(!willRetry)` 收最终结构化产出。
5. **env 显式 allowlist**：只透 `CZ_GPT_KEY / CZ_CLAUDE_KEY / DEEPSEEK_KEY / LARK_PROFILE / PI_*`（+ 第②段 `LARK_ALLOW_WRITE`），不再 `{...process.env}`。
6. **录真实 Pi JSONL fixture**（首份已抓）→ 冻结事件集合 + unknown/stderr/parse-error 策略 → 据 fixture 建并测 **SSE 翻译器**。

**Pi 事件 → 前端 SSE 映射**（翻译器职责；事件形状已实测）：

| Pi 事件（真实结构键） | 前端 SSE |
|---|---|
| `message_start {message}` | `message_start(threadId=jobId)` |
| `message_update {message, assistantMessageEvent{type,contentIndex,partial}}` | 按 `assistantMessageEvent.type` 分流：`thinking_*`→`thinking_status`；文本 delta→`assistant_delta` |
| `tool_execution_start {toolCallId,toolName,args}` | `tool_start` |
| `tool_execution_end {toolCallId,toolName,result:{content,details},isError}` | `tool_result` |
| `turn_start` / `turn_end {message,toolResults}` | （分组边界，可选驱动 UI 分组）|
| `agent_end {messages, willRetry:false}` | `message_done` |
| 合成 `stderr` / `parse_error` / `unknown` / Pi `error`/`extension_error` | `error`（分级）|

---

## 后端 server

### 端点

```
GET  /api/auth/feishu/login       → 返回飞书 authorize URL(带 state/nonce)
GET  /api/auth/feishu/callback     → 校 state → code 换 user_access_token → 取 open_id/name/avatar
                                     → auth.js 签会话 token → upsert users
GET  /api/me                       → bootstrap（复用定价模式）
GET  /api/templates                → 任务模板列表（v1 仅"会议→建任务"）
POST /api/jobs {templateId,params} → 建 job + 起第①段 Pi，返回 jobId
GET  /api/jobs?status=&mine=       → 列表（看板/侧栏）
GET  /api/jobs/:id                 → 详情（events+draft+actions+decisions；断线重放用）
GET  /api/jobs/:id/stream          → SSE 实时事件（15s 心跳）
POST /api/jobs/:id/decision {approve, edited_items?, note, decision_token}
                                   → 落 decisions；approve 则起第②段 Pi
POST /api/jobs/:id/abort           → 中止（kill Pi 子进程）
```

### 持久化写入策略

- **不逐 token 同步落库**（better-sqlite3 同步写会堵事件循环）。实时流只走 SSE 给浏览器；DB 走 **ring buffer + 批量 flush**，或只持久化**关键审计事件**（`message_start`、`tool_execution_start/end`、`agent_end`、错误），不落每个 `assistant_delta`。
- 断线重放：客户端 `GET /api/jobs/:id` 从落库的关键事件重水合（复用定价 app 的 server-first + refs 抗闭包套路）。

### 并发/资源

- 一条跑动 Pi ≈1GB。后端**信号量限流：默认上限 = 2**（配置项 `MSTD_MAX_CONCURRENT_PI` 可调到 3），超出进 `status=queued`。理由：1GB 服务器还要留给 Node / lark-cli / 系统 / 失败重试余量，v1 取 2 更稳。
- **审批等待期不占任何进程**（B 的核心红利：第①段跑完 Pi 已退出），故实际吞吐不受此上限太大影响。

---

## 数据模型（SQLite 本地 / Postgres 可移植）

```
users            (id, feishu_open_id UNIQUE, name, avatar, role, created_at)
orch_jobs        (id, template_id, title, params_json, status, created_by, thread_ref,
                  created_at, updated_at)
                 status ∈ {queued, running_readonly, awaiting_approval, needs_attention,
                           running_write, done, partial_failed, failed, rejected, aborted}
job_events       (id, job_id, phase, seq, type, payload_json, ts)      -- 关键审计事件（非全量）
job_draft        (job_id, card_text, items_json, action_set_json, raw_output)  -- 第①段产出+canonical
decisions        (id, job_id, decided_by, decision, edited_items_json,
                  approved_action_keys_json, payload_hash_at_decision,
                  approval_token_id → approval_tokens.id, note, ts)
job_actions      (id, job_id, action_key, kind, target_open_id, canonical_payload_json,
                  payload_hash, idempotency_key, status, external_ref, result_json, ts,
                  UNIQUE(job_id, action_key))
-- 有状态挑战表（S5：不能只靠无状态 token）
auth_challenges  (state PK, nonce, redirect_after, created_at, expires_at, consumed_at)
approval_tokens  (id, token_hash UNIQUE, job_id, issued_to_open_id,
                  issued_at, expires_at, used_at)          -- 只存哈希；used_at 单次消费
```

侧栏/工作台"会话"直接 = `orch_jobs`（一个任务=一条会话），复用定价会话侧栏的 pin/改名/删交互，底层换 jobs，**不需要单独 chat thread 表**。**登录会话 token** 无状态（HMAC + exp），不建 sessions 表；但 **OAuth 挑战**（`auth_challenges`）与**审批挑战**（`approval_tokens`）必须落库以支撑预签发/校验/单次消费/防重放（S5）。`idempotency_key = job_id:action_key`（S4）。

**v1 用 better-sqlite3，schema 保持 Postgres 可移植（已定）**：迁服务器时切既有迁移计划 D3 的本地 Postgres，故 migration 从一开始就写成 **Postgres-friendly**——**避免 SQLite 专属特性**（不用 `INTEGER PRIMARY KEY` 隐式 rowid 依赖、不用 `AUTOINCREMENT`，改用显式主键/UUID；JSON 列用文本+应用层序列化，别依赖 SQLite 的 `json1` 专属行为；时间戳统一存 ISO8601 文本或 epoch，别用 SQLite 专属日期函数；布尔用 0/1 但列声明兼容 Postgres `boolean`）。直接上 Postgres 会提前引入运维变量，本地验证阶段不值当。

---

## 前端 mstd-ui

### 复用判断（已下调——不整体 fork，不 drop-in）

已核实：`streamApi`(`main.tsx:707`) 是 **POST** 聊天流、以 `message_done` 收尾；`chat-state.ts:640-663` 的结果判定/`assistant_delta` 分支和 pricing `result/estimate` 块**缠在一起**。故：

**只抽原子**：`MarkdownContent`、`Icon`/`ICON_PATHS`、CSS design tokens（`:root`/`[data-theme=dark]`）、少量 hooks（`useMediaQuery`/`useProcessingClock`）、工具活动**展示原子**（`ToolDetailItem` 的渲染外观）、Login 的**分屏布局**（表单换飞书 OAuth）、App 壳的**布局骨架**（侧栏+main+移动端）。

**全部重建**（类型化到我们的 job/event 模型）：`JobEventLog`（基于冻结后的事件协议）、审批卡 + **动作清单编辑器**、Board、Workspace 状态机、我们自己的 job 流客户端（SSE 消费借 `consumeBlock` 思路，但传输/终止条件按我们的协议）。

**不搬**：`chat-state.ts` 整体、`streamApi` drop-in、房价结果卡、report-export/types、规则 tab、pricing 类型。

### 两视图

- **工作台**：模板选择器 + 触发表单（自动/指定妙记）→ 下方流式时间线看第①段 → 跑完原地展开审批卡视图（卡文案 + 可编辑 canonical action 清单，低置信度高亮强制补 open_id）。侧栏 = 任务列表（底层 `orch_jobs`）。
- **看板**：任务表（状态/模板/时间/发起人）+ 审批队列（筛 `awaiting_approval`）+ 任务详情（`job_events` 回放 + action 清单 + 每条写结果 + 决策审计）。

---

## 错误处理与边界

- **Pi spawn 失败/崩溃** → `failed`，抓 stderr（现已进事件）存 `job_events`，UI 展示可重试。
- **第①段超时**（默认 240s）→ `failed(timeout)`，可重跑。
- **意图 schema 不过** → `needs_attention`，展示原始文本，人工重跑。
- **第②段部分失败** → `partial_failed`，逐条 `job_actions.status` 展示，**只重试失败条目**，重试前对账。
- **hash 漂移**（批准后 action 被改） → 第②段执行拒绝该条，标 `failed(hash_mismatch)`。
- **decision_token 重放/过期** → 拒绝，要求重新审批。
- **SSE 断线** → `GET /api/jobs/:id` 重放补齐；15s 心跳。
- **鉴权过期** → 401 → 前端重登（复用 `api()` 401→logout）。

## 数据脱敏与保留期

- **原始 transcript**：存**哈希 + 截断摘要**，不整篇长期留；原始导出文件（`./out`）设 TTL 清理。
- **工具 stdout/stderr、open_id 映射**：`job_events` 里 PII 最小化（业主/电话/完整房号一律剥离，继承既有计划红线）。
- **保留期**：`job_events` 原始 payload 设 TTL；审计要点（谁批了什么、执行结果）长留。

## 测试策略

- **单元（vitest，复用定价测试设置）**：① action DSL 规范化/hash（同意图→同 hash；改一字→hash 变）；② 意图 schema 校验器（缺字段/低置信度分支）；③ Pi 事件→SSE 翻译器（喂录制 fixture，断言 SSE 序列 + unknown/stderr/parse-error 策略）；④ 幂等（重复 `action_key` 被 UNIQUE 挡）。
- **集成**：mock `pi-client` 喂录制的第①段事件流 → 断言 job `running_readonly`→`awaiting_approval` 且 action_set 正确；mock lark 执行跑第②段断言逐条结果 + 对账路径。
- **端到端（真机）**：第①段只读天然安全，对 dev workspace 真妙记跑；第②段写**只打测试群/测试任务清单**，且经对账。用 `demo/run-meeting-job.mjs` 当第①段 fixture 来源。
- 收尾走 `verify` skill：**用 Browser 插件（Claude-in-Chrome，`mcp__claude-in-chrome__*`）真机验证** 触发→看流→审批→真写 观察行为。**不用 Playwright**（本项目约定默认走 Browser 插件）。

---

## 分阶段实施顺序（先安全后 UI）

- **Phase 0 · 基座**：`mstd-orchestrator` 补 Express / better-sqlite3 / Vitest；scaffolding、tsconfig、脚本。
- **Phase 1 · 安全内核（无 UI、不真写）**：`lark_read` deny-by-default 白名单；意图 schema；action DSL + 规范化/hash；审批绑定（decision_token/operator/expires）；幂等 schema（`action_key`+UNIQUE）+ 对账恢复。**连同测试写死。**
- **Phase 2 · Pi RPC 冻结**：修 `pi-client`（id 关联 / stderr 进事件 / parse-error 显式 / resolve 认匹配 agent_end / env allowlist）；录 fixture；冻结事件协议；建并测 SSE 翻译器。
- **Phase 3 · Server 基座**：jobs API、持久化（批量写）、飞书 OAuth（state/nonce/decision token）——接好但写仍关。
- **Phase 4 · UI + 打开真写**：Workspace + Board + 审批编辑器（抽原子 + 重建状态机）；启用第②段 `lark_execute_approved_action`，只打测试群/测试清单，走对账。

## 复用总账（落到具体文件）

- **原样抽原子**：定价 `MarkdownContent`、`Icon`/tokens/hooks、`ToolDetailItem` 渲染外观；`auth.js` token 签发；mstd 侧 `pi-ext/draft.ts`·`providers.ts`。
- **微调/重建**：App 壳布局骨架、Login（→飞书 OAuth）、`pi-client.mjs`（升级见 Phase 2）、`lark.ts`（拆成 `lark_read` + `lark-execute.ts`）。
- **丢弃**：`chat-state.ts` 整体、`streamApi` drop-in、房价卡/报告导出/规则 tab/pricing 后端全套、Cloudflare Pages+D1 双部署、`/usr/bin/sqlite3` wrapper。
- **净新增**：`server/`（jobs API + 两段编排 + action DSL + OAuth + DB）、看板、审批动作清单编辑器、意图 schema、`lark_execute_approved_action`。

## 前置依赖 / 假设

1. **飞书应用 OAuth**：应用（记忆 `cli_aac4855d1a781cd6`）后台需配 redirect URI + 用户身份 scope。OAuth 能跑的前提。
2. **主机环境**：目标机装好 Hermes/Pi/lark-cli 且授权 profile 就绪；≥ 每并发 1GB 内存余量。
3. **执行身份分层（v1）**：UI 登录识别"人"及其 open_id（发起/审批/派活对象）；第②段真正 lark-cli 写统一走**单一持牌服务账号 profile**（记忆 user613148）。多租户按登录人身份执飞书写留 v2。

## 非目标（v1）

- 多任务模板（周报/通知派发…）——v1 只"会议→建任务"。
- 触发层 `lark-cli event consume` 自动起 job（妙记生成 / card.action.trigger）——v1 仅手动触发。
- 多租户按登录人身份执行飞书写。
- Pi 内建 `extension_ui_request` 单进程暂停审批（那是方案 A；本设计走 B）。
- 迁 Postgres/上海服务器（schema 预留可移植，落地在既有迁移计划里做）。

---

## 附录 A · 本地验证结果（2026-07-09，先验证后定稿）

写 spec 前对核心假设做了本地实测，避免带着乐观假设开工。均在本机 `mstd-orchestrator` 真环境：

**环境就绪** ✅
- `pi` 0.80.3、`lark-cli` 均在 `~/.hermes/node/bin`；`.env` 四把 key 齐（`CZ_GPT_KEY/CZ_CLAUDE_KEY/DEEPSEEK_KEY/LARK_PROFILE=user613148`）。

**lark-cli flag 断言（跑 `--help` 核实）** ✅（修正 spec 早期两处错误）
- 搜人：`contact +search-user` 的关键词搜索是 `--query`（≤50 字）/`--queries`（多名并行），`--user-ids` 是**按 open_id 反查**——早期 spec 写反，已改（S1）。
- 幂等：`task +create` 与 `im +messages-send` **均有 `--idempotency-key`**——定为主防重（S4）。

**Pi RPC 事件协议（静态类型 + 真跑双确认）** ✅
- 类型源：`pi-agent-core/dist/types.d.ts`（`AgentEvent` 联合体）+ `modes/rpc/rpc-types.d.ts`（`RpcCommand`/`RpcResponse`/`extension_ui_*`）。
- 真跑（cz-gpt/gpt-5.5，一次只读 `minutes +search`，16.5s）实测事件：`agent_start / message_start×4 / message_update×68 / message_end×4 / turn_start×2 / turn_end×2 / tool_execution_start / tool_execution_end / agent_end`。
- 校正现有 `pi-client.mjs` 两处错误假设：**`agent_end` 带 `willRetry`（仅假才终止）**；**`agent_idle/idle` 是幻象**。
- `id` correlation 原生可用（`response{command:prompt}` 回显 `id`）；流式事件不带 id。
- `tool_execution_end.result = {content,details}`；`message_update.assistantMessageEvent = {type,contentIndex,partial}`（首个 `thinking_start`）。
- 首份真实 fixture 已抓（scratchpad），Phase 2 转正式 fixture。
- 全程**零飞书写**（只读 `minutes +search`）。

**结论**：spec 的 Pi→SSE 映射、correlation、终止判定、幂等、搜人链路均已落到实测证据上，可据此进入 writing-plans。
