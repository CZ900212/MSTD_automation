# 飞书三机器人仿真评测运行手册

## 0. 目标与红线

- **目标**：用三个自然同事身份的 bot（或 C 模式合成事件）驱动小达群聊评测，自动阅卷路由/延迟/安全。
- **红线**：
  - 永远只有 **一个** 小达 event consumer；演员 bot **只发消息、从不消费事件**。
  - 模拟器不得代杀已有 daemon。
  - 写操作仍走确认卡；确认人只来自服务端 `MSTD_SIMULATOR_APPROVAL_OPEN_ID`。
  - 默认全关：`MSTD_ENABLE_SIMULATOR=0`。

## 1. 创建三个演员应用（A 模式）

1. 在飞书开放平台创建三个应用（林夕 / 周岩 / 何淼），**最小权限仅 `im:message:send`**。  
   **不要**给演员应用配置事件订阅 / event consume——少一个 scope 少一分风险，也避免误建第二个 consumer。
2. 分别为每个应用建立 lark-cli profile；secret 只从 stdin / 本地 `.env` 注入，勿写入 git。
3. 把三个 bot 与小达拉进 **专用测试群**（同时写入 `MSTD_TEST_CHAT_IDS` 与 `MSTD_SIMULATOR_CHAT_IDS`）。

## 2. 环境变量（fail-closed）

见 `mstd-orchestrator/.env.example` 中「三机器人仿真评测」段。要点：

| 变量 | 含义 |
|---|---|
| `MSTD_ENABLE_SIMULATOR=1` + `MSTD_E2E=1` | master 开关 |
| `MSTD_ENABLE_SIMULATOR_INGRESS=1` | 挂 C 入口 |
| `MSTD_SIMULATOR_SECRET` | ≥32 字符 HMAC |
| `MSTD_SIMULATOR_BOT_ACTORS` | `cli_xxx=lin_xi,...`；空=不启用 A |
| `MSTD_SIMULATOR_APPROVAL_OPEN_ID` | 写意图唯一确认人（须在 `MSTD_TEST_OPEN_IDS`） |

## 3. P0 探路（决定 A 是否可用）

前置：小达 daemon 已在跑；probe bot 已入测试群。

```bash
cd mstd-orchestrator
export MSTD_SIM_PROBE_PROFILE=... MSTD_SIM_CHAT_ID=oc_...
npm run sim:probe
```

输出 JSON：`nativeEligible=true` 才允许配置 `MSTD_SIMULATOR_BOT_ACTORS` 并跑 A。

## 4. C 模式日常回归（主力）

```bash
export MSTD_E2E=1 MSTD_ENABLE_SIMULATOR=1 MSTD_ENABLE_SIMULATOR_INGRESS=1
export MSTD_SIMULATOR_SECRET=$(openssl rand -hex 32)
export MSTD_TEST_CHAT_IDS=oc_... MSTD_SIMULATOR_CHAT_IDS=oc_...
# 启动/复用小达 daemon 后：
npm run sim:run -- --scenario simulator/scenarios/01-routing-core.yaml --transport synthetic
```

C 入口安全：loopback only；出现 `X-Forwarded-For` 直接拒；HMAC + nonce + 30s 时间窗；chat 双白名单。

`senderType=simulator` 按 **user 语义** 走 mention / 群 policy（@ 小达 → addressed；未 @ → observe/ambient）。

## 5. 阅卷与架构迁移说明

- Trace 表使用中性列名：`decision_action/source/guard/provider/latency_ms` + `pipeline`（`legacy`|`responder`），避免 triage 退役后改 schema。
- 场景 `route` 标签集版本见 `simulator/route-labels.mjs`（v1 旧 triage 词汇；v2 应答机词汇）。
- **双回复语义两代不同**，场景期望迁移时需整体复核：
  - **legacy**：escalate 常为短 ACK + 终态正式答复。
  - **responder**：真实首答 + 条件闭环（不一定有独立 ack 回合）。

## 6. 群 policy 与写操作

- 测试前记录群 `group_policies`；测后恢复。
- 写意图场景默认 **不自动点确认卡**；人工在测试 org 点卡。
- B 模式 user token 过期时明确失败，不静默换身份。

## 7. 真机门禁

```bash
MSTD_E2E=1 npm run sim:e2e -- --transport synthetic
# A 可用时：
MSTD_E2E=1 npm run sim:e2e -- --transport bot
```

报告目录：`mstd-orchestrator/simulator-results/<run-id>/`。含 skip/pending/todo 则整次失败。

## 8. Kill switch

- `MSTD_ENABLE_SIMULATOR=0`：关 A+C
- `MSTD_ENABLE_SIMULATOR_INGRESS=0`：只关 C
- 清空 `MSTD_SIMULATOR_BOT_ACTORS`：关 A
- 停止导演 CLI 不影响小达 daemon

## 9. 推荐全局顺序

1. 模拟器 Task 1–3（probe + 身份贯穿 + trace）
2. C 模式跑通 legacy 基线场景库
3. 应答机架构迁移 shadow 阶段用本场景库喂流量
4. 迁移完成后场景标签切 v2，并复核双回复期望

## 10. 迁移编号

SQL 迁移实施时取 **当时下一个空号**（本仓库落地时为 `018_simulator_trace.sql`）。两份计划互抢编号时，谁先合并谁占号。
