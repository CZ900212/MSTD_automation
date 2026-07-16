# 执行提示词：可靠性收敛·批次一

（2026-07-15，交付给执行模型的一次性任务提示词；随批次完成即失效）

---

你是本仓库的执行工程师，任务是完整执行一份已拍板的更改 spec，不做任何 spec 之外的决定。

仓库：/Users/admin1/Desktop/Dev/RSH_WUHAN/MSTD_automation

开工前按顺序读完三份文件，缺一不可：
1. `project.md` —— 产品意图最高权威。很多"看起来像 bug"的行为是记录在案的刻意设计，
   不得当缺陷修掉；与任何文件冲突时以它为准。
2. `CLAUDE.md` —— 硬规则速查（单测必须在 mstd-orchestrator/ 内跑、E2E 门控、.env 纪律等）。
3. `docs/superpowers/specs/2026-07-15-reliability-batch-one.md` —— 本次任务的唯一授权范围，
   含 T1–T7 七项，每项有现状、操作、验收。

执行纪律：
- 顺序：T7（只读审查）可先行或并行；T1→T2→T3→T4→T5 依序独立提交；T6（真机灰度）
  必须最后，且开始前把 T1–T5 的测试结果报出来。
- 每次提交前：在 mstd-orchestrator/ 内 `npx vitest run` 全量通过（基线 1387 passed /
  7 skipped，若你的起点数字对不上，先停下上报），`git diff --check` 干净。
- TDD：行为改动先写失败测试再实现；禁止削弱或删除既有断言来换绿。
- 范围收紧：spec 没写的一律不碰——不重构、不升级依赖、不动安全层
  （reply-egress / context-envelope / 审批门 / verbatim / 会话域门禁）、不改 project.md。
- `.env` 只做 spec 明示的行级增删，绝不回显内容、绝不提交。
- T6 的 `MSTD_AGENT_ACTIVE_TARGETS` 具体群 id 必须先向项目负责人确认，拿不到就停在
  T6 之前，把已完成部分交付。
- 如实报告：任何失败、跳过、意外（测试波动、模型 503、E2E 假绿迹象）都原样记录并上报；
  禁止虚报完成，禁止"应该没问题"式收尾。E2E 若出现整套快速通过，先怀疑
  MSTD_ENABLE_WRITE 缺失导致的静默 skip（这算 FAIL 不算 PASS）。

交付物：
1. 逐 T 的提交 hash 与测试数字；
2. T7 的审查报告 `docs/research/2026-07-15-receipt-coupling-review.md`；
3. T6 的真机证据（消息 id、启动日志关键行）或"停在 T6 前"的说明；
4. 遗留问题清单（包括 spec 中预告的观测项：gpt-5.6-sol 高推理下的工具异常率）。
