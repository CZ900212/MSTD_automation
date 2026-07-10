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
| respond | 对外中文出口 | opus-4.6 → v4-pro → gpt-5.5 |

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
pi-ext/           # Pi 薄壳工具：reply/memory/session-search/propose-actions/background-job/heartbeat
agent-memory/     # 五层记忆文件（gitignore；SOUL.md 人格）
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

启动要求（`MSTD_ENABLE_AGENT=1` 时 fail-fast 强制）：`MSTD_BOT_OPEN_ID` / `MSTD_BOT_NAME` / `LARK_PROFILE` / 三模型 key / `MSTD_SESSION_SECRET`。写闸 `MSTD_ENABLE_WRITE=1` 时必须给 `MSTD_TEST_OPEN_IDS` 或 `MSTD_TEST_CHAT_IDS`（白名单 fail-closed，空=全拒）。全部开关见 `.env.example`。

## 安全内核（回归红线，动前必读）

- **模型永远不可信**：写动作形状由服务端 `buildAgentAction` canonical 化 + hash；卡片 JSON 结构模型碰不到；记忆写入过注入扫描。
- **四道锁**：意图校验 → canonical+hash → approval token（绑发起人、TTL 30min、一次性）→ 操作人/令牌/hash 三校验后才执行；执行带 dry-run 与幂等 key（sha256 32hex，飞书 client_token 限长）。
- **写目标白名单**：`server/execute/write-target.mjs` fail-closed；测试期只允许 test org 白名单目标。
- 改动 `server/safety/` `server/execute/` 后必须全量回归：`npx vitest run`。

## 测试

```bash
npx vitest run                      # 全量单测（不出网）
MSTD_E2E=1 MSTD_ENABLE_WRITE=1 npx vitest run test/e2e-full.test.mjs   # 真机全链路回归（test org，已获授权）
cd ../mstd-ui && npx vitest run     # UI 测试
```

真机 E2E 硬约束（违反必假失败）：

1. **先停本机 daemon**（`pkill -f server/index.mjs` 后确认）——飞书对同一应用的多条事件长连接负载均衡投递，残留 daemon 会抢走测试事件（且它会真回复）。
2. **多套 E2E 只能逐套串行跑**——vitest 默认文件级并行，四套同打一个 test 群/私聊会互相污染：
   `for t in e2e-write e2e-p2p e2e-group e2e-full; do npx vitest run test/$t.test.mjs; done`
3. 需导出写白名单：`MSTD_TEST_OPEN_IDS`（发起人）与 `MSTD_TEST_CHAT_IDS`（测试私聊+测试群），以及 `MSTD_SESSION_SECRET`。

## 运营

- 新群接入 SOP、写闸逐步放开、dreaming shadow→apply 切换、告警响应：见 `../docs/superpowers/runbooks/agent-rollout.md`。
- 观察期：群策略 `observe_only` 判定照跑只落 `observe_log` 不出站，周一 09:00 DM 管理员信噪报告。
- lark-cli 真机硬约束（单事件/stdin 保活/扁平 NDJSON/mentions 缺失靠 botName 文本匹配）：见 spec §Phase A。
