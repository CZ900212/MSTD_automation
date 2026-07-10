# 小达（常驻飞书助手）上线开闸运营手册

> 适用：mstd-orchestrator 常驻 agent（spec: `../specs/2026-07-09-feishu-resident-agent.md`）。
> 原则：**每一道闸独立、可回退；出问题先关闸再排查**。总开关 `MSTD_ENABLE_AGENT=0` 一键回到静默。

## 0. 前置检查清单（每次上线/迁移必过）

- [ ] `.env` 存在、`chmod 600`、已 gitignore；key 从不进代码/日志/Git
- [ ] `node server/index.mjs` 冷启动无 fail-fast 报错（报错清单会一次性列全缺项）
- [ ] `npx vitest run` 全绿（安全内核回归红线）
- [ ] `MSTD_E2E=1 MSTD_ENABLE_WRITE=1 npx vitest run test/e2e-full.test.mjs` 七段剧本 PASS（test org）
- [ ] lark-cli profile 有效：`lark --profile <p> auth status`；机器人应用版本为最新已发版
- [ ] 本机无残留 event consumer（`pgrep -fl "event consume"`；同 EventKey 每主机只能一个消费者）
- [ ] web 调试台可登录、六 tab 正常（会话/看板/调试台/记忆/调试对话）

## 1. 生产应用发版（含敏感权限）

1. 飞书开放平台 → 应用 → 权限管理：确认已勾 `im:message`（收发）、`im:message.group_msg`（**敏感权限，需管理员审批**）、任务/日历写权限。
2. 每次改 scope 后**必须创建新版本并发布**（scope 不随保存生效，只随发版生效）；灰度可用测试企业先发。
3. 事件订阅：`im.message.receive_v1`（长连接模式）；一 EventKey 一消费进程由 daemon 自管。
4. 发版后用真机 smoke：私聊 bot 一句"你好"，确认日志出现 `[agent] turn kind=message`。

## 2. 写闸逐步放开（四道锁之上的运营闸）

写路径本身有四道锁（intent→canonical+hash→approval token→操作人/令牌/hash 校验+幂等），运营层再分三步：

| 阶段 | 配置 | 说明 |
|---|---|---|
| ① 只读 | `MSTD_ENABLE_WRITE=0` | 写意图只发确认卡文案预览，不真写 |
| ② 白名单写 | `=1` + `MSTD_TEST_OPEN_IDS`/`MSTD_TEST_CHAT_IDS` 只含运营者自己 | 真写但目标 fail-closed（白名单外一律拒） |
| ③ 逐步扩圈 | 白名单按人/群逐个追加 | 每加一个目标，观察一周审计（调试台·写动作审计）无误写再加下一个 |

**永远不要**一次性清空白名单换成"全放开"——保持 fail-closed 语义，全员放开 = 把全员 open_id 列进白名单，动作有审计可查。
回退：任何误写 → `MSTD_ENABLE_WRITE=0` 重启，再查 `job_actions` 审计与幂等键核对影响面。

## 3. 新群接入 SOP（观察期两周）

1. 拉 bot 进群；`group_policies` 落 `observe_only`（默认新群建议先 observe_only）：
   ```sql
   INSERT INTO group_policies (chat_id, policy, hourly_proactive_limit, updated_at)
   VALUES ('oc_xxx', 'observe_only', 4, strftime('%s','now')*1000)
   ON CONFLICT (chat_id) DO UPDATE SET policy='observe_only';
   ```
2. 观察期判定照跑但**一律不出站**，结果落 `observe_log`；每周一 09:00 自动 DM 管理员信噪报告（该群若开旁听会说什么/信号噪声比）。
3. **两周后看报告决策**：
   - 信噪好、群欢迎 → `ambient`（旁听可主动接话，受限额器约束：小时限额 + 连续主动≤2）
   - 信噪差 / 正式群 → `mention_only`（只答 @）
   - 不适合 → `disabled`
4. 调整后在调试台·会话浏览器盯 3 天 admit 判定流水（徽标可读），有误接话随时降级 `mention_only`。

## 4. dreaming shadow→apply 切换条件

默认 `MSTD_DREAMING_MODE=shadow`：每晚 03:30 只产出 `memory/dreams/YYYY-MM-DD.md` 报告，不写记忆层。

**切 apply 前必须同时满足**：
- [ ] 连续 ≥14 天影子报告人工审查（调试台·记忆 tab 可读），拟新增/拟失效条目无幻觉、无跨群串layer、无注入残留
- [ ] `agent-memory/` 独立 git 仓正常（每晚蒸馏前自动 commit 备份，`git -C agent-memory log` 可见）
- [ ] 记忆层字数在限内（ORG 4000 / group 2200 / user 1375），apply 后不至于挤爆注入预算

切换：`MSTD_DREAMING_MODE=apply` 重启。切换后第一周每天早上看 dreams 报告 + `git -C agent-memory diff HEAD~1`。
回滚：`git -C agent-memory revert/reset` 到蒸馏前备份 commit，改回 shadow。

## 5. 告警响应

| 告警/症状 | 第一反应 | 排查 |
|---|---|---|
| lark 健康检查失败 DM（`MSTD_ALERT_OPEN_ID` 收到） | 查 profile 是否过期：`lark auth status` | 重新 device-flow 授权；确认应用未被停用 |
| bot 全线沉默 | 查 daemon 存活 + consumer：`pgrep -fl "event consume"` | 同 EventKey 撞消费者（"another consumer (pid…)"）→ 杀旧进程重启 daemon |
| 回复但人格错乱/自称分诊员 | 查 `agent-memory/SOUL.md` 是否被改/丢 | git 回滚 SOUL.md；查 dreaming 报告是否误写 |
| 写动作失败堆积 | 调试台·写动作审计看 reason | `non_test_target`=白名单外（预期拦截）；`hash_mismatch`=改单后未重算（查 confirm-flow 日志） |
| token 花费异常飙升 | 查 `token_usage` 表按日聚合 | 降 `MSTD_DAILY_TOKEN_BUDGET`/`MSTD_SESSION_TOKEN_BUDGET`；查是否某群 ambient 太话痨 → 降策略 |
| 主动消息刷屏投诉 | 立即把该群策略降 `mention_only` | 查限额器 `proactive_log`；必要时调低 `hourly_proactive_limit` |
| daemon 反复重启 | 看 fail-fast 清单输出 | 多为 env 缺失/秘钥轮换后未更新 .env |
| 回复变慢/答非所问（疑似降级中） | 调试台看板·模型链路事件（`model_log`） | `model_retry` 密集=网关抖动（curl 探 CZ 网关）；`brain_fallback`=中枢换 provider 跑（回合会慢一档）；`pipeline_error`=全链耗尽，查三家 key/网络 |

## 6. 日常运维节奏

- **每天**：扫一眼调试台看板（job 失败、审计异常、模型链路事件）；dreams 报告（apply 期）
- **每周一**：看观察期信噪周报，决策群策略升降级
- **每月**：`.env` key 轮换检查；`agent-memory` git 仓大小；SQLite `VACUUM`（或迁移 Postgres 计划）
- **升级部署**：先 `MSTD_ENABLE_AGENT=0` 起新版本跑 fail-fast + 单测，再开闸；数据库迁移由 `schema_migrations` 自动追踪，不重复执行
