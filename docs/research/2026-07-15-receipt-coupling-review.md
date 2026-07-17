# Receipt + Done 耦合审查

日期：2026-07-15

审查范围：只读盘点，不改实现。

行号基准：本报告提交时的 `feat/resident-agent` 工作树。

## 结论

`receipt+done` 不应落成第四套终态状态机，也不应把操作执行阶段并入
`reasoning_runs.closure_state`。它应收编并扩展现有 `job_actions` 执行/对账状态：

- `job_actions` 及其执行器负责证明“真实写操作发生到了哪一步”；
- `reasoning_runs` 负责证明“本次推理是否已经向用户闭环”；
- active-turn business receipt 负责当前进程内“一次 daemon 回合是否已有终态投递”，
  是并发与重复出站护栏，不是操作成功证据。

三者需要显式引用，但不能共享同一个 `done`。一次写操作可以处于 `UNKNOWN`，同时
reasoning run 已经用“状态尚未确认”的诚实消息完成闭环；反过来，操作已验证成功而
终态消息尚未送达时，run 仍必须保持待闭环。把这两个维度合并会再次允许“消息发出”
冒充“操作成功”，或让操作状态未知永久卡住对话闭环。

## 一、现存三套终态语义

### 1. Active-turn registry：business receipt

#### 状态集与含义

business receipt 本体只有两个状态：`active` 与 `terminal`。`ack` 是附属 effect，
不是终态；终态 outcome 封闭为 `formal_reply_sent`、`safe_fallback_sent`、
`daemon_fallback_sent`（`server/sessions/active-turn.mjs:13-17,187-196,213-224`）。

同一个 registry 中的 brain lifecycle 另有 `active → closing → closed`，并记录
`progress`、正式 final、安全 fallback、daemon fallback 的投递计数和唯一
`finalReceipt`（`server/sessions/active-turn.mjs:245-274,348-383,420-475,519-531`）。
这部分与 business receipt 共用 turn lease，但不是第二份持久化业务状态。

#### 终态触发者

- `turn-handler` 在 legacy 慢机业务回合开始时签发 receipt，ACK 只调用
  `recordAck`（`server/gateway/turn-handler.mjs:427-435`）。
- 正式 final 或 egress 安全 fallback 通过 `brainTurns.recordDelivery()` 原子记录投递，
  再由 `completeLinkedReceipt()` 把同 turn 的 business receipt 终态化
  （`server/sessions/active-turn.mjs:361-383,500-507`）。
- daemon terminal fallback 通过 `recordDaemonDelivery()` 做同样联动
  （`server/sessions/active-turn.mjs:386-405`）。没有 brain lifecycle 的降级拓扑由
  `turn-handler` 直接调用 `receipts.complete()`（`server/gateway/turn-handler.mjs:93-135`）。
- `turn-handler` 的 `finally` 无论终态是否成功都会 clear；未终态时发
  `business_turn_abandoned`，避免会话永久占槽（`server/gateway/turn-handler.mjs:497-510`）。

#### 持久化位置

无持久化。状态只在 `createActiveTurnRegistry()` 内的 `Map`，receipt 另有 15 分钟
泄漏兜底 TTL（`server/sessions/active-turn.mjs:32-35,64-68,100-109`）。进程重启会丢失，
因此它只能证明当前进程 epoch 内的投递与并发所有权，不能充当不可变 tool receipt。

#### 相互引用点

- registry record 可携带 `taskId`、`runId`、`executionKey`，但它们只是内存元数据，
  没有数据库外键（`server/sessions/active-turn.mjs:64-75,136-167`）。
- task-scoped reasoner 激活时要求 `taskId` 与 `runId` 成对，并把它们写入 admission
  snapshot（`server/sessions/active-turn.mjs:245-274,300-328`）。
- coordinator 读取 lifecycle 的 `finalReceipt`，据此升级 required closure、复用
  `messageId`，最后再 finalize registry lifecycle
  （`server/reasoning/coordinator.mjs:106-195`）。这是与 run-store 的实际耦合点。
- 与 `job_actions` / action id 没有直接引用。

### 2. Run-store：reasoning run closure

#### 状态集与含义

`reasoning_runs.status` 的状态集是 `queued`、`running`、`closing`、`completed`、
`failed`、`interrupted`、`cancelled`；open 集合是前三者。`closure_mode` 是
`required | silent_ok`；`closure_state` 是 `open`、`pending_send`、`sent`、
`safe_fallback_sent`、`silent_closed`、`cancelled`
（`server/reasoning/run-store.mjs:4-9`；数据库约束见
`server/db/migrations/021_reasoning_runs.sql:4-27`）。

实际写路径如下：

- create：`queued/open`；start：`running/open`
  （`server/reasoning/run-store.mjs:27-45,134-197`）；
- required closure claim：`closing/pending_send`
  （`server/reasoning/run-store.mjs:56-63,229-235`）；
- 已投递终态：`completed/sent` 或 `completed/safe_fallback_sent`
  （`server/reasoning/run-store.mjs:64-69,238-255`）；
- 允许静默：`completed/silent_closed`
  （`server/reasoning/run-store.mjs:70-77,257-266`）；
- 启动恢复无法安全继续时：`interrupted`
  （`server/reasoning/run-store.mjs:78-82,268-281`）。

schema 允许 `failed`、`cancelled` 以及 closure `cancelled`，但本次审查范围内的
run-store API 没有对应 transition writer；当前受控失败主要经“发送失败说明后
completed”或 `interrupted` 表达。不能据 schema 中预留值误判为已完整实现。

#### 终态触发者

终态协调 owner 是 `createReasoningCoordinator().closeRun()`：

- `required` run 先 claim；若 lifecycle 已有 final receipt 就复用其消息，否则调用
  `deliverTerminal`；随后唯一调用 `runStore.recordTerminal()`
  （`server/reasoning/coordinator.mjs:106-182`）；
- `silent_ok` run 调用 `closeSilent()`（`server/reasoning/coordinator.mjs:183-186`）；
- reasoner 正常或异常退出都进入 `closeRun()`，异常路径会发送失败闭环
  （`server/reasoning/coordinator.mjs:293-399`）；
- 重启恢复对 required run 重走 `closeRun()`；无法恢复的 silent run 标
  `interrupted`（`server/reasoning/coordinator.mjs:407-456`）。

store 是状态转移的确定性执行者，以条件 UPDATE/CAS 拒绝非法竞争；coordinator 是
决定何时闭环、发什么终态投递的编排 owner。

#### 持久化位置

SQLite 的 `reasoning_runs` 表持久化完整 run/closure 状态、终态消息 id、失败摘要和
时间戳；每个 task 只允许一个 open run
（`server/db/migrations/021_reasoning_runs.sql:4-41`）。每个 run 还有稳定唯一的
`run:<runId>:terminal` idempotency key
（`server/reasoning/run-store.mjs:11-14,27-33,156-169`）。

#### 相互引用点

- 与 active-turn 的桥是 `taskId/runId/executionKey` 和 lifecycle `finalReceipt`，见上一节；
  run-store 不持久化 active-turn lease。
- `reasoning_runs` 通过 task、dispatch、parent run 外键建立推理来源链
  （`server/db/migrations/021_reasoning_runs.sql:4-10,43-52`）。
- 写操作 job 目前只在 `orch_jobs.params_json` 中以 `originRunId` 软引用来源；
  confirm flow 解析它用于执行结果回注，没有 FK
  （`server/cards/confirm-flow.mjs:368-378,456-459`）。
- run-store 不引用 action id、payload hash、外部资源 id 或写后验证结果。

### 3. Action-store：审批绑定、幂等执行与启动对账

#### 状态集与含义

`job_actions.status` 没有数据库 CHECK；生产代码实际使用：

- `pending`：action 已规范化落库、尚待执行；
- `executing`：通过批准/hash/provenance/dry-run 门后，真实写调用即将发出；
- `succeeded`：写调用返回成功，或重启/重试对账命中外部指纹；
- `failed`：门禁、dry-run、执行或对账失败；可被 `actionsToExecute()` 再取出重试；
- `unknown`：恢复查询把它视为需对账状态，但本次审查未发现生产 writer；未知 action
  只在函数返回值中使用 `status: "unknown"`。

建表字段与唯一 `(job_id, action_key)` 见 `server/db/migrations/001_init.sql:72-87`；
落库 `pending`、可重试集合和通用状态覆盖写入见
`server/safety/action-store.mjs:11-15,24-56`。因此这是“半成品 receipt projection”，
不是不可变 receipt：`status/result_json` 会原地覆盖，且 result 形状按动作分散。

聚合层另有：

- `orch_jobs` 的 `executing → done | partial_failed`；
- `confirm_cards` 的 `pending → executing → done`，部分失败时实际回到 `pending` 以允许重试，
  展示 state 则为 `partial_failed`
  （`server/cards/confirm-flow.mjs:255-297,419-460`）。

#### 终态触发者

- `recordActions()` 是 `pending` 的唯一集中创建点，并绑定 canonical payload hash、
  provenance hash、幂等 key（`server/safety/action-store.mjs:17-41`；canonical hash 规则见
  `server/safety/action-dsl.mjs:21-45,265-277`）。
- `executeApprovedAction()` 校验批准、payload hash、provenance、canonical 重建和
  test target；真实调用前标 `executing`，依据 adapter 返回标 `succeeded/failed`
  （`server/execute/execute-action.mjs:31-105`）。本地 reminder 走同样状态序列
  （`server/execute/execute-action.mjs:108-145`）。
- `reconcileAction()` 由外部幂等指纹、任务真实状态或本地唯一 source action id 判定
  是否可收敛为 `succeeded`（`server/execute/execute-action.mjs:163-196`）。
- 写前对账和启动对账负责处理 `executing/unknown`；未找到时当前会降为可重试的
  `failed`（`server/execute/write-phase.mjs:4-16`；
  `server/execute/reconcile-startup.mjs:5-35`）。
- confirm flow 汇总全部 action，只有全为 `succeeded` 才把 job/card 置 `done`；否则
  `partial_failed` 并重新签发确认 token（`server/cards/confirm-flow.mjs:350-365,419-460`）。

#### 持久化位置

SQLite 的 `job_actions` 保存 canonical payload、hash、idempotency key、可变 status 和
`result_json`；`decisions` 保存批准时 action key/hash 集合，后续 migration 又绑定
provenance hash（`server/db/migrations/001_init.sql:59-87`；
`server/db/migrations/016_approval_provenance.sql:1-9`）。`orch_jobs` 与 `confirm_cards`
保存聚合/UI 投影。没有 append-only execution receipt 表，也没有通用
`external_resource_id/postcondition_status` 字段。

#### 相互引用点

- action 通过 `job_id` 外键挂到 `orch_jobs`，批准 decision 也按 job 绑定；执行时重新读取
  最新批准 hash（`server/execute/execute-action.mjs:7-20,31-53`）。
- action 没有 `run_id` 外键；run 来源仅在 job params 中软引用，见上一节。
- action 幂等 key 是 `(jobId, actionKey)` 的确定性短 hash
  （`server/safety/action-store.mjs:5-9`），与 run 的 terminal idempotency key 是不同域，
  不应复用。
- active-turn business receipt 与 action-store 没有引用。

## 二、与 hallucination-governance receipt+done 的重叠与冲突

### 重叠

草案要求的 `action_id`、`args_hash`、执行状态和幂等对账，大部分地基已经在
`job_actions.id`、`payload_hash`、`idempotency_key`、`status/result_json` 以及
`reconcileAction()` 中。批准时 hash/provenance 绑定甚至比草案一句话描述更完整。
因此另建一套不引用 `job_actions` 的 PLANNED→… 状态机会造成双写和相互矛盾。

run-store 已有的 `terminal_idempotency_key`、`terminal_message_id` 与
`safe_fallback_sent` 解决的是“终态消息是否投递”，不是“工具操作是否成功”。它可以
承载 receipt+done 的最终通知，但不能作为执行 receipt 的主表。

### 冲突与缺口

1. **语义同名冲突**：现有 `completed`/`done` 表示推理闭环或 job 聚合完成；草案
   `SUCCEEDED` 表示操作经 postcondition 验证。必须在字段和事件名中保留作用域，禁止
   裸 `done` 横跨三域。
2. **阶段粒度不足**：`pending/executing/succeeded` 无法区分草案的 PLANNED、
   SUBMITTED、EXECUTED、VERIFIED、SUCCEEDED；当前 adapter 返回 0 就直接 succeeded。
3. **UNKNOWN 被过早降级**：写前/启动对账未命中即写 `failed`。对于“请求可能已送达，
   但查询暂时未见”的场景，`not found` 不足以证明未执行，可能触发重复写。
4. **记录可变**：`markStatus()` 原地覆盖 status/result，不能证明完整执行序列，也无法
   防止后写抹去早期证据。
5. **外部证据不统一**：resource id 藏在各动作不同的 stdout/result JSON 中；没有统一
   execution status、postcondition status 和 read-after-write receipt。
6. **来源引用过软**：job 到 reasoner run 只有 params JSON 中的 `originRunId`，无法用 FK
   或唯一约束证明“哪次 run 的哪条完成声明对应哪组 action receipts”。
7. **进程内 receipt 不耐崩溃**：active-turn registry 可防同进程重复终态出站，但不能
   恢复写操作事实；不能拿它补 action receipt 的持久化缺口。

### 判定：收编 action-store，关联但不扩展 run-store closure

本审查推翻“以扩展 run-store closure 为主”的预判。receipt+done 是现有 action-store
状态机的严格化与证据化，不是第四套；run-store 只增加显式引用/消费验证结论的能力，
不增加 SUBMITTED/EXECUTED/VERIFIED 等操作阶段。

理由是两个状态机具有正交终态：

| 操作状态 | 推理闭环状态 | 正确行为 |
|---|---|---|
| `SUCCEEDED` | 未终态 | 重试终态投递，不重做操作 |
| `UNKNOWN` | 可闭环 | 如实发送“状态尚未确认”，然后完成 run |
| `FAILED` | 可闭环 | 如实发送失败和可重试建议，然后完成 run |
| 未开始/执行中 | 未终态 | 等待或发送进度；不得宣称完成 |

若把操作阶段塞进 `closure_state`，一个 run 含多个 action、部分成功、后台重试或同一 task
多 run 时都会失去可表达性；同时会污染 `silent_ok`/`required` 这一本来只描述用户闭环
义务的产品语义。

## 三、建议收编路径

### 唯一 owner

receipt+done 的唯一终态 owner 应是**服务端 action execution evidence layer**：以
`job_actions` 为权威投影，以 append-only action receipt/event 为事实日志；只有该层可以
把 action 推进到 `VERIFIED/SUCCEEDED`。Lark adapter、Pi、reasoner、responder 和
render-card 都只能提交观察或读取投影，不能自行写成功终态。

`createReasoningCoordinator().closeRun()` 继续是**消息闭环** owner。它消费 action owner
给出的结构化状态：即使操作 `UNKNOWN`，也可发送诚实终态消息并把 run 置 completed。
这不是两个“操作终态 owner”，而是两个不同聚合根各自唯一 owner。

### 迁移步骤

1. **先冻结词汇与不变量**：明确 action execution phase、postcondition phase、run closure
   三个命名空间；规定只有 `VERIFIED` 后可生成“已完成/已发送/已创建”。
2. **加法建表**：新增 append-only action receipt/event 表，至少含 `receipt_id`、
   `action_id`、`payload_hash/args_hash`、`idempotency_key`、phase、adapter result、
   `external_resource_id`、`postcondition_status`、时间戳和可选 `run_id`。保留
   `job_actions.status` 作为兼容投影，不在第一步删除旧列。
3. **集中 transition API**：把散落的 `markStatus()` 调用收编为带合法转移校验和 CAS 的
   action-store API；同一事务 append receipt/event 并更新 projection。adapter 只能返回
   observation，不能直接选择 `SUCCEEDED`。
4. **兼容映射**：旧 `pending` 映射 PLANNED，旧 `executing` 启动时按 UNKNOWN 恢复，旧
   `succeeded` 只能标为 legacy-unverified；不要伪造历史 VERIFIED receipt。`failed` 保留
   原因和可重试性。
5. **拆开执行与验证**：远端调用成功先到 EXECUTED；高风险动作 read-after-write 后才
   VERIFIED/SUCCEEDED。网络超时或外部查询不确定进入 UNKNOWN，不能仅因一次 not-found
   自动转成可重试 failed。
6. **显式 run/action 关联**：把现在 params JSON 中的 `originRunId` 升为受约束引用，或建
   `reasoning_run_actions(run_id, action_id, relation)`；一个 run 可关联多个 action，一个
   action 的恢复/重试也可关联后续 run。不要复用两域 idempotency key。
7. **收权完成文案**：confirm flow/render-card 只按 action projection 生成完成、失败、未知
   文案；reasoner→responder 只传经过批准的结构化声明。run-store 记录的是该文案的
   `terminal_message_id`，不是操作成功本身。
8. **启动恢复双轨运行**：先让旧 status 和新 receipt projection 对账并发 discrepancy
   事件；确认无分歧后，读路径切新 projection，最后再移除直接 `markStatus()` writer。

### 测试策略

1. **状态机表驱动单测**：覆盖每个合法 transition、所有非法跳转、终态幂等重放、
   append-only 约束和 CAS 竞争；禁止 EXECUTED 直接渲染成功。
2. **崩溃点注入**：分别在提交前、远端接受后但 receipt 落库前、EXECUTED 后验证前、
   VERIFIED 后消息投递前制造崩溃；恢复后不得重复不可逆操作，也不得虚报成功。
3. **对账三态**：read-after-write 命中→VERIFIED，权威证明失败→FAILED，仅暂时未找到/
   查询失败→UNKNOWN。特别回归当前 `reconcile_not_found*` 过早 failed 的行为。
4. **幂等与重复回调**：同 action/idempotency key 多次提交、卡片重复点击、daemon 重启和
   terminal message 重试，均只产生一个外部 effect；receipt event 可多条但事实不冲突。
5. **多 action 聚合**：全成功、部分失败、部分 UNKNOWN、依赖 action 失败、单项恢复后
   聚合更新；卡片和 responder approved claims 必须逐项如实。
6. **run/action 集成**：验证 `SUCCEEDED + pending_send` 只重发消息不重做 action；
   `UNKNOWN + required` 发送未知状态后 run 可 completed；`silent_ok` 不得吞掉已承诺结果。
7. **active-turn 集成**：formal/egress/daemon 三种终态投递仍只各终态化一次 business
   receipt；进程内 receipt 丢失不能改变持久 action 事实。
8. **迁移与回放**：用现有 pending/executing/succeeded/failed 数据快照跑 migration；旧
   succeeded 必须明确标注 legacy-unverified。把线上 false-completion 事故加入可重放集。

## 四、实施前必须另行拍板的边界

本报告只给耦合结论，不授权实现。后续 spec 至少要明确：高风险 read-after-write 白名单、
历史 succeeded 的产品展示、UNKNOWN 的重试/人工处理策略、action receipt 的保留期限，
以及 reasoner→responder “已批准声明集合”的最小 schema。它们都会改变用户可见完成语义
或安全执行流程，不能在本批次顺手落地。
