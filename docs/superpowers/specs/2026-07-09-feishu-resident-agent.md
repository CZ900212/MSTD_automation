# 飞书常驻全能助手（mstd-agent）— 设计 Spec + 实施计划

> 本文件分两部分：**Part 1 设计 Spec**（brainstorming 定稿）+ **Part 2 实施计划**（writing-plans 展开，spec 批准后追加）。
> 取代原"会议纪要单一流水线"方向；原 `docs/superpowers/plans/2026-07-09-mstd-full-loop-completion.md` 剩余任务全部作废。

---

# Part 1 · 设计 Spec

## 1. 目标与定位

给公司建一个**常驻的全能 AI 助手**（对标 OpenClaw / Hermes agent，但更轻量）：

- **一个公司一个 agent**：共享大脑、共享记忆，区分"谁在说话"（open_id 入上下文与审计），单一服务账号执行写操作。
- **每分每秒待命**：飞书事件（消息、卡片回调、妙记生成）唤醒 + 定时任务 + 心跳自主行为。
- **能交流**：主入口 = 飞书 bot（私聊随问随答、群 @、群内旁听自主插话）；辅入口 = web 调试台（复用 rsh-pricing-app 壳，仅管理员）。
- **能干活**：飞书权限内的一切（读写任务/消息/日程/文档、问答检索、定时报告），所有写操作经**卡片预览→确认**。

**本期范围 = V1+V2 一口气**：私聊问答 + 写确认卡、群@（pending 上下文窗口）、群内全量旁听自主插话（运营上先跑观察期）、定时任务 + HEARTBEAT、web 调试台、会议纪要闭环迁移。

### 与原项目的关系

原 mstd-orchestrator 的"会议纪要→审批→建任务"流水线**不是白干**：安全内核（action DSL / hash 绑定 / 一次性 token / 幂等对账）、Pi RPC 层、lark-cli 事件长连接、OAuth 全部续命（迁移清单见 §9）。跑偏的只是形态——从"单一流水线+web 审批台"转为"常驻对话 agent+卡片确认"。

## 2. 已锁定的塑形决策

| 维度 | 决定 |
|---|---|
| 用户范围 | 公司级多用户，共用一个 agent 身份与记忆 |
| 执行身份 | 单一持牌服务账号（profile `user613148`）；按人执行 = 非目标 |
| 交互面 | 私聊 + 群@ + 群内全量旁听自主插话 + 主动推送 |
| 写安全 | 一切写操作走飞书交互卡片：预览（可含表单编辑）→确认→执行→卡片原地更新 |
| 大脑 | 三模型协作：V4 Flash 前台 / GPT-5.5 中枢 / Opus 出口（§5） |
| 架构选型 | 方案 A：现有栈（Node + Pi RPC + lark-cli + SQLite）自建常驻层；OpenClaw/Hermes 只当设计图纸 |
| 记忆 | 文件三层 + FTS 检索起步，不上向量库；权限隔离是铁律 |
| 测试 | 单测 mock；集成/E2E 打 test organization 真飞书 |

## 3. 总体架构

```
┌──────────────── mstd-agent 常驻进程（Node，演进自 mstd-orchestrator）────────────────┐
│                                                                                      │
│ 通道层                会话层                 大脑层                 执行层            │
│ lark-cli event   →  每聊天一会话        →  V4/5.5/Opus 三模型  →  executeApproved    │
│ consume 长连接      JSONL/SQLite 持久化     协作（§5）             Action()（四道锁    │
│ ·im 消息            pending 窗口                                   原样保留）         │
│ ·卡片回调           两级门控+admit                                                    │
│ ·妙记事件                                                                             │
│                                                                                      │
│ 主动层: 单 ticker（cron + HEARTBEAT + 蒸馏 + 巡检）    存储: SQLite + 记忆文件        │
│ 管理面: Express API → web 调试台（pricing-app 壳，仅管理员）                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **一个常驻 Node 进程是唯一的"身体"**：24h 挂 `lark-cli event consume` 长连接（事件接收不计飞书配额，"听"免费）。所有唤醒源统一进**事件收件箱**，路由到会话。
- **Pi 是大脑不是身体**：每个活跃会话挂一个常驻 Pi 子进程（现有 pi-client RPC），空闲 10 分钟回收。**状态永远在 daemon 侧**（transcript/记忆/任务都持久化），Pi 可抛弃可重启，重启即重放上下文。
- **反面教材防腐**：严禁 Hermes 式上帝对象——`gateway/`、`sessions/`、`memory/`、`models/`、`cards/`、`ticker/` 各自成包、单一职责、独立可测。

## 4. 会话与记忆

### 4.1 会话模型

- **会话键**：`feishu:p2p:<open_id>` ｜ `feishu:group:<chat_id>[:topic_id]` ｜ `cron:<job_id>` ｜ `debug:<id>`。
- **群 = 一个共享会话**（不按人拆），消息带发言人署名 `[张三]: …`；话题群 topic 映射子会话。
- **存储**：单 SQLite（better-sqlite3，SQL 保持 Postgres 可移植）：`sessions` + `messages`（role、sender_open_id、content、ts、`observed` 旁听标记、`active` 软删、platform_message_id）+ **FTS5 双索引（标准+trigram，中文友好）**；模型配 `session_search` 工具跨会话检索。
- **生命周期**：24h 空闲 + 每日 04:00 双重重置；**重置前强制 memory flush**（先让模型把要紧事写入记忆）；有后台 job 挂着的会话豁免。
- **防抖合批**：同一发送者连发消息 3s 窗口合并为一次推理。
- **入站去重**：event_id + 内容 MD5 双重去重（扩展现有 `orch_events` 表）。
- **上下文压缩**：token 超阈值 → 压缩早期回合保留近 20 条 + 压缩前 memory flush。

### 4.2 记忆系统（全局记忆，重点交付）

```
SOUL.md                     身份/人格/规矩（热加载，注入 slot#1，管理员可随时手改）
memory/ORG.md               公司级共享事实（字符数上限，超限提醒模型自行合并淘汰）
memory/groups/<chat_id>.md  每群记忆
memory/users/<open_id>.md   每人记忆（私聊画像）
```

- **注入铁律**：群会话 = SOUL+ORG+本群；私聊 = SOUL+ORG+本人。**群 A 记忆与私聊记忆绝不进群 B。**
- **冻结快照**：会话启动时冻结记忆注入（保 prompt 前缀缓存）；会话中写入立即落盘、下次会话生效。
- **写入**：单一 `memory` 工具（add/replace/remove/read）；条目带**来源+时间戳**；写入前注入扫描（威胁模式规则内嵌，不依赖外部二进制）；**外部漂移检测**（人手改过文件则拒写并 `.bak` 备份）。
### 4.3 夜间蒸馏（dreaming，补 Hermes 短板；机制参照 OpenClaw memory-core + 调研落地建议）

- **触发**：每晚 cron（默认 03:30，挂单 ticker）；调试台留手动触发入口。
- **输入切片**：按三层（ORG/群/人）**并行独立处理**；范围 = 当天 + 前一天 overlap 的会话 transcript；长会话按时间块切片；规则先筛高信号片段防 token 爆炸。
- **两阶段模型**：V4 做 per-chunk 结构化提取（JSON：`content/source/ts/confidence/evidence/tags`；提示词强制"严格 grounding 于对话片段、禁止推断、低置信跳过"）→ 5.5 做跨块合并与冲突裁决。Opus 不参与。
- **合并策略：append-only**——重复→跳过；矛盾→追加新条目 + 旧条目标 `invalidated_at`，**绝不静默覆盖**；单条字符上限，超限再精炼。
- **过期判据**：事件类默认 30 天；偏好/事实类长期、被矛盾时更新；低置信自动降级归档。
- **防污染保护**（OpenClaw dreaming 模式）：每晚产出人类可读蒸馏报告 `memory/dreams/YYYY-MM-DD.md`（新增了什么/淘汰了什么/依据），调试台可审查；ORG 层可配置人工审批 gate（先 report-only 影子运行再放开自动写入）；`memory/` 目录入 git，每次蒸馏前自动 commit 备份，可回滚。
- **对话内双保险**：每 10 轮 nudge 提醒模型整理记忆（Hermes 模式）。

## 5. 消息管道、三模型协作与并行模型

### 5.1 管道全链路

```
飞书事件 → ①去重 → ②防抖合批(3s) → ③admit 判定(拒绝原因枚举) → ④门控分级
        → ⑤会话 actor 队列 → ⑥前台/中枢处理 → ⑦回复/卡片/静默
```

- **③ admit**（抄 Hermes 飞书适配器）：返回**原因枚举**（`bot_not_mentioned / group_policy_rejected / self_echo / rate_limited / …`）而非布尔；策略按群覆盖（全局默认 mention-only，白名单群开旁听）。
- **④ 门控三层**：第 0 层规则（@直通/白名单/冷却期，零成本）→ 第 1 层 V4 Flash should_reply → 第 2 层 5.5 全价。静默 = `NO_REPLY` 哨兵，框架吞掉。**防刷屏硬限制**：每群每小时主动发言上限 + 连续主动消息上限。

### 5.2 三模型协作（用户手绘图定稿）

```
用户消息 → 【前台】DeepSeek V4 Flash (thinking on)   daemon 内直调 API，无 Pi 进程
              ├─ a) 快速回复（回执/澄清/简单事实）→ 直接出站 ✂ 终结（不经 Opus）
              ├─ b) NO_REPLY 静默 → 吞掉 ✂ 终结
              └─ c) 灌上下文给 5.5（唯一入枢路径：没跑就带上下文拉起，在跑就注入 steer）
                      ↓
              【中枢】GPT-5.5（Pi 会话进程）推理+工具循环+后台 job 编排，从不直接面对用户
                      ↓
              【出口】Opus ← 一切正式面向用户的表达（消息文案、确认卡片文案）→ 出站
```

- **工具调用全部归 5.5**；Opus 专职表达不碰工具；V4 不碰工具。
- **Opus 出口 = 5.5 的 `reply` 工具**（现有 `draft_zh` 模式泛化，用户定案）：`reply({kind: message|card_copy, brief, tone?, target?})` → daemon 将 SOUL + 会话上下文快照 + 简报灌给 Opus 渲染终稿 → 出站/填卡片槽位。**结构性强制：daemon 永不外发 5.5 裸文本，`reply` 是唯一出站通道**；整回合不调用 = 自然静默。5.5 可多次调用（中途进度播报 + 最终结论）。
- **V4 直回边界**：仅限轻量内容（回执/澄清短句/一句话事实）；正式、复杂、涉第三人或对外内容必须走 5.5→Opus。边界写进 V4 系统提示词 + daemon 兜底（直回超长或含写意图 → 强制升级）。
- **人格一致**：三模型共享 SOUL.md 注入。
- a) 天然构成 GPT-Live 式 backchanneling：重任务灌 5.5 的同时 V4 先回"收到，我去办"。

### 5.3 并行模型（GPT-Live 委托模式的 IM 版）

- **会话间并行**：每会话一个 actor（串行队列），互不阻塞。
- **会话内前台+后台**：5.5 判断任务量级；重任务（深度检索、批量写、等审批）注册为**后台 job（复用现有 orch_jobs 基建）**，会话立刻解锁；job 完成后结果作为事件**回注**会话，模型自然播报。
- **任务版本化防过时回复**：job 带 correlation id + 发起时会话版本号；回注时话题已翻篇则简短播报或静默归档。
- **插话**：默认 steer（注入当前回合）；"停" = 中止当前回合但不杀后台 job（除非点名取消）。
- **进度心跳**：>3 分钟的 job **编辑同一条消息**更新进度，不刷屏。
- **刻意不学**：全双工毫秒决策（语音专属）；Temporal/Redis/向量库（量级不需要）。

## 6. 写路径与卡片确认

```
5.5 提出写意图 → daemon 规范化 canonical action + hash → Opus 写卡片文案
→ 服务端固定模板渲染卡片（预览+可编辑表单+确认/取消）→ 发到会话
→ 点确认 → card.action.trigger 回调 → 校验(token 单次/TTL/operator)+hash 校验
→ executeApprovedAction（dry-run→真写→幂等 key→对账）→ 卡片原地更新"✅ 已执行+结果"
```

- **核心红线原样**：模型只提意图，动作形状由服务端确定；action DSL 类型封闭（`create_task / send_dm` 起步，逐个加 `create_event / send_group_msg / doc_append`…，每类配 argv 白名单构造器+测试）。
- **卡片技术选型**（外部调研定稿）：Card JSON 2.0（`schema:"2.0"` + `update_multi:true`）；表单容器 + `person_select`（**原生回传 open_id**，解决负责人补齐）；回调走长连接订阅 `card.action.trigger`；**3 秒约束** → 回调响应立即返回新卡片（"⏳ 执行中"、按钮移除、天然防重复点击）→ 异步执行 → `message_id` 更新终态（14 天窗口）。
- **确认人绑定**：按钮无原生权限限制（官方确认）→ 服务端校验 `operator.open_id` = 发起人（或管理员白名单），他人点击 toast"仅发起人可操作"。token 一次性 + 30 分钟 TTL（`approval_tokens` 原样），过期卡片更新为"已过期"。
- **表单编辑后**：服务端按 form_value 重新规范化 + 重算 hash 再执行（等价原 web 编辑器逻辑）。
- **纵深保留**：`MSTD_ENABLE_WRITE` 总开关 + `assertTestTarget` 白名单渐进开闸。
- **反馈闭环**：执行结果更新卡片 + 回注会话上下文（后续对话接得上）。

## 7. 主动层

- **单 ticker 多周期**（60s 一跳 + `tick % N` 分频）：cron 调度、会话过期、夜间蒸馏、lark profile 健康巡检（现有模块）、TTL 清理。不引入调度框架。
- **cron 任务**：`jobs` 表（schedule：`30m`/`every 2h`/cron 表达式/一次性 ISO + prompt + 投递目标）。执行起**新鲜会话**（注入相关记忆层），结果经 Opus 渲染投递。**cron 写动作一律发确认卡给任务 owner，绝不静默真写。**
- **HEARTBEAT.md**：模型自维护的待办清单；心跳回合（工作时间内）由 **V4 扫描判断**：无到期项回 `HEARTBEAT_OK` 被吞；有到期项**灌上下文给 5.5 执行**（与消息路径同一入枢机制，V4 始终不碰工具）。承载"明天提醒我 X"类零散主动行为。
- **事件唤醒**：妙记消费者（现有）为第一个事件源；新事件类型 = 多一个订阅进收件箱。

## 8. web 调试台（pricing-app 壳，仅管理员）

1. **会话浏览器**：全会话列表 + transcript 回放，每条消息标注 admit/门控判定结果（"为什么没回"一眼看穿）；
2. **实时时间线**：活跃回合 SSE 流（现有 Timeline 组件）；
3. **任务看板**：cron 管理 + 后台 job 状态（现有 BoardView 演进）+ 审计查询（decisions/job_actions）；
4. **登录**：现有飞书 OAuth + admin 白名单；
5. **记忆编辑器**：四层记忆文件查看/编辑（配合漂移检测）；
6. **调试对话**：web 里直接与 agent 聊（`debug:` 会话）。

## 9. 错误处理、测试、迁移

### 9.1 错误处理

| 故障 | 处理 |
|---|---|
| Pi 崩溃/卡死 | daemon 重启 Pi 重放上下文；连续失败 → DM 告警（现有 `makeDmAlert`） |
| lark 长连接断 | 自动重连（5s backoff）+ 断档回扫（`backfill` 扩展到消息事件） |
| V4 挂 | 门控降级纯规则（mention-only 直通、旁听暂停）——宁静默不误发 |
| 5.5 挂 | V4 告知稍后；事件留收件箱重试 |
| Opus 挂 | 5.5 产出经模板直出并标注降级 |
| 写执行失败 | 现有 partial_failed/对账；卡片显失败详情+重试按钮（重试前对账） |
| 回调重复/伪造 | 幂等(message_id+action_id)+token 单次+operator 校验 |
| 工具循环失控 | 回合 max_turns + 重复失败检测（警告后硬停） |
| token 失控 | 每会话/每日 token 预算上限，超限暂停+告警 |

### 9.2 测试

- 单测 vitest + mock 注入（`runLark`/`spawnFn`/`startPi`/三模型 client），保速度与确定性；**安全内核 199 用例基线持续全绿**。
- **集成/E2E 打 test organization 真飞书**（用户自有测试租户）：真发消息、真卡片、真回调、真建任务，全链路状态机断言。
- 新模块单测重点：门控（admit 枚举/分级/限额）、会话 actor（串行/版本号/防抖）、记忆（限额/漂移/注入隔离铁律）、卡片构建器（模板固定性、form_value 解析）、蒸馏。
- web 调试台真机验证用 Claude-in-Chrome（项目约定，不用 Playwright）。
- 旁听上线运营节奏：新群先"只听不说"观察期，统计信号/噪声比后再开自主插话。

### 9.3 现有代码迁移清单

- **原样保留**：`server/execute/*`（四道锁）、`server/safety/*`、`server/db` 基座、`supervisor/pi-client`、`pi-ext/*`（draft_zh 扩展为 Opus 出口）、`triggers/`、`health/`、`auth/`。
- **改造**：`jobs/orchestrator` 两段式 → 后台 job 执行器（被大脑调用）；`templates` → 事件处理 prompt；SSE/event-bus → 调试台实时流。
- **新增**：`gateway/`（去重/防抖/admit/门控）、`sessions/`（actor+store+FTS）、`memory/`（三层+工具+蒸馏）、`models/`（V4 直调+Opus 出口）、`cards/`（模板+回调）、`ticker/`（cron+心跳）。
- **退役**：web 审批队列视图、`POST /jobs/:id/decision`；mstd-ui 壳改造为调试台。原"完全体计划"剩余任务作废。

## 10. 前置依赖与全局约束

- **飞书应用配置**（test org + 生产各一套）：订阅 `im.message.receive_v1`、`card.action.trigger`、妙记相关事件；申请敏感权限 **`im:message.group_msg`**（群全量消息，需发版+管理员审批）、`im:message:send`、contact 读权限；长连接模式。
- **主机**：Node ≥22；`~/.hermes/node/bin/{pi,lark-cli}`；`.env`（chmod 600）持 `CZ_GPT_KEY / CZ_CLAUDE_KEY / DEEPSEEK_KEY / LARK_PROFILE`；密钥红线不进代码/日志/Git。
- **SQL Postgres 可移植**（显式主键、epoch BIGINT、JSON 存 TEXT、双方言 `ON CONFLICT`）。
- **模型永远不可信**：写形状服务端定；记忆写入过注入扫描；卡片结构模型碰不到。
- commit 风格：`feat(mstd)/fix(mstd): 中文短句`。

## 11. 非目标

- 按人执行身份（已定单一 agent 身份；如未来要做，OAuth 基建已留）。
- 飞书之外的通道（微信/Slack…）。
- 向量库/RAG 重型记忆（FTS 遇到瓶颈再升级）。
- 语音交互。
- 多 agent 协作/Kanban 任务板（Hermes 有，我们量级不需要）。

## 12. 调研依据（摘要索引）

- OpenClaw：每群独立会话、pending 窗口、NO_REPLY、HEARTBEAT、compaction 前 memory flush；无内置两级门控（每条全价）。docs.openclaw.ai
- Hermes agent（本机 `~/.hermes` + GitHub）：admit 拒绝原因枚举、按群覆盖 mention 策略、防抖合批、记忆冻结快照+漂移检测、单 ticker、审批分层、`observed` 标记；反面教材：2 万行上帝对象、无蒸馏。
- GPT-Live-1：轻交互层+重委托、任务版本化/可 supersede、分层路由。openai.com/index/introducing-gpt-live
- 飞书平台：`im:message.group_msg` 敏感权限；事件接收免配额；卡片 JSON 2.0/表单/person_select/3s 回调/14 天更新窗；妙记无 webhook（轮询正确）。open.feishu.cn
- 业界治理：Claude Tag 按群 opt-in；Aily 无指令不行动；Clyde 关停教训；级联门控降本 92% 实证。

---

# Part 2 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 mstd-orchestrator 从"会议纪要单一流水线"改造成常驻的公司级飞书全能助手（Part 1 spec 全量范围 V1+V2）。

**Architecture:** 单常驻 Node 进程（通道/会话/记忆/模型/卡片/主动层各自成包）+ 三模型协作（V4 前台 / 5.5 中枢 Pi / Opus reply 工具出口）+ 写路径复用现有四道锁执行器，审批面从 web 换飞书卡片。

**Tech Stack:** Node ≥22 · Express · better-sqlite3（SQL Postgres 可移植）· Pi 0.80.3 RPC（`supervisor/pi-client.mjs`）· lark-cli（`~/.hermes/node/bin/`，event consume 长连接）· DeepSeek V4 Flash API 直调 · Vite+React+vitest。

## Global Constraints（每个任务隐含遵守）

- **模型永远不可信**：写形状服务端定；模型只能选 `action_id`；卡片 JSON 结构模型碰不到；记忆写入过注入扫描。
- **`reply` 是 5.5 唯一出站通道**：daemon 永不外发 5.5 裸文本。
- **记忆注入隔离铁律**：群 A / 私聊记忆绝不进群 B。
- **真写纵深**：`MSTD_ENABLE_WRITE=1` 才开写；目标受 `MSTD_TEST_OPEN_IDS` 白名单（`assertTestTarget` fail-closed）。
- **密钥红线**：只进 gitignore 的 `.env`（chmod 600）。
- **SQL Postgres 可移植**：显式主键、无 AUTOINCREMENT、epoch BIGINT、JSON 存 TEXT、双方言 `ON CONFLICT`。FTS5 为唯一例外（检索封装进独立模块，PG 时换 pg_trgm）。
- **测试**：单测不真调飞书/模型（注入 `runLark`/`spawnFn`/`startPi`/模型 client mock）；集成/E2E 打 **test organization** 真飞书；web 真机验证用 Claude-in-Chrome 不用 Playwright。
- **安全内核回归红线**：现有 `cd mstd-orchestrator && npx vitest run` 基线（39 文件 199 用例）任何任务完成时必须全绿。
- commit 风格：`feat(mstd)/fix(mstd): 中文短句`。

## 文件结构总图（新增/改造锁定）

```
mstd-orchestrator/server/
  gateway/            # Phase A：consumer.mjs(通用事件长连接) inbox.mjs(归一化+去重)
                      #          debounce.mjs(防抖合批) admit.mjs(准入判定枚举)
  sessions/           # Phase A：session-key.mjs store.mjs(表+transcript) actor.mjs(串行队列+版本)
                      #          search.mjs(FTS 封装)
  models/             # Phase B：v4-client.mjs(直调API) triage.mjs(前台分诊) brain.mjs(5.5 Pi 会话管理)
                      #          reply.mjs(Opus 出口渲染) budget.mjs(token 预算)
  memory/             # Phase C：files.mjs(三层读写+漂移检测) inject.mjs(注入规则+冻结快照)
                      #          tool.mjs(memory 工具) scan.mjs(注入扫描) compact.mjs(压缩+flush)
  cards/              # Phase D：templates.mjs(固定卡片模板) confirm-flow.mjs(发卡/回调/更新状态机)
  jobs/               # Phase D 改造：orchestrator → 后台 job 执行器；版本化回注
  ticker/             # Phase E：ticker.mjs(单 ticker 分频) cron-jobs.mjs heartbeat.mjs dreaming.mjs
  safety/ execute/    # 原样保留（Phase D 只加 action 类型与 argv 构造器）
mstd-ui/              # Phase G：调试台六面板（壳复用）
pi-ext/               # Phase B/D：reply 工具、lark_read 扩展、lark-execute 原样
```

## Phase 总览（每 Phase 交付可独立测试的活软件）

| Phase | 交付 | 任务数 |
|---|---|---|
| **A 通道与会话基座** | 事件进得来、会话存得住、串行跑得对（本文件已全粒度展开 ↓） | A1-A8 |
| **B 三模型层** | V4 分诊四选一→5.5 Pi 会话→reply 工具出站；SOUL 注入；token 预算 | B1-B7 |
| **C 记忆系统** | 三层文件+工具+冻结快照+隔离注入+漂移检测+压缩 flush+session_search | C1-C7 |
| **D 写路径卡片** | action DSL 扩类→固定模板卡→card.action.trigger→四道锁执行→卡片状态机；后台 job 版本化回注 | D1-D8 |
| **E 主动层** | 单 ticker、cron 表、HEARTBEAT、dreaming 蒸馏（影子模式起步）、健康巡检挂载、妙记闭环迁移 | E1-E7 |
| **F 群聊能力** | 群@、pending 窗口、旁听三层门控、NO_REPLY、限额、观察期模式 | F1-F6 |
| **G web 调试台** | 六面板（会话浏览/时间线/看板/记忆编辑/调试对话/OAuth+admin） | G1-G6 |
| **H 收尾** | 退役旧端点、test org E2E 全链路、生产配置收口、README | H1-H4 |

> **详批节奏**：Phase A 已展开如下；每个 Phase 开工前，按 Phase A 同粒度（TDD 五步、完整代码、精确路径）追加该 Phase 详批到本文件。B-H 的任务边界与接口已在各 Phase 开工前的详批中锁定，不得跨 Phase 挪动职责。

---

## Phase A · 通道与会话基座（全粒度详批）

### Task A1: 数据库迁移 003（会话/消息/FTS/群策略/收件箱去重）

**Files:**
- Create: `mstd-orchestrator/server/db/migrations/003_agent_core.sql`
- Test: `mstd-orchestrator/test/migration-agent-core.test.mjs`

**Interfaces:**
- Produces: 表 `agent_sessions / agent_messages / agent_messages_fts / group_policies / inbox_events`，后续 A3/A4/A6 全部依赖。

- [ ] **Step 1: 写失败测试**

```js
// test/migration-agent-core.test.mjs
import { describe, it, expect } from "vitest";
import { openDb } from "../server/db/index.mjs";

describe("003_agent_core migration", () => {
  it("建齐五张表且 FTS trigram 可检中文", () => {
    const db = openDb(":memory:");
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') OR type='table'"
    ).all().map(r => r.name);
    for (const t of ["agent_sessions","agent_messages","group_policies","inbox_events"])
      expect(tables).toContain(t);
    db.prepare("INSERT INTO agent_messages_fts (message_id, session_id, content) VALUES (?,?,?)")
      .run("m1","s1","下周三交付武汉项目方案");
    const hit = db.prepare(
      "SELECT message_id FROM agent_messages_fts WHERE agent_messages_fts MATCH ?"
    ).all("武汉");
    expect(hit.map(r => r.message_id)).toContain("m1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mstd-orchestrator && npx vitest run test/migration-agent-core.test.mjs`
Expected: FAIL（表不存在）

- [ ] **Step 3: 写迁移**

```sql
-- 003_agent_core.sql（Postgres 可移植：显式主键、epoch BIGINT、JSON 存 TEXT；FTS5 除外）
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                       -- p2p | group | cron | debug
  chat_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- active | archived
  version INTEGER NOT NULL DEFAULT 0,       -- 会话版本号（过时回复判定）
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  role TEXT NOT NULL,                       -- user | assistant | tool | system
  sender_open_id TEXT,
  sender_name TEXT,
  content TEXT NOT NULL,
  observed INTEGER NOT NULL DEFAULT 0,      -- 旁听未回复标记
  active INTEGER NOT NULL DEFAULT 1,        -- 软删除
  platform_message_id TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, ts);

CREATE TABLE IF NOT EXISTS group_policies (
  chat_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL DEFAULT 'mention_only',  -- disabled | mention_only | ambient
  hourly_proactive_limit INTEGER NOT NULL DEFAULT 4,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_events (
  event_id TEXT PRIMARY KEY,
  chat_id TEXT,
  content_md5 TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_events_md5 ON inbox_events(chat_id, content_md5, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(
  message_id UNINDEXED, session_id UNINDEXED, content, tokenize='trigram'
);
```

- [ ] **Step 4: 跑测试通过 + 全量回归**

Run: `cd mstd-orchestrator && npx vitest run`
Expected: 新用例 PASS，基线 199 用例全绿

- [ ] **Step 5: Commit**

```bash
git add mstd-orchestrator/server/db/migrations/003_agent_core.sql mstd-orchestrator/test/migration-agent-core.test.mjs
git commit -m "feat(mstd): agent 核心表迁移（会话/消息/FTS/群策略/收件箱去重）"
```

### Task A2: 会话键构造与解析

**Files:**
- Create: `mstd-orchestrator/server/sessions/session-key.mjs`
- Test: `mstd-orchestrator/test/session-key.test.mjs`

**Interfaces:**
- Produces: `buildSessionKey({kind, openId?, chatId?, topicId?, jobId?, debugId?}) -> string`；`parseSessionKey(key) -> {kind, ...ids}`。A3/A6/B 全线依赖。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from "vitest";
import { buildSessionKey, parseSessionKey } from "../server/sessions/session-key.mjs";

describe("session-key", () => {
  it("四种键往返一致", () => {
    expect(buildSessionKey({ kind: "p2p", openId: "ou_a" })).toBe("feishu:p2p:ou_a");
    expect(buildSessionKey({ kind: "group", chatId: "oc_1" })).toBe("feishu:group:oc_1");
    expect(buildSessionKey({ kind: "group", chatId: "oc_1", topicId: "omt_9" }))
      .toBe("feishu:group:oc_1:omt_9");
    expect(buildSessionKey({ kind: "cron", jobId: "daily" })).toBe("cron:daily");
    expect(parseSessionKey("feishu:group:oc_1:omt_9"))
      .toEqual({ kind: "group", chatId: "oc_1", topicId: "omt_9" });
    expect(parseSessionKey("debug:d1")).toEqual({ kind: "debug", debugId: "d1" });
  });
  it("缺必填字段抛错", () => {
    expect(() => buildSessionKey({ kind: "p2p" })).toThrow();
    expect(() => buildSessionKey({ kind: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）

- [ ] **Step 3: 实现**

```js
// server/sessions/session-key.mjs
export function buildSessionKey({ kind, openId, chatId, topicId, jobId, debugId }) {
  switch (kind) {
    case "p2p":
      if (!openId) throw new Error("p2p 需要 openId");
      return `feishu:p2p:${openId}`;
    case "group":
      if (!chatId) throw new Error("group 需要 chatId");
      return topicId ? `feishu:group:${chatId}:${topicId}` : `feishu:group:${chatId}`;
    case "cron":
      if (!jobId) throw new Error("cron 需要 jobId");
      return `cron:${jobId}`;
    case "debug":
      if (!debugId) throw new Error("debug 需要 debugId");
      return `debug:${debugId}`;
    default:
      throw new Error(`未知会话类型: ${kind}`);
  }
}

export function parseSessionKey(key) {
  const parts = key.split(":");
  if (parts[0] === "cron") return { kind: "cron", jobId: parts[1] };
  if (parts[0] === "debug") return { kind: "debug", debugId: parts[1] };
  if (parts[0] === "feishu" && parts[1] === "p2p") return { kind: "p2p", openId: parts[2] };
  if (parts[0] === "feishu" && parts[1] === "group") {
    const out = { kind: "group", chatId: parts[2] };
    if (parts[3]) out.topicId = parts[3];
    return out;
  }
  throw new Error(`无法解析会话键: ${key}`);
}
```

- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `feat(mstd): 会话键构造与解析`

### Task A3: 会话存储（getOrCreate / append / transcript / 软删 / 版本）

**Files:**
- Create: `mstd-orchestrator/server/sessions/store.mjs`
- Test: `mstd-orchestrator/test/session-store.test.mjs`

**Interfaces:**
- Consumes: A1 的表、A2 的 `buildSessionKey`。
- Produces: `createSessionStore(db)` → `{ getOrCreate(sessionKey, meta?) -> session, append(sessionId, {role, senderOpenId?, senderName?, content, observed?, platformMessageId?, ts?}) -> message, transcript(sessionId, {limit?}) -> message[], softDelete(messageId), bumpVersion(sessionId) -> number, touch(sessionId) }`。B（上下文重放）、F（observed）、G（浏览器）依赖。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from "vitest";
import { openDb } from "../server/db/index.mjs";
import { createSessionStore } from "../server/sessions/store.mjs";

describe("session store", () => {
  it("getOrCreate 幂等；append/transcript 按 ts 序；软删不出现在 transcript；版本自增", () => {
    const db = openDb(":memory:");
    const store = createSessionStore(db);
    const s1 = store.getOrCreate("feishu:p2p:ou_a", { kind: "p2p", title: "张三" });
    const s2 = store.getOrCreate("feishu:p2p:ou_a");
    expect(s2.id).toBe(s1.id);

    const m1 = store.append(s1.id, { role: "user", senderOpenId: "ou_a", content: "第一句", ts: 1000 });
    store.append(s1.id, { role: "assistant", content: "回复", ts: 2000 });
    expect(store.transcript(s1.id).map(m => m.content)).toEqual(["第一句", "回复"]);

    store.softDelete(m1.id);
    expect(store.transcript(s1.id).map(m => m.content)).toEqual(["回复"]);

    expect(store.bumpVersion(s1.id)).toBe(1);
    expect(store.bumpVersion(s1.id)).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```js
// server/sessions/store.mjs
import { randomUUID } from "node:crypto";

export function createSessionStore(db) {
  const getBySessionKey = db.prepare("SELECT * FROM agent_sessions WHERE session_key = ?");
  const insertSession = db.prepare(
    `INSERT INTO agent_sessions (id, session_key, kind, chat_id, title, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`
  );
  const insertMessage = db.prepare(
    `INSERT INTO agent_messages (id, session_id, role, sender_open_id, sender_name, content, observed, active, platform_message_id, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const insertFts = db.prepare(
    "INSERT INTO agent_messages_fts (message_id, session_id, content) VALUES (?, ?, ?)"
  );

  function getOrCreate(sessionKey, meta = {}, now = Date.now()) {
    const found = getBySessionKey.get(sessionKey);
    if (found) return found;
    const id = randomUUID();
    insertSession.run(id, sessionKey, meta.kind ?? sessionKey.split(":")[1] ?? "p2p",
      meta.chatId ?? null, meta.title ?? null, now, now);
    return getBySessionKey.get(sessionKey);
  }

  function append(sessionId, msg) {
    const id = randomUUID();
    const ts = msg.ts ?? Date.now();
    insertMessage.run(id, sessionId, msg.role, msg.senderOpenId ?? null, msg.senderName ?? null,
      msg.content, msg.observed ? 1 : 0, msg.platformMessageId ?? null, ts);
    insertFts.run(id, sessionId, msg.content);
    touch(sessionId, ts);
    return { id, sessionId, ...msg, ts };
  }

  function transcript(sessionId, { limit = 200 } = {}) {
    return db.prepare(
      "SELECT * FROM agent_messages WHERE session_id = ? AND active = 1 ORDER BY ts LIMIT ?"
    ).all(sessionId, limit);
  }

  function softDelete(messageId) {
    db.prepare("UPDATE agent_messages SET active = 0 WHERE id = ?").run(messageId);
  }

  function bumpVersion(sessionId) {
    db.prepare("UPDATE agent_sessions SET version = version + 1 WHERE id = ?").run(sessionId);
    return db.prepare("SELECT version FROM agent_sessions WHERE id = ?").get(sessionId).version;
  }

  function touch(sessionId, now = Date.now()) {
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  }

  return { getOrCreate, append, transcript, softDelete, bumpVersion, touch };
}
```

- [ ] **Step 4: 跑测试通过 + 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): 会话存储（transcript/软删/版本号）`

### Task A4: 收件箱归一化与双重去重

**Files:**
- Create: `mstd-orchestrator/server/gateway/inbox.mjs`
- Test: `mstd-orchestrator/test/inbox.test.mjs`

**Interfaces:**
- Consumes: A1 `inbox_events` 表。
- Produces: `createInbox(db)` → `{ normalize(rawLarkEvent) -> {eventId, kind, chatId, chatType, senderOpenId, senderName, content, mentionsBot, topicId?, ts} | null, isDuplicate(evt, now?) -> boolean, markSeen(evt, now?) }`。`kind ∈ {message, card_action, minutes}`。A8/F 依赖。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from "vitest";
import { openDb } from "../server/db/index.mjs";
import { createInbox } from "../server/gateway/inbox.mjs";

const rawMsg = (over = {}) => ({
  header: { event_id: over.eventId ?? "ev1", event_type: "im.message.receive_v1" },
  event: {
    sender: { sender_id: { open_id: "ou_a" } },
    message: {
      chat_id: "oc_1", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text: over.text ?? "你好 @_user_1" }),
      mentions: over.mentions ?? [{ id: { open_id: "ou_bot" }, key: "@_user_1" }],
      create_time: "1720000000000",
    },
  },
});

describe("inbox", () => {
  it("归一化文本消息并识别 @bot", () => {
    const inbox = createInbox(openDb(":memory:"), { botOpenId: "ou_bot" });
    const evt = inbox.normalize(rawMsg());
    expect(evt).toMatchObject({
      eventId: "ev1", kind: "message", chatId: "oc_1", chatType: "group",
      senderOpenId: "ou_a", mentionsBot: true,
    });
  });
  it("event_id 去重 + 60s 内同 chat 同内容 MD5 去重", () => {
    const inbox = createInbox(openDb(":memory:"), { botOpenId: "ou_bot" });
    const e1 = inbox.normalize(rawMsg());
    expect(inbox.isDuplicate(e1, 1000)).toBe(false);
    inbox.markSeen(e1, 1000);
    expect(inbox.isDuplicate(e1, 2000)).toBe(true);                        // 同 event_id
    const e2 = inbox.normalize(rawMsg({ eventId: "ev2" }));
    expect(inbox.isDuplicate(e2, 30_000)).toBe(true);                      // 同内容 60s 窗口
    expect(inbox.isDuplicate(inbox.normalize(rawMsg({ eventId: "ev3" })), 120_000)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```js
// server/gateway/inbox.mjs
import { createHash } from "node:crypto";

export function createInbox(db, { botOpenId }) {
  function normalize(raw) {
    const type = raw?.header?.event_type;
    if (type === "im.message.receive_v1") {
      const m = raw.event.message;
      let text = "";
      try { text = JSON.parse(m.content).text ?? ""; } catch { return null; }
      const mentions = m.mentions ?? [];
      return {
        eventId: raw.header.event_id,
        kind: "message",
        chatId: m.chat_id,
        chatType: m.chat_type,                    // p2p | group
        senderOpenId: raw.event.sender.sender_id.open_id,
        senderName: raw.event.sender.sender_id.name ?? null,
        content: text,
        mentionsBot: mentions.some(x => x?.id?.open_id === botOpenId),
        topicId: m.thread_id ?? null,
        ts: Number(m.create_time),
      };
    }
    if (type === "card.action.trigger") {
      return { eventId: raw.header.event_id, kind: "card_action", raw: raw.event, ts: Date.now() };
    }
    if (type?.startsWith("minutes.")) {
      return { eventId: raw.header.event_id, kind: "minutes", raw: raw.event, ts: Date.now() };
    }
    return null;
  }

  const md5 = (evt) => createHash("md5")
    .update(`${evt.chatId ?? ""}|${evt.senderOpenId ?? ""}|${evt.content ?? ""}`).digest("hex");

  function isDuplicate(evt, now = Date.now()) {
    if (db.prepare("SELECT 1 FROM inbox_events WHERE event_id = ?").get(evt.eventId)) return true;
    if (evt.kind !== "message") return false;
    return !!db.prepare(
      "SELECT 1 FROM inbox_events WHERE chat_id = ? AND content_md5 = ? AND ts > ?"
    ).get(evt.chatId, md5(evt), now - 60_000);
  }

  function markSeen(evt, now = Date.now()) {
    db.prepare(
      "INSERT INTO inbox_events (event_id, chat_id, content_md5, ts) VALUES (?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING"
    ).run(evt.eventId, evt.chatId ?? null, evt.kind === "message" ? md5(evt) : null, now);
  }

  return { normalize, isDuplicate, markSeen };
}
```

- [ ] **Step 4: 跑测试通过 + 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): 事件收件箱（归一化 + event_id/内容MD5 双重去重）`

### Task A5: 防抖合批（3 秒窗口按发送者合并）

**Files:**
- Create: `mstd-orchestrator/server/gateway/debounce.mjs`
- Test: `mstd-orchestrator/test/debounce.test.mjs`

**Interfaces:**
- Produces: `createDebouncer({ delayMs = 3000, setTimeoutFn, clearTimeoutFn }) -> { push(batchKey, item, onFlush) }`——同 `batchKey`（约定 `sessionKey|senderOpenId`）在窗口内累积，窗口静默后 `onFlush(items[])` 一次。A8 依赖。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, vi } from "vitest";
import { createDebouncer } from "../server/gateway/debounce.mjs";

describe("debounce", () => {
  it("窗口内连发合并为一次 flush；不同 key 互不影响", () => {
    vi.useFakeTimers();
    const flushed = [];
    const d = createDebouncer({ delayMs: 3000 });
    d.push("s1|ou_a", { content: "第一条" }, items => flushed.push(items));
    vi.advanceTimersByTime(1000);
    d.push("s1|ou_a", { content: "第二条" }, items => flushed.push(items));
    d.push("s2|ou_b", { content: "别人" }, items => flushed.push(items));
    vi.advanceTimersByTime(3000);
    expect(flushed).toHaveLength(2);
    expect(flushed.find(b => b.length === 2).map(i => i.content)).toEqual(["第一条", "第二条"]);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```js
// server/gateway/debounce.mjs
export function createDebouncer({ delayMs = 3000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const pending = new Map(); // batchKey -> { items, timer, onFlush }
  function push(batchKey, item, onFlush) {
    let entry = pending.get(batchKey);
    if (!entry) { entry = { items: [], timer: null, onFlush }; pending.set(batchKey, entry); }
    entry.items.push(item);
    entry.onFlush = onFlush;
    if (entry.timer) clearTimeoutFn(entry.timer);
    entry.timer = setTimeoutFn(() => {
      pending.delete(batchKey);
      entry.onFlush(entry.items);
    }, delayMs);
  }
  return { push };
}
```

- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `feat(mstd): 消息防抖合批（3s 窗口按发送者合并）`

### Task A6: admit 准入判定（拒绝原因枚举 + 按群策略）

**Files:**
- Create: `mstd-orchestrator/server/gateway/admit.mjs`
- Test: `mstd-orchestrator/test/admit.test.mjs`

**Interfaces:**
- Consumes: A1 `group_policies` 表、A4 归一化事件。
- Produces: `createAdmit(db, { botOpenId })` → `{ admit(evt) -> { ok: true, mode: "addressed"|"ambient" } | { ok: false, reason } }`；`reason ∈ { self_echo, empty_content, group_disabled, bot_not_mentioned_observe, unknown_kind }`。`bot_not_mentioned_observe` 表示"存为 observed 上下文但不唤醒"（F 的 pending 窗口消费）。A8/F 依赖。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../server/db/index.mjs";
import { createAdmit } from "../server/gateway/admit.mjs";

const evt = (over = {}) => ({
  kind: "message", chatType: "group", chatId: "oc_1",
  senderOpenId: "ou_a", content: "在吗", mentionsBot: false, ...over,
});

describe("admit", () => {
  let db, admit;
  beforeEach(() => {
    db = openDb(":memory:");
    admit = createAdmit(db, { botOpenId: "ou_bot" });
  });
  it("私聊直通 addressed", () => {
    expect(admit.admit(evt({ chatType: "p2p" }))).toEqual({ ok: true, mode: "addressed" });
  });
  it("bot 自己的消息拒绝 self_echo", () => {
    expect(admit.admit(evt({ senderOpenId: "ou_bot" }))).toEqual({ ok: false, reason: "self_echo" });
  });
  it("群默认 mention_only：@ 了 addressed，没 @ 存 observed", () => {
    expect(admit.admit(evt({ mentionsBot: true }))).toEqual({ ok: true, mode: "addressed" });
    expect(admit.admit(evt())).toEqual({ ok: false, reason: "bot_not_mentioned_observe" });
  });
  it("群策略 ambient：未 @ 也放行为 ambient；disabled 拒绝", () => {
    db.prepare("INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at) VALUES ('oc_1','ambient',4,0)").run();
    expect(admit.admit(evt())).toEqual({ ok: true, mode: "ambient" });
    db.prepare("UPDATE group_policies SET policy='disabled' WHERE chat_id='oc_1'").run();
    expect(admit.admit(evt())).toEqual({ ok: false, reason: "group_disabled" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```js
// server/gateway/admit.mjs
export function createAdmit(db, { botOpenId }) {
  const getPolicy = db.prepare("SELECT policy FROM group_policies WHERE chat_id = ?");
  function admit(evt) {
    if (evt.kind !== "message") return { ok: false, reason: "unknown_kind" };
    if (evt.senderOpenId === botOpenId) return { ok: false, reason: "self_echo" };
    if (!evt.content?.trim()) return { ok: false, reason: "empty_content" };
    if (evt.chatType === "p2p") return { ok: true, mode: "addressed" };

    const policy = getPolicy.get(evt.chatId)?.policy ?? "mention_only";
    if (policy === "disabled") return { ok: false, reason: "group_disabled" };
    if (evt.mentionsBot) return { ok: true, mode: "addressed" };
    if (policy === "ambient") return { ok: true, mode: "ambient" };
    return { ok: false, reason: "bot_not_mentioned_observe" };
  }
  return { admit };
}
```

- [ ] **Step 4: 跑测试通过 + 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): admit 准入判定（原因枚举 + 按群策略覆盖）`

### Task A7: 会话 actor（每会话串行队列）

**Files:**
- Create: `mstd-orchestrator/server/sessions/actor.mjs`
- Test: `mstd-orchestrator/test/session-actor.test.mjs`

**Interfaces:**
- Produces: `createActorPool()` → `{ enqueue(sessionKey, asyncFn) -> Promise }`——同 key 严格按序执行（前一个 resolve/reject 后才起下一个），不同 key 并发；`asyncFn` 抛错不阻塞后续任务。B（回合执行）、D（回注）依赖。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from "vitest";
import { createActorPool } from "../server/sessions/actor.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe("session actor", () => {
  it("同 key 串行、异 key 并发、抛错不断队列", async () => {
    const pool = createActorPool();
    const order = [];
    const p1 = pool.enqueue("s1", async () => { await sleep(30); order.push("s1-a"); });
    const p2 = pool.enqueue("s1", async () => { order.push("s1-b"); });
    const p3 = pool.enqueue("s2", async () => { order.push("s2-a"); });
    await Promise.all([p1, p2, p3]);
    expect(order.indexOf("s2-a")).toBeLessThan(order.indexOf("s1-a")); // s2 不等 s1
    expect(order.indexOf("s1-a")).toBeLessThan(order.indexOf("s1-b")); // s1 内串行

    await expect(pool.enqueue("s1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(pool.enqueue("s1", async () => "ok")).resolves.toBe("ok"); // 队列没死
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```js
// server/sessions/actor.mjs
export function createActorPool() {
  const tails = new Map(); // sessionKey -> Promise
  function enqueue(sessionKey, asyncFn) {
    const tail = tails.get(sessionKey) ?? Promise.resolve();
    const run = tail.then(() => asyncFn());
    const guarded = run.catch(() => {});          // 吞掉尾部错误，队列继续
    tails.set(sessionKey, guarded);
    guarded.then(() => { if (tails.get(sessionKey) === guarded) tails.delete(sessionKey); });
    return run;
  }
  return { enqueue };
}
```

- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `feat(mstd): 会话 actor 串行队列`

### Task A8: 通用事件长连接消费者（管道装配）

**Files:**
- Create: `mstd-orchestrator/server/gateway/consumer.mjs`
- Modify: `mstd-orchestrator/server/index.mjs`（boot 时装配：consumer → inbox → admit → debounce → actor → 占位 handler）
- Test: `mstd-orchestrator/test/gateway-consumer.test.mjs`

**Interfaces:**
- Consumes: A4/A5/A6/A7 全部；现有 `triggers/minutes-consumer.mjs` 的 spawn/重启模式（照抄其注入 `spawnFn` 约定）。
- Produces: `createGatewayConsumer({ spawnFn, larkCliPath, events, onEvent, restartDelayMs })` → `{ start(), stop() }`——spawn `lark-cli event consume <events...> --as bot` NDJSON 长连接，每行 JSON parse 后 `onEvent(raw)`；进程退出自动重启（backoff）；parse 失败发 `onEvent({ __parse_error: line })` 不静默。`server/index.mjs` 中的装配函数 `wireGateway({db, consumerFactory, handleTurn})` 是 B1 替换占位 handler 的接缝。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createGatewayConsumer } from "../server/gateway/consumer.mjs";

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

describe("gateway consumer", () => {
  it("NDJSON 逐行回调；坏行显式上报；退出后重启", async () => {
    vi.useFakeTimers();
    const children = [];
    const spawnFn = vi.fn(() => { const c = fakeChild(); children.push(c); return c; });
    const events = [];
    const consumer = createGatewayConsumer({
      spawnFn, larkCliPath: "/fake/lark-cli",
      events: ["im.message.receive_v1", "card.action.trigger"],
      onEvent: e => events.push(e), restartDelayMs: 5000,
    });
    consumer.start();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    children[0].stdout.emit("data", Buffer.from('{"header":{"event_id":"e1"}}\n不是json\n'));
    expect(events[0]).toEqual({ header: { event_id: "e1" } });
    expect(events[1]).toHaveProperty("__parse_error");
    children[0].emit("exit", 1);
    vi.advanceTimersByTime(5000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    consumer.stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

```js
// server/gateway/consumer.mjs
export function createGatewayConsumer({ spawnFn, larkCliPath, events, onEvent, restartDelayMs = 5000, setTimeoutFn = setTimeout }) {
  let child = null, stopped = false, buf = "";
  function start() {
    stopped = false;
    spawnOnce();
  }
  function spawnOnce() {
    if (stopped) return;
    buf = "";
    child = spawnFn(larkCliPath, ["event", "consume", ...events, "--as", "bot"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); }
        catch { onEvent({ __parse_error: line }); }
      }
    });
    child.on("exit", () => { if (!stopped) setTimeoutFn(spawnOnce, restartDelayMs); });
  }
  function stop() { stopped = true; child?.kill(); }
  return { start, stop };
}
```

`server/index.mjs` 装配（在现有 boot 序列的 minutes consumer 旁边加）：

```js
// index.mjs 新增（占位 handler 在 Phase B1 换成真回合执行器）
import { createGatewayConsumer } from "./gateway/consumer.mjs";
import { createInbox } from "./gateway/inbox.mjs";
import { createAdmit } from "./gateway/admit.mjs";
import { createDebouncer } from "./gateway/debounce.mjs";
import { createActorPool } from "./sessions/actor.mjs";
import { createSessionStore } from "./sessions/store.mjs";
import { buildSessionKey } from "./sessions/session-key.mjs";

export function wireGateway({ db, config, spawnFn, handleTurn }) {
  const inbox = createInbox(db, { botOpenId: config.botOpenId });
  const admitter = createAdmit(db, { botOpenId: config.botOpenId });
  const debouncer = createDebouncer({});
  const actors = createActorPool();
  const store = createSessionStore(db);

  const consumer = createGatewayConsumer({
    spawnFn, larkCliPath: config.larkCliPath,
    events: ["im.message.receive_v1", "card.action.trigger"],
    onEvent(raw) {
      if (raw.__parse_error) return console.error("[gateway] parse error:", raw.__parse_error);
      const evt = inbox.normalize(raw);
      if (!evt || inbox.isDuplicate(evt)) return;
      inbox.markSeen(evt);
      if (evt.kind !== "message") return handleTurn({ kind: evt.kind, evt }); // 卡片/妙记直达
      const verdict = admitter.admit(evt);
      const sessionKey = evt.chatType === "p2p"
        ? buildSessionKey({ kind: "p2p", openId: evt.senderOpenId })
        : buildSessionKey({ kind: "group", chatId: evt.chatId, topicId: evt.topicId ?? undefined });
      const session = store.getOrCreate(sessionKey, { kind: evt.chatType === "p2p" ? "p2p" : "group", chatId: evt.chatId });
      if (!verdict.ok) {
        if (verdict.reason === "bot_not_mentioned_observe")
          store.append(session.id, { role: "user", senderOpenId: evt.senderOpenId, senderName: evt.senderName, content: evt.content, observed: true, ts: evt.ts });
        return;
      }
      debouncer.push(`${sessionKey}|${evt.senderOpenId}`, evt, items =>
        actors.enqueue(sessionKey, () => handleTurn({ kind: "message", session, sessionKey, items, mode: verdict.mode }))
      );
    },
  });
  consumer.start();
  return { consumer };
}
```

- [ ] **Step 4: 跑测试通过 + 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): 通用事件长连接消费者 + gateway 管道装配`

**Phase A 完成标志**：`npx vitest run` 全绿；对 test org 发一条私聊消息，能在日志里看到"归一化→admit→合批→actor 入队"全链路（handler 为占位打印）。

---

## Phase B-H · 详批占位

>（各 Phase 开工前按 Phase A 同粒度追加。任务边界、Files、Interfaces 以"Phase 总览"表 + 文件结构总图为准，不得跨 Phase 挪动职责。）
