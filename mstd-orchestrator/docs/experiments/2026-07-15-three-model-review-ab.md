# 三模型审核架构 A/B 实验记录

状态：中途终止，结果不确定；用户要求优先切换当前前台白名单（2026-07-15）

## 假设

面向测试租户会话，将旧链路切换为 `responder 首答 → dispatcher 独立复核 → 必要时 reasoner`，首答延迟预计至少降低 30%，同时不突破任何安全护栏。

- 目标人群：测试租户内、白名单测试用户发起的私聊。
- 唯一主指标：从网关收到输入到首条用户可见回复成功发送的延迟（毫秒），以 10 个配对场景的中位数比较。
- 基线估计：预跑 2 个 legacy 正式回复场景为 4,676 ms、5,191 ms，中位数 4,934 ms。
- 预期方向：B 组更低。
- MDE：相对降低 30%，即 B 组中位数不高于 3,454 ms。

## 变体与实验设计

- A（control）：`legacy`，沿用 triage/brain 单链路。
- B（treatment）：`active`，responder 先回复，dispatcher 后置独立裁决，仅在需要时启动 reasoner。
- 唯一变化：架构模式及该模式要求的白名单目标；模型、提示词、租户、测试用户、场景、超时与写入策略保持一致。
- 分配：10 个固定场景做配对比较；执行采用 ABBA 时段块，缓解供应商与网络随时间漂移。
- 写入：`MSTD_ENABLE_WRITE=0`，不执行业务写操作。

## 样本量与时长

- 双侧显著性水平：5%（95% 置信度）。
- 统计功效：80%。
- 先验假设：配对延迟差的标准差不超过 1.5 秒；MDE 约 1.48 秒。
- 正态近似：`ceil(((1.96 + 0.84) * 1.5 / 1.48)^2) = 9` 对，向上取 10 对。
- 计划样本：每组 10 次，共 20 次；未达到 10 对不得给出胜负结论。
- 计划时长：单次连续窗口不超过 60 分钟。
- 小样本同时报告逐对结果、中位数和配对差的 95% bootstrap CI；统计结论不外推到生产流量。

## 场景与裁决标签

固定 10 个场景分为两层：

- 5 个可由首答完整处理的简单问题，期望 B 组 dispatcher=`no_reasoning`。
- 5 个明确要求核查当前工作区/运行状态、不能靠猜测完成的请求，期望 B 组 dispatcher=`spawn_new|attach_existing`，并产生 reasoner 生命周期证据。

具体文本在执行产物中按哈希和标签记录；实验报告不存储租户消息正文。

## 护栏与停止条件

任一项失败即 B 组不可发布，即使主指标胜出：

- 漏答：0。
- 重复首答或重复终态：0。
- 跨会话/跨任务关联：0。
- 未授权写入：0。
- daemon fallback：0。
- responder 必须先于 dispatcher 决策；需慢机的场景必须在 dispatcher 之后才出现 reasoner_started。
- dispatcher 标签准确率至少 90%（至少 9/10）。
- 简单场景不得无故拉起 reasoner；核查场景不得仅口头承诺后静默结束。

## 有效性假设

- 测试窗口内没有其他 daemon/event consumer；每个时段块独占消费者。
- 两个变体使用同一测试用户、相同模型配置与相同场景集。
- 每个时段块使用隔离数据库和工作区；变体切换时完整停止本实验启动的进程组。
- 飞书、模型供应商及网络在 60 分钟内可能波动，使用 ABBA 块与配对分析降低影响，但不能完全消除。
- 单个测试用户的重复场景不满足独立真实用户假设，因此这是工程架构实验，不代表总体用户因果效应。

## 追踪就绪门槛

- legacy 与 active 均在 `gateway_turn_trace` 使用 `received_at → ack_sent_at/terminal_sent_at` 的同一时钟。
- active 的 `responder_sent` 必须落首答 message id 与时间。
- `model_log` 必须包含 dispatcher 决策以及 task/reasoner/handoff 生命周期关联字段。
- 启动前确认写入关闭、active target 仅包含测试私聊 canonical session、端口空闲、无其他消费者。

## 结果

- 实际样本：A1 完成 5 次，首答延迟为 20,346 / 3,858 / 4,399 / 4,473 / 4,179 ms，中位数 4,399 ms；B 组尚未形成任何有效配对样本。
- 主指标：未达到 10 对，按预注册规则不得比较胜负，也不计算显著性。
- 中止原因：A1 完成后，用户要求优先把当前前台白名单切到三模型 active；为避免后续 ABBA 块再次切回 legacy，实验立即停止。
- 决策：`inconclusive`。这些数据不能支持 B 胜出或失败；后续若需要统计结论，必须从新的独占窗口重新跑满 10 对。

## 中止后的定向 active canary

定向切换不计入已冻结的 A/B 样本，但作为发布安全证据单独记录：

- 首次 active canary 暴露真实飞书兼容问题：Responder 已生成答案，但 64 位 dispatch 幂等键被飞书以 `99992402 field validation failed` 拒绝，用户不可见。
- 修复：新 dispatch 使用 32 位确定性哈希；迁移 023 将数据库内历史 64 位 outbox 键缩短，使 `pending_send` 可在重启后恢复。
- 恢复验证：旧失败 outbox 成功补发；Dispatcher 使用 `v4-flash`，裁决 `no_reasoning`。
- 正常简单 canary：Responder 首答 5,073 ms；Dispatcher `v4-flash` 用时 1,614 ms，裁决 `no_reasoning`；无 reasoner。
- 正常慢机 canary：Responder 首答 4,965 ms；Dispatcher `v4-flash` 用时 2,481 ms，裁决 `spawn_new`；随后 `reasoner_started`，约 19 秒后 `handoff_sent`，run=`completed`、closure=`sent`。
- 顺序护栏：两条正常 canary 均满足 responder_sent < dispatcher_decision；慢机场景进一步满足 dispatcher_decision < reasoner_started < handoff_sent。
- 其他护栏：两条正常 canary 均无重复 responder/handoff、无 daemon/safe fallback、无跨会话关联。

## 后续

- 当前仅将一个测试私聊 canonical session 固定为 active；其他会话继续由 allowlist resolver 保持 legacy。
- 若恢复 A/B，需重新建立 10 对完整样本，不能把上述定向 canary 拼入中止实验。
