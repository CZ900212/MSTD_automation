# Spec：可靠性收敛·批次一（模型链回正 / 闭环兜底 / 失败如实化 / 应答机收紧 / active 灰度）

> 状态：**已拍板，可执行**（2026-07-15 项目负责人逐项确认）。
> 执行者开工前必读：仓库根 `project.md`（产品意图最高权威，本 spec 与其冲突时以
> project.md 为准）、`CLAUDE.md`（硬规则速查）。
> 本 spec 只授权下列 T1–T7 的改动。**不授权任何顺手重构、依赖升级、安全层
> （reply-egress / context-envelope / 审批门 / verbatim / 会话域门禁）语义变更、
> 或对 project.md 的修改。**

## 0. 决策记录（背景）

2026-07-15 项目负责人拍板：

1. 架构切 active 灰度（生产此前一直跑 legacy，新架构从未服务过用户）。
2. `MSTD_THINK_ALL` 实验取消。
3. 推理机主脑切回 gpt-5.6-sol（此前因网关 503+额度临时切 DeepSeek），**推理强度用 high**。
4. 应答机独答收紧：新事实类问题必须交推理机（详见 project.md 第二节"独答边界"）。
5. 调度器失败兜底 closure 由 silent_ok 升为 required。
6. receipt+done 状态机将做，落地前先出耦合审查报告。
7. 治理层失败表达如实化；文案层等"AI 味语言"调研，先做事件层。

工作目录：`mstd-orchestrator/`（**全量单测必须在此目录内跑**，仓库根会扫出无关假失败）。
当前单测基线：1387 passed / 7 skipped（`npx vitest run`）。

---

## T1 取消 MSTD_THINK_ALL 实验

**现状**：工作树中 `server/models/caller.mjs` 与 `test/model-caller.test.mjs` 有一份
**未提交**的改动（引入 `thinkingField:"deepseek"` 与 `MSTD_THINK_ALL` 开关）；
`mstd-orchestrator/.env` 中有 `MSTD_THINK_ALL=1` 行。

**操作**：
1. `git restore server/models/caller.mjs test/model-caller.test.mjs`（丢弃该实验实现，
   恢复到已提交的 `disableThinking: true` 形态）。
2. 删除 `.env` 中的 `MSTD_THINK_ALL=1` 行（只删这一行；`.env` 含密钥，
   不得回显其内容、不得提交、不得改动其它行）。

**验收**：这两个文件 `git status` 干净；`grep -r MSTD_THINK_ALL server/ test/` 无结果；
全量单测绿。

## T2 主脑切回 gpt-5.6-sol，推理强度 high

**现状**：
- `server/models/brain.mjs` `REASON_PROVIDERS`（约 :10–:16）当前 v4-pro 在前
  （2026-07-15 临时应急），注释写明"上游恢复后把两行顺序换回"。上游已恢复。
- `pi-ext/providers.ts` 中 gpt-5.6-sol 的 `thinkingLevelMap` 全档钉死 `"medium"`。

**操作**：
1. `REASON_PROVIDERS` 恢复 gpt-5.6-sol 为首选、v4-pro 为兜底；gpt-5.6-sol 的
   `thinking` 档改为 `"high"`；v4-pro 兜底保持 `"xhigh"`（DeepSeek 思考是二元开关）。
   更新注释：记录 2026-07-15 定案"主脑 gpt-5.6-sol high"，删除"临时切换"段。
2. `providers.ts` 中 gpt-5.6-sol 的 `thinkingLevelMap` 全档钉死改为 `"high"`
   （保留"钉死防调用方乱改"的语义，只抬档位）；同步注释。gpt-5.5 与 DeepSeek
   条目不动。
3. 搜索并更新断言 medium 钉死/provider 顺序的测试
   （`grep -rn "thinkingLevelMap\|REASON_PROVIDERS" test/`）。

**已知风险（不阻塞，须留观测）**：内部调研结论"高推理强度会提高工具幻觉"。
本批次不加新防护（架构解是 receipt 状态机，见 T7），但 model_log 中
`brain_fallback` / 工具异常事件是观测面，交付报告中提示负责人关注。

**验收**：全量单测绿；`rg "deepseek-v4-pro" server/models/brain.mjs` 显示其为兜底位。

## T3 调度器失败兜底 closure 升 required

**现状**：`server/models/dispatcher.mjs` `dispatcherFailureFallback()`（约 :164–:176）
addressed/private 场景返回 `closure: "silent_ok"`。与 project.md 四.8 配套定案冲突。

**操作**：
1. addressed/private 分支 `closure` 改为 `"required"`；`reason_code` 维持
   `dispatcher_fallback_spawn`；ambient 分支（`no_reasoning`）**不动**。
2. 更新函数上方 "Owner-confirmed" 注释：注明 2026-07-15 定案升 required 及理由
   （应答机兜底话术构成承诺，承诺必须闭环）。
3. 更新断言 silent_ok 的测试（`grep -rn "dispatcher_fallback\|silent_ok" test/` 中
   与 fallback 相关者）；补一条测试：dispatcher 抛错 + mode=addressed ⇒ spawn_new
   且 closure=required ⇒ coordinator 路径最终必产生终态投递（可复用现有
   coordinator/closure 测试基建）。

**验收**：全量单测绿；针对性测试覆盖"兜底承诺必闭环"。

## T4 失败表达如实化——事件层

**范围**：只做可观测，**不改任何用户可见文案**（文案层等语体调研，明确 out of scope）。

**现状**：四个兜底点已有零散事件：`responder_fallback`（responder.mjs）、
`dispatcher_fallback`（dispatcher.mjs）、daemon terminal（turn-handler.mjs，
`business_turn_terminal` outcome=daemon_fallback_sent）、`reply_egress_fallback`
（reply-pipeline.mjs）。但无统一分类，调试台无法按"兜底"横向聚合。

**操作**：
1. 为上述四类事件统一补充字段 `fallback_kind`（枚举：`responder_parse` /
   `dispatcher_error` / `dispatcher_parse` / `daemon_terminal` / `egress_safe`），
   不改事件名（向后兼容既有消费者）。
2. 确认四类事件全部落 model_log（现有 onEvent→model_log 管道；缺的接上）。
3. 在 `README`（或 server/models 邻近文档注释）登记事件字典：五种 fallback_kind
   的触发条件与含义。

**验收**：单测断言各兜底路径事件携带正确 `fallback_kind`；全量绿。

## T5 应答机独答收紧（路由层）

**依据**：project.md 第二节"独答边界（2026-07-15 收紧定案）"，原文为准。

**现状**：`server/models/responder.mjs` `ANSWER_SYSTEM` 鼓励"可以给出完整答案"。

**操作**：
1. 改写 `ANSWER_SYSTEM` 规则段，加入独答边界：身份/寒暄/对话中已有信息可直答；
   涉及新事实、需要查证、需要工具或最新数据的，不得凭记忆作答，改为用自己的话
   自然说明要去核实后再答。
2. **硬约束：提示词中不得提供任何固定示例句**（不得写"例如：我查一下"之类——
   给意图，不给台词）；不得出现"稳稳""接住"等模板腔词汇。语体细则字段留待
   调研产出后补充，本次改动保持最小。
3. `SAFE_ADDRESSED_FALLBACK`（"收到，我先处理一下。"）是刻意设计（project.md 四.8），
   **不动**。
4. 更新 responder 提示词形状测试；若存在 E2E persona 断言首答内容的用例，检查
   是否受影响并如实报告（不得为过测试而放宽断言）。

**验收**：全量单测绿；`responderPrompts.answerSystem` 输出含独答边界规则且不含示例台词。

## T6 active 灰度切换（真机，串行最后做）

**前置**：T1–T5 已合入且全量单测绿；四门控 E2E PASS。

**操作**：
1. E2E：`set -a; source mstd-orchestrator/.env; set +a` 后显式 export
   `MSTD_E2E=1 MSTD_ENABLE_WRITE=1 MSTD_TEST_OPEN_IDS=... MSTD_TEST_CHAT_IDS=...`
   （值见 .env 与 docs 日志；缺 `MSTD_ENABLE_WRITE` 会整套静默 skip=假绿，视为 FAIL）。
   跑 `bash scripts/e2e-serial.sh`。
2. `.env` 追加两行（不动其它行）：
   `MSTD_AGENT_ARCHITECTURE_MODE=active`
   `MSTD_AGENT_ACTIVE_TARGETS=<测试群 chat_id，执行时向负责人确认具体值>`
3. 重启 daemon，核对启动日志：architecture mode=active、targets 正确、
   capability readiness 探针通过。
4. 真机验证清单（在测试群逐条做，逐条记录消息 id）：
   - 点名提问事实类问题 ⇒ 首答自然表明去核实（不直接编答案）⇒ 二段回复给出结果；
   - 点名寒暄 ⇒ 直答、无二段；
   - 旁听闲聊 ⇒ no_reply，调试台可见 dispatch 记录；
   - 人为制造 dispatcher 失败不可行时，至少核对 model_log 中 dispatcher_decision 流。
5. **不放业务群**——扩大 targets 是负责人的后续决定。

**验收**：E2E 全 PASS；真机清单四条全过并留证；.env 变更如实记录在交付报告。

## T7 receipt+done 耦合审查（只读，可与 T1–T5 并行）

**产出**：`docs/research/2026-07-15-receipt-coupling-review.md`，回答：

1. 现存三套终态语义盘点——active-turn registry 的 business receipt
   （`server/sessions/active-turn.mjs`）、run-store 的 closure 状态机
   （`server/reasoning/run-store.mjs`）、action-store 的幂等对账
   （`server/store/` 与 `server/safety/action-dsl.mjs` 一带）——各自的状态集、
   终态触发者、持久化位置、相互引用点（file:line）。
2. `docs/superpowers/specs/2026-07-15-hallucination-governance.md` 的 receipt+done
   状态机与上述三套的重叠与冲突；是"第四套"还是收编（预判是扩展 run-store
   closure，须论证或推翻）。
3. 收编路径建议：谁是终态唯一 owner、迁移步骤、测试策略。**只出报告，不改代码。**

---

## 全局约束与交付

- TDD：每个行为改动先有失败测试再实现；不得削弱既有断言换绿。
- 提交粒度：T1 / T2 / T3 / T4 / T5 各自独立提交（或 T1+T2 合并），每次提交前
  在 `mstd-orchestrator/` 内全量 `npx vitest run` 且 `git diff --check`。
- `.env` 纪律：只做 spec 明示的行级增删；绝不回显、绝不提交、绝不动密钥行。
- 变异抽查还原严禁 `git checkout --`（会连未提交实现一起回退），只能反向编辑；
  T1 的 `git restore` 是唯一例外（其目的就是丢弃未提交实验）。
- 如实报告：任何一步失败、跳过、或与本 spec 预期不符（如测试基线不是 1387），
  停下记录并上报，不得静默绕过、不得虚报完成。
- 交付报告：逐 T 列出提交 hash、测试结果数字、真机证据（T6）、遗留问题。
