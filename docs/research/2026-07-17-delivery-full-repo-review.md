# 民商通达 / 小达 — 交付前整仓库审查报告

审查对象：`/Users/admin1/Desktop/Dev/RSH_WUHAN/MSTD_automation` 工作树当前状态（feat/resident-agent，含未提交改动）。全部发现均经对抗性复核（confirmed = 复核人亲读代码、逐条尝试驳倒后仍成立），严重度以复核人校准后的等级为准。全部 confirmed 发现均已对照 project.md 排除刻意设计——**无一条与 project.md 记录在案的刻意设计冲突**（双回复、兜底话术、observe 沉默等均未被误报）。

---

## 一、总体结论：**go-with-fixes（修复后可交付）**

整体架构骨架是健康的：写审批四道锁、reply-egress 出站唯一出口、会话域门禁、internal token 绑定、active-turn 不变量、SOUL/记忆授权边界等核心安全内核经复核全部扎实，测试面 1546 用例 0 挂、无 vi.mock 自欺。**但不能按现状交付**，原因是存在一组集中于三个主题的 high 级缺陷：(1) **observe_only 观察期门禁在 wire 合批处被折叠成 ambient，"绝不出站"保证在生产路径完全失效且单测假绿**——这是三个审查单元独立追出的同一根因（wire.mjs:96）；(2) **一批"承诺后无下文/静默停摆"类缺陷**（消费者 spawn 失败永不重启、后台 job 崩溃残留 running 永不回收、attach 窗口吞掉用户纠正、closing 态 brain 永久死锁、双队列交叉饥饿），直接冲撞 project.md 第二节条件闭环与第四节第 8 条"不装聋"的产品承诺；(3) **写路径两处对账缺口**（enableWrite=false 启动跳过本地对账、create_event 无幂等可重复建日程）触及章程明文的"幂等对账"支柱。此外评测侧 grader 的 unauthorized_writes 安全门自上线起因引用不存在的列而永久失效（实测确认），交付验收的把关能力本身有洞。以上 high 项修复面均不大（多为补 finally/补分支/补对账/改一处 SQL），建议收口后再交付；无需推翻架构。

---

## 二、各单元健康度一览

| 单元 | 一句话评估 | confirmed |
|---|---|---|
| gateway-inbound | 入站结构清晰，但 observe_only 折叠 + 消费者 spawn 失败永不重启两处硬伤 | 3 |
| gateway-turn-outbound | 出站骨架扎实（deliverText 唯一出口、幂等 key 到位），observe_only 同根缺陷 + 两处静默失败 | 3 |
| models-caller-brain | 底座健康，C0.2 语义无回归；4 处 medium 以下（截断计费、驱逐雪崩等） | 3 |
| models-roles | 三角色语义与定案一致（补网/枚举边界/兜底方向均在位）；progress 解析矛盾等 4 处 | 4 |
| safety-egress-disclosure | 安全内核非常扎实；唯一问题是 security-fast-path 建好未接线 | 1 |
| safety-write-approval | 四道锁扎实；执行窗口可靠性尾巴（对账 gating、create_event 幂等）2 高 2 低 | 4 |
| sessions-memory-store | 查询面/授权边界严谨；生命周期纪律两缺口（closing 死锁、压缩无事务） | 5 |
| reasoning-jobs-ticker | 状态机设计扎实，但交界处丢消息/丢结果/饥饿/崩溃盲区集中，本次问题最多的单元 | 7 |
| http-auth-routes | 鉴权面严密 fail-closed；剩两处次要资源治理 | 2 |
| pi-ext | 薄壳纪律良好；lark-read egress 登记静默 fail-open 一处 | 1 |
| simulator-eval | 骨架健康，但 grader 两处系统性放水 + active 流水线不可评测 | 7 |
| tui-bin-supervisor | 只读纪律良好；就绪判定假绿 + pi-client 无 SIGKILL 升级 | 2 |
| mstd-ui | 无 XSS 面、hash 绑定 fail-closed；均为可小成本修复的客户端状态/静默失败 | 4 |
| test-health | 1539/1546 过 0 挂，无假绿套件问题（e2e-internal-disclosure 游离门禁一条已被驳回） | 0 |

Confirmed 合计 46 条（其中 observe_only 为 3 条同根发现）；复核后无 critical，high 9 条（去重后 7 个独立问题）。

---

## 三、Confirmed 发现（按复核后严重度分组）

### HIGH（交付前必须收口）

**H1. observe_only 观察期门禁被 wire 合批折叠成 ambient，观察期群会真实出站，配套单测假绿**（三单元同根，修一处即收口三条）
- 位置：`mstd-orchestrator/server/gateway/wire.mjs:96`（根因）；受害门 `server/gateway/turn-handler.mjs:418`
- 失败场景：admit.mjs:43 对 policy=observe_only 群返回 `{ok:true, mode:"observe_only"}`（含 @小达），但 wire.mjs:96 的 flush 只有 addressed/ambient 两个出口，observe_only 恒被折叠成 ambient → turn-handler:418 的"落 observe_log、绝不出站"分支从生产路径永不可达，active 路径更是完全没有 observe_only 分支。观察期群成员发开放求助 → triage/responder 判 reply → 小达真实在"只观察"的群里发言，observe_log 恒空、observe-report 周报恒 `skipped:"empty"`。runbook 明确要求新群 onboarding 第一步设 observe_only，功能全部意义在此失效。git 追溯为 b9eb7e1 回归。`test/observe-only.test.mjs` 直接手工注入 mode 绕过 wire，属假绿。
- fix_hint：wire flush 保留 observe_only 第三态透传（勿二值折叠），给 handleTurnActive 补 observe_only 抑制分支；单测改走 ingestNormalized 真实管道验证零出站 + observe_log 落库。

**H2. lark-cli 消费者 spawn 失败（error 事件）永不重启，事件消费静默永久停摆**
- 位置：`mstd-orchestrator/server/gateway/consumer.mjs:32`
- 失败场景：重启只挂在 exit 事件；本机实测 spawn 失败（ENOENT 等）只发 error+close 不发 exit。重启循环中某次 respawn 撞上二进制替换/EMFILE/ENOMEM → 该 EventKey（全量入站或卡片回调）消费者永久死亡，daemon 存活、/api/health 仍 200，与已归档的"静默装聋"事故同类但更隐蔽。
- fix_hint：error 分支同样按 restartDelayMs 重排 spawnOne，并用一次性标志防 error+exit 双触发重复 spawn。

**H3. enableWrite=false 启动时全部对账被跳过（含无需 lark 的本地对账），executing 卡片/job 永久卡死**
- 位置：`mstd-orchestrator/server/execute/reconcile-startup.mjs:15`
- 失败场景：用户点"确认执行"→ 进程在执行窗口崩溃 → 以 MSTD_ENABLE_WRITE=false 重启（本项目已发生过的开关丢失签名）→ 全部对账 gating 在 runLark 上被跳过，连 schedule_reminder 的纯本地 DB 对账也一并跳过；job 停 executing、卡片永远"⏳ 执行中"、onExecuted 永不回注，且 executing 属 ACTIVE_JOB_STATUSES 令 owner 会话永不归档。agent 开/写闸关是受支持的稳定态，本地提醒场景为永久静默卡死。CHANGELOG:116 已登记该缺口，确认仍未修。
- fix_hint：拆分 gating——本地指纹对账与全本地写 job 的 finalize 无条件执行，仅远端对账 gating 在 runLark 上；让 recoverFinalizedExecutingCards 在任意启动可恢复本地-only 卡。

**H4. create_event 无幂等键且不被对账支持：超时/崩溃后经系统自弹的重试按钮重复建日程**
- 位置：`mstd-orchestrator/server/execute/execute-action.mjs:185`（对账不支持）、`write-args.mjs:55`（无 --idempotency-key，注释宣称的"启动对账兜底"不存在）
- 失败场景（无需崩溃）：日程已在飞书侧落地，run-lark 60s 超时 SIGTERM 杀 CLI → exitCode 非 0 → action 标 failed → 卡片 partial_failed 弹重试按钮 → 用户点重试 → 同一日程建两次。崩溃路径同理（boot 对账对 unsupported 盲目标 failed → 弹 retry）。直接违反 project.md 四.1 明文的"幂等对账"支柱。
- fix_hint：给 calendar +create 补 --idempotency-key（或补 create_event 对账分支）；unsupported 且 executing 的 action 应保守保留而非盲标 failed（这正是触发重试按钮的根因）。

**H5. brain closing 态永不过期，coordinator 的 finalizeTurn 不在 finally 内——一次闭合期投递失败即令该 task 永久死锁**
- 位置：`mstd-orchestrator/server/sessions/active-turn.mjs:114`；`server/reasoning/coordinator.mjs` closeRun 末尾
- 失败场景：required closure 的终态消息因飞书网络故障发送失败 → closeRun 抛出，finalizeTurn 被跳过（外层 catch 因 closureAttempted 不补），`task:<id>` 的 brain 卡死 closing；此后该 task 每次新 run 在 activate 处抛"active brain turn identity 非法"，重启前永久失效且无 sweeper。legacy 路径 turn-handler:532 恰恰在 finally 里做了同一不变量并配了警示注释，coordinator 漏了。
- fix_hint：finalizeTurn 挪进 closeRun/runJob 的 finally（幂等），或给 closing 态加 TTL 兜底。

**H6. dispatcher attach_existing 命中 run 收尾/排队窗口时用户纠正消息被静默永久丢弃**
- 位置：`mstd-orchestrator/server/reasoning/coordinator.mjs:642`
- 失败场景：目标 run 处于 closing/queued/刚结束（open 但不可 steer）时，attach_existing 分支只 attachMessage 链到 task、不写 runStore.attachInput → run 完成时 pendingInputs 为空、无 follow-up、dispatch 已标 done 不重试——用户纠正永久失踪。与 reinjector 走的 attachOrStart（先持久化 pending input）形成明确不对称，违反 project.md"补充/修正注入对应推理实例"与条件闭环。附带：635 行 busy 分支忽略 brain.steer 返回值，steer 竞态失败同样静默丢失。
- fix_hint：非 busy open-run 分支镜像 attachOrStart 先 attachInput；busy 分支按 steer 实际返回值决定，false 时同样落 input 兜底。

**H7. 后台 job 崩溃遗留的裸 'running' 状态无任何启动回收：会话永久豁免归档 + 承诺的结果永不回注**
- 位置：`mstd-orchestrator/server/jobs/background.mjs:43`
- 失败场景：进程在后台 job 240s 执行窗口内被部署重启（全仓无 SIGTERM drain）→ orch_jobs 行永久停 'running'——reconcile-startup 只收口 running_readonly/queued/running_write/executing，唯独漏了裸 'running'；该行命中 hasActiveJobForSession → session-expiry 永久豁免归档（记忆 flush 永不发生）；reinjector.onJobComplete 永不触发，推理机对用户的委托承诺永远没有下文，零告警。
- fix_hint：启动对账把裸 'running' 一并收口并对停滞 job 调 onJobComplete({ok:false}) 闭环给用户；或加按 updated_at 的时间型看门狗。

**H8. launcher 与 background 共享同一 semaphore 但各自只 pump 自己：槽位空闲时 queued job 无限期滞留，重启后被静默标 failed**
- 位置：`mstd-orchestrator/server/jobs/launcher.mjs:51`（background.mjs:98 同构）
- 失败场景：2 槽被后台 job 占满时妙记事件到达 → 会议 job 落 queued 进 launcher.queue；后台 job 完成后 release 只 pump background 自己的空队列 → 槽位空闲而会议 job 永久停 queued，直到偶然的下一次 launcher.submit；且下次重启 reconcile 把滞留 queued 直接标 failed——自动化静默丢单。反向同样成立。
- fix_hint：semaphore.release 通知所有等待方（统一 pump/dispatcher），或两队列各自独立 semaphore，再退一步加 ticker 周期 re-pump queued。

**H9. grader 的 unauthorized_writes 安全硬失败门引用不存在的列，自上线起永久静默失效（假绿，已实测）**
- 位置：`mstd-orchestrator/simulator/grader.mjs:156`
- 失败场景：查询用的 `job_actions.approval_token` 列从未存在（审批在 decisions.approval_token_id），且状态字面量 'executed' 也非真实状态——查询每次必抛、被 catch 归零 → 若 daemon 回归出未审批写，评测照样 unauthorized_writes:0 放行 passed。这条防御纵深回归探测通道从未工作过（生产写门的 fail-closed 本身独立且完好）。
- fix_hint：改查真实审批绑定（join decisions/approval_tokens）+ 真实状态 'succeeded'，查询出错 fail-closed 而非归零，并补一条断言 >0 的红队用例。

### MEDIUM（建议交付前修，逐条精简）

| 位置 | 问题 | fix_hint 摘要 |
|---|---|---|
| gateway/wire.mjs:51 | markSeen 先于处理持久化去重指纹，debounce 窗口内崩溃/kill 使消息永久丢失（入站纯 at-most-once，与出站 pending_send 恢复不对称）。注意：因 lark-cli 已 ack，仅挪 markSeen 位置无效 | inbox_events 加 handled 状态位 + 启动回放，或 SIGTERM drain |
| models/token-window.mjs:38 | 截断循环逐码点 Math.ceil 把 ASCII 计费放大 4 倍，ASCII 重的超预算 prompt 被过砍至预算约 1/4（brain.mjs:490 整串路径最重） | 循环内累加分数成本，仅比较时取整 |
| models/brain.mjs:264 | semaphore 等位每 500ms 驱逐一个新空闲 Pi 而 permit 要等 close（最长 3s+）才释放，burst-at-cap 下雪崩误杀热池 | 加在途驱逐记账，有在途驱逐时只等待 |
| models/responder.mjs:99 | progress 执笔 parser 对全文 /```/ 一律判失败，与提示词自宣"支持代码块"矛盾，含代码块的进度回复必失败（HTTP 500） | 先 JSON.parse 再做结构校验，围栏守卫收窄到 startsWith |
| memory/compact.mjs:49 | 压缩 softDelete×N + 摘要 append 无事务，中途崩溃/模型返回空串 → 删真留空，早期历史静默丢失 | 包 db.transaction；out.text 空则跳过压缩 |
| memory/compact.mjs:24 | active 路径 off-actor 触发下同会话可并行压缩，产生永久重复摘要污染每次重放 | 会话级 in-flight 单飞守卫或删除前重验阈值 |
| reasoning/coordinator.mjs:405 | run 失败路径不搬运 pendingInputs 且 origin 唯一绑定不可重入——已成功的后台结果永久丢失 | catch 路径镜像成功路径搬运 pending input |
| jobs/orchestrator.mjs:43 | claim 成 running_readonly 后 mkdirSync 在 try 之外，磁盘满/权限错时 job 永久卡死且吞错 | 纳入 try 并走 failIfRunning 兜底 |
| jobs/event-buffer.mjs:48 | 定时 flush 先 splice 后写库且无 try/catch：DB 异常丢事件 + uncaughtException 崩掉整个 daemon（全仓无兜底处理器） | 仿 ticker.mjs 包 try/catch；成功落库后再移除 |
| triggers/minutes-consumer.mjs:48 | 先落 dedupe 再建 job，建 job 失败该妙记永久不再触发（backfill 同墓碑封死），零告警 | 同事务或补偿扫 job_id IS NULL |
| simulator/grader.mjs:133 | terminal_within_ms 在终答缺失时静默跳过，路由判分只看决策不看送达——投递失败照样 PASS | 声明了 terminal_within_ms 而 terminal_sent_at 缺失应记 critical；waitMs 不小于场景最大值 |
| simulator/trace-reader.mjs:73 | 不识别 active 流水线词表，active daemon 下评测全红不可判分（fail-closed 但目标架构不可评测；本工作树 .env 已 active-for-all，sim:e2e 必红） | 识别 responder_* 并回接 dispatcher 决策/推理终态 |
| scripts/simulator-e2e.sh:79 | 收尾门禁取"最新目录"必然命中 locks/（复核实证），line 94 ok 永不可达、skip 检测成永久 no-op；status grep 会匹配嵌套 grade.status | 按 runId 定位目录，jq/node 精读顶层 status |
| bin/mstd:125 | agent!=1 时启动就绪只凭 /api/health 200，端口被截胡（已知 8787 坑）时报假成功、PID 残留 | 就绪判定要求本进程身份信号（listening 日志行或 health 回 pid） |
| supervisor/pi-client.mjs:166 | close() 超时只发一次 SIGTERM 即 resolve，不等退出不升 SIGKILL——挂死 pi 永久泄漏且并发额度提前释放（仓内 stopOwnedProcessTree 已有正确升级模式） | 等 close 事件才 resolve，SIGTERM 后宽限升级 SIGKILL |

### LOW（择机修，压缩列出）

- `gateway/turn-handler.mjs:247` — 首答发送失败后 pending_send 无运行期重投（仅重启恢复），注释与事实不符；加 ticker 泵或改注释+挂告警。
- `gateway/observe-report.mjs:33` — 周报发送失败仍烧掉本周档期且吞错；投递成功后再提交 lastObsWeek。
- `models/brain.mjs:578` — 粘滞兜底 provider 的 resident 失败时整回合失败、不回探主 provider；改"本回合已尝试集合"驱动（属降级语义变更，按 project.md §5 先确认）。
- `models/triage.mjs:24` — advice/factual 护栏只拦 quick_reply 不拦 no_reply，点名事实问答被快机误判 no_reply 时装聋（与已修的 recap 护栏、responder 的 addressed 兜底方向不对称）。
- `models/triage.mjs:173` — 解析失败兜底不分 mode 一律 escalate+ack，ambient 群会插话"收到,我看看哈"；在 enforce 中按 mode 分叉为 no_reply。
- `safety/security-fast-path.mjs:222` — 入站攻击分类器造好+单测却完全未接线（P0 计划 Task 3 未交付，团队已知）；接线或显式标注 staged。
- `execute/run-lark.mjs:13` — 超时只发一次 SIGTERM 无 SIGKILL 升级，CLI 挂起时 Promise 永不 settle（重启前卡死）。
- `safety/action-dsl.mjs:159` — create_event 时间校验接受无时区/纯日期串，日程随执行环境时区漂移；对齐 schedule_reminder 的 parseStrictIsoWithTimezone。
- `sessions/search.mjs:32` — 模型可控 query 直传 FTS5 MATCH 无捕获（工具对含引号/括号查询整体失效，优雅降级）；limit 未钳制（-1=无上限）。加 try/catch + 钳 limit。
- `memory/files.mjs:58` — 记忆文件覆盖写非原子，崩溃/断电可截断 SOUL.md 且无备份；改 tmp+rename。
- `http/sse.mjs:33` — SSE 回放段无 try/finally，DB 抛错时订阅泄漏（含无界 backlog）；回放包 try/catch 或先注册 close 清理。
- `auth/routes.mjs:13` — auth_challenges 表 INSERT-only 无清扫（simulator_nonces 已修同类问题）；加过期 DELETE。
- `pi-ext/lark-read.ts:84` — reportSource 登记失败静默 fail-open 且零可观测（缓解：mail_message 仅限 owner 私聊、verbatim 本为辅助信号层）；至少补日志/留痕，fail-closed 改法需负责人确认。
- `simulator/process-owner.mjs:12` — chat 锁 existsSync+write 两步 TOCTOU（纯离线 eval 工具、微秒窗口）；改 `{flag:"wx"}` 独占创建。
- `simulator/scenario-schema.mjs:93` — security_hard_fail/ack_required 无布尔校验，`yes`/`1` 静默禁用逐 turn 安全通道（run 级仍被 accuracy/全局扫描兜住）；强制 boolean/整数。
- `simulator/runner.mjs:70` — burst 内层不复查 max_turns/墙钟（速率节流仍在，需病态场景触发）；检查下沉进内层循环。
- `supervisor/write-smoke.mjs` 见 uncertain。
- `mstd-ui/src/App.tsx:69` — job stream 错误全吞、401 不触发重登（内部调试台、易恢复）；补 401 分支与错误横幅。
- `mstd-ui/src/api/auth.ts:55` — 无条件采信 #token= fragment（登录 CSRF/会话固定）+ decodeURIComponent 可抛异常卡死加载页；加 nonce 绑定 + try/catch + bootstrap 补 .catch。
- `mstd-ui/src/views/MemoryEditor.tsx:41` — open() 无错误处理，加载失败跨层串显内容并诱发误导性 .bak/漂移报错；补 try/catch 复位状态。
- `mstd-ui/src/views/DebugChat.tsx:92` — Enter 未过滤 IME 组合态，中文输入确认候选词即误发半截消息；加 `!e.nativeEvent.isComposing`。

---

## 四、Uncertain 发现（复核未定论，建议人工再看）

1. **pi-ext/lark-read.ts:33** — runLark 超时只 SIGTERM、resolve 依赖 close 事件，理论上存在挂起路径（孙进程持管道/SIGTERM handler 卡死）。复核：被 240s 服务端回合超时背板兜住，"无限挂起"不成立；触发依赖 lark-cli 内部行为、仓内无证据；且是跨读/写两路的统一写法。可选加固：改听 exit + SIGKILL 升级（与 run-lark.mjs:13 一并处理）。
2. **supervisor/write-smoke.mjs:45** — 用法注释写 MSTD_ENABLE_WRITE=1 但代码从不检查，未开写闸也真写。复核：脚本本就是真写 smoke、结果全程可见、assertTestTarget fail-closed 夹死爆炸半径，"操作员以为干跑"属虚构预期；但代码/注释确实不一致。二选一：入口加开关检查，或删掉误导性注释。
3. **test/event-buffer.test.mjs 等（覆盖缺口清单）** — 工作树多处新增逻辑（event-buffer seq 回收、lark-read 超时、brain_turn 遥测、UI 三处）零测试。复核：缺口客观存在，但旗舰项的技术依据有误（job_events 无 UNIQUE(job_id,seq) 约束，风险是 SSE 续传漏一条而非崩溃），且五处新代码本身均正确。若补测优先 event-buffer 回收守卫与 lark-read 超时分支。

---

## 五、附录

### 被驳倒的发现：9 条

典型误报原因（按频次）：

1. **忽略了既有防护/兜底层**（最常见）：如 consumer onEvent 异常隔离（实际有防护链）、prompt 截断丢注入声明头（context-budget 已按源码点边界重预算）、UI 过期流回调竞态（陈述的 repro 路径不可达）。
2. **把部署边界当代码缺陷**：internal 通道未强制 loopback（token 绑定已构成有效边界，部署面另论）。
3. **把在案设计/已知权衡当缺陷**：60s 同文去重（有设计依据与审计）、applyFormValue 表单改写（hash 绑定语义实际覆盖）。
4. **对测试基建的门禁范围理解偏差**：e2e-internal-disclosure 游离门禁、e2e-write 单套裸跑假绿——实际门禁/preflight 覆盖方式与陈述不符。
5. **参数展开顺序污染审计**（internal-channel）：服务端 fail-closed 兜住，实际危害不成立。

### 未复核的低优先级发现

无——全部发现均已复核。

### 与 project.md 的张力

无 confirmed 发现被判定为 is_deliberate_design=true。相反，多条 high 项（H3/H4/H6/H7 及 triage no_reply 洞）恰恰是**实现落后于 project.md 已定案承诺**（幂等对账、条件闭环、点名不装聋）的缺口，修复方向与章程一致；仅 brain.mjs:578 降级语义与 lark-read fail-closed 改法两处，按 project.md §5 需先与负责人确认修法。