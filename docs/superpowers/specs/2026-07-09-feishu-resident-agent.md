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

>（spec 批准后由 writing-plans 展开，追加于此。）
