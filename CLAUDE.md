# CLAUDE.md — 本仓库 AI 会话开工必读

## 第一件事：读 project.md

[project.md](project.md) 是本项目产品意图与刻意设计的最高层说明，对开发者和 AI 同等生效。
**在把任何现有行为判定为缺陷、提出重构建议、或改变用户可见行为之前，必须先对照它**——
很多"看起来像 bug"的行为（双回复、兜底话术、群聊短平快等）是记录在案的刻意设计。

## 当前架构一句话

小达 = 飞书常驻助理。三角色：应答机（唯一对用户声音，先答）→ 独立调度器（事后评审是否需要深入）→
推理机（task 隔离的 Pi 进程，工具+推理，结果经 reply 交回应答机表达）。详见 project.md 第二节。

已知框架级问题（幻觉/速度/工具稳定性/模型返回）的完整诊断:
`docs/research/2026-07-15-framework-reliability-diagnosis.md`。

## 硬规则速查（踩过的坑，违反即返工）

- **全量单测必须在 `mstd-orchestrator/` 目录内跑**；仓库根跑会连带 ui/bid-browse 扫出假失败。
- **E2E 门控必须显式 export**：`MSTD_E2E` / `MSTD_ENABLE_WRITE` / `MSTD_TEST_OPEN_IDS` /
  `MSTD_TEST_CHAT_IDS`。缺 `MSTD_ENABLE_WRITE` 时 e2e-full 整套静默 skip（假绿）。
  正确姿势：`set -a; source mstd-orchestrator/.env; set +a` 后再 export 四门控。
- **生产开关必须落 `.env`**（`MSTD_ENABLE_AGENT` / `MSTD_ENABLE_WRITE` 等），
  只在 shell 里 export 会随重启丢失，小达静默装聋。
- **Pi 扩展跨扩展状态必须走 `globalThis`**：每个 `-e` 是独立 jiti 模块实例。
- **变异抽查还原严禁 `git checkout --`**（会连未提交实现一起回退），只能反向编辑。
- 设计变更确认边界见 project.md 第五节：所有改用户可见行为/核心语义的改动，动手前先向项目负责人确认。

## 文档地图

- `project.md` — 产品意图与刻意设计（最高优先级）
- `docs/superpowers/specs/` — 实现规格（与 project.md 冲突时以 project.md 为准）
- `docs/plans/` — 架构方案
- `docs/research/` — 调研与诊断存档
- `docs/operator-journal.md` — 操作员工作日志
