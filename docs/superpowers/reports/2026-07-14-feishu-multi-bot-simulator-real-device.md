# 飞书三机器人模拟器真机验证记录（2026-07-14）

## 范围与完成标准

- 确认飞书桌面端登录态、测试群与群机器人配置。
- 执行 P0 bot 可见性探路并保留飞书 API 证据。
- 至少执行一轮走真实飞书入站链路的 smoke 场景，核对群内实际行为、inbox 与 trace。
- C/A 无法执行时，明确外部配置或进程所有权阻塞，不启动第二个 event consumer。
- 修复真机发现的测试门禁缺口，并通过契约、回归和现场负向复测。

## 环境发现

- daemon：PID 31007，监听 `8899`，启动于 2026-07-14 15:17；实现提交 `b9eb7e1` 于 17:11 完成，因此该进程仍运行提交前代码。
- 飞书桌面端已登录；测试群为 `mstd-agent E2E 群2`（ID 已脱敏）。
- 群内当前只有一个 bot：小达。另一个本机 app profile 存在，但未加入测试群；尚无林夕/周岩/何淼三个演员 profile。
- 当前 daemon 启动环境未开启 simulator、simulator ingress，也未配置测试群双白名单与 HMAC secret。

## 真机结果

### P0：A 模式探路

- `sim:probe` 结果：`nativeEligible=false`，原因 `actor_send_failed`。
- 直接诊断飞书 API 返回 `230002 Bot/User can NOT be out of the chat`。
- 结论：A 模式当前因演员 bot 未入群而不具备执行条件，尚不能判断“小达是否收到其他 bot 消息”。

### B 模式 smoke

- run ID：`41fb0a8b-2ce7-4e29-a091-e04067f28050`。
- 两条真实飞书消息均成功进入 inbox：
  - `@小达 在吗` → `addressed`；群内实际回复“在的，啥事？”。
  - `今天天气不错啊哈哈` → `ambient`；群内未观察到小达插话。
- 实际路由行为符合 smoke 预期，但旧 daemon 没有写入 `platform_message_id` 与 turn trace，原始自动报告因此为 `trace_missing`，不能作为当前实现的有效评分。

### C 模式

- 旧 daemon 的 `/api/simulator/v1/inject` 返回 404，符合其启动时未加载/未启用 simulator 的状态。
- 未重启或另起 daemon，避免建立第二个 event consumer；完整 C 回归等待 daemon 所有者按当前代码与 simulator 环境重启。

## 真机发现与修复

发现两个门禁缺口：

1. `sim:e2e` 只检查通用 health，会复用“健康但运行旧代码”的 daemon，直到发完消息才以 `trace_missing` 失败。
2. `npm run sim:*` 原先不读取项目 `.env`；本机 daemon 使用 `PORT=8899`，导演默认可能误连 `8787`。

修复：

- 新增 `/api/health/simulator`，暴露不含秘密的 `contractVersion`、`traceEnabled`、`ingressEnabled`。
- `sim:run` 与 `sim:e2e` 在发送前校验 capability；旧 daemon 或未开启 C ingress 时 fail-closed。
- `sim:probe`、`sim:run`、`sim:e2e` 统一用 Node `--env-file-if-exists=.env` 加载与 daemon 相同的本地环境。
- 支持 `MSTD_SIMULATOR_BASE_URL` 显式覆盖导演连接地址。

## 修复后验证

- 现场负向复测：
  - `sim:run` 对旧 daemon 退出码 3，原因 `gateway_simulator_contract_missing`。
  - `sim:e2e` 对旧 daemon 退出码 8，提示 stale/trace capability unavailable。
  - 两次复测 inbox 均保持 103，证明门禁发生在任何消息发送之前。
- 自动测试：
  - simulator/admit/inbox/trace：16 files，66 tests PASS。
  - turn-handler/config/model-log/session-store：4 files，103 tests PASS。
  - Bash/Node 语法与 `git diff --check` PASS。

## 仍需真机完成

1. 将至少一个演员 bot（最终为三个）加入专用测试群；再跑 P0，只有 `nativeEligible=true` 才开放 A。
2. 由现有 daemon 所有者用当前代码重启唯一进程，并启用 C 所需开关、secret 与双白名单。
3. 先跑 synthetic smoke/core，再跑 A smoke/core；报告不得含 skip/pending/todo。
