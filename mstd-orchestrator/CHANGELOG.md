# 更新日志 · mstd-orchestrator

本项目遵循[语义化提交](https://www.conventionalcommits.org/)与 TDD + 双引擎对抗审核纪律。
每条 `feat/fix` 均经 opus 证伪式代码审核 + Codex(GPT-5.6)变异审卷,补杀测试后合入;
详细审核处置见 `../docs/operator-journal.md`,实施偏差见 `../docs/superpowers/plans/2026-07-10-agent-persona-runtime.md` 各任务段。

> **阶段一之后的演进**（Responder–Dispatcher–Reasoner 架构、active/shadow/legacy 三模式、
> model_log 关联 ID、可靠性批次、ambient 收紧等）以 `README.md`、`../project.md` 与
> `../docs/superpowers/specs/` 为准；下方阶段一条目保留作历史基线，**不再代表当前架构心智**。

---

## [阶段二起] 架构转向与可观测 — 2026-07-14 起（摘要）

- **RDR 三角色**：应答机 / 独立调度器 / 任务级推理机；`MSTD_AGENT_ARCHITECTURE_MODE=legacy|shadow|active`。
- **可观测**：`model_log` 扩展 task/run/dispatch/decision/latency；成功调用 `model_call`、推理回合 `brain_turn`、首答发送失败 `responder_send_failed`。
- **可靠性批次与诊断**：见 `../docs/research/2026-07-15-framework-reliability-diagnosis.md` 与相关 specs。
- **产品定案续写**：双回复条件闭环、兜底话术承诺、ambient 受话判断、8192 history / 128k 输入上限等见 `../project.md`。

---

## [阶段一] 人格运行时(Persona Runtime) — 2026-07-10 ~ 2026-07-12

将「会议纪要单一流水线」升级为**常驻公司级飞书全能助手「小达」**:24h 挂在飞书里,
私聊/群聊即时应答,写操作走卡片确认,记忆分五层长期演化。规格 `spec/2026-07-10-agent-persona-prompt-design.md`(状态:已实施),
计划 `plans/2026-07-10-agent-persona-runtime.md`(C0-C6,13 任务,步骤级 TDD)。

**里程碑**:13 个任务全部收官。单测基线 452 → **719 passed**(strict 只增不减) + UI 51;
五套真机 E2E(persona/write/p2p/group/full)全 PASS(Vitest JSON 门禁);四幕真机验收剧本通过。

分支 `feat/resident-agent`,未合 main、未 push(遵守红线)。

### 新增(Added)

- **C1 中枢人格运行时**(Task 8,`9e9b65e`):`pi-ext/persona.ts` 在 `before_agent_start`
  钩子整体替换 Pi coding-agent 默认系统提示词;`persona-prompt.ts` 三层纯函数(身份 SOUL /
  世界观场景+记号约定 / 工具纪律),字节稳定吃前缀缓存,每个 Pi 进程只读一次 SOUL。
  `server/pi/resident-extensions.mjs` 成为常驻扩展清单唯一来源(index 与测试共用)。
  新增**系统维护回合豁免**:记忆压缩/归档/后台任务这类「不要调用 reply」的内部回合
  不与「reply 唯一出站通道」冲突,且豁免作用域钉死在 `## 任务` 段,免疫用户消息注入拒答。
- **C4 干练同事风人格**(Task 9,`6cbc555`):`agent-memory/SOUL.md` 重写为好坏示例对照的
  同事口吻(反客服腔);分诊系统提示词记号化;`RECAP_INTENT` 复述/总结类**代码级强制升级**
  ——点名场景 quick_reply/no_reply 都拦(完整上下文不在分诊手里),ambient 旁听豁免。
  SOUL 在 `agent-memory` 独立 git 仓演进(dreaming 回滚依赖)。
- **C4/C6 出口场景感知 + Markdown 卡片分流**(Task 10+11,`591a441`):`renderReply` 按
  投递去向(`deliverKind`)注入长度策略(群短平快/私聊可展开);新增 `server/gateway/md-detect.mjs`
  `hasRichMarkdown`(冻结契约:强信号单命中/弱信号≥2类共现/转义 U+0000 哨兵占位不计);
  `buildMarkdownMessageCard` 固定 Card JSON 2.0;`turn-handler.deliverText` 成为唯一文本
  出口(命中富 Markdown 走消息卡,否则纯 text),四条业务路径统一走它。
- **发布门禁脚本**(Task 13,`920f273`):`scripts/e2e-serial.sh` / `e2e-one.sh` 五套 E2E
  串行 + Vitest JSON 统计双校验(passed>0 且无 failed/pending/todo,skip 假绿现形),
  独占前置探测 daemon/consumer 存在即退出不代杀。

### 变更(Changed)

- **C0.1 全局唯一 actor 注册表**(Task 1,`54ff304` 等):网关/回注/后台/归属共用同一串行
  队列,同会话不再双队列并发;归档前复查后台任务、入站即时续期关闭 debounce 归档竞态。
- **C0.2 brain 回合互斥 + 可中断关停**(Task 2,`ad302c6`/`18d40ea`):并发 ensure 合并 spawn、
  同会话回合 mutex,杜绝同 session 双 Pi 并行;shutdown 可中断 sleep + 等待在途 spawn。
- **C0.3 内部通道会话绑定 token**(Task 3,`2d11bdd`):per-spawn 签发、随 Pi 生命周期回收
  吊销,废除静态共享 `MSTD_INTERNAL_TOKEN`;冒名 session_key 一律 403 落 `model_log`。
- **C2 入站 @ 单趟规范化**(Task 5,`27d4fff`):结构化 mention 与纯文本双名(主名+别名)边界
  匹配同源、单趟替换,保留原文与原始空白;规范化前原文落 `inbox_events.raw_content` 供审计。
- **C3.1/2 近期语义修正**(Task 6,`cd7e572`):`store.recent/replaySet` 取真"最近"(同 ts 用
  rowid 定序);历史行四处同源统一,tool 行标 `[内部记录]` 不冒充用户;重放快照按回合冻结。
- **C3.3/4/5/6 群聊上下文供给**(Task 7,`7326986`):30 条滚动窗口(含自身发言+时间戳)替代
  一次性 observed 消费(复述二连问不丢料);跨目标投递回写目标会话;nudge 持久水位。
- **回答模型**(`aa7792d`):按用户 2026-07-11 指令,respond 链改 `v4-pro`(DeepSeek)主选,
  opus 移出回答链(fast/reason 链 opus 兜底不动)。
- **可观测**(`5d3c7d3`):降级/重试/预算命中落 `model_log`,调试台新增「模型链路事件」看板。

### 安全(Security)

- **C0.4 写路径四道锁 + heartbeat owner-bound**(Task 4A/4B,`1e5adae`/`0bf28df`):
  `schedule_reminder` 接入四道锁——服务端闭合规范化(action DSL + stableHash)→ 确认卡
  operator+token → 确认事务落 immutable decision → executor 只认最新 decision hash
  (fail-closed `not_approved`);heartbeat 改结构化 owner-bound 队列逐项直投,封住跨会话
  注入与 read-await-rewrite 丢更新;`reply.target` 跨会话投递必须经 deliver grant。

### 机器人改名(Task 12,`024a0cc`)

- 实机改名「小达」:`.env` 加 `MSTD_BOT_ALIASES` 双名过渡 → 开发者后台改应用/机器人名 +
  发版 1.0.3(免审即生效)→ 切 `MSTD_BOT_NAME=小达`。真机 @新名/@旧名各一条均 addressed
  且入库 `[@我]` 规范化。改名 SOP(顺序/发版/双名验证/回滚 + PID 所有权)写入 runbook。

### 工程纪律与事故记账

- **双引擎对抗审核**:每 `feat/fix` 走 opus 证伪式代码审(修全部确认缺陷 + 复审)+ Codex
  变异审卷(逐条处置:采纳补杀 / 拒绝记录理由)+ 头号变异复验(mutate→红→还原)。
- **合并交付**(Task 10+11):opus 判定 Task 10 单独提交则"含 Markdown 系统自动走卡片渲染"
  为假声明(分流未落地,群里显示原始 markdown),两任务共改 turn-handler,合并为单提交
  消灭假声明窗口——spec 拆分粒度未预见,已在计划/日志留痕。
- **`git checkout` 事故**(Task 8):变异抽查还原误用 `git checkout --` 抹掉未提交的接线,
  凭会话审读记录逐行重建 + diff 核对。**教训:未提交文件的变异还原只能反向编辑,禁 git checkout。**
- **表格检测实现缺陷**(Task 11 §5.2):分隔行正则未要求连字符,`| a | b |\n|   |   |` 误判,
  修正为每列必须含 `-`。**转义哨兵坑**:先用空格占位(属 `\s` 被行首锚吃掉,等于没修),
  改 U+0000。

### 真机验收(四幕剧本)

1. 群聊三话题 → @小达 复述:两次二连问均完整命中三件事、无旧应用名。
2. `@小达 在吗` →「在,说。」零客服腔(对照 SOUL 好坏示例)。
3. 私聊要对比表格 → 出站 `msg_type=interactive` 卡片,表格渲染正常。
4. 自会话「1 分钟后提醒喝水」→ heartbeat 单条准时直投;「2 分钟后在测试群提醒」→ 先出
   确认卡,确认前 heartbeat 表无跨会话 row,operator 锁拦非发起人点击(确认后投递链路由
   e2e-write/group 程序化覆盖)。

### 文档(Task 13,`920f273`)

- README 同步:记号约定全集、SOUL fail-fast + 人格生效延迟、进程所有权、heartbeat DB
  (旧 `HEARTBEAT.md` quarantine)、C6 deliverText 唯一出口、SQLite 方言例外(rowid→自增
  序列 / FTS5)、`MSTD_BOT_ALIASES` / 静态 token 废弃、持牌 user 仅 `oc_b67c` 群的坑。

### 阶段二登记项(待定优先级)

- 确认后执行窗口崩溃缺口(job 停 `executing` 无人重驱 + boot 收口扩状态,连带 enableWrite=false
  时本地指纹对账被 gating 跳过)。
- cron 发起的跨会话提醒发卡前拒绝 UX。
- `index.mjs` composition-root 注入统一(三次复发,重构收益明确)。
- `reply_sent` 全链 message-ID 归因(可观测)。
- dateStr 冻结 >24h 的长会话 Pi;triage 空 SOUL(fail-open)与 persona(fail-closed)策略对齐。
