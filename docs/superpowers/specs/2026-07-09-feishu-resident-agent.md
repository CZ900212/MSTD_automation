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
SOUL.md                       身份/人格/规矩（热加载，注入 slot#1，管理员可随时手改）
memory/ORG.md                 公司级共享事实（字符数上限，超限提醒模型自行合并淘汰）
memory/journal/YYYY-MM-DD.md  公司总日志：今天发生了什么（每回合结束追加一条；
                              人↔agent 私聊同样记录；群/私聊事件都汇入这本总账）
memory/groups/<chat_id>.md    每群记忆
memory/users/<open_id>.md     每人记忆（私聊画像）
```

- **注入铁律**：群会话 = SOUL+ORG+当日 journal 摘要+本群；私聊 = SOUL+ORG+当日 journal 摘要+本人。**群 A 记忆与私聊原文绝不进群 B**；journal 是公司共享总账，写入时即做敏感脱敏（私聊细节只记要点不记原文）。
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
- **重试与模型降级链（用户定案）**：任何模型调用失败先 **5 次 × 10s 重试**，仍失败才降级到链内下一个模型；全链耗尽才算管道故障（§9.1 兜底才触发）。三条链：
  - **前台 fast**：DeepSeek V4 Flash → Opus 4.6 → GPT-5.5（全部 non-thinking）
  - **中枢 reason**：GPT-5.5 → Opus 4.8 → DeepSeek V4 Pro
  - **出口 respond**：Opus 4.6 → DeepSeek V4 Pro → GPT-5.5
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
| 模型调用失败 | 先 5 次×10s 重试 → 链内降级（fast/reason/respond 三条链，见 §5.2）→ **全链耗尽**才触发最终兜底：门控退纯规则（宁静默不误发）/ 告知用户稍后 / 模板直出标注降级 |
| 写执行失败 | 现有 partial_failed/对账；卡片显失败详情+重试按钮（重试前对账） |
| 回调重复/伪造 | 幂等(message_id+action_id)+token 单次+operator 校验 |
| 工具循环失控 | 回合 max_turns + 重复失败检测（警告后硬停） |
| token 失控 | 每会话/每日 token 预算上限，超限暂停+告警 |

### 9.2 测试

- 单测 vitest；纯逻辑模块用 mock 注入（`runLark`/`spawnFn`/`startPi`/模型 client）保速度与确定性；**经用户授权（已默认授权，用户可随时收回）单测亦可直调 test organization 真飞书**；**安全内核 199 用例基线持续全绿**。
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
- **重试与降级链**：一切模型调用失败先 5 次×10s 重试再链内降级（fast：V4 Flash→Opus 4.6→GPT-5.5 non-thinking；reason：GPT-5.5→Opus 4.8→V4 Pro；respond：Opus 4.6→V4 Pro→GPT-5.5）；全链耗尽才算管道故障。
- **记忆注入隔离铁律**：群 A / 私聊记忆绝不进群 B。
- **真写纵深**：`MSTD_ENABLE_WRITE=1` 才开写；目标受 `MSTD_TEST_OPEN_IDS` 白名单（`assertTestTarget` fail-closed）。
- **密钥红线**：只进 gitignore 的 `.env`（chmod 600）。
- **SQL Postgres 可移植**：显式主键、无 AUTOINCREMENT、epoch BIGINT、JSON 存 TEXT、双方言 `ON CONFLICT`。FTS5 为唯一例外（检索封装进独立模块，PG 时换 pg_trgm）。
- **测试**：纯逻辑单测用 mock 注入（`runLark`/`spawnFn`/`startPi`/模型 client）；**经用户授权（已默认授权，可收回）单测/集成/E2E 均可直调 test organization 真飞书**；web 真机验证用 Claude-in-Chrome 不用 Playwright。
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

## Phase B · 三模型层

### Task B1: 统一模型调用器（重试 + 三条降级链）

**Files:**
- Create: `mstd-orchestrator/server/models/caller.mjs`
- Test: `mstd-orchestrator/test/model-caller.test.mjs`

**Interfaces:**
- Produces: `createModelCaller({ fetchFn, env, sleepFn, retries = 5, retryDelayMs = 10_000 })` → `call(chain, { system, messages, thinking? }) -> { text, model, usage }`；`chain ∈ {"fast","reason","respond"}`。链定义（用户定案）：fast = V4 Flash→Opus 4.6→GPT-5.5（强制 non-thinking）；reason = GPT-5.5→Opus 4.8→V4 Pro；respond = Opus 4.6→V4 Pro→GPT-5.5。B3/B5/E/dreaming 全部经此调用。

- [ ] **Step 1: 写失败测试**——注入 fake fetchFn：①首模型前 5 次 500、第 6 次不再重试而是降级到第二模型（断言 sleepFn 被调 5 次×10s）；②第二模型成功则返回其 text 且 `model` 字段正确；③三个模型全挂（各 5 次重试后）抛 `PipelineError`；④fast 链请求体断言 thinking 关闭。
- [ ] **Step 2: 跑测试确认失败** Run: `cd mstd-orchestrator && npx vitest run test/model-caller.test.mjs` Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现**——链表配置（模型名→provider endpoint/key env/请求体构造器）；每级 for 循环 retries 次、失败 `await sleepFn(retryDelayMs)`；级间降级打日志 `[model-fallback] chain=... from=... to=...`；全链耗尽 throw PipelineError（带各级最后错误）。
- [ ] **Step 4: 跑测试通过 + 全量回归** Run: `cd mstd-orchestrator && npx vitest run` Expected: 全绿
- [ ] **Step 5: Commit** `git commit -m "feat(mstd): 统一模型调用器（5次×10s重试 + fast/reason/respond 三条降级链）"`

### Task B2: token 预算器

**Files:**
- Create: `mstd-orchestrator/server/models/budget.mjs`；Modify: `server/config.mjs`（`MSTD_DAILY_TOKEN_BUDGET`、`MSTD_SESSION_TOKEN_BUDGET`）
- Test: `mstd-orchestrator/test/model-budget.test.mjs`

**Interfaces:**
- Produces: `createBudget(db, { dailyLimit, sessionLimit })` → `{ record(sessionKey, usage), allow(sessionKey) -> {ok} | {ok:false, scope:"session"|"daily"} }`；超限时 caller 拒调并触发告警回调（挂现有 `makeDmAlert`）。

- [ ] **Step 1: 写失败测试**——记账后 `allow` 在会话/当日两个维度分别封顶；跨天自动清零（注入 now）。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/model-budget.test.mjs`
- [ ] **Step 3: 实现**——`token_usage` 表（迁移并入本任务：`004_models.sql`，含 usage 与 cron/journal 所需列见 E2）；epoch 日切。
- [ ] **Step 4: 全量回归** Run: `cd mstd-orchestrator && npx vitest run`
- [ ] **Step 5: Commit** `feat(mstd): token 预算器（会话/日双维度封顶+告警）`

### Task B3: 前台分诊（V4 四选一）

**Files:**
- Create: `mstd-orchestrator/server/models/triage.mjs`
- Test: `mstd-orchestrator/test/triage.test.mjs`

**Interfaces:**
- Consumes: B1 `call("fast",…)`、A3 transcript、C4 注入（未就绪前注入器参数可传 null）。
- Produces: `createTriage({ caller, store })` → `triage({ session, items, mode }) -> { action: "quick_reply", text } | { action: "no_reply" } | { action: "escalate", brief } | { action: "steer", note }`。提示词强制 JSON 输出四选一；quick_reply 边界（回执/澄清/一句话事实）写死在系统提示词；输出超长或含写意图 → daemon 侧强制改判 escalate（代码兜底，不信提示词）。

- [ ] **Step 1: 写失败测试**——mock caller 返回四种 JSON 分别断言解析；返回非法 JSON → 默认 escalate（不猜）；quick_reply 文本 >200 字或命中写意图关键词 → 强制 escalate。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/triage.test.mjs`
- [ ] **Step 3: 实现**——拼 prompt（SOUL + 记忆快照 + 近 N 条 transcript + 合批消息 + mode 标记 ambient/addressed）；JSON parse + 兜底改判逻辑。
- [ ] **Step 4: 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): V4 前台分诊（四选一 + 代码兜底强制升级）`

### Task B4: 中枢会话进程管理（5.5 Pi 常驻 + 空闲回收 + steer）

**Files:**
- Create: `mstd-orchestrator/server/models/brain.mjs`；Modify: `pi-ext/providers.ts`（reason 链 provider 可切换）
- Test: `mstd-orchestrator/test/brain.test.mjs`

**Interfaces:**
- Consumes: `supervisor/pi-client.mjs` 现有 `startPi`/RPC 协议、A3 transcript、现有信号量。
- Produces: `createBrain({ startPi, store, semaphore, caller, idleMs = 600_000 })` → `{ turn({ session, sessionKey, brief, context }) -> Promise<TurnResult>, steer(sessionKey, note), shutdown() }`。每活跃会话一个 Pi 进程；新回合先重放 transcript；空闲 10min 回收；**Pi spawn 失败按 reason 链降级 provider 重拉**（5 次×10s 同规则）；`TurnResult = { events[], replyCalls[], intents[] }`（replyCalls/intents 由 B5/D3 消费）。

- [ ] **Step 1: 写失败测试**——mock startPi：①同会话两回合复用同进程；②空闲计时器到点 kill；③steer 在回合中注入 prompt；④spawn 连败 5 次后以降级 provider 重试（断言第二 provider 被用）。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/brain.test.mjs`
- [ ] **Step 3: 实现**——进程池 Map(sessionKey→{pi, idleTimer})；回合 = prompt 组装（brief + 上下文 + 记忆快照槽位）→ RPC prompt → 收集事件至 `agent_end(!willRetry)`；工具事件透传（供 SSE/调试台）。
- [ ] **Step 4: 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): 中枢 5.5 会话进程管理（常驻/回收/steer/provider 降级）`

### Task B5: reply 工具（Opus 出口）+ 出站发送器

**Files:**
- Create: `pi-ext/reply.ts`、`mstd-orchestrator/server/models/reply.mjs`、`mstd-orchestrator/server/gateway/outbound.mjs`
- Test: `mstd-orchestrator/test/reply.test.mjs`、`test/outbound.test.mjs`

**Interfaces:**
- Consumes: B1 `call("respond",…)`、现有 `runLark` argv 白名单模式。
- Produces: ① pi-ext `reply({ kind: "message"|"card_copy", brief, tone? })` 工具（5.5 可多次调用）；② `renderReply({ caller, soul, context, brief }) -> text`；③ `createOutbound({ runLark })` → `{ sendMessage({ chatId, text, idempotencyKey }) -> { messageId }, editMessage({ messageId, text }) }`。**结构性强制在 brain：assistant 裸文本永不进 outbound，只有 reply 工具结果可出站。**

- [ ] **Step 1: 写失败测试**——renderReply 用 respond 链且注入 SOUL；outbound 构造 lark-cli argv 白名单断言（含 `--idempotency-key`）；brain 的 assistant 文本直发被拒（单测断言 outbound 未被裸文本调用）。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/reply.test.mjs test/outbound.test.mjs`
- [ ] **Step 3: 实现**——reply 工具实现为薄壳（回传 daemon 渲染+发送，结果回给 5.5）；outbound 只认具名参数拼 argv。
- [ ] **Step 4: 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): reply 工具（Opus 出口）+ 出站发送器（唯一出站通道）`

### Task B6: 回合执行器装配（triage→brain→reply 全链）

**Files:**
- Create: `mstd-orchestrator/server/gateway/turn-handler.mjs`；Modify: `server/index.mjs`（wireGateway 的 handleTurn 换真实现）
- Test: `mstd-orchestrator/test/turn-handler.test.mjs`

**Interfaces:**
- Consumes: A8 `wireGateway` 接缝、B3/B4/B5、A3 store（append 双方消息）、B2 budget。
- Produces: `createTurnHandler({ triage, brain, renderReply, outbound, store, budget })` → `handleTurn({ kind, session, sessionKey, items, mode })`——quick_reply 直出站；no_reply 落 observed；escalate 走 brain（回合事件写 job_events 供 SSE）；budget 超限直接礼貌拒绝。

- [ ] **Step 1: 写失败测试**——四选一各分支的落库/出站断言；escalate 分支 brain.turn 被调且 reply 结果出站；budget 拒绝分支。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/turn-handler.test.mjs`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): 回合执行器（triage→brain→reply 全链装配）`

### Task B7: Phase B E2E（test org 真机私聊闭环）

**Files:**
- Create: `mstd-orchestrator/test/e2e-p2p.test.mjs`（标记 `describe.skipIf(!process.env.MSTD_E2E)`）

- [ ] **Step 1: 写 E2E 用例**——起完整 daemon（真 lark-cli + 真三模型），向 test org bot 私聊发"你好，介绍一下你自己"，轮询断言 60s 内收到回复消息；再发"帮我算 1+1"断言 quick_reply 路径（日志含 triage=quick_reply）。
- [ ] **Step 2: 跑通** Run: `cd mstd-orchestrator && MSTD_E2E=1 npx vitest run test/e2e-p2p.test.mjs` Expected: PASS
- [ ] **Step 3: Commit** `test(mstd): Phase B E2E——test org 私聊问答闭环`

**Phase B 完成标志**：test org 里私聊 bot 能收到回答（快问快答走 V4 直出、复杂问题走 5.5→Opus）；`npx vitest run` 全绿。

---

## Phase C · 记忆系统

### Task C1: 记忆文件层（五层读写 + 字符上限 + 漂移检测）

**Files:**
- Create: `mstd-orchestrator/server/memory/files.mjs`
- Test: `mstd-orchestrator/test/memory-files.test.mjs`

**Interfaces:**
- Produces: `createMemoryFiles({ rootDir })` → `{ readLayer(layer, id?) -> { content, snapshotHash }, writeLayer(layer, id, content, { expectedHash }) , appendJournal(entryText, now?) }`；`layer ∈ {soul, org, journal, group, user}`；写入时 `expectedHash` 与磁盘不符 → 抛 DriftError 并落 `.bak.<ts>` 备份；org/group/user 有字符上限（org 4000 / group 2200 / user 1375），超限抛 LimitError。

- [ ] **Step 1: 写失败测试**——五层路径正确性；漂移检测（外部改文件后带旧 hash 写入被拒且生成 .bak）；上限拒写；journal 按日期文件追加。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/memory-files.test.mjs`
- [ ] **Step 3: 实现**——路径映射（`SOUL.md` / `memory/ORG.md` / `memory/journal/YYYY-MM-DD.md` / `memory/groups/<id>.md` / `memory/users/<id>.md`）；hash = sha256(content)。
- [ ] **Step 4: 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): 记忆文件层（五层/上限/漂移检测/journal 追加）`

### Task C2: 注入扫描（威胁模式规则，内嵌不依赖外部二进制）

**Files:**
- Create: `mstd-orchestrator/server/memory/scan.mjs`
- Test: `mstd-orchestrator/test/memory-scan.test.mjs`

**Interfaces:**
- Produces: `scanForInjection(text) -> { ok } | { ok:false, pattern }`——规则集：提示词覆写句式（"忽略以上指令"类中英变体）、外传诱导（url+密钥语义）、工具指令伪装。记忆写入（C3）与 cron prompt 组装（E3）前置调用。

- [ ] **Step 1-5**：标准 TDD 五步（正例/反例各≥5 条中文用例；实现为正则+关键词组合规则表，可配置追加）。Run: `npx vitest run test/memory-scan.test.mjs`；Commit `feat(mstd): 记忆/prompt 注入扫描规则集`。

### Task C3: memory 工具（挂 pi-ext）

**Files:**
- Create: `pi-ext/memory.ts`、`mstd-orchestrator/server/memory/tool.mjs`
- Test: `mstd-orchestrator/test/memory-tool.test.mjs`

**Interfaces:**
- Consumes: C1 files、C2 scan、B4 brain（工具注册）。
- Produces: 5.5 可调 `memory({ action: add|replace|remove|read, layer, id?, entry?, old_text? })`；条目自动追加 `〔来源:<sessionKey> 时间:<ISO>〕`后缀；`§` 分隔；add 前过 scan；写入即落盘（冻结快照不变，下会话生效）。

- [ ] **Step 1: 写失败测试**——add 带来源时间戳后缀；replace 按 old_text 子串匹配唯一命中才改（多命中/零命中报错）；含注入模式的 entry 被拒；层级越权（群会话写 user 层）被拒。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/memory-tool.test.mjs`
- [ ] **Step 3-4: 实现 + 全量回归**
- [ ] **Step 5: Commit** `feat(mstd): memory 工具（add/replace/remove/read + 来源时间戳 + 扫描）`

### Task C4: 注入器（冻结快照 + 隔离铁律）

**Files:**
- Create: `mstd-orchestrator/server/memory/inject.mjs`；Modify: `server/models/triage.mjs`、`server/models/brain.mjs`（记忆槽位接入）
- Test: `mstd-orchestrator/test/memory-inject.test.mjs`

**Interfaces:**
- Produces: `buildMemorySnapshot({ files, sessionKey }) -> { soul, org, journalDigest, scoped }`——群会话 scoped=本群文件；私聊 scoped=本人文件；**测试铁律：群 A 快照绝不含群 B/任何 user 层内容，反之亦然**；快照在回合开始冻结（对象不可变）。

- [ ] **Step 1: 写失败测试**——隔离铁律矩阵（p2p/groupA/groupB 三方交叉断言）；journalDigest 只含当日；快照 Object.freeze。
- [ ] **Step 2: 确认失败** Run: `npx vitest run test/memory-inject.test.mjs`
- [ ] **Step 3-4: 实现 + 全量回归**（triage/brain 的 prompt 组装改为消费快照）
- [ ] **Step 5: Commit** `feat(mstd): 记忆注入器（冻结快照 + 跨层隔离铁律）`

### Task C5: session_search 工具（FTS 检索）

**Files:**
- Create: `mstd-orchestrator/server/sessions/search.mjs`、`pi-ext/session-search.ts`
- Test: `mstd-orchestrator/test/session-search.test.mjs`

**Interfaces:**
- Consumes: A1 FTS 表。
- Produces: 5.5 可调 `session_search({ query, session_id?, limit? }) -> {hits: [{sessionKey, content, ts}]}`；**权限过滤**：群会话内只可搜本群 + journal 已脱敏条目，私聊只可搜本人+ORG（隔离铁律延伸到检索面）。

- [ ] **Step 1-5**：TDD 五步（中文 trigram 命中；跨会话越权检索被过滤）。Run: `npx vitest run test/session-search.test.mjs`；Commit `feat(mstd): session_search 跨会话检索（FTS + 权限过滤）`。

### Task C6: 上下文压缩 + memory flush + nudge

**Files:**
- Create: `mstd-orchestrator/server/memory/compact.mjs`；Modify: `server/models/brain.mjs`
- Test: `mstd-orchestrator/test/memory-compact.test.mjs`

**Interfaces:**
- Produces: `shouldCompact(transcriptTokens, threshold)`；压缩流程 = 先注入"把重要信息写入 memory"的 flush 回合 → 早期回合摘要化（reason 链）保留近 20 条原文 → transcript 标记压缩点；nudge = 每 10 用户轮注入整理提醒（计数从 transcript 重算，防进程重启丢状态）。

- [ ] **Step 1-5**：TDD 五步（阈值触发；flush 先于摘要；近 20 条不动；nudge 计数重启后正确重算）。Run: `npx vitest run test/memory-compact.test.mjs`；Commit `feat(mstd): 上下文压缩（flush 先行）+ 记忆 nudge`。

### Task C7: journal 记录器（公司总账装配）

**Files:**
- Create: `mstd-orchestrator/server/memory/journal.mjs`；Modify: `server/gateway/turn-handler.mjs`
- Test: `mstd-orchestrator/test/journal.test.mjs`

**Interfaces:**
- Produces: 每个非 observed 回合结束追加一条 journal（`- HH:mm [群名/私聊·发起人] 一句话要点`）；要点由 fast 链生成并**脱敏**（私聊只记要点不记原文，人名保留 open_id 映射）；失败不阻塞主回合（fire-and-forget + 日志）。

- [ ] **Step 1-5**：TDD 五步（群/私聊两种条目格式；fast 链失败不影响回合返回；脱敏断言——原文敏感词不出现在 journal）。Run: `npx vitest run test/journal.test.mjs`；Commit `feat(mstd): 公司总日志记录器（每回合追加+脱敏）`。

**Phase C 完成标志**：test org 私聊里说"记住我喜欢周报用表格"，重开会话后 agent 能引用该偏好；`memory/journal/` 出现当日总账；`npx vitest run` 全绿。

---

## Phase D · 写路径与卡片确认

### Task D1: action DSL 扩类（create_event / send_group_msg）

**Files:**
- Modify: `mstd-orchestrator/server/safety/action-dsl.mjs`、`server/safety/write-args.mjs`
- Test: 追加 `test/action-dsl.test.mjs`、`test/write-args.test.mjs`

**Interfaces:**
- Produces: 新 action kind `create_event { summary, start_time, end_time, attendee_open_ids[] }`、`send_group_msg { chat_id, card_ref }`；各配 fail-closed argv 构造器（open_id 正则、时间 ISO 校验、chat_id `^oc_` 校验）；canonical/hash 逻辑复用不改。

- [ ] **Step 1-5**：TDD 五步（每类正例 argv 断言含 `--idempotency-key`；非法字段 fail-closed 抛错；同意图同 hash/改一字变 hash 回归）。Run: `npx vitest run test/action-dsl.test.mjs test/write-args.test.mjs`；Commit `feat(mstd): action DSL 扩类 create_event/send_group_msg（fail-closed argv）`。

### Task D2: 卡片模板构建器（Card JSON 2.0 固定模板）

**Files:**
- Create: `mstd-orchestrator/server/cards/templates.mjs`
- Test: `mstd-orchestrator/test/card-templates.test.mjs`

**Interfaces:**
- Produces: `buildConfirmCard({ title, previewMd, actions[], formFields[], tokenRef }) -> cardJson`（schema 2.0 + update_multi:true + form 容器 + person_select + 确认/取消按钮，按钮 value 只含 `{action_id, token_ref}`）；`buildStatusCard({ state: executing|done|partial_failed|expired, resultsMd })`。**模板固定性测试：模型输入（previewMd 等文案槽位）无论内容是什么都改变不了卡片结构键集合。**

- [ ] **Step 1-5**：TDD 五步（结构键集合快照断言；文案槽位注入 `"}]` 恶意串结构不变；person_select 的 name 规范 `Person_assignee_<action_key>`）。Run: `npx vitest run test/card-templates.test.mjs`；Commit `feat(mstd): 确认卡/状态卡固定模板构建器`。

### Task D3: 发卡流程（意图→canonical→token→Opus 文案→发卡）

**Files:**
- Create: `mstd-orchestrator/server/cards/confirm-flow.mjs`；Modify: `pi-ext/lark-execute.ts`（5.5 的 `propose_actions` 工具入口）
- Test: `mstd-orchestrator/test/confirm-flow.test.mjs`

**Interfaces:**
- Consumes: 现有 `intent-schema`/`action-dsl`/`approval.mjs`（token 签发）、B5 renderReply(card_copy)、B5 outbound、D2 模板。
- Produces: `startConfirmFlow({ session, intents, initiatorOpenId }) -> { messageId, actionIds[] }`——意图 schema 校验→canonical+hash 落 `job_actions`→签发 approval token（绑定 initiator+TTL30min）→Opus 渲染文案→发卡并把 messageId 关联落库。schema 不过 → needs_attention 走 reply 告知，不猜。

- [ ] **Step 1-5**：TDD 五步（全 mock 断言链路顺序与落库形状；schema 不过分支；低置信 open_id 缺失 → 卡片含 person_select 必填项）。Run: `npx vitest run test/confirm-flow.test.mjs`；Commit `feat(mstd): 写意图发卡流程（canonical+token+Opus 文案）`。

### Task D4: 卡片回调消费（校验 + 立即翻"执行中"）

**Files:**
- Modify: `mstd-orchestrator/server/cards/confirm-flow.mjs`（`handleCardAction`）、`server/gateway/turn-handler.mjs`（kind=card_action 路由）
- Test: `mstd-orchestrator/test/card-callback.test.mjs`

**Interfaces:**
- Produces: `handleCardAction(evt) -> { responseCard }`——校验链：operator=initiator（否则返回 toast 卡"仅发起人可操作"）→ token 未过期未消费 → form_value 重规范化+重算 hash（人员选择器补齐 open_id）→ 消费 token → **立即返回"⏳ 执行中"状态卡（按钮移除）** → 异步触发 D5 执行。重复点击/过期分别有专属 toast。

- [ ] **Step 1-5**：TDD 五步（六个分支：正常/非发起人/过期/重复/form 补齐重 hash/取消）。Run: `npx vitest run test/card-callback.test.mjs`；Commit `feat(mstd): 卡片回调消费（operator/token/hash 三重校验+防重复点击）`。

### Task D5: 异步执行 + 终态卡更新

**Files:**
- Modify: `mstd-orchestrator/server/cards/confirm-flow.mjs`、`server/gateway/outbound.mjs`（`updateCard({messageId, cardJson})`）
- Test: `mstd-orchestrator/test/card-execute.test.mjs`

**Interfaces:**
- Consumes: 现有 `executeApprovedAction`（一行不改）、D2 buildStatusCard。
- Produces: 逐条执行已批 action → 结果落 `job_actions` → `message_id` 更新终态卡（done/partial_failed，失败条目带重试按钮 value）→ 结果摘要回注会话（A7 actor 入队，5.5 上下文能接上）。重试按钮回调只重试失败条目且重试前对账。

- [ ] **Step 1-5**：TDD 五步（全成功/部分失败/重试路径；executeApprovedAction 用现有测试替身；回注消息落 transcript 断言）。Run: `npx vitest run test/card-execute.test.mjs`；Commit `feat(mstd): 卡片异步执行+终态更新+结果回注会话`。

### Task D6: 后台 job 委托（复用 orch_jobs + 版本化）

**Files:**
- Create: `mstd-orchestrator/server/jobs/background.mjs`；Modify: `server/jobs/orchestrator.mjs`（两段式改造为被调用的执行器）、`pi-ext`（5.5 的 `spawn_background_job` 工具）
- Test: `mstd-orchestrator/test/background-job.test.mjs`

**Interfaces:**
- Produces: `spawnBackgroundJob({ sessionKey, sessionVersion, kind, params }) -> jobId`（复用 orch_jobs 表+信号量+事件缓冲）；5.5 调用后回合立即可结束（会话解锁）；job 状态机沿用现有 queued/running/done/failed。

- [ ] **Step 1-5**：TDD 五步（job 落库带 sessionVersion；会话不被阻塞——job running 时同会话可跑新回合；信号量限流沿用）。Run: `npx vitest run test/background-job.test.mjs`；Commit `feat(mstd): 后台 job 委托（orch_jobs 复用+会话版本快照）`。

### Task D7: 完成回注（版本判定播报/归档 + 进度心跳）

**Files:**
- Create: `mstd-orchestrator/server/jobs/reinjector.mjs`
- Test: `mstd-orchestrator/test/reinject.test.mjs`

**Interfaces:**
- Produces: job 完成事件 → actor 入队回注回合：`当前 session.version - 发起时 version <= 阈值(默认3)` → 正常播报（5.5+reply）；超过 → prompt 标注"话题可能已翻篇，简短播报或静默"由 5.5 决定；>3min 的 running job 每 3min `editMessage` 更新进度（同一条消息不刷屏）。

- [ ] **Step 1-5**：TDD 五步（新鲜/过时两分支 prompt 断言；进度编辑用 fake timer 断言只 edit 不 send）。Run: `npx vitest run test/reinject.test.mjs`；Commit `feat(mstd): 后台 job 回注（版本判定+进度心跳编辑）`。

### Task D8: Phase D E2E（test org 真写闭环）

**Files:**
- Create: `mstd-orchestrator/test/e2e-write.test.mjs`（`MSTD_E2E=1` 门控）

- [ ] **Step 1: 写 E2E**——私聊"给测试账号建个任务：明天交周报"→ 断言收到确认卡 → 程序化触发确认回调 → 断言 lark 真建任务成功（task list 查询验证）→ 卡片终态 done → 会话里追问"刚才建的任务改到后天"能接上下文再发卡。
- [ ] **Step 2: 跑通** Run: `MSTD_E2E=1 MSTD_ENABLE_WRITE=1 npx vitest run test/e2e-write.test.mjs` Expected: PASS（目标在 MSTD_TEST_OPEN_IDS 白名单内）
- [ ] **Step 3: Commit** `test(mstd): Phase D E2E——卡片确认真写闭环`

**Phase D 完成标志**：test org 里对话触发建任务→卡片预览（可改负责人）→确认→真建成功→卡片翻终态→对话可追问引用；基线+新用例全绿。

---

## Phase E · 主动层

### Task E1: 单 ticker（分频调度骨架）

**Files:**
- Create: `mstd-orchestrator/server/ticker/ticker.mjs`；Modify: `server/index.mjs`（boot 挂载）
- Test: `mstd-orchestrator/test/ticker.test.mjs`

**Interfaces:**
- Produces: `createTicker({ intervalMs = 60_000, setIntervalFn })` → `{ register(name, everyNTicks, fn), start(), stop() }`；任务抛错被捕获记日志不断 ticker；同 tick 内任务串行。

- [ ] **Step 1-5**：TDD 五步（fake timer：分频正确、抛错不影响后续 tick、stop 幂等）。Run: `npx vitest run test/ticker.test.mjs`；Commit `feat(mstd): 单 ticker 分频调度骨架`。

### Task E2: cron 任务表 + schedule 解析

**Files:**
- Create: `mstd-orchestrator/server/ticker/cron-jobs.mjs`、`server/db/migrations/004_models.sql` 内含 `cron_jobs` 表（若 B2 已建 004 则本任务建 `005_cron.sql`）
- Test: `mstd-orchestrator/test/cron-jobs.test.mjs`

**Interfaces:**
- Produces: `cron_jobs` 表（id、schedule、prompt、deliver_to sessionKey、enabled、last_run_at）；`parseSchedule("30m"|"every 2h"|"0 9 * * *"|ISO一次性) -> nextRunAt(now)`；`duePicker(db, now) -> jobs[]`（挑到期且防重复触发）。

- [ ] **Step 1-5**：TDD 五步（四种 schedule 语法的 nextRun 计算；边界：跨天 cron 表达式、一次性任务跑完自动 disabled）。Run: `npx vitest run test/cron-jobs.test.mjs`；Commit `feat(mstd): cron 任务表+schedule 解析`。

### Task E3: cron 执行器（新鲜会话 + 确认卡纪律）

**Files:**
- Create: `mstd-orchestrator/server/ticker/cron-runner.mjs`
- Test: `mstd-orchestrator/test/cron-runner.test.mjs`

**Interfaces:**
- Consumes: B4 brain、B5 reply/outbound、C4 注入、C2 scan（prompt 组装后扫描）、D3 发卡。
- Produces: 到期 job → 起 `cron:<jobId>` 新鲜会话（无历史，注入 SOUL+ORG+journal）→ brain 回合 → 结果 reply 投递到 deliver_to；**cron 回合的写意图一律走 D3 发卡给 job owner，工具集里禁掉直接执行路径**；组装 prompt 过注入扫描后才执行。

- [ ] **Step 1-5**：TDD 五步（新鲜会话断言无历史；写意图强制发卡断言；注入扫描拦截污染 prompt）。Run: `npx vitest run test/cron-runner.test.mjs`；Commit `feat(mstd): cron 执行器（新鲜会话+写必发卡+prompt 扫描）`。

### Task E4: HEARTBEAT（清单文件 + 心跳回合）

**Files:**
- Create: `mstd-orchestrator/server/ticker/heartbeat.mjs`；`pi-ext` 加 `heartbeat_update` 工具（5.5 增删清单项）
- Test: `mstd-orchestrator/test/heartbeat.test.mjs`

**Interfaces:**
- Produces: `HEARTBEAT.md`（`- [ ] <ISO到期> <事项> <deliver_to>` 行格式）；心跳 tick（30min 分频、activeHours 09:00-21:00）→ V4 扫描（fast 链）判断到期项 → 无事返回 `HEARTBEAT_OK` 被吞 → 有到期项灌 brain 执行并勾选完成；5.5 对话中可用工具往清单加项（"明天提醒我X"场景）。

- [ ] **Step 1-5**：TDD 五步（activeHours 外不跑；HEARTBEAT_OK 静默；到期项触发 brain 且完成后勾选；工具加项格式）。Run: `npx vitest run test/heartbeat.test.mjs`；Commit `feat(mstd): HEARTBEAT 清单+心跳回合（V4 扫描→5.5 执行）`。

### Task E5: dreaming 夜间蒸馏（影子模式起步）

**Files:**
- Create: `mstd-orchestrator/server/ticker/dreaming.mjs`
- Test: `mstd-orchestrator/test/dreaming.test.mjs`

**Interfaces:**
- Consumes: A3 transcript、C1 files、B1 caller（V4 提取/5.5 合并）。
- Produces: 03:30 分频触发：①按层切片当天+前日 overlap 会话 → ②V4 per-chunk 结构化提取（content/source/ts/confidence/evidence/tags，低置信跳过）→ ③5.5 跨块合并/冲突裁决 → ④**append-only 写入**（重复跳过；矛盾追加新条+旧条标 `〔invalidated:<ts>〕`）→ ⑤产出 `memory/dreams/YYYY-MM-DD.md` 报告 → ⑥事件类>30天条目归档。**`MSTD_DREAMING_MODE=shadow|apply`（默认 shadow：只出报告不写记忆层）**；蒸馏前 `git -C memory commit` 自动备份（memory/ 目录独立 git 仓）。

- [ ] **Step 1-5**：TDD 五步（mock 双模型：提取→合并→append-only 各不变式；shadow 模式不碰记忆层文件；矛盾条目 invalidated 标记；备份 commit 被调）。Run: `npx vitest run test/dreaming.test.mjs`；Commit `feat(mstd): dreaming 夜间蒸馏（两阶段/append-only/影子模式/git 备份）`。

### Task E6: 巡检与会话过期挂载

**Files:**
- Modify: `mstd-orchestrator/server/index.mjs`（health/lark-profile 从独立 interval 改挂 ticker）；Create: `server/ticker/session-expiry.mjs`
- Test: `mstd-orchestrator/test/session-expiry.test.mjs`

**Interfaces:**
- Produces: 过期检查（24h idle 或每日 04:00）→ 过期会话先触发 memory flush 回合再 archived；活跃后台 job 的会话豁免；lark profile 巡检沿用现有边沿告警逻辑，只换调度载体。

- [ ] **Step 1-5**：TDD 五步（idle/daily 两种过期；flush 先于 archive；豁免逻辑）。Run: `npx vitest run test/session-expiry.test.mjs`；Commit `feat(mstd): 会话过期重置（flush 先行）+ 巡检挂 ticker`。

### Task E7: 妙记闭环迁移（web 审批 → 卡片确认）

**Files:**
- Modify: `mstd-orchestrator/server/triggers/minutes-consumer.mjs`（建 job 后走新链路）、`server/jobs/orchestrator.mjs`
- Test: `mstd-orchestrator/test/minutes-migration.test.mjs`

**Interfaces:**
- Produces: 妙记事件 → 后台 job（D6）跑第①段只读抽取（现有 lark_read+意图 schema 原样）→ 产出意图直接走 D3 发卡给会议主持人私聊 → 确认后 D5 执行。原 `awaiting_approval` web 状态不再产生。

- [ ] **Step 1-5**：TDD 五步（fixture 事件→job→发卡链路断言；卡片收件人=主持人 open_id）。Run: `npx vitest run test/minutes-migration.test.mjs`；Commit `feat(mstd): 会议纪要闭环迁移至卡片确认`。

**Phase E 完成标志**：test org 建一条"每天 18:00 往测试群发今日 journal 摘要"的 cron 真跑成功；私聊"10 分钟后提醒我喝水"经 HEARTBEAT 真提醒；dreaming 影子报告生成；妙记→卡片→建任务全链真跑。

---

## Phase F · 群聊能力

### Task F1: 群@ 回合（pending observed 窗口注入）

**Files:**
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`、`server/sessions/store.mjs`（`recentObserved(sessionId, limit=50)`）
- Test: `mstd-orchestrator/test/group-mention.test.mjs`

**Interfaces:**
- Produces: addressed 群回合的 prompt 前置 `[自你上次发言以来的群消息-仅供上下文]` 块（近 50 条 observed，带发言人署名）；注入后这些消息标记已消费（不重复注入）。

- [ ] **Step 1-5**：TDD 五步（observed 累积→@ 时注入→再 @ 不重复注入；50 条截断）。Run: `npx vitest run test/group-mention.test.mjs`；Commit `feat(mstd): 群@ 回合 pending 窗口注入`。

### Task F2: 旁听限额器（防刷屏硬限制）

**Files:**
- Create: `mstd-orchestrator/server/gateway/rate-limit.mjs`
- Test: `mstd-orchestrator/test/rate-limit.test.mjs`

**Interfaces:**
- Produces: `createProactiveLimiter(db)` → `{ allow(chatId, now) -> boolean, record(chatId, now) }`——每群每小时 ≤ `group_policies.hourly_proactive_limit`（默认 4）+ 连续主动消息 ≤2（有人类消息间隔后重置）；持久化计数（重启不清零）。

- [ ] **Step 1-5**：TDD 五步（小时窗滑动；连续上限；重启恢复）。Run: `npx vitest run test/rate-limit.test.mjs`；Commit `feat(mstd): 群主动发言限额器`。

### Task F3: ambient 门控接线（V4 should_reply + NO_REPLY）

**Files:**
- Modify: `mstd-orchestrator/server/gateway/turn-handler.mjs`、`server/models/triage.mjs`（ambient 模式提示词分支）
- Test: `mstd-orchestrator/test/ambient-gate.test.mjs`

**Interfaces:**
- Produces: ambient 消息批 → 限额预检（F2 不过直接 observed 落库）→ V4 triage（ambient 提示词：更高沉默倾向，"只在能提供明确价值时开口"）→ no_reply 落 observed；quick_reply/escalate 出站前再过 F2.record。三层门控完整成链：规则(admit+限额)→V4→5.5。

- [ ] **Step 1-5**：TDD 五步（限额短路不调模型——成本断言 caller 未被调；NO_REPLY 落 observed；放行路径记账）。Run: `npx vitest run test/ambient-gate.test.mjs`；Commit `feat(mstd): 旁听三层门控接线`。

### Task F4: admit 判定落库（可观测）

**Files:**
- Modify: `mstd-orchestrator/server/gateway/inbox.mjs`（`inbox_events` 加 `verdict` 列，迁移 `006_verdict.sql`）、`server/index.mjs`（wireGateway 记录判定）
- Test: `mstd-orchestrator/test/admit-log.test.mjs`

**Interfaces:**
- Produces: 每条消息事件的 admit 结果（含拒绝原因/门控层级/耗时）落库；G2 会话浏览器消费。

- [ ] **Step 1-5**：TDD 五步（各 reason 落库形状）。Run: `npx vitest run test/admit-log.test.mjs`；Commit `feat(mstd): admit 判定落库（调试可观测）`。

### Task F5: 观察期模式（observe_only 群策略）

**Files:**
- Modify: `mstd-orchestrator/server/gateway/admit.mjs`（policy 加 `observe_only`）、`server/ticker/`（周报统计任务）
- Test: `mstd-orchestrator/test/observe-only.test.mjs`

**Interfaces:**
- Produces: `observe_only` 策略 = 全链门控照跑（V4 判定也跑、结果落库）但**一律不出站**；ticker 周任务汇总"本群若开旁听会说什么/信号噪声比"报告 DM 管理员——上线新群先跑两周观察期的运营抓手。

- [ ] **Step 1-5**：TDD 五步（判定跑了但 outbound 零调用；统计报告形状）。Run: `npx vitest run test/observe-only.test.mjs`；Commit `feat(mstd): 群旁听观察期模式`。

### Task F6: Phase F E2E（test org 群聊真机）

**Files:**
- Create: `mstd-orchestrator/test/e2e-group.test.mjs`（`MSTD_E2E=1` 门控）

- [ ] **Step 1: 写 E2E**——test org 建测试群拉 bot：①群里闲聊两条不 @ → 断言 bot 沉默且 observed 落库；②@bot 提问 → 回复且引用了前两条上下文；③把群策略切 ambient，发一条明确求助 → bot 主动接话；④连发多条无关闲聊 → 限额与 NO_REPLY 生效（bot 不刷屏）。
- [ ] **Step 2: 跑通** Run: `MSTD_E2E=1 npx vitest run test/e2e-group.test.mjs` Expected: PASS
- [ ] **Step 3: Commit** `test(mstd): Phase F E2E——群@/旁听/限额真机`

**Phase F 完成标志**：test org 群里 @ 能答（带前情上下文）、旁听能在该说话时说话、闲聊时闭嘴、限额兜底；全量测试绿。

---

## Phase G · web 调试台

### Task G1: 管理 API + admin 白名单

**Files:**
- Create: `mstd-orchestrator/server/http/admin-routes.mjs`；Modify: `server/app.mjs`、`server/config.mjs`（`MSTD_ADMIN_OPEN_IDS`）
- Test: `mstd-orchestrator/test/admin-routes.test.mjs`

**Interfaces:**
- Produces: `/api/admin/*` 路由组（现有 OAuth 会话 + open_id ∈ 白名单，否则 403）：`GET sessions`、`GET sessions/:id/messages`（含 verdict）、`GET/PUT memory/:layer/:id?`、`GET/POST cron-jobs`、`GET jobs`、`POST debug-chat`。

- [ ] **Step 1-5**：TDD 五步（403/200 权限矩阵；memory PUT 走漂移检测）。Run: `npx vitest run test/admin-routes.test.mjs`；Commit `feat(mstd): 调试台管理 API+admin 白名单`。

### Task G2: 会话浏览器（列表 + transcript + 判定标注）

**Files:**
- Create: `mstd-ui/src/views/SessionBrowser.tsx`；Modify: `mstd-ui/src/App.tsx`（tab 重组）、`mstd-ui/src/api/admin.ts`
- Test: `mstd-ui/src/test/session-browser.test.tsx`

- [ ] **Step 1-5**：TDD 五步（列表渲染/选中加载 transcript/observed 灰显/每条消息 verdict 徽标——`bot_not_mentioned_observe` 等原因可读化）。Run: `cd mstd-ui && npx vitest run`；Commit `feat(mstd-ui): 会话浏览器（判定标注可视化）`。

### Task G3: 实时时间线接入

**Files:**
- Modify: `mstd-ui/src/views/SessionBrowser.tsx`（活跃会话挂现有 Timeline 组件 + SSE）；`server/jobs/routes.mjs` SSE 端点扩展会话维度
- Test: `mstd-ui/src/test/timeline-live.test.tsx`

- [ ] **Step 1-5**：TDD 五步（SSE 事件驱动 Timeline 渲染，复用现有 job-stream 消费逻辑）。Run: `cd mstd-ui && npx vitest run`；Commit `feat(mstd-ui): 会话实时时间线`。

### Task G4: 任务看板改造（cron + 后台 job + 审计）

**Files:**
- Modify: `mstd-ui/src/views/BoardView.tsx`、`mstd-ui/src/api/admin.ts`
- Test: `mstd-ui/src/test/board-admin.test.tsx`

- [ ] **Step 1-5**：TDD 五步（cron 列表增删启停；后台 job 表沿用现有列；decisions/job_actions 审计查询面板保留）。Run: `cd mstd-ui && npx vitest run`；Commit `feat(mstd-ui): 看板改造（cron+后台 job+审计）`。

### Task G5: 记忆编辑器

**Files:**
- Create: `mstd-ui/src/views/MemoryEditor.tsx`
- Test: `mstd-ui/src/test/memory-editor.test.tsx`

- [ ] **Step 1-5**：TDD 五步（五层树导航/编辑保存带 snapshotHash/漂移冲突提示重载；dreams 报告只读查看）。Run: `cd mstd-ui && npx vitest run`；Commit `feat(mstd-ui): 记忆编辑器（漂移保护）`。

### Task G6: 调试对话 + 真机验收

**Files:**
- Create: `mstd-ui/src/views/DebugChat.tsx`（`debug:` 会话，走 admin API 收发 + SSE 看回合内部）

- [ ] **Step 1: 实现并单测**（消息收发渲染、内部事件展开）。Run: `cd mstd-ui && npx vitest run`
- [ ] **Step 2: Claude-in-Chrome 真机验收**——六面板全走一遍：浏览会话、看实时回合、建 cron、改记忆触发漂移提示、调试对话问答。
- [ ] **Step 3: Commit** `feat(mstd-ui): 调试对话面板 + 调试台真机验收`

**Phase G 完成标志**：Claude-in-Chrome 真机走查六面板通过；`cd mstd-ui && npx vitest run` 全绿。

---

## Phase H · 收尾

### Task H1: 退役与清理

**Files:**
- Delete/Modify: `server/jobs/routes.mjs`（移除 `POST /api/jobs/:id/decision`）、mstd-ui 旧审批队列视图（`ApprovalActionEditor` 保留组件供卡片预览复用判断，视图入口移除）、无引用死代码
- Test: 全量回归 + `grep -r "decision" server/ mstd-ui/src` 人工核对残留

- [ ] **Step 1**: 移除旧端点与视图入口，改动处测试同步删改
- [ ] **Step 2**: Run: `cd mstd-orchestrator && npx vitest run && cd ../mstd-ui && npx vitest run` Expected: 全绿
- [ ] **Step 3: Commit** `chore(mstd): 退役 web 审批端点与视图`

### Task H2: 生产配置收口

**Files:**
- Modify: `.env.example`（新增 env 全清单：三模型 key、budget、admin、dreaming mode、E2E 开关）、`server/config.mjs`（secret fail-fast 沿用）、`mstd-orchestrator/README.md`

- [ ] **Step 1**: env 清单+启动 fail-fast 校验补全；README 重写为常驻 agent 架构说明（部署/开闸步骤/观察期运营手册）
- [ ] **Step 2**: Run: `node server/index.mjs`（缺 env 时 fail-fast 报错清单）Expected: 明确报错
- [ ] **Step 3: Commit** `chore(mstd): 生产配置收口+README 重写`

### Task H3: 全链路 E2E 回归剧本

**Files:**
- Create: `mstd-orchestrator/test/e2e-full.test.mjs`（串联 B7/D8/F6 + cron/heartbeat/dreaming 影子）

- [ ] **Step 1**: 编排全剧本（私聊问答→群@→旁听→卡片写→cron 投递→HEARTBEAT 提醒→dreaming 影子报告），断言各环节产物
- [ ] **Step 2**: Run: `MSTD_E2E=1 MSTD_ENABLE_WRITE=1 npx vitest run test/e2e-full.test.mjs` Expected: PASS
- [ ] **Step 3: Commit** `test(mstd): 全链路 E2E 回归剧本`

### Task H4: 上线开闸文档

**Files:**
- Create: `docs/superpowers/runbooks/agent-rollout.md`

- [ ] **Step 1**: 写运营手册——生产应用发版（`im:message.group_msg` 敏感权限审批）、`MSTD_ENABLE_WRITE`/`MSTD_TEST_OPEN_IDS` 逐步放开步骤、新群接入 SOP（observe_only 两周→看报告→mention_only 或 ambient）、dreaming shadow→apply 切换条件、告警响应
- [ ] **Step 2: Commit** `docs(mstd): 上线开闸运营手册`

**Phase H 完成标志（= 项目完成标志）**：H3 全链路 E2E 通过；两套 vitest 全绿；README/runbook 齐；旧审批面退役无残留。
