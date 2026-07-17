# GPT-5.6 迭代交接 Prompt（MSTD 常驻飞书助手）

> 用法：整份贴给 GPT-5.6 作为任务上下文，最底部「本次任务」处填当次要做的事。

---

你是本项目的资深工程师，接手一个**已全量落地、真机验证过**的系统做持续迭代。先读完本文再动手；动手前先读权威文档，不确定的事问用户，不要猜。

## 一、项目是什么

**常驻的公司级飞书全能助手**（对标 OpenClaw/Hermes 但更轻）：一个公司一个 agent，7×24 由飞书事件唤醒，支持私聊问答、群 @ 必答、群内旁听自主插话、写操作卡片确认、定时任务、心跳提醒、夜间记忆蒸馏（dreaming）、web 调试台。执行身份是单一服务账号，只区分「是谁在说话」。

- 权威设计文档（spec + 八 Phase 实施计划同文件，**改行为前必读对应章节**）：
  `docs/superpowers/specs/2026-07-09-feishu-resident-agent.md`
- 运行/测试/安全手册：`mstd-orchestrator/README.md`
- 运营手册（开闸/观察期/dreaming 切换）：`docs/superpowers/runbooks/agent-rollout.md`

当前状态：Phase A-H（52 个任务）全部完成并提交；单测 356 通过（orchestrator）+ 50 通过（mstd-ui）；四套真机 E2E 中 write/p2p/group PASS，e2e-full 于网络劣化夜间受阻（机制已验证，网络恢复重跑即可）。分支 `feat/resident-agent`。

## 二、架构速览（三模型协作）

```
飞书事件 → gateway(inbox 去重→debounce 合批→admit 准入→actor 串行)
  → turn-handler 回合执行器
      → V4 Flash 前台分诊（四选一：quick_reply 直出 / no_reply 落旁听 /
        steer 注入运行中回合 / escalate 灌上下文进中枢）
      → GPT-5.5 中枢（每活跃会话一个常驻 Pi 进程，工具循环：
        memory / session_search / propose_actions / background_job / lark-read / reply）
      → reply 工具 = Opus 出口（渲染终稿后出站）
```

**模型调用纪律（用户钦定，处处适用）**：每次调用 5 次×10s 重试 → 链内降级 → 全链耗尽才算 PipelineError。三条链：
- fast（分诊/快答，全链强制 non-thinking）：`v4-flash → opus-4.6 → gpt-5.5`
- reason（中枢）：`gpt-5.5 → opus-4.8 → v4-pro`
- respond（出口）：`opus-4.6 → v4-pro → gpt-5.5`

中枢还有**回合级降级**（`server/models/brain.mjs`）：runJob 失败/超时 → 杀 Pi → 沿 reason 链换 provider 重拉重放 → 同一回合重跑。出站 lark 调用有瞬时错误重试（`server/gateway/outbound.mjs`）。

**五层记忆**（文件制，`agent-memory/`，独立 git 仓）：`SOUL.md`（人格）/ `memory/ORG.md`（公司事实）/ `memory/journal/YYYY-MM-DD.md`（公司总账，每回合追加+脱敏）/ `memory/groups/<chat_id>.md` / `memory/users/<open_id>.md`。注入时冻结快照保 prompt 缓存。dreaming 每日 03:30 两阶段蒸馏（V4 提取→5.5 归并），append-only，默认 shadow 只出报告。

## 三、不可破坏的不变量（动这些等于事故）

1. **reply 是唯一出站通道**：daemon 永不外发 5.5 裸文本；brain 的 `finalText` 只落库为 `role=tool` 内部记录（`turn-handler.mjs`）。前台 V4 的 quick_reply 直出是唯一例外（设计如此）。
2. **模型永远不可信**：写动作形状由服务端 `buildAgentAction` canonical 化 + hash，模型只能选 action、填白名单字段；卡片 JSON 结构模型碰不到；记忆写入过注入扫描。
3. **四道锁写路径**：意图校验 → canonical+hash → approval token（绑发起人、TTL 30min、一次性）→ 回调 operator/token/hash 三重校验后才执行；执行带 dry-run、幂等 key（sha256 32hex）、启动对账。
4. **fail-closed 写闸**：`MSTD_ENABLE_WRITE=1` 才开写；目标必须过 `MSTD_TEST_OPEN_IDS`/`MSTD_TEST_CHAT_IDS` 白名单（空=全拒，`server/execute/write-target.mjs`）。
5. **记忆隔离铁律**：群 A 的记忆和私聊原文绝不注入群 B；scoped 层群会话只读本群、私聊只读本人（`server/memory/inject.mjs`）。
6. **密钥红线**：key/secret 只进 gitignore 的 `.env`（chmod 600），不进代码、日志、Git、报错信息。
7. **lark 调用只走 argv 白名单**：具名参数拼数组，chatId/openId/messageId 全部正则校验，无 shell 拼接。

改 `server/safety/` 或 `server/execute/` 后**必须全量回归** `npx vitest run`。

## 四、工程纪律

- Node ≥22，ESM（.mjs），Express，better-sqlite3（SQL 写法保持 Postgres 可移植，FTS5 trigram 是唯一例外）。UI 是 React+Vite+vitest（`mstd-ui/`）。
- **TDD**：先写失败测试→实现→全绿→提交。全量单测必须始终全绿（当前 356+50），不出网、秒级完成。
- 提交信息中文、`type(mstd): 摘要` 风格，一个逻辑单元一个提交。
- 行为变更同步更新 spec/README/runbook——文档即合同。
- 依赖能不加就不加；cron 解析、防抖、信号量这类都是手写的小件，保持零依赖风格。
- Pi 由 `@earendil-works/pi-coding-agent`（0.80.3）提供，经 `supervisor/pi-client.mjs` RPC 管理；工具壳在 `pi-ext/*.ts`，通过内部 HTTP（`MSTD_INTERNAL_TOKEN`）回调 daemon。

## 五、测试与真机 E2E

```bash
cd mstd-orchestrator && npx vitest run          # 全量单测（不出网，必须全绿）
cd mstd-ui && npx vitest run                    # UI 测试
```

真机 E2E（用户已授权直调其自建 test organization，授权可随时收回）：
```bash
set -a; . ./.env; set +a
export MSTD_E2E=1 MSTD_ENABLE_WRITE=1 MSTD_SESSION_SECRET=$(openssl rand -hex 16)
export MSTD_TEST_OPEN_IDS=ou_aca75bd11914b20bda06e2462a569593
export MSTD_TEST_CHAT_IDS=oc_11b72bc3d3bdedff7c86f3c4c61560fc,oc_b67c4510743e68be6a9a91f3906e7f97
for t in e2e-write e2e-p2p e2e-group e2e-full; do npx vitest run test/$t.test.mjs; done
```

**三条硬约束（违反必假失败）**：①先停本机 daemon（`pkill -f server/index.mjs`）——飞书对同一应用多条事件长连接负载均衡投递，残留 daemon 会抢事件且真回复；②多套 E2E 只能逐套串行（vitest 文件并行互相污染）；③写白名单 env 必须导出。

已知环境坑：CZ 网关（`api.cz900212.com`，5.5/Opus 都在后面）深夜偶发 503/挂起——e2e-full 三 provider 全超时先 `curl` 探网关延迟再定论；lark-cli（`~/.hermes/node/bin/lark-cli`，profile 在 `.env`）单 EventKey 一子进程、扁平 NDJSON、mentions 字段缺失靠 botName 文本匹配；heartbeat 活跃时段默认 9-21 北京时间，晚上测试要开 0-24；闲置 Pi 占并发位（`MSTD_MAX_CONCURRENT_PI` 钳 ≤3），连开新会话会无日志饿死第 4 个——调 `MSTD_PI_IDLE_MS`。

## 六、代码地图（改哪类问题去哪里）

```
mstd-orchestrator/
  server/gateway/    入站管道：consumer(长连接)/inbox(去重)/debounce/admit/
                     turn-handler(回合)/outbound(唯一出站+重试)/rate-limit/observe-report
  server/models/     caller(三链+重试)/triage(V4)/brain(5.5 Pi 池+回合级降级)/reply(Opus)/budget
  server/memory/     files(五层)/inject(隔离)/scan(注入扫描)/tool/compact/journal
  server/cards/      templates(Card JSON 2.0 固定模板)/confirm-flow(发卡→回调→异步执行→回注)
  server/safety/     action-dsl/approval(一次性token)/intent-schema/write-args/lark-read
  server/execute/    execute-action(四道锁)/write-target(白名单)/run-lark(argv)/reconcile-startup
  server/ticker/     ticker(单表分频)/cron-jobs+cron-runner/heartbeat/dreaming/session-expiry
  server/sessions/   session-key/store(transcript+observed)/actor(串行队列)/search(FTS)
  server/http/       admin-routes(调试台API)/internal-routes(pi-ext回调)/session/sse
  pi-ext/            Pi 工具壳（reply/memory/session-search/propose-actions/background-job/lark-read）
  test/              85+ 文件；e2e-*.test.mjs 为真机套件（MSTD_E2E=1 才跑）
mstd-ui/src/views/   调试台：SessionBrowser/AdminBoard/MemoryEditor/DebugChat + BoardView
```

## 七、候选迭代方向（用户未指定时可参考，按价值排序）

1. **生产开闸推进**（按 runbook）：配 `MSTD_ADMIN_OPEN_IDS`；真实群走 observe_only 观察期→看信噪周报→放开；写白名单从 test org 逐步扩容。
2. **dreaming shadow→apply**：积累若干天影子报告，人工审查质量后切 `MSTD_DREAMING_MODE=apply`（有 git 备份可回滚）。
3. **可观测性**：模型降级/重试/预算命中目前只有 stderr 日志，可落库进调试台（admit 判定已有先例 `observe_log`）。
4. **杂项收尾**：`mstd-ui/vite.config.ts` proxy 可配置化改动待提交；`.gitignore` 补 `mstd-orchestrator/db/`、`lark-*.png`；e2e-full 网络恢复后回归一次。
5. **性能**：记忆快照/系统提示的 prompt 缓存命中率验证；journal 摘要超长截断策略（现 1500 字符尾截）。

## 八、行事规则

- 先读 spec 对应章节和相关源码再改；接口/行为变更列出影响面。
- 每个任务：失败测试 → 实现 → `npx vitest run` 全绿 → 提交 → 简报（做了什么/为什么/怎么验证的）。
- 碰到真机验证需求，按第五节硬约束执行；测试目标只允许 test org 白名单。
- 不确定的产品决策（口吻、限额数值、放开范围）问用户，不要自作主张。
- 遇到与本文冲突的代码现状，以代码+spec 为准并向用户报告差异。

---

## 本次任务

（在这里填写当次迭代的具体任务、验收标准、约束）
