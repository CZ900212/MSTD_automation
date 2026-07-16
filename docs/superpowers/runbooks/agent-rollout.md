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

## 0.5 可复现构建与发布证据（Phase 7）

发布候选必须来自一个 **clean SHA**，安装、验证、构建和清单生成都在该 SHA 的独立工作树完成。不得从开发中的脏工作树复制 `node_modules` 或 `dist`。运行时契约为 package 中声明的 Node 22.19+（且小于 23）与 npm 10.9.8；锁文件只能通过 `npm ci` 消费，不在发布窗口更新依赖。

```bash
git status --porcelain --untracked-files=all   # 必须无输出
node --version                                 # v22.19+ 且 <23
npm --version                                  # 10.9.8
npm --prefix mstd-orchestrator ci
npm --prefix mstd-ui ci
npm --prefix mstd-orchestrator test
npm --prefix mstd-orchestrator run policy:eval
node mstd-orchestrator/scripts/dispatcher-eval.mjs --offline
npm --prefix mstd-ui test
npm --prefix mstd-ui run build
(cd mstd-orchestrator && node -e "import('better-sqlite3').then(() => console.log('better-sqlite3 load ok'))")
```

全部通过后生成非敏感发布清单；`--output` 必须指向仓库外的受控证据目录，以保持工作树干净。清单记录 commit、Node/npm、两个 lockfile 摘要、migration ceiling、UI artifact 摘要、架构开关和 target 集合摘要；不记录密钥或原始 session key。

```bash
node mstd-orchestrator/scripts/release-manifest.mjs \
  --verification-json '{"orchestrator_tests":"passed","policy_eval":"passed","dispatcher_eval":"passed","ui_tests":"passed","ui_build":"passed","native_module_load":"passed"}' \
  --output /受控证据目录/mstd-release-manifest.json
```

发布操作者把清单、测试输出和 UI artifact 摘要一并交给复核者。真实 provider eval、测试企业七段 E2E 和真机 smoke 必须另附时间、操作者、测试组织、结果和日志位置；没有生产/测试企业授权时不得用本地通过替代这些证据。

## 0.6 停机排空、启动恢复与回滚

1. **准备下一次启动配置**：rollout owner 先把候选版本固定为 `MSTD_AGENT_ARCHITECTURE_MODE=legacy`、`MSTD_ENABLE_WRITE=0`；记录变更时间和旧进程 PID。已有 daemon 不属于本次发布时按 PID 所有权规则暂停，不能代杀或启动第二个 consumer。
2. **维护窗口与排空**：当前 daemon 没有 SIGTERM 级的全局 graceful-shutdown hook，修改 env 也不会动态关闭正在运行的 consumer。因此只在无新消息的维护窗口切换；从调试台/日志确认没有活跃回合，并检查 `reasoning_dispatches` 无 `running`、`reasoning_runs` 无 `running`/`closing` 后才停旧 PID。若仍有在途工作就延期，不能用强杀冒充排空。代码中的 30 秒 **drain timeout** 只保护单个 active reasoner 回合的 final send；出现 `drainTimedOut=true` 时记录 session/task/run 和 in-flight 数，不重放用户消息，并在切换前等待 durable 状态收口或走事故回滚。
3. **切换与迁移**：只启动 clean SHA 的新进程。启动日志须显示 `schema_migrations` 已到发布清单中的 migration ceiling；迁移仅前向、幂等执行，回滚不删表、不降 schema。
4. **stale run 恢复**：新进程会先重试 dispatch `pending_send`（沿用稳定幂等键）、释放 stale running review 回 `pending_review`，再恢复 durable reasoner run 的 pending terminal send。准入新 review 前，核对启动日志没有持续 recovery failure，并抽查 DB 中没有超过恢复窗口仍卡住的记录。
5. **开闸顺序**：先 `legacy + write=0` smoke，再 shadow，最后只对已批准 targets active；写闸始终单独审批。每一步记录配置摘要、起止时间、健康指标和操作者。
6. **回滚条件**：重复发送、错误 target 出站、恢复队列不下降、migration 启动失败、drain timeout 持续发生或错误率越阈值时立即回滚。rollback owner 关闭 agent/write，切回上一份已验清单对应 SHA，以 `npm ci` 重建并启动 `legacy`；不得恢复旧数据库文件覆盖新 schema。
7. **回滚验收**：rollback evidence 至少包含上一/当前 SHA、两份 release manifest、开关摘要、PID、`schema_migrations` ceiling、`pending_send`/`pending_review`/running run 计数、smoke 结果、日志位置和事件时间线。确认 legacy 回复正常且无重复出站后才结束事故状态。

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

## 2.5 Responder 架构定向放量

- 默认 `MSTD_AGENT_ARCHITECTURE_MODE=legacy`，active targets 为空。
- 全局 shadow：设为 `shadow`；legacy 仍是唯一业务出站，新链只记录 telemetry，不能创建 dispatch/task/run/Pi。
- 定向 canary：设为 `active`，并把已批准的 canonical session key 写入 `MSTD_AGENT_ACTIVE_TARGETS`。未命中会话保持 legacy；`MSTD_AGENT_SHADOW_TARGETS` 命中会话只跑 shadow。
- 全局 active：设为 `active` 并显式设置 `MSTD_AGENT_ACTIVE_ALL=1`；所有合法会话走 Responder–Dispatcher–Reasoner，active targets 可保留作为历史灰度记录但不再限制范围。
- active 模式下既未打开 `ACTIVE_ALL`、targets 又为空，或 targets 含非法 session key时会启动失败。回滚时将 `ACTIVE_ALL=0`、清空 active targets、切回 legacy 并重启；写闸独立保持原配置。

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

## 4.5 机器人改名 SOP（C5,2026-07-12 已按此完成「小达」切换）

**顺序严格不可倒置**（先双名兼容,再改后台,最后切主名）：

1. **aliases 先行**：`.env` 写 `MSTD_BOT_ALIASES="<旧显示名>"`（值含空格/引号必须整体双引号包裹,`zsh -n` 校验通过再用）。重启 daemon 后真机发 `@旧名 在吗`,确认日志 `mode=addressed`。
2. **后台改名发版**：open.feishu.cn 开发者后台（应用 cli_aac4855d1a781cd6）→ 凭证与基础信息 → 国际化配置 → 应用名称改「小达」（应用描述为必填项,需一并填写）→ 保存 → 版本管理与发布 → 创建版本（版本号顺延,可用范围沿用上一版）→ 提交发布。本应用为企业自建+可用范围仅所有者,**免审核,提交即生效**;若未来可用范围扩大触发管理员审核,通知用户等待。
3. **切主名**：发版生效后 `.env` 改 `MSTD_BOT_NAME=小达`（旧名留在 aliases）。按 PID 所有权规则重启 daemon;真机分别 `@新名`、`@旧名` 各发一条,**两条都必须** `mode=addressed` 且入库 content 为 `[@我] …`（2026-07-12 实测通过）。
4. **回滚预案**：恢复 `.env` 双名配置（`MSTD_BOT_NAME=旧名`,新名进 aliases）→ 重启 → 后台按步骤 2 重新发布旧显示名版本。

**daemon PID 所有权规则**（本 SOP 全程适用）：操作前 `pgrep -af '[n]ode .*server/index.mjs'`;已有 daemon 且不是本次 rollout 记录的 PID → 不得代杀、不得起第二个 consumer（飞书对同应用多长连接负载均衡投递,双 consumer 会抢事件）,暂停等维护窗口。临时验证实例必须记录自己的 PID 并只清理它。

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
