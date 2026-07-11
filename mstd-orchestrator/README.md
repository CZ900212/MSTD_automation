# mstd-orchestrator（常驻公司级飞书全能助手「小达」）

原「会议纪要单一流水线」已改造为**常驻对话式 agent**：24h 挂在飞书 test org 里，私聊/群聊即时应答，写操作走卡片确认，记忆分五层长期演化，夜间 dreaming 蒸馏。设计与实施计划见 `../docs/superpowers/specs/2026-07-09-feishu-resident-agent.md`，上线开闸手册见 `../docs/superpowers/runbooks/agent-rollout.md`。

## 架构一图流

```
飞书事件（lark-cli event consume，每 EventKey 一个子进程，扁平 NDJSON）
  → gateway/inbox 归一化 + MD5 去重 → debounce 3s → admit（disabled/mention_only/ambient/observe_only）
  → 预算闸 → 主动限额器 → V4 Flash 分诊（fast 链）
  → ↘ 直答（fast 链渲染）
    ↘ 升级 GPT-5.5 Pi 中枢（reason 链；池化、闲置回收、steer 注入）
        · 出站唯一通道 = reply 工具 → daemon /internal/reply → Opus 4.6（respond 链）渲染 → outbound
        · 写意图 → propose-actions → buildAgentAction 规范化+hash → 卡片确认（approval token 绑发起人）
          → 操作人/令牌/hash 三校验 → executeApprovedAction（dry-run→写→幂等）→ 终态卡 + 回注会话
  记忆：SOUL / ORG / journal / groups/<chat_id> / users/<open_id>（隔离铁律：群A绝不进群B）
  ticker 单轮询分频：cron / heartbeat(5min) / dreaming(03:30) / 会话过期 / lark 健康 / 周一信噪报
```

三条模型链（每级重试 5×10s 再降级）：
| 链 | 用途 | 顺序 |
|---|---|---|
| fast | 分诊/直答/journal 摘要 | v4-flash → opus-4.6 → gpt-5.5 |
| reason | Pi 中枢编排推理 | gpt-5.5 → opus-4.8 → v4-pro |
| respond | 对外中文出口 | v4-pro → gpt-5.5（2026-07-11 用户指令:回答不用 opus） |

## 目录

```
server/gateway/   # inbox/consumer/debounce/admit/outbound/turn-handler/rate-limit/observe-report
server/models/    # caller(三链) / budget / triage / brain(Pi池) / reply
server/sessions/  # session-key / store / actor(串行队列) / search(FTS)
server/memory/    # files(五层) / scan(注入扫描) / tool / inject / compact / journal
server/cards/     # templates(卡片结构固定) / confirm-flow(发卡→确认→执行→终态)
server/ticker/    # ticker / cron-jobs / cron-runner / heartbeat / dreaming / session-expiry
server/jobs/      # 旧流水线(readonly 段保留) + background(agent 后台任务) + reinjector
server/safety/    # action-dsl / write-args / action-store / approval / intent-schema（安全内核，回归红线）
server/execute/   # execute-action / write-target(白名单 fail-closed) / run-lark / reconcile
server/http/      # internal-routes(Pi⇄daemon) / admin-routes(web 调试台) / session / sse
pi-ext/           # Pi 薄壳工具：persona(系统提示词整体替换)/reply/memory/session-search/propose-actions/background-job/heartbeat/lark-read
agent-memory/     # 五层记忆文件（gitignore;独立 git 仓;SOUL.md 人格,缺失/为空时 agent 拒绝启动）
agent-workspace/  # 中枢 Pi 的 bash/文件工具工作目录(piCwd 迁出源码树;gitignore;MSTD_AGENT_WORKSPACE 可覆盖)
scripts/          # e2e-serial.sh:五套真机 E2E 串行 JSON 门禁(发布仪式)
```

## 部署 / 运行

```bash
cd mstd-orchestrator
cp .env.example .env && chmod 600 .env   # 填 key；密钥红线：只进 .env，不进代码/日志/Git
set -a; . ./.env; set +a
node server/index.mjs                    # 缺关键 env 会 fail-fast 打印全清单
# web 调试台：cd ../mstd-ui && npx vite  # 六 tab：工作台/看板/会话/调试台/记忆/调试对话
#   /api 代理默认 http://localhost:8787，daemon 不在本机时用 MSTD_API_URL 覆盖
```

启动要求（`MSTD_ENABLE_AGENT=1` 时 fail-fast 强制）：`MSTD_BOT_OPEN_ID` / `MSTD_BOT_NAME` / `LARK_PROFILE` / 三模型 key / `MSTD_SESSION_SECRET`，且 `agent-memory/SOUL.md` 必须存在且非空（空人格拒绝启动）。写闸 `MSTD_ENABLE_WRITE=1` 时必须给 `MSTD_TEST_OPEN_IDS` 或 `MSTD_TEST_CHAT_IDS`（白名单 fail-closed，空=全拒）。全部开关见 `.env.example`。改名过渡期旧名放 `MSTD_BOT_ALIASES`（双名命中点名）。静态 `MSTD_INTERNAL_TOKEN` 已废弃——内部通道 token 按 Pi 进程签发/吊销，不可手填。

**人格生效延迟**：SOUL/persona 提示词每个 Pi 进程只在拉起时读一次——改 SOUL.md 后，正在服务的会话要等该 Pi 回收（闲置默认 10min）后下次拉起才生效；急切换就重启 daemon。

**进程所有权**：任何脚本/操作只能停止自己记录的 PID。已有 daemon/event consumer 时不得代杀、不得起第二个 consumer（飞书对同一应用多条长连接负载均衡投递，双 consumer 抢事件）。

## 安全内核（回归红线，动前必读）

- **模型永远不可信**：写动作形状由服务端 `buildAgentAction` canonical 化 + hash；卡片 JSON 结构模型碰不到；记忆写入过注入扫描。
- **四道锁**：意图校验 → canonical+hash → approval token（绑发起人、TTL 30min、一次性）→ 操作人/令牌/hash 三校验后才执行；执行带 dry-run 与幂等 key（sha256 32hex，飞书 client_token 限长）。
- **写目标白名单**：`server/execute/write-target.mjs` fail-closed；测试期只允许 test org 白名单目标。
- 改动 `server/safety/` `server/execute/` 后必须全量回归：`npx vitest run`。

## 测试

```bash
npx vitest run                      # 全量单测（不出网;必须在 mstd-orchestrator 目录跑,仓库根会扫出 ui/bid-browse 假失败）
bash scripts/e2e-serial.sh          # 发布仪式:五套真机 E2E 串行 + JSON 统计门禁(passed>0 且无 failed/pending/todo,skip 假绿现形)
cd ../mstd-ui && npx vitest run     # UI 测试
```

真机 E2E 硬约束（违反必假失败）：

1. **独占前置**——`scripts/e2e-serial.sh` 先探测 daemon/event consumer，存在未知 PID 时打印清单退出（不代杀）；只有自己拉起的实例才能自己停。
2. **多套 E2E 只能逐套串行跑**——vitest 默认文件级并行，多套同打一个 test 群/私聊会互相污染。
3. 需导出写白名单：`MSTD_TEST_OPEN_IDS`（发起人）与 `MSTD_TEST_CHAT_IDS`（测试私聊+测试群），以及 `MSTD_SESSION_SECRET`；e2e-full 缺 `MSTD_ENABLE_WRITE=1` 会整套静默 skip（JSON 门禁判 FAIL）。
4. 持牌 user 只在 `oc_b67c…` 测试群；`oc_13c5…`（bot 建群）里发 user 侧消息会报 230002。

## 运营

- 新群接入 SOP、写闸逐步放开、dreaming shadow→apply 切换、告警响应：见 `../docs/superpowers/runbooks/agent-rollout.md`。
- 观察期：群策略 `observe_only` 判定照跑只落 `observe_log` 不出站，周一 09:00 DM 管理员信噪报告。
- 模型链路可观测：降级/重试/全链耗尽/预算命中/出站重试落 `model_log` 表（caller/brain/outbound 的 onEvent + budget onExceed，落库 fail-safe 不反噬主链路）；调试台看板「模型链路事件」或 `GET /api/admin/model-log?kind=` 查询。
- lark-cli 真机硬约束（单事件/stdin 保活/扁平 NDJSON/mentions 缺失靠 botName 文本匹配）：见 spec §Phase A。
- SQLite 方言例外（Postgres 迁移时需替换）：FTS5 全文检索（另换全文索引方案）；`store.recent`
  同 ts 用 rowid 定序（uuid 主键排序随机，Postgres 用自增序列替代 rowid）。
- 消息记号约定（C1/C3，persona 与 triage/replay 同源）：`[名字]:` 群成员发言；`[@我]` 该句对
  机器人说（规范化自 @主名/@别名/结构化 mention）；`[我]` 重放里机器人自己的发言；`[内部记录]`
  tool 行；`[群内最近消息-截至本批之前]…[/群内最近消息]` 群滚动窗口（30 条，复述/总结以它为准）。
- heartbeat 提醒走 `heartbeat_items` 表（owner-bound：owner=会话规范键，跨会话提醒必须经
  propose_actions 确认卡；`source_action_id` UNIQUE 幂等）。旧文件版 `HEARTBEAT.md` 已 quarantine
  （只读不再消费），迁移只认 DB。
- 出站 C6：`turn-handler.deliverText` 是 quick_reply/正式 reply/budget 拒绝/受信直投的唯一文本
  出口——`hasRichMarkdown` 命中（强信号单发或弱信号≥2类）走消息卡（markdown 组件，结构服务端
  冻结），否则纯 text；debug 会话落库即出站。
- 入站 @ 识别已知局限（C2）：扁平事件缺 mentions metadata 时，纯文本 @ 只能按 bot 名（主名+别名）
  做**有边界**匹配（`server/gateway/normalize.mjs`，左右双边界：前后是字母/数字/下划线都不算）——
  与 bot 完全同名的真人被 @ 时无法区分，会被当成点名机器人。该纯文本匹配对官方信封路径同样生效
  （打字型 @名 视为点名，属产品意图；引用他人话语里出现 @名 会误触发，靠 ambient 判定兜底）。
  靠唯一 bot 名与边界匹配降低风险，不能声称彻底消除；规范化前原文落 `inbox_events.raw_content`
  供审计复核，去重指纹（md5）亦基于原文。
