# 迭代三：任务闭环自动化（追踪 · 晨报 · 会前预习包）

> 2026-07-15 草案，待用户评审。前置：迭代二（全域感知 + 妙记派任务全自动）已收官——28 只读 op、7 写 kind、妙记→确认卡→建任务→群播报全链真机验通。本迭代把"派发"补全成"派发→追踪→闭环"，不新增写白名单（Track D 除外，默认不做）。

## 目标（一句话口径）

派出去的任务不能没人管：小达自动记住自己派了什么，到期前提醒、逾期后升级、完成即销账；每天早上给出全组任务面貌；开会前把上次的账翻好。

## 现状盘点（迭代起点）

- **写动作 7 kind 全走确认卡**：create_task / complete_task / notify_task_assignee / send_dm / send_group_msg / create_event / update_document（`server/safety/write-args.mjs`）。本迭代三条主 Track 的写需求全部落在既有 kind 内。
- **`onExecuted` 钩子已带全上下文**（`server/index.mjs:449`）：jobId / sessionKey / taskId / resultsMd / ok——派发台账的落库接缝现成。
- **cron-runner 已支持任意 prompt 定时任务**（`server/ticker/cron-runner.mjs`）：新鲜会话 + deliver_to 临时投递授权 + propose_actions 纪律 + 注入扫描。晨报类场景 ≈ 一条 cron job 配置。
- **确定性 ticker 范式已有**（`server/ticker/token-watch.mjs`）：不走 Pi、纯代码巡检 + 直投告警。追踪器复用此形状。
- **DB migration 体系**：`server/db/migrations/` 序号 SQL，当前至 022。
- 教训（须遵守）：所有开关落 `.env` 不落 shell export（`agent-flags-must-be-in-env`）；lark_read 会话域门禁不越界；Pi 扩展跨模块状态走 globalThis。

## Track A · 行动项闭环追踪（核心，确定性代码）

**设计立场**：状态检查用确定性 ticker，不走 Pi——催办是纪律活不是创意活，要的是准时、幂等、可审计。Pi 只负责晨报里的自然语言汇总（Track B）。

### A1 派发台账（dispatched_tasks）

新 migration `023_dispatched_tasks.sql`：

| 列 | 说明 |
|---|---|
| task_guid | 主键，来自 create_task 执行结果 |
| title / assignee_open_id / due_ts | 派发时快照 |
| source_job_id / source_session_key | 溯源（哪次妙记/哪个会话派的） |
| origin_chat_id | 播报群（可空） |
| status | open / done / closed_external（飞书侧被删等） |
| last_check_ts | 追踪器巡检游标 |

- 写入点：`onExecuted` 钩子内，仅 `ok && kind === "create_task"` 的动作落账（execute-action 已把 task_guid 写进结果 JSON）。
- 启动对账：复用 `reconcile-startup.mjs` 形状，job_actions 中 succeeded 的 create_task 若不在台账则补录（防进程中途挂掉丢账）。

### A2 追踪 ticker（task-tracker）

挂 ticker 周期（与 token-watch 同层，间隔 `MSTD_TRACKER_INTERVAL_MS`，默认 30min）。每轮对台账中 status=open 的任务：

1. `lark_read get_task` 查真实状态（read 白名单已含）；
2. **已完成** → status=done，若 origin_chat_id 配置了播报则销账播报；
3. **到期前 24h 未完成** → 提醒负责人；
4. **逾期 >24h** → 升级：通知 owner + 来源群。

**提醒幂等**：新表 `task_reminders(task_guid, milestone, sent_ts)`，milestone ∈ {due_soon, overdue, escalated}，每任务每里程碑最多一次。节流：单轮全局提醒上限 `MSTD_TRACKER_MAX_NOTICES`（默认 5），超出留到下轮，防止台账积压时轰炸。

### A3 提醒的批准形态（关键决策点，见"待用户拍板"）

两档，分阶段：

- **阶段 1（本迭代默认）**：ticker 发现待提醒 → 组装 `notify_task_assignee` / `send_dm` action → 走既有确认卡发 owner，一键批。安全面零新增。
- **阶段 2（灰度后可选，单独立项）**：引入"预授权规则"（standing approval）——服务端校验通过即免卡自动执行，规则硬编码不由模型生成：kind 仅限 notify_task_assignee、目标必须是台账内该任务的 assignee、内容走服务端模板、命中节流上限即停。这是新安全机制，须单独过方案，本迭代不实现。

### A4 文案

阶段 1 用服务端模板打底（任务名/截止/来源会议三要素），不经 Pi——确认卡上 owner 看到的就是最终文案，符合"卡片绝不渲染不可信原文"的既有纪律（provenance 那套照用）。

## Track B · 每日任务晨报（纯配置 + 调优）

- 实现 = 一条 cron job：`prompt` 描述"汇总今天到期/逾期/昨日完成"，`deliver_to` 指向播报群或 owner 私聊。cron-runner 的 grants 机制使 reply 直投无需确认卡（迭代一已验通的既有纪律）。
- Pi 数据源：`my_tasks` / `search_tasks`（既有 read op）+ 新增只读 op `dispatched_ledger`（读 A1 台账，本地 DB 查询、非 lark 调用，让晨报能说"这三个是上周三例会派的"）。
- 无事可报保持静默（cron brief 既有纪律）。
- 主要工作量在文案质量调优 + E2E，参照 SOUL 语气调教已验通的对标方法。

## Track C · 会前预习包（第二优先级）

- 触发：ticker 扫 `agenda`（未来 `MSTD_PREBRIEF_LEAD_MS`，默认 30min 窗口），每事件触发一次（`prebrief_sent(event_id)` 幂等表）。
- 内容（Pi 只读回合，复用 cron 会话形状）：同主题历史妙记（search_minutes）+ 相关文档（search_docs）+ 台账中该会派发且未闭环的行动项。
- **收件人起步只发会议组织者/owner 私聊**（DM 全体参会人打扰面大，灰度后再议）。
- 依赖 Track A 台账才有"上次派的活干完没有"这个最有价值的部分，故排在 A/B 之后。

## Track D · 能力缺口

- 写侧：update_event / cancel_event（改期取消）、task 转派/改截止、task 评论。每个都是新 kind + 确认卡 + 单测，需求出现时单独提。
- 读侧：`freebusy`（多人忙闲，"找时间约会议"场景的前置）——scope `calendar:calendar.free_busy:read` 已在 48 scope 内，缺的只是白名单 op，可顺手做也可等场景。

## 里程碑顺序

0. 补齐Task D 中的能力缺口
1. A1 台账 + 启动对账（migration 023/024 + onExecuted 落库 + 单测）
2. A2 追踪 ticker + A3 阶段 1 确认卡 + A4 模板（单测：里程碑幂等/节流/状态迁移）
3. B 晨报 cron job + `dispatched_ledger` read op（单测 + 文案调优）
4. 真机 E2E：妙记派一个 due=明天 的任务 → 观察 due_soon 提醒卡 → 批准 → 负责人收到 DM → 完成任务 → 下轮巡检销账 → 次日晨报提及
5. 运行一周后复盘，再议 A3 阶段 2 预授权

## 风险与回滚

- 开关：`MSTD_ENABLE_TRACKER` / `MSTD_ENABLE_PREBRIEF`，**落 `.env`**；默认关，验通再开。
- 骚扰面：里程碑幂等 + 单轮上限 + 阶段 1 有 owner 确认卡兜底，最坏情况是卡片积压而非消息轰炸。
- 台账漂移：飞书侧任务被删/转派 → get_task 报错或 assignee 变化时标 closed_external 并在晨报中如实报，不猜。
- 全部提醒/播报走既有出口（outbound 门禁 + grants），无新出口。

## 待用户拍板

1. **A3 催办批准形态**：阶段 1 全走确认卡（默认，稳）？还是本迭代就做阶段 2 预授权（省 owner 点卡，但新增安全机制须先过方案）？ 
2. **晨报投递目标**：播报群还是 owner 私聊起步？
3. **Track C 是否进本迭代**：进（里程碑 5）或砍掉留下迭代。

用户回答：
1. 全走确认卡
2. owner
3. 不进入
