# 基于 Pi 的自动管理系统（上海服务器）迁移计划

> **For agentic workers:** 本文件是**分阶段迁移路线图**（非单文件 bite-sized TDD 清单——本工程跨多子系统，按 writing-plans 的 Scope Check 做了分解）。Phase 0 已拆到可开工粒度；Phase 1+ 在各自开工时展开成逐任务 TDD 清单（届时用 superpowers:writing-plans 生成子计划，用 superpowers:subagent-driven-development 执行）。进度用 `- [ ]` 勾选。

**Goal:** 在上海服务器上，用 Pi（`@earendil-works/pi-coding-agent`）做常驻自主"大脑"，与 bid-browse 合并，逐步替换掉写死的 LLM harness 循环，成为公司级自动管理系统（感知→推理→人在环路确认→执行）。

**Architecture:** Pi 以 RPC/SDK 模式常驻服务器，由一个瘦 Node **supervisor**（systemd 守护）驱动——supervisor 负责 Pi 天生没有的那层：事件循环、调度、并发/重试、会话恢复、token 刷新。Pi 通过**扩展工具**（lark-cli、gateway、bid-browse 数据、企微、飞书卡片）与外界交互；模型走 `api.cz900212.com` OpenAI 兼容端点：**opus-4-6(medium) 写报告/消息/决策**，**gpt-5.5 做图像识别/OCR/硬推理**。复用 bid-browse 已验证的信条：`callStructured`(校验→修复→重试→兜底) 和 gear/档位人在环路审批。

**Tech Stack:** Pi(TS coding-agent, RPC 模式) · Node ≥22 + systemd · PostgreSQL(服务器本地,复用 Gen-1 Docker 模式) · lark-cli(飞书感知/执行,已验证) · rsh-api-gateway(只读代理) · Cloudflare D1/Worker(bid-browse 现有捕获/存储,保留) · 端点 `https://api.cz900212.com/v1`。

## Global Constraints（每个任务都隐含遵守）

- **端点固定** `https://api.cz900212.com/v1`，OpenAI 格式(`api:"openai-completions"`)——**该网关不吃 Anthropic `/v1/messages`**。
- **模型分工（2026-07-09 定型，已本地端到端真机验证 ~86s）**：
  - **主脑/工具循环/编排 = GPT-5.5**(CZ 网关 `cz-gpt`，`$CZ_GPT_KEY`)——经网关返回**干净** tool_calls，多轮循环通。**推理强度始终 medium**（providers.ts 把 gpt-5.5 `thinkingLevelMap` 全档钉死映射 `"medium"`）。
  - **与用户交互/对外中文表达 = `claude-opus-4-6`**(CZ 网关 `cz-claude`，`$CZ_CLAUDE_KEY`)——作 `draft_zh` 工具，所有给人看的中文成品必经它，主脑不直接写成品。
  - **图像识别/OCR = `gpt-5.5`**(多模态，同 `$CZ_GPT_KEY`)——视觉工具待建。
  - **备用主脑 = DeepSeek**(`api.deepseek.com`)——网关不可用时兜底，已降级非默认。
  - 🔴 **架构反转记录**：07-08 时 CZ 网关**不支持工具调用**（tools 参数被吃），一度被迫用 DeepSeek 直连当主脑；**07-09 用户在网关侧开通工具调用**后实测：GPT 路由 tool_calls 干净、Claude 路由 arguments 会多拼前导 `{}`（`{}{...}`，但 Pi 解析器能容忍）→ 回归 GPT 主脑 + Opus 交互。Pi 对 gpt 发 `max_completion_tokens` + `reasoning_effort:medium`，网关都认。
- **两把 key 分属不同分组且加密**：Claude 分组用 `sk-db18…`（`$CZ_CLAUDE_KEY`，只有 claude，无 gpt）；GPT 分组用 `sk-99024…`（`$CZ_GPT_KEY`，含 gpt-5.5/5.4/5.4-mini，无 claude）——故必须双 key 双 provider。key **只进 gitignore 的 `.env`/环境变量，不进代码/日志/Git**（均已落地 `mstd-orchestrator/.env`，chmod 600）。
- **服务器约束**：大陆轻量 ubuntu 服务器,**1GB 内存 + 2GB swap**,时区 Asia/Shanghai,SSH 私钥 `bid-browse/secrets/bidbrowse.pem`,用户 `ubuntu`。内存极紧——footprint 是一等约束。
- **只读红线继承**：碰公司 RSH 系统只经 `rsh-api-gateway` 的**只读** `HARNESS_GATEWAY_API_KEY`,**绝不用**能写的全量 `GATEWAY_API_KEY`；PII(业主名/电话/完整房号)一律剥离。
- **安全红线**：Pi 扩展/skill/package 以**完整系统权限**运行任意代码；每个副作用工具走 `tool_call` hook 门禁 + 人在环路卡片确认；敏感动作(派活/回价/审批)必须真人确认。

---

## 关键架构决策（本计划的"设计"，无独立 spec，故在此固化）

### D1. Pi 的驱动方式 = RPC 模式 + Node supervisor
Pi 无内置守护/调度/子agent。选 **RPC 模式**(`pi --mode rpc`,JSONL over stdin/stdout)而非 SDK：语言无关、进程隔离、崩溃可重启、每个 job 一个会话。supervisor(Node/TS)对每个 job 派生/复用一个 Pi RPC 进程,写 `{"type":"prompt",…}`,读事件流(`agent_end`/`message_end` 标志完成),按 `--session <id>` 恢复上下文。**这层 supervisor 是最大新建工作量。**

### D2. 与 bid-browse 的合并边界（保留 Cloudflare 捕获层，服务器做大脑）
- **保留在 Cloudflare**：qianlima 截图捕获(`/capture`)、Queue、D1(`bidbrowse` 库,线索/公告数据)、R2、邮件路由——这些是合规+可靠性驱动的,不动。
- **搬到服务器/Pi**：被替换的"harness"= bid-browse worker 里**写死的 LLM 编排循环**(`llm.ts` 的 `llmForRole` 三角色硬路由 + `structured.ts` 的固定流程)。Pi 成为可推理、会用工具、能升级到人的 agent 循环。
- **接口**：Pi 经只读 API 读 bid-browse D1 的 `v_announcements`/`v_list_clues` 合格线索(而非重算)。

### D3. 状态与审计 = 服务器本地 PostgreSQL（复用 Gen-1 模式）
orchestrator 自己的 job/决策/审计/token 存本地 Postgres(Docker,复用 Gen-1 的 5433 + swap 配方)。表：`orch_jobs`(状态机 pending→running→awaiting_confirm→done/failed)、`orch_decisions`(每次分配的依据,审计)、`orch_events`(event_id 幂等去重)、`orch_tokens`(加密 refresh_token + 单点刷新锁)、复用 ops-self-heal 的 `symptoms/plans/executions` 形状。线索数据不落此库(留 D1)。

### D4. 人在环路 = gear/档位 + 飞书卡片（复用 + 今日已验证）
搬 bid-browse gear-1 模式：确定性检测→冻结动作目录(action_id+params,非 shell)→**飞书交互卡片确认**(今日已端到端验证:发卡片→`card.action.trigger` 回调带 operator_id+action_value→就地更新)→执行+复检。档位是唯一旋钮,代码不随档位变。审批身份校验(允许发起人+回调 operator_id 匹配)。

### D5. LLM 可靠性 = callStructured 信条不变
Pi 的 agent 循环负责"要不要做/做什么"的推理;但一切确定性工作(SQL、算术、字段归一、JSON 校验)仍走 `callStructured`(校验→自动修复→字段级重试→typed 兜底)的信条,作为 Pi 工具的内部契约。**加固 harness,而非升级模型。**

---

## 组件/文件结构（新建仓库：`mstd-orchestrator`，置于服务器 `~/mstd-orchestrator`）

```
mstd-orchestrator/
├─ supervisor/                 # D1: 驱动 Pi 的常驻服务（systemd）
│  ├─ src/main.ts              # 事件循环入口：订阅触发→派发 job→驱动 Pi RPC
│  ├─ src/pi-client.ts         # 封装 pi --mode rpc：spawn、写 prompt、解析事件流、会话恢复
│  ├─ src/scheduler.ts         # cron 式定时 tick（node-cron），Asia/Shanghai
│  ├─ src/triggers/lark.ts     # lark-cli event consume 长连接（妙记生成/会议结束/卡片回调）
│  ├─ src/triggers/bidbrowse.ts# 轮询/webhook：bid-browse 新合格线索、日报钩子
│  ├─ src/jobs/registry.ts     # job 定义（每个能力一个 job：prompt 模板 + 允许工具 + 模型）
│  └─ src/state/db.ts          # orch_* 表读写（pg）
├─ pi-config/                  # Pi 运行配置（部署到 ~/.pi/agent/）
│  ├─ models.json              # D 端点+两 provider（opus-4-6 / gpt-5.5），key 走 $ENV
│  ├─ SYSTEM.md                # orchestrator 系统提示（角色/红线/输出规范）
│  └─ AGENTS.md                # 项目指令
├─ pi-extensions/              # D2: Pi 工具（pi.registerTool + tool_call 门禁）
│  ├─ lark.ts                  # 包 lark-cli（发消息/卡片/建任务/读妙记/通讯录）
│  ├─ gateway.ts               # rsh-api-gateway 只读价格案例查询
│  ├─ bidbrowse-data.ts        # 读 D1 v_announcements/v_list_clues 合格线索
│  ├─ wecom.ts                 # 企微 webhook 推送（复用 harness 逻辑）
│  └─ guard.ts                 # tool_call hook：副作用工具门禁 + 审计写库
├─ db/migrations/0001_orch.sql # orch_* 建表
├─ deploy/
│  ├─ mstd-orchestrator.service# systemd unit（supervisor 常驻）
│  ├─ install.sh               # 服务器一次性：装 node22/pi/pg-docker
│  └─ .env.example             # 变量名清单（无值）
└─ eval/                       # 复用 bid-browse eval 思路：分类/抽取黄金集回归
```

---

## Phase 0 — 服务器地基（可开工，交付：一个能被 supervisor 驱动、能调两模型的 Pi 会话）

> 前置确认项（开工前需用户提供）：① 上海服务器真实 IP/host + 现状(现在跑着 Gen-1 python 吗,内存余量)；② bid-browse 的 GPT-5.5 `LLM_API_KEY` 值。

### Task 0.1: 打通到服务器 + 摸清现状
- [ ] `ssh -i bid-browse/secrets/bidbrowse.pem ubuntu@<IP>`，记录：OS 版本、`free -h`(内存/swap)、`node -v`(是否已装)、`docker ps`(现跑什么)、时区、磁盘。
- [ ] 判断 1GB 内存能否同时承载 Pi(Node) + supervisor + Postgres + 现有 python bid-browse。**若不能，本任务产出结论：需扩内存或拆分（决策点，见风险 R1）。**

### Task 0.2: 装 Node 22 + Pi
- [ ] 服务器装 Node ≥22（nvm 或 nodesource）。
- [ ] `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`；`pi --version` 记录并**钉版本**（Pi 年轻、RPC 协议可能变）。
- [ ] 设 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`（锁定/离线友好）。

### Task 0.3: 配置双 provider 模型（models.json）
- [ ] 写 `~/.pi/agent/models.json`：一个 provider `cz-claude`（baseUrl `https://api.cz900212.com/v1`, apiKey `$CZ_CLAUDE_KEY`, api `openai-completions`, 模型 `claude-opus-4-6` 声明 `reasoning:true` + `thinkingLevelMap` 映射 medium, `input:["text","image"]`）；一个 provider `cz-gpt`（同 baseUrl, apiKey `$CZ_GPT_KEY`, 模型 `gpt-5.5` `input:["text","image"]`, reasoning:true）。
- [ ] key 放 `~/.pi/agent/.env`(chmod 600, gitignore)，`models.json` 用 `$CZ_CLAUDE_KEY`/`$CZ_GPT_KEY` 插值。
- [ ] 验证：`pi -p --provider cz-claude --model claude-opus-4-6 "reply ok"` 返回 ok；`pi -p --provider cz-gpt --model gpt-5.5 "reply ok"` 返回 ok（若 GPT key 未到位，标记待补，Claude 单跑先过）。
- [ ] 视觉验证：`pi --provider cz-gpt --model gpt-5.5 @test.png "描述这张图"`（用一张测试图）确认 image 输入通。

### Task 0.4: supervisor 骨架 + pi-client（RPC 驱动 spike）
- [ ] `supervisor/src/pi-client.ts`：`spawn('pi',['--mode','rpc','--provider','cz-claude','--model','claude-opus-4-6'])`；实现 `prompt(text): Promise<result>`——写 `{"type":"prompt","message":text}\n`，按 `\n` 分行解析事件，收 `agent_end` 结束并取最后 `message_end` 文本。**注意：只按 `\n` 切、剥尾 `\r`，勿用会把 Unicode 分隔符当换行的 reader。**
- [ ] TDD：mock 一个假 pi 进程（echo 固定 JSONL），测 `prompt()` 能正确解析出 assistant 文本 + 处理 `tool_execution_*` 事件流。
- [ ] 真机 smoke：`pi-client` 驱动真 Pi 跑 "用 opus-4-6 写一句中文问候" 并拿到文本。
- [ ] 交付物：`node supervisor/dist/spike.js` 打印 Pi 返回的中文。**Phase 0 完成。**

---

## Phase 1 — 工具层 + 与 bid-browse 合并的首个 job（交付：一条真事件驱动的自动链，人在环路卡片确认）

- **1.1 lark 扩展工具**：`pi.registerTool` 包 lark-cli(发消息/交互卡片/建任务/读妙记/通讯录解析)，工具结果 `{content:[{type:'text',…}],details:{}}`；沿用会话内已验证的 profile `user613148`/生产切真实组织。
- **1.2 guard hook**：`pi.on('tool_call')` 对 lark 发卡片/建任务、gateway、wecom 等副作用工具做门禁——按 job 的档位决定"直接执行/必须卡片确认/拒绝",并把每次调用写 `orch_decisions` 审计。
- **1.3 bidbrowse-data 工具**：只读查 D1 `v_announcements`/`v_list_clues` 合格线索。
- **1.4 首个 job（与 bid-browse 合并）**：`orch_jobs` 定义 "线索分派/日报增强" job——触发(bid-browse 新合格线索 or 每日 tick)→Pi 用 opus-4-6 读线索+负载→产出分派建议→**飞书卡片发给主管确认**(复用今日验证的卡片回调闭环)→确认后建任务/通知。低置信度对齐走人工确认(今日"燕总"案例的模式)。
- **1.5 triggers/lark 长连接**：supervisor 常驻 `lark-cli event consume`(妙记生成/会议结束/`card.action.trigger`)，event_id 幂等去重入 `orch_events`。
- 交付物：真实一条线索/一场会 → 卡片 → 确认 → 建任务，全自动跑通，审计入库。

## Phase 2 — 替换写死的 harness 循环（交付：bid-browse LLM 编排改由 Pi 驱动，旧 llmForRole 退役）
- 把 `worker/src/llm.ts` 的三角色硬路由迁到 Pi job；`callStructured` 契约作为 Pi 工具内部实现保留(校验/修复/重试/兜底)。
- extract 走 gpt-5.5(多模态 OCR)、analyze/mailbot 走 opus-4-6 或 deepseek——由 job 的模型 pin 决定,配置非代码。
- 保留 bid-browse eval 黄金集做回归门禁(precision≥0.9/recall≥0.95),迁移后不得掉点。
- 灰度：新旧并行跑一段,比对结果一致再切,退掉 Worker 内 LLM 循环。

## Phase 3 — 自主运维 + 更多能力（交付：服务器自愈 + 平台化）
- 复活 ops-self-heal gear 模式（因为重新引入了服务器/守护进程,Gen-2 消掉的失效模式回来了）：健康检查/邮件或飞书审批/执行-复检。
- 增量上线更多 job：会议纪要→建任务(今日已验证链路,直接作为一个 job)、企微回价核查(需先配通 gateway 回价案例数据源——见 R4)、招标线索分发规则细化。
- token manager：服务账号 user_access_token 的 refresh 滚动(20% 寿命提前续期,PostgreSQL 原子落库 + 全局锁),刷新失败发飞书告警卡片。

---

## 开工前必须确认/提供（Prerequisites）
- [ ] **上海服务器**：真实 IP/host、现状、内存余量（决定 R1）。
- [x] **GPT key**：已到位（`$CZ_GPT_KEY = sk-99024…`，GPT 分组，含 gpt-5.5/5.4/5.4-mini），存于 `mstd-orchestrator/.env`（chmod 600）。工具调用已实测通。
- [ ] **合并边界确认**：D2 的"Cloudflare 保留捕获层 / 服务器做大脑"划分是否符合你的意图。
- [ ] **首个 job 精确定义**：Phase 1.4 是"线索分派"还是"日报增强"还是"会议纪要建任务"——三选一或组合。
- [ ] **回价案例数据源**（若做 Phase 3 企微回价）：gateway 的 `RSH_PRICE_CASE_*` 适配还没配通,当前端到端跑不了。

## 风险（Risks）
- **R1｜1GB 内存**：Pi(Node) + supervisor + Postgres + LLM 调用在 1GB 上极紧,很可能 OOM。**大概率需扩内存(推荐 ≥2GB)或把 Postgres/捕获拆到别处。** 这是最硬的物理约束,Task 0.1 先量。
- **R2｜架构反转**：bid-browse Gen-2 刻意 serverless 以消除服务器失效模式；搬 Pi 回服务器把这些模式带回来了(磁盘/进程/cron/断电),故 Phase 3 自愈不是可选。
- **R3｜Pi 年轻**：RPC 协议/config 键名可能随版本变；钉版本,编码前用 `pi --mode json` 实测事件 schema 再写解析器。
- **R4｜回价数据源未配**：任何"回价核查"能力的硬前置,与技术栈无关。
- **R5｜单点 LLM 网关**：所有推理压在 `api.cz900212.com`;备好降级(DeepSeek 直连)与告警。
- **R6｜安全面放大**：Pi 任意代码 + 服务器上握着 tenant/user token + 只读网关旁边就是可写全量网关。tool_call 门禁 + 严格 key 隔离 + 考虑 Docker/OpenShell 隔离,从第一天起。
