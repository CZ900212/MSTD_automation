# 2026-07-16 全仓库代码质量审查（精简/质量/性能）

方法：多 agent workflow——11 个 Opus 4.8 探索 agent 按子系统全量审查（开工前强制对照 project.md 刻意设计），50 条原始发现去重后逐条交 Sonnet 5 对抗性 agent 证伪（默认立场：发现不成立，须亲自核查代码+全仓库 grep 引用+对照 project.md 才可确认）。全部 agent max effort，共 56 个 agent、约 546 万 subagent tokens、1598 次工具调用。

结果：50 条原始 → 6 条被证伪剔除 → **39 条 CONFIRMED**（high 1 / medium 10 / low 28），0 条存疑。

本报告只记录审查结论，未改任何代码。修复动手前注意 CLAUDE.md 硬规则（单测在 mstd-orchestrator/ 内跑；用户可见行为变更先过负责人）。

## HIGH（1 条）

### HIGH-1 [正确性] mstd-orchestrator/server/sessions/active-turn.mjs:154

**问题**：ensureTurn 轮换分支返回被 prune 删除的记录，未重新 sessions.set，导致新回合 record 脱离 sessions Map（业务回合单飞门禁失效）。

**证据**：line 138 `let rec = sessions.get(executionKey)` 捕获引用后，line 154 的短路条件 `!receiptLive(rec) && !brainLive(rec)` 会触发副作用：receiptLive/brainLive 在收集过期域时调用 prune()，当 receipt 已为 null、brain 过期可回收、initiator 为空时，brainLive 里的 prune() 执行 `sessions.delete(rec.executionKey)`（active-turn.mjs:94-98）。随后 155-162 的轮换分支仅改写 rec 字段并 `return rec`，唯独没有 `sessions.set(executionKey, rec)`（只有 139 的全新分支才 set）。receipts.begin(173-198) 走到这里后把 rec.receipt 挂到一个已不在 Map 里的对象上。

**建议**：在轮换分支开头补 `sessions.set(rec.executionKey, rec)`（幂等；若被 prune 删过即恢复），或让 ensureTurn 不依赖 Live 检查的 prune 副作用。

<details><summary>对抗证伪核查记录</summary>

全部核查通过，且已用两种独立方式（裸 node 脚本直接 import 生产模块 + 项目自带 vitest）针对真实代码做出可复现的实证，而非纯理论推导。

1. 逐行核对源码（mstd-orchestrator/server/sessions/active-turn.mjs），论断引用的每一处行号都精确无误：line 154 `if (!receiptLive(rec) && !brainLive(rec)) {`；155-162 轮换分支只改字段、`return rec` 无 `sessions.set`；94-98 `prune()` 内 `sessions.delete(rec.executionKey)`；151 是 `sessions.set` 唯一调用点（在 139 起的全新分支里）；173-198 是 `receipts.begin`。语义理解correct：`begin()` 自身的前置守卫只调用 `receiptLive(existing)`、从不触碰 `brain`，因此当 `rec.receipt` 已空而 `rec.brain` 处于 active/inFlight=0/已过期 时，`rec` 不会被前置守卫剪除，会带着"脏" brain 活着进入 `ensureTurn`；随后 154 行短路求值中 `brainLive(rec)` 才第一次探测到 brain 过期并触发 `prune()`，此时若 `initiator` 也为空，三域皆空即整条记录被 `sessions.delete`——但函数接着进入 155-162 分支只是在这个已经"游离"的对象上改字段并原样返回，从未把它放回 Map。

2. 构造具体触发场景并实测（两条独立证据链）：
   a) 裸 node 脚本直接 import 真实模块：先 `brainTurns.activate({sessionKey:"s", turnId:"t-auto", purpose:"automation"})`（未挂 taskId，executionKey 退化为裸 sessionKey——这正是 test/active-turn.test.mjs 第一个用例验证过的"business 回合"主干用法同款 key 结构），推进 clock 越过 brainTtlMs 但不做任何显式 finalize/clear（模拟崩溃/未处理异常导致的泄漏，文件顶部注释自陈"receipts 曾因缺 TTL 出过永久卡死"，证明这类泄漏在本仓库是真实发生过的场景类别，非臆造）；随后调用 `receipts.begin({sessionKey:"s",...})`。结果：`receipts.resolve("s")` 立即返回 null、`inspect("s")` 返回 null（刚创建的 receipt 变得不可达）；再次 `receipts.begin()` 未抛出"active turn 已存在"而是成功签发第二个并发业务回合（单飞门禁失效，与论断"业务回合单飞门禁失效"完全吻合）；对最初拿到的 receipt 调用 `complete()` 返回 `{ok:false, code:"stale_turn"}`（终态永远记不进去）。
   b) 同一场景用项目自带 vitest 复跑一遍（`npx vitest run` 于 mstd-orchestrator/ 目录内，符合 CLAUDE.md 硬规则），4 条断言全部 PASS，验证过程中未残留任何仓库改动（跑完即删除 scratch 测试文件，`git status` 确认干净）。
   基线也已确认：现有 28 条相关单测（active-turn*.test.mjs 四个文件）全部通过，说明现有测试套件确实没有覆盖"TTL 过期发生在 ensureTurn 内部而非外部前置守卫"这一特定间隙——不是"测试已经防住了、论断是臆想"的情况。

3. 排除"记录在案的刻意设计"：project.md 全文搜索不到任何与该行为相关的段落（"单飞""ensureTurn""sessions.set""prune""回合注册表"均零命中），不构成刻意设计。

4. 建议改法验证：在 scratchpad 复制模块并按建议在轮换分支开头补 `sessions.set(rec.executionKey, rec)`，重跑同一 bug 场景 + 额外补跑三个正常路径（业务 receipt/brain 配对直通、显式清空后整条记录回收拿新 lease、纯 receipt 泄漏的 TTL 兜底放行）——全部按预期通过，证明该补丁精准打掉此 bug 且不改变任何既有不变量/用户可见行为，纯属会话注册表内部记账修正，不涉及 `.env`、不用 `git checkout --`、不跑仓库根目录测试，未触碰 CLAUDE.md 任何硬规则。

impact 上调为 high 的理由：该 bug 的失效模式是完全静默的——不抛异常、不返回 rejection code，只是悄悄让"同会话至多一个活跃业务回合"这条被源码注释明确当作不变量看待的约束（"宁可 fail-loud 也不让新回合借走活跃回合的 lease"）失守，且触发前提（某个非立即清理的 brain/receipt 域撑到 TTL 才被回收）正是该文件顶部注释点名的、历史上已经真实导致过生产事故的那类"泄漏"场景，而非需要臆造的极端边角案例。一个原本设计为"兜底安全网"的 TTL 机制，在这个分支上反而把可观测的"卡死"故障模式换成了不可观测的"状态腐化"故障模式，属于同类问题里更隐蔽、更难在运维中察觉的退化。

</details>

## MEDIUM（10 条）

### MEDIUM-1 [死代码] mstd-orchestrator/pi-ext/lark.ts:56

**问题**：写能力版 lark 工具是被替代的旧实现：不在任何生产能力档，仅被未接线的手动 demo 加载

**证据**：server/pi/resident-extensions.mjs 的 PROFILE_SPECS（resident / readonly_job / background 三档）均不含 lark.ts；生产读路径是 lark-read.ts、写路径是 propose-actions.ts（经服务端审批门）。全仓库（排除 .claude/worktrees 副本）对 lark.ts 的唯一引用是 demo/run-meeting-job.mjs:31，而该 demo 未接入 package.json/supervisor，仅靠 `node demo/run-meeting-job.mjs` 手动跑。lark.ts 自身头注也标注为「本地验证版」，其 LARK_ALLOW_WRITE=1 一刀切放行 + 粗正则拦截（HIGH_RISK / HIGH_RISK_SUBCOMMANDS）正是 project.md §4.1「写操作一律经服务端审批门、只读不依赖提示词」所替代的模式。

**建议**：确认 demo/run-meeting-job.mjs 是否仍需保留；若 demo 一并退役则删除 lark.ts；若保留 demo，则把 demo 迁到 lark-read.ts + propose-actions.ts 后删除 lark.ts，消除这份与安全架构相悖的旧写路径。

<details><summary>对抗证伪核查记录</summary>

全部核查通过，未找到任何反证。

1. 代码位置与语义核查：读取 mstd-orchestrator/pi-ext/lark.ts 全文，第 56 行确为 `export default function (pi: ExtensionAPI) {`（工具注册入口）。第 20-30 行确认 `isBlockedWrite`：`LARK_ALLOW_WRITE=1` 一刀切放行，否则仅拦截 `--yes`/`delete`/`logout`/`recall` 等粗正则，`task +create`/`im +messages-send` 等真实写操作在默认状态下即可畅通（一旦设置该环境变量）。文件自身头注（第 6-7 行）自认是「本地验证版」，并写明生产版计划升级为 guard hook + 人在环路卡片确认（Phase 1.2）——即该文件自证是被规划取代的原型，而非声称中的生产设计。

2. Dead-code 全仓库排查（按步骤 2 要求覆盖 test/、scripts/、tui/、simulator/、mstd-ui/、pi-ext/、docs/、package.json scripts、动态引用）：
   - test/ 下多个文件命中的是裸字符串 "lark"（工具名 lark_read 等），逐一确认后无一处引用字面量 "lark.ts"。
   - scripts/、tui/、simulator/、mstd-ui/ 全部零命中。
   - pi-ext/ 内唯一命中是 lark.ts 自身的用法注释（自引用，非外部加载）。
   - 全仓库（排除 .claude/worktrees 副本）对 "lark.ts" 的代码级引用只有 demo/run-meeting-job.mjs:31 一处，与发现描述完全一致。
   - package.json scripts 无 demo/run-meeting-job 相关条目；全仓库搜索 "run-meeting-job" 除该文件自身外零命中；未发现 Procfile/docker-compose/plist/launch.json 等进程管理配置。
   - 检查 supervisor/pi-client.mjs、server/index.mjs、server/jobs/orchestrator.mjs、launcher.mjs：extensions 数组均显式来自 server/pi/resident-extensions.mjs 的 buildCapabilityProfile()（该文件头注自称"生产唯一真源"），无任何目录扫描/通配符加载逻辑会隐式捡到 lark.ts。

3. 生产能力档核查：完整读取 server/pi/resident-extensions.mjs，PROFILE_SPECS 确为 resident/readonly_job/background 三档，三档 extensions 列表均只含 lark-read.ts（工具名 lark_read），不含 lark.ts，与发现描述逐字吻合。

4. project.md 刻意设计核对：§4.1 第 1 条明确写着"写操作一律经过服务端审批门：action DSL、hash 绑定确认卡片和幂等对账；只读不依赖提示词，而依赖服务端授权"。读取 propose-actions.ts 头注："5.5 提出写意图的唯一入口……动作形状/hash/token/卡片全部由服务端定，确认后才真写"，与 lark-read.ts 头注"deny-by-default 只读白名单……无任何写能力"——二者正是 §4.1 所述架构的落地，lark.ts 的粗正则黑名单模式是被这套架构替代的旧模式，不是与之并存的另一种刻意设计。

5. 独立佐证（未被要求但发现的强支持证据）：docs/superpowers/plans/2026-07-10-resident-agent-security-reliability-fixes.md 中项目自己的实施计划已把 lark.ts 列为"Delete"目标，Step 7 原文称其为"unused unrestricted lark.ts extension"——项目自身规划文档独立得出了同样的"未使用"结论。git 时间戳佐证：lark.ts 自 2026-07-09 创建后再未被改动，而其替代者 lark-read.ts（2026-07-16 15:55）与 propose-actions.ts（2026-07-16 13:23）均为当天刚提交，commit message 明确写着"第①段切换 deny-by-default lark_read……只读真只读"和"Phase D 全量装配（propose_actions……)"，是有名有姓的架构迁移。

6. 建议改法核查：建议文本本身即以"确认 demo 是否仍需保留"为前提，未主张擅自删除，符合 project.md §5"改变用户可见行为/权限与审批门相关代码前须先向项目负责人确认"的边界；不涉及 CLAUDE.md 硬规则涉及的单测目录、E2E 门控、.env 落盘、globalThis 跨扩展状态或 git checkout -- 还原等场景，不构成违反。

补充发现（不影响 CONFIRMED 结论，但影响 impact 定级）：startPi()/buildPiArgs() 在未传 capabilityProfile 时会直接透传裸 extensions 数组、跳过 resolveCapabilityProfile() 的白名单校验，而 demo/run-meeting-job.mjs 正是走这条裸 extensions 路径；其头注写明感知/执行走"真实飞书"。也就是说 lark.ts 并非彻底惰性代码，而是"生产路径已完全绕开、但手动执行一行命令（node demo/run-meeting-job.mjs，配合 LARK_ALLOW_WRITE=1）即可对真实飞书租户发起不经审批门的写操作"的一份存活但未联线的旁路实现，风险层级略高于普通死代码清理项。

</details>

### MEDIUM-2 [死代码] mstd-orchestrator/server/execute/job-workdir.mjs:57

**问题**：sweepExpiredExports 是唯一清理 job out/ 产物的实现，但生产从未调用，导致 out/<jobId> 目录随作业无限增长。

**证据**：grep 全仓库（排除 worktrees/node_modules/dist）显示 sweepExpiredExports 仅被 test/job-workdir.test.mjs 引用，无任何生产调用方。同时 server/execute/job-workdir.mjs 内的 rmSync（第66行）是全 server/supervisor 目录里唯一一处删除 job 产物的代码；orchestrator.mjs:43-44 用 jobWorkdir(...) + mkdirSync(workdir,{recursive:true}) 创建 out/<jobId>，之后无任何路径删除它。这个 TTL 收割器就是本该被定时/启动调用的清理器，却是死代码。

**建议**：要么在启动/定时任务里真正接上 sweepExpiredExports（补上工件磁盘回收），要么若确认另有外部清理机制则删除该函数与其测试。二选一，别让它以‘看似已实现的清理’继续误导。

<details><summary>对抗证伪核查记录</summary>

逐项核查，未能证伪，判 CONFIRMED。

1. 代码真实存在且语义无误：job-workdir.mjs 第57行 `export function sweepExpiredExports(baseDir, ttlMs, now = Date.now())`，第66行 `if (now - st.mtimeMs > ttlMs) { rmSync(p, { force: true }); removed.push(p); }`，行号与语义（按 mtime TTL 递归清扫并删除过期文件）与论断完全一致。

2. 全仓库 grep（不限扩展名，排除 node_modules/dist/worktrees）确认 `sweepExpiredExports` 仅 4 处命中：定义本身、test/job-workdir.test.mjs 的 import+调用（纯单测，用 mkdtempSync 临时目录）、以及 docs/superpowers/plans/2026-07-09-mstd-ui-phase4-ui-real-writes.md 里的历史设计稿（该稿明确写"导出物由定时 sweepExpiredExports(base, TTL, now) 清理"——证明这本来就是计划中要接的定时任务，但从未落地）。生产代码零调用方。

3. 交叉验证唯一 import 者：orchestrator.mjs 只 import `jobWorkdir`（第7行），第43-44行 `jobWorkdir(...)` + `mkdirSync(workdir,{recursive:true})` 创建 out/<jobId>，全文件搜不到任何删除该目录的代码；pi-ext/lark-read.ts 只 import `readJobArtifactUtf8`（只读不删）。grep server/+supervisor/ 全目录的 rmSync/unlinkSync/rm -rf/rimraf，唯一命中就是 job-workdir.mjs 第66行本身——与论断"全 server/supervisor 目录唯一删除点"逐字吻合。

4. 排查外部清理机制：无 Dockerfile、无 systemd/launchd/cron 配置文件；package.json scripts 无 cleanup/sweep 脚本；.env/.env.example 无 TTL/SWEEP/EXPORT 相关配置项。已注册的 ticker 任务（server/index.mjs 547-603行：cron/heartbeat/dreaming/session-expiry/lark-health/token-watch/observe-report）里没有一个指向 job-workdir 清理。排除了"另有外部清理机制"的可能。

5. 比对 project.md 全文（153行通读）：第四节"其他刻意设计"9条逐一核对，均与路由、审批门、人格、会话域隔离等产品语义相关，无一提及 out/ 产物清理或磁盘管理；全文对 sweep/TTL/磁盘/导出清理零提及。不是记录在案的刻意设计。

6. 实测证据（非纯理论）：本机 mstd-orchestrator/out/ 目录当前实存 4153 个 job 子目录（`find ... -mindepth 1 -maxdepth 1 | wc -l` = 4153），mtime 横跨 2026-07-08 至 2026-07-16（即 sweepExpiredExports 随 236804f 提交引入以来的全部区间），且该目录被 .gitignore 显式声明为运行期产物（根 .gitignore 第8/36行）。这直接证实"随作业无限增长"不是假设而是正在发生的既成事实——只是当前总字节数因产物多为空/小文件而尚小（24K），风险体现在目录/inode 数量的无界累积，而非当下磁盘占用。

7. 建议改法合规性：ticker.mjs 是现成的"60s 基频 + N 分频"框架，`ticker.register("session-expiry", 10, () => expiry.sweep())` 已是同构范例，接入 `sweepExpiredExports` 只需比照写一行注册，属于纯内部资源回收、不改变任何用户可见行为，落在 project.md 第五节"可以直接执行的范围"（"用户可见行为不变的内部重构"），不触碰 CLAUDE.md 硬规则（不涉及 .env 生产开关、不涉及 globalThis 跨扩展状态、不是变异测试场景）。删除函数+测试的备选方案因未发现替代清理机制而不成立，故正确路径是接线而非删除。

修正影响评级为 medium：确认是真实且持续发生的无界资源泄漏（非纯理论风险），但当前字节量级尚小、无崩溃/数据丢失/安全后果，属于会随生产 24/7 常驻使用（尤其妙记会议纪要等产物写入）逐步恶化的运维债务，而非紧急故障。

</details>

### MEDIUM-3 [性能] mstd-orchestrator/server/gateway/turn-handler.mjs:84

**问题**：recentConversationBeforeTurn 每回合以 LIMIT 10_000 拉 promptRecent，远超 8,192-token 窗口所能消费的行数，大会话上严重过量取数。

**证据**：第 84 行 `store.promptRecent(session.id, { limit: 10_000, roles: ['user','assistant'] })`；promptRecent(store.mjs:196) 是 `SELECT * ... ORDER BY ts DESC LIMIT ?`，会全列物化最多一万行再 .reverse()，随后 tokenWindow 仅按 8,192 token（约数百行）截取。active 模式每回合经 handleTurnActive(184 行) 走此路径，shadow 亦然。真正边界是 token 窗口，10,000 只是防御上限，对超长会话是 10 倍以上的无谓物化与 GC。

**建议**：把该 SQL 上限降到覆盖 8,192-token 窗口最坏行数的安全裕量（约 3,000 即可），token 窗口仍是语义边界、结果不变，但显著减少大会话每回合的取数与对象分配。

<details><summary>对抗证伪核查记录</summary>

全部核查通过，判 CONFIRMED。实际核查证据：

1. 代码属实：turn-handler.mjs 第 84 行 `store.promptRecent(sessionId, { limit: 10_000, roles: ["user","assistant"] })`，紧邻注释明确写"SQL limit is only a defensive retrieval ceiling"，与论断一致。store.mjs:196-208 的 promptRecent 确为 `SELECT * ... ORDER BY ts DESC, rowid DESC LIMIT ?` 后 `.all().reverse()`，全量物化后翻转，无早停。token-window.mjs:64 的 tokenWindow 确以 8,192 token（DEFAULT_RESPONDER_HISTORY_TOKENS）为真实语义边界，从数组尾部往前挑满预算即 break。

2. 确认是热路径而非冷路径：recentConversationBeforeTurn 被 handleTurnActive（184行，每回合必经）和 observeTurnShadow（278行）调用。查生产 .env：`MSTD_AGENT_ARCHITECTURE_MODE=active` 且 `MSTD_AGENT_ACTIVE_ALL=1`——active 是当前对所有会话生效的生产默认架构，不是灰度小流量或实验路径，每回合必经此查询。

3. 实测量化（用真实 store.mjs/token-window.mjs 代码、内存 SQLite、插入 2 万条仿真短中文消息构造"大会话"）：promptRecent(limit=10000) 均值 15.3ms/次，limit=3000 为 3.4ms/次（4.5x），完整 recentConversationBeforeTurn 路径 11.3ms→3.55ms（3.2x）。更关键的是：同一批真实短消息下 tokenWindow 最终只用了 753 行填满 8,192-token 预算——取 10,000 行只用 753 行，过量取数在真实场景下就已成立，不只是理论最坏情形。底层驱动 better-sqlite3 是同步阻塞的，这段耗时会阻塞整个 Node 事件循环，波及同进程内其他并发会话的回合处理，不是"慢查询但不影响别人"。

4. "大会话"场景非纯假设：查 store.append/resolvePolicy 确认 ambient（旁听）消息的 observed 标记不影响 prompt_eligible，即群内旁听消息同样计入 promptRecent 扫描池；compact.mjs 的压缩阈值按字符量估算（content.length/2 > 60,000），是容量而非行数触发，配合 project.md 记录的"群聊回复默认短平快"设计，短消息密集的活跃群完全可能在压缩触发前积累数千至上万条 prompt_eligible 行。

5. project.md 第三节明确把"应答机每回合注入最近约 8,192 tokens"记为 2026-07-16 定案的刻意设计，但从未提及、更未要求 SQL 取数上限必须是 10,000——该数字是纯实现层防御常数（且经 git log 确认是本仓库最新一次提交 18ee827 当天新引入的，从固定 20 条改造成 token 窗口时顺手设的宽松保险值），改动它不触及 project.md 保护的语义边界。

6. 行为不变性验证：直接把该行改成 limit: 3_000，在 mstd-orchestrator/ 目录内跑了 4 个相关测试文件（143 用例）及全量单测（1525 passed / 7 skipped[e2e门控预期跳过] / 0 failed），随后用反向 Edit（非 git checkout，符合 CLAUDE.md 硬规则）精确复原，git diff 确认已完全还原。证明建议改法不改变任何被测的用户可见行为。

7. 唯一需要指出的细节偏差（不影响 CONFIRMED 结论）：建议值"约 3,000"在纯理论最坏情形下裕量偏薄——按 estimateTokens 逐字精算，whoLabel 回退到极短 ASCII 名+极短内容时最低约 3 token/行，8192/3≈2731，接近 3,000；若 sender_name 恰为空字符串（`??` 不会把空串当 nullish 处理，理论上可达 2 token/行），需要行数可到约 4,096，略超建议值。但这是极端边角场景，且原论断措辞本就是"约 3,000 即可"的示意值而非精确下限，不影响"10,000 相对实际所需是数量级过量"这一核心论断的成立；若采纳建议，实践中把常数取到 4,096~5,000 会更稳妥。

revised_impact 定为 medium：机制真实且验证充分（生产默认热路径、同步阻塞事件循环、实测多倍加速、零回归风险），但当前绝对耗时（现网大会话场景下约十余毫秒）相对 LLM 调用延迟（通常数百毫秒至秒级）不算主导因素，且该"active"架构是同一天刚上线的新代码，尚无证据表明已有生产会话真正积累到万级行规模——故不评为 high；但同步阻塞会波及同进程内所有并发会话这一点，比单纯"某个大会话自己变慢"更值得早修，故不降到 low。

</details>

### MEDIUM-4 [重复] mstd-orchestrator/server/http/internal-routes.mjs:53

**问题**：legacy turn 绑定推导在三个内部路由里逐字重复三遍。

**证据**：第 53-55、102-104、157-159 行完全相同：`const legacyTurnContext = !taskId && !runId;` + `const turnId = binding?.turnId ?? (legacyTurnContext ? body.turn_id ?? null : null);` + `const turnLease = binding?.turnLease ?? (legacyTurnContext ? body.turn_lease ?? null : null);`，分别出现在 /internal/reply、/internal/propose-actions、/internal/background。三处还各自重复 taskId/runId/dispatchId/executionKey 的 binding 解构。

**建议**：抽一个 `deriveTurnBinding(binding, body)` 返回 { taskId, runId, dispatchId, executionKey, turnId, turnLease }，三个路由复用，避免这段安全敏感（发起人/lease 归属）的推导日后在某一处被漏改而产生漂移。

<details><summary>对抗证伪核查记录</summary>

实地核查通过，未能证伪，结论维持 CONFIRMED。

1. 代码真实性与语义（第53-55/102-104/157-159行）：用 Read 打开 mstd-orchestrator/server/http/internal-routes.mjs 全文核对，三处逐字一致：
   `const legacyTurnContext = !taskId && !runId;`
   `const turnId = binding?.turnId ?? (legacyTurnContext ? body.turn_id ?? null : null);`
   `const turnLease = binding?.turnLease ?? (legacyTurnContext ? body.turn_lease ?? null : null);`
   grep 全仓库确认这9行三段字节级相同，且外围 taskId/runId/dispatchId 的 `binding?.X ?? null` 三行也在三处逐字重复（executionKey 仅 propose-actions 与 background 两处重复，reply 用 residentKey/residentEpoch 替代——这一点上发现的表述"四字段各自重复"略宽松，但不影响核心论断的准确性）。语义理解正确：这是从 token 绑定或（仅当无 taskId/runId 时）body 兜底推导 turn 身份，用于后续鉴权判断。

2. 排查是否已有共享实现/是否为死代码：grep `deriveTurnBinding`、`legacyTurnContext` 全仓库（含 test/、pi-ext/、tui/、docs/、另一 worktree）未发现任何现成的抽取函数或第二处引用——三处都是活代码，且均被 test/internal-routes.test.mjs 的 turn_id/turn_lease 用例实际覆盖（如267-272行伪造 task_id/run_id 探测越权），非死代码，非误判。

3. 历史成因加重了"漂移"论断的可信度：`git log -S legacyTurnContext` 定位到这三段是在同一个 commit（a728470 "fix(agent): complete durable run lifecycle"，2026-07-15）里被同时手写进三个路由的——即为了给三个内部路由补同一条安全语义，作者确实靠复制粘贴分别改了三处。这正是发现里"日后在某一处被漏改而产生漂移"担心的同类场景已经发生过一次。且最新一次 commit（18ee827，昨天，标题恰好叫"简化共享逻辑"）touch 了同一文件却没有处理这处重复，说明这不是"即将被清理的临时状态"。

4. 项目自身惯例佐证可抽取而非刻意内联：同文件顶部的 `guard()` 函数本身就是把六个路由共用的 Bearer 解析/body 校验/session_key 越权检查抽成了共享函数——说明作者在这个文件里本来就奉行"跨路由共用的请求解析逻辑要抽取"，legacyTurnContext 三处重复更像遗漏而非风格选择。

5. 对照 project.md：全文搜索未见任何关于本文件、turn binding 推导、或"刻意内联安全代码"的记录设计；第五节明确把"用户可见行为不变的内部重构"列入无需项目负责人确认即可直接执行的范围，建议改法（抽 `deriveTurnBinding` 返回值，三路由复用）属于纯值计算的合并，不触碰各路由后续互不相同的鉴权判断逻辑（reply 的 admission 检查、propose-actions 的 initiator 解析、background 的 activeBrainTurns.resolve 各自独立），不改变任何用户可见行为，不违反 CLAUDE.md 任何一条硬规则（不涉及测试目录、E2E门控、.env开关、Pi扩展globalThis、变异测试还原）。

6. 额外背景支撑"安全敏感"定性：docs/superpowers/specs/2026-07-10-agent-persona-prompt-design.md 第16行记录过该文件曾有的真实安全问题（S2：内部通道信任 body 自带 session_key，可跨会话冒名），此后才有本文件里"Model-supplied body.task_id 一律不信"的强注释与token绑定改造——在一个有跨会话冒名前科的文件里，三份可能漂移的身份推导逻辑，风险定性成立。

impact 修正为 medium：目前三处仍字节级一致，未观察到已发生的实际 bug 或线上事故，因此不评 high；但该推导结果直接喂给 propose-actions 的 initiator 鉴权与 background 的 active-run 鉴权，覆盖了几乎全部写路径的身份判定，且该文件有跨会话冒名的前科，一旦日后仅改一处，影响面是整条写权限链路，因此不宜评 low。

</details>

### MEDIUM-5 [正确性] mstd-orchestrator/server/jobs/background.mjs:51

**问题**：launch() 的行读取与 JSON.parse 在 try 之外，抛错时 finally 的 semaphore.release()/pump() 不执行，永久泄漏一个并发槽

**证据**：line 51-52 `const row = db.prepare("SELECT * FROM orch_jobs WHERE id = ?").get(jobId); const meta = JSON.parse(row.params_json);` 位于 line 53 的 try 之前，而 semaphore.release()+pump() 在 line 84-87 的 finally 内。若 row 为 undefined（job 行在 spawn 与 pump 之间被删）则 `row.params_json` 抛 TypeError；.get() 在写竞争下也可能抛 SQLITE_BUSY——两者都在 try 之前，finally 不运行，槽不归还。默认 MSTD_MAX_CONCURRENT_PI=2，两次即令后台 job 子系统永久卡死（pump 的 tryAcquire 永远失败）。调用方 `launch(job.id).catch(()=>{})` 还会吞掉该异常。launcher.mjs:26 的 `const job = getJobRow(db, jobId)` 同样在 try 之外，是同一缺陷。

**建议**：把行读取与 JSON.parse（launcher 里是 getJobRow）移进 try，或在函数入口用 try/finally 把 acquire→release 全程包住；row 为空时显式落 failed 终态并 return。launcher.mjs 同改。

<details><summary>对抗证伪核查记录</summary>

逐条核查，结论：CONFIRMED（发现基本成立，但其"行被删"这一具体诱因描述不准确，真正的触发点是另一条更贴近先例的路径——已在核查中用真代码复现验证）。

1. 代码结构核查（Read 原文件）：background.mjs 第 50-88 行 launch() 中，第 51 行 `db.prepare(...).get(jobId)` 与第 52 行 `JSON.parse(row.params_json)` 确实在第 53 行 try 之外；finally（semaphore.release()+pump()）在第 84-87 行。JS 语义上，try 之前的代码抛错，finally 不会执行——这是基本事实，无争议。

2. "row 被删"诱因证伪：全仓库 grep（含 test/simulator/supervisor/scripts）未找到任何对 orch_jobs 的 DELETE 语句；唯一的 DELETE 目标是 cron_jobs（无关表）。createJob 是同步 INSERT+SELECT，spawn() 到 launch() 首次读取之间没有让出事件循环的机会。因此"job 行在 spawn 与 pump 之间被删"这一具体叙事在当前代码库中没有真实路径，是发现里站不住的部分。

3. 但同一位置的真实触发点被找到且已用生产代码直接复现：
   - schema（001_init.sql）里 params_json 是裸 TEXT，无 CHECK(json_valid(...))约束；
   - 关键先例：just 在当前 HEAD 之前的提交 e2c3fde（"fix(mstd): core-layer failure containment and predicate correctness"，日期与今日相同）明确写道"orchestrator params_json 解析挪到 spawn 之前:损坏参数走 failed 终态,不再永久卡 running_readonly...也不泄漏已 spawn 的 Pi 进程"——即维护者本人在本轮质量巡检中已经对 jobs/orchestrator.mjs 修过几乎同构的缺陷，但 jobs/background.mjs 和 jobs/launcher.mjs 被漏掉，与发现的判断完全吻合。
   - 我据此在 scratchpad 写脚本直接调用真实 createBackgroundJobs/openDb/migrate，用 `UPDATE orch_jobs SET params_json='{not-json'` 模拟"内容损坏"（不依赖删除，仅需 params_json 在排队期间变得不合法即可，属于该库当前 schema 允许的状态）。复现结果：
     a) semaphore.active 在损坏 job 被 pump 后保持满值不降，即便真实运行的 job 已经结束——槽位永久泄漏；
     b) 该 job 的 DB 状态永远停在 "queued"，既不会变成 running 也不会变成 failed（因为 updateJobStatus("running") 在 try 内，根本没执行到）；
     c) 用 MSTD_MAX_CONCURRENT_PI 的生产默认值 2 复现"两次即永久卡死"：连续两个损坏 job 耗尽两个槽后，一个全新健康 job 被 spawn，等待 200ms 后仍卡在 "queued"，semaphore 维持 2/2，且再无任何在途 job 能触发 pump()——与发现描述的"后台 job 子系统永久卡死"逐字吻合；
     d) 额外验证了"调用方 .catch(()=>{}) 吞异常"的后果比发现描述的更严重：log() 从未被调用、job_events 里没有 background_failed 记录、也没有 unhandledRejection——这次失败对日志/监控完全不可见。
   - SQLITE_BUSY 分支：全仓库未配置 busy_timeout；db/index.mjs 显式注释 WAL 是"双进程并发写防护"，且 simulator/cli.mjs、simulator/probe-bot-visibility.mjs、supervisor/write-smoke.mjs 均独立 openDb() 同一文件，多进程访问是当前项目的既定设计而非假想。WAL 下纯读 SELECT 一般不会被并发写阻塞，所以这一分支比 JSON 损坏分支弱，但并非无根据的空想，可作为次要佐证。

4. project.md 比对：第四节"其他刻意设计"未提及此行为；第九条恰恰要求"治理层拒绝或降级时用户看到的必须是诚实的失败陈述而不是自信话术"——当前 background.mjs 的静默吞错与此原则相悖，说明这是应修的实现错误而非刻意设计。按第五节，"修复能明确证明与本文档意图不符的实现错误"和"用户可见行为不变的内部重构"都在可直接执行范围内，不需要先找项目负责人确认。

5. 建议改法核查：把 row 读取 + JSON.parse 移入 try（或用整函数级 try/finally 包住 acquire→release），行为上与 e2c3fde 对 orchestrator.mjs 采用的已被接受的修法完全同构，只影响失败路径（从"静默永久泄漏"变成"显式 failed + 释放槽位"），success 路径行为不变，不触碰 .env/生产开关、不涉及 Pi 扩展跨扩展状态、不需要 git checkout --、不改变用户可见行为，未违反 CLAUDE.md 任何硬规则。launcher.mjs:26 的 getJobRow 同类问题也核查属实，但机制更窄——job 为 undefined 时的属性访问发生在 try 内部的 runReadonlyPhase 调用链深处，真正会跳过 finally 的只有 getJobRow 本身（即 .get()）同步抛错这一种情形，不如 background.mjs 的"两处均在 try 外"典型，这点发现原文未加区分，属于轻微夸大但不影响主发现。

revised_impact 上调为 high：默认并发上限仅 2，两次同类异常即可让"后台 job 委托"（推理机深度任务的核心异步通道）整体永久卡死，且失败路径完全没有日志/事件/异常留痕，无法被现有可观测手段发现，只能靠重启进程恢复；触发类别（TEXT 列无完整性约束的 JSON 解析、无 busy_timeout 的同步 DB 调用）已被本仓库自己最近一次质量巡检认定为值得修的缺陷类别，只是这次巡检未覆盖到这两个文件。

</details>

### MEDIUM-6 [性能] mstd-orchestrator/server/jobs/event-buffer.mjs:9

**问题**：seqByJob Map 随 jobId 无界增长，进程生命周期内从不清理，常驻进程慢性内存泄漏

**证据**：buffer 是 index.mjs:148 `const buffer = createEventBuffer(db)` 的进程级单例。nextSeq (line 12-19) 对每个首次出现的 jobId `seqByJob.set(jobId, ...)`，整文件无任何 delete/clear——stop() (line 49-52) 只 flush 不清。每个曾产生 key 事件的 job 永久占一条目，24/7 常驻助理下随累计 job 总数无限增长。

**建议**：job 到终态（done/failed/aborted）时删除对应 seqByJob 条目——可在 record 收到终态事件时或由完成回调触发；或给 Map 加容量上限/LRU。

<details><summary>对抗证伪核查记录</summary>

逐条核查结果：

1. 代码事实核查（逐行对照 mstd-orchestrator/server/jobs/event-buffer.mjs）：
   - L9 `const seqByJob = new Map();` 确认存在。
   - L12-20 `nextSeq(jobId)`：对每个首次出现的 jobId 先查 DB 得到当前最大 seq 再 `seqByJob.set`，此后只 `.get`/`.set` 递增，从不 `.delete`。
   - L49-52 `stop()`：只 `clearInterval` + `flush()`，未触碰 `seqByJob`。
   - 全文件（56 行）grep 不到任何 `.delete(`/`.clear(` 调用——Map 条目一旦创建即永久存活到进程退出。
   论断对代码行为的描述完全准确。

2. 非死代码，且是活跃生产路径：
   - `grep index.mjs` 确认 `const buffer = createEventBuffer(db)` 在 L148，`buffer.start()` 在 L149，均在模块顶层执行一次——确系进程级单例，非 per-request 临时对象。
   - 全仓库唯一的 `buffer.record` 调用点在 `server/jobs/orchestrator.mjs:12`（`emit()` 内），该文件是 `runReadonlyPhase` 的核心实现，是"推理机"任务执行的主干路径（project.md 第二节描述的架构）。
   - `createJob`（server/store/jobs.mjs:19）用 `randomUUID()` 为每个任务铸造全新 ID，且 project.md 第二节明确"推理实例按任务而不是按会话隔离……新消息属于不同任务时，调度器拉起新的推理实例"——即每个推理任务=一个永不复用的新 jobId=一条永久 Map 条目。这是系统核心吞吐量驱动的增长，不是边缘场景。
   - 确认 write-phase.mjs 不调用 buffer，job 进入 awaiting_approval/awaiting_confirm/needs_attention/failed 等状态后不会再有该 jobId 的 record() 调用，即该 Map 条目在任务完成后即成为纯粹的死重（dead weight），无任何后续用途。
   - index.mjs 通篇搜索确认没有其它定时器/sweep 逻辑触碰 buffer 或 seqByJob（唯一的 sweep 是 `session-expiry`，与此无关）。

3. 对照 project.md 全文（153 行）：未发现任何关于 event-buffer/seqByJob/job 级内存缓存生命周期的刻意设计记录，不属于"看起来像 bug 实为刻意设计"的已知情形。

4. 建议改法的可行性与合规性：project.md 第五节把"用户可见行为不变的内部重构"列入"可以直接执行的范围"，无需先向项目负责人确认。终态清理（job 到 done/failed/aborted 时删除 Map 条目）只影响进程内 seq 计算缓存，不改变 job_events 表已持久化的数据，也不改变任何用户可见行为，不触碰 CLAUDE.md 列出的任何硬规则（无关全量单测目录、E2E 门控、.env 开关、Pi 扩展跨扩展状态或变异抽查还原）。

结论：这是一个真实存在、发生在活跃生产路径上、且确实无界增长（随历史任务总数单调递增、进程生命周期内不释放）的资源管理缺陷，判 CONFIRMED。

impact 修正为 low：Map 每条目开销很小（UUID 字符串 key + 一个整数，V8 下约 100–150 字节/条），即便按较高强度估算（如日均数百个推理任务），年增量也只在几十 MB 量级，达到真正影响 RSS/GC 的规模需要连续运行数月到数年且期间不重启/不重新部署；而据 memory 记录该项目目前仍处于生产租户接入准备阶段（mstd-prod-onboarding-prep），实际任务量和连续无重启运行时长都远未到"慢性内存泄漏"这一措辞暗示的紧迫程度。因此这是一个方向正确、值得顺手修的卫生性缺陷，但当前实际风险等级应为 low 而非原文暗示的高危级别。

</details>

### MEDIUM-7 [性能] mstd-orchestrator/server/safety/verbatim-guard.mjs:25

**问题**：verbatim guard 的 sessions Map 按会话数无上限增长，常驻进程内存缓慢泄漏。

**证据**：`const sessions = new Map()`（line 25）只对单会话内 shingle 数量做 FIFO 上限（DEFAULT_MAX_SHINGLES=50_000，约数 MB/会话），但对会话『数量』无任何淘汰。teardown 用的 `clear(sessionKey)`（line 76）经 grep 仅出现在 test/verbatim-guard.test.mjs，mstd-orchestrator/server/ 下无任何生产调用点；verbatimGuard 是 index.mjs:220 的进程级单例，record 经 lark-read-egress-source 每次读取持续累积。于是每个曾出现过的 sessionKey 都永久保留一个 Set，常驻小达服务大量群/私聊会话时无界增长。

**建议**：在会话/epoch 结束时（如 brain.mjs 现有 replyEgress.revoke 的同一时机）调用 verbatimGuard.clear(sessionKey)，或给 sessions 加 LRU/TTL。顺带：inspect（line 80-82）全仓库零引用（含测试），可一并删除。

<details><summary>对抗证伪核查记录</summary>

核查结论：论断成立，CONFIRMED（附对"建议改法"的修正）。

**逐项核查证据：**

1. 代码真实存在、语义无误。`mstd-orchestrator/server/safety/verbatim-guard.mjs:25` 确为 `const sessions = new Map()`。`record()`（27-44 行）只在单会话 Set 超 `maxShinglesPerSession`（默认 50_000）时做 FIFO 淘汰（38-42 行），全文件搜索无任何按 session **数量** 做淘汰的逻辑。

2. `clear(sessionKey)`（76-78 行）生产调用点为零。全仓库 grep `verbatimGuard`/`createVerbatimGuard`（排除 node_modules 与 `.claude/worktrees` 重复树）命中 index.mjs、lark-read-egress-source.mjs、reply-egress.mjs、reply-pipeline.mjs、turn-handler.mjs 五个生产文件，均只调用 `.record(` / `.check(`，唯一 `.clear(` 调用在 `test/verbatim-guard.test.mjs:32`。`inspect()`（80-82 行）在全仓库（含全部测试文件）零引用，是真·死代码（grep 到的其余 `.inspect(` 命中分别属于 `policy-eval.test.mjs` 的另一个 guard 和 `active-turn.test.mjs` 的 registry，与本文件无关）。

3. 单例与热路径属实：`index.mjs:220` 的 `const verbatimGuard = createVerbatimGuard()` 在 `enableAgent` 启动块内只执行一次，是进程级单例；随后作为依赖注入 `reply-pipeline`/`turn-handler`（服务每一条出站回复都走 `checkReplyPostRender` → `verbatimGuard.check`）与 `lark-read-egress-source.mjs`（每次 `lark_read` 成功读取都调用 `verbatimGuard.record`）。这是正常使用下必经的高频路径，不是冷路径微优化。

4. 生命周期解耦是真实缺口：`brain.mjs` 的 resident 收尾逻辑（`closeEntry` 122-155 行、taint-recycle 558-564 行）会调用 `tokens.revoke`/`replyEgress.revoke`/`brain.recycle`，但 `brain.mjs` 全文件搜索不到一处 `verbatimGuard` 引用——它根本没拿到这个依赖，物理上不可能在 resident 回收时清理。sessionKey（`feishu:p2p:{openId}` / `feishu:group:{chatId}[:topicId]`）按真实会话身份计，不随 resident 回收/重生而变，因此只要有新的群/私聊触发过 `lark_read`，就永久占一条 Set，符合"常驻服务大量会话时无界增长"的描述。

5. `project.md` 全文（153 行）搜索"内存/泄漏/清理/常驻内存/GC"等关键词均无命中，未见任何将此行为记录为刻意设计的条款；仓库内也未发现进程级定时重启机制（无 pm2/systemd/plist 配置），与"常驻"（resident，本项目的核心身份定位）的产品定位一致，缺乏兜底，缺陷是真实的、非纯理论。

**对"建议改法"的修正（这也是我作为对抗性审查最想推翻但推翻不掉核心论断、只能证伪部分建议的地方）：**

建议改法的第一选项——"在 replyEgress.revoke 的同一时机调用 verbatimGuard.clear(sessionKey)"——如果照做会改变安全语义，不能直接采纳：`index.mjs:218-219` 的注释明确把"逐字引用记录"和"epoch 级 taint"分成两套独立机制（"lark_read 每次成功读取经 /internal/egress/source 登记 shingle；席位私有 op 同时给本 epoch 打 taint（业务回合收口后 turn-handler 回收 resident）"），taint 特意做成 epoch 级自动失效，而 verbatim shingle 记录特意用 sessionKey（跨 resident 重生持久）。resident 回收（`replyEgress.revoke`）在正常运行下每 `MSTD_PI_IDLE_MS`（默认 600_000ms=10 分钟）空闲即触发一次，如果把 verbatimGuard.clear 绑在这个时机，逐字引用防护窗口会从"整个会话生命周期"收窄成"当前 10 分钟内的 resident epoch"，攻击者只需等一次自然空闲重生就能让模型"复述"之前读过的敏感原文而不被拦截——这是实质性的安全回归，触碰 project.md 第五节"权限与审批门"相邻的核心语义，理论上需要先找项目负责人确认，而不是可以直接执行的内部重构。

但建议改法给出的第二选项——"给 sessions 加 LRU/TTL"——是安全的，且仓库里已经有现成、更合适的挂载点：`mstd-orchestrator/server/ticker/session-expiry.mjs`（24 小时空闲或每日北京时间 04:00 双重判据，归档前强制 memory flush，`index.mjs:576-580` 经 ticker 每 10 tick 调 `expiry.sweep()`）是"这个会话真的结束了"的既有信号，且该文件同样未引用 verbatimGuard——把 `verbatimGuard.clear(sessionKey)` 挂在 sweep 归档成功之后（而非 resident/epoch 回收处）才是行为不变、且真正解决无界增长的正确修法。`inspect()` 删除건 本身无风险，可直接执行。

**revised_impact 修正为 medium**（原发现未标注 impact）：确系真实缺陷、触发条件是正常使用（无需构造特殊场景），但单会话已有 50_000 shingle 的 FIFO 上限（约几 MB/会话），总内存增速受真实世界"该 bot 曾进入过的群+私聊身份数"这一较慢基数驱动，非短期 OOM 风险，故不评 high；但项目明确以"常驻不重启"为产品身份且未见任何进程级重启兜底，缺陷会随运行时间单调恶化，不适合评 low。

</details>

### MEDIUM-8 [正确性] mstd-orchestrator/simulator/scenario-schema.mjs:26

**问题**：scenario-schema 接受 route_label_version: v2，但 grader 的 actualRouteFromTrace 只会产出 v1 标签，任何 v2 场景都会静默 100% 判失败。

**证据**：scenario-schema.mjs:25-28 允许 labelVersion 为 V2 并用 ROUTE_LABELS_V2(reply/no_reasoning/attach_existing/spawn_new...) 校验 expect.route。但 trace-reader.mjs:72-87 的 actualRouteFromTrace 注释明写“v1”，只返回 quick_reply/no_reply/steer/escalate/... 这类 v1 标签；grader.mjs:43 用 `actual === rec.expected.route` 字符串直等。于是 v2 场景里 expected='reply' 永远不可能等于 actual='quick_reply'，accuracy 恒为 0 → status 恒 failed（grader.mjs:84）。grep 确认当前 8 个 scenario 全部 route_label_version: v1，v2 从未在场景中使用，只有 test 引用。

**建议**：要么在 actualRouteFromTrace 里按 label 版本用 ROUTE_V1_TO_V2 映射输出 v2 标签，要么在 scenario-schema 暂时拒绝 v2（明确报“grader 尚不支持 v2”），避免声明 v2 的场景被静默误判。

<details><summary>对抗证伪核查记录</summary>

逐项核查，论断成立，且我做了可执行的实证复现（非仅代码阅读）。

**1. 代码事实核查（逐行对照原文件）**
- `scenario-schema.mjs:25-28`：`labelVersion = doc.route_label_version ?? routeLabelVersion; if (![V1, V2].includes(labelVersion)) throw` —— 确认 v2 会被放行，不报错。
- `trace-reader.mjs:72-87`：`actualRouteFromTrace` 函数头注释明写 `(v1)`，函数体只可能返回 `quick_reply|no_reply|steer|escalate|confirm_card|security_refused|observed|unknown` 这一固定 v1 词表，结构上不可能产出 v2 专属词（`reply/no_reasoning/attach_existing/spawn_new`）。
- `grader.mjs:34,43,83-84`：`actual = actualRouteFromTrace(trace)` 不传任何 label-version 参数；`actual === rec.expected.route` 严格字符串相等；`status = hardFail || accuracy < 1 ? "failed" : "passed"`。均与论断描述一致。

**2. 全仓库引用扫描（含 test/、scripts/、mstd-ui/、pi-ext/、tui/、docs/、package.json）**
`route_label_version`/`ROUTE_LABEL_SET_VERSION`/`mapRouteV1ToV2` 仅出现在 `route-labels.mjs`（定义）、`scenario-schema.mjs`（校验）、`test/simulator-scenario.test.mjs`（对 `isValidRoute`/`mapRouteV1ToV2` 的孤立单测）——从未被 `grader.mjs`/`trace-reader.mjs` 导入使用。8 个真实 scenario YAML（`grep route_label_version simulator/scenarios/*.yaml`）全部是 `v1`，无一使用 v2。`simulator/runner.mjs:115` 把完整 `scenario`（含 `route_label_version`）传给 `grader.grade()`，但 `grade()` 内部从未读取该字段——数据已经在调用链里，只是没接上，属于典型"半成品集成缺口"而非架构性难题。

**3. 实证复现（直接 import 仓库真实代码执行，非复述）**
构造 `route_label_version: v2` + `expect.route: "reply"` 的场景对象，喂给真实 `validateScenarioObject` —— 通过校验。再构造一条"应答机真的正确回复了"的 trace（`status: "responder_sent"`，对照 `server/gateway/turn-trace.mjs` 里 `responder_sent` 事件的真实写法），喂给真实 `actualRouteFromTrace` —— 返回 `"unknown"`。复现 grader 的匹配/accuracy/status 逻辑 —— `accuracy=0, status='failed'`，即**对完全正确的行为判定失败**。进一步验证：v2 专属 4 个词与 `actualRouteFromTrace` 全部可能输出**零交集**，即只要 v2 场景用到这 4 个词中任意一个，保证 100% 不匹配，不是概率性风险。

**4. project.md 刻意设计核对（关键，纠正了 runbook 的时效性误导）**
`project.md` 全文未提及本问题；但第二节明确记载："**状态：已接受（2026-07-14 定案）；代码已实现...2026-07-15 决定：切换 active 灰度上线，先测试群、验证后放业务群**"。核对当前 `mstd-orchestrator/.env` 确认 `MSTD_AGENT_ARCHITECTURE_MODE=active`、`MSTD_AGENT_ACTIVE_ALL=1` 已经打开，且 `f42c191 feat(agent): support global active rollout` 是今天（2026-07-16）15:01 刚合入 HEAD 的祖先提交。也就是说应答机/独立调度器架构不是遥远假设，而是**已拍板、已实现、正在灰度**的当前状态。runbook（`docs/superpowers/runbooks/feishu-multi-bot-simulator.md` 第5、9节，末次编辑于 07-14 17:37，早于 active 全量灰度落地）把"场景标签切 v2"描述成"迁移完成后"的未来步骤，但该文档相对当前部署状态已经滞后——这不是"永久如此的产品设计"，而是**待办工作项**，且触发条件已经临近/成熟，不属于"记录在案、不应改动"的刻意设计范畴（project.md 第五节讲的是产品可见行为，不覆盖测试工具链的未完成 TODO）。

**5. 建议改法安全性**
改动范围限定在 `mstd-orchestrator/simulator/`（scenario-schema.mjs / trace-reader.mjs / grader.mjs），纯测试评测工具链代码，不触碰 `server/gateway`、`server/reasoning` 等真实响应路径，不改变小达对用户的任何可见行为。落入 project.md 第五节明确预授权的"用户可见行为不变的内部重构""不引入新设计判断的文档和测试修正"范围，不需要项目负责人二次确认；也未违反 CLAUDE.md 任何硬规则（不涉及全量单测跑法、E2E 门控变量、.env 生产开关、Pi 扩展 globalThis、变异抽查还原）。且论断建议的两个方向之一（用已存在但从未接线的 `ROUTE_V1_TO_V2`/`mapRouteV1ToV2` 做映射）本身就是仓库已经写好、已经单测过的现成工具，接线成本低、风险小。

综合以上，该发现在事实、触发场景、影响范围、修复安全性四方面全部核实通过，判 CONFIRMED。

</details>

### MEDIUM-9 [正确性] mstd-orchestrator/tui/store.mjs:68

**问题**：snapshot() 捕获到的 DB 读错误写入 err 却从不上报，轮询期瞬时错误会让面板静默清空且无提示。

**证据**：snapshot() 的 try 内一旦 tail/openRuns/reliability/recentSessions 抛错(如瞬时 SQLITE_BUSY)，catch 置 `err = e?.message ?? String(e)`，而 runs/reliability/sessions 仍停留在函数顶部的空默认值；返回对象含 err，但 app.mjs 全文无 snap.err 消费者，Footer 的 flash/错误位也未接线。结果：一次瞬时读失败会让仪表盘整屏清空(0 runs / 空 sessions / 归零 reliability)且无任何错误指示，运维会误判为真的没数据。

**建议**：把 snap.err 接到 Footer(复用 flash 或加一行红色错误提示)，让读失败可见，而不是与'确实为空'无法区分。

<details><summary>对抗证伪核查记录</summary>

逐条核查，论断成立，判 CONFIRMED。

1) 代码真实存在且语义读对：store.mjs 51-82 行 `snapshot()`——`err`/`runs`/`reliability`/`sessions` 均在 try 之前声明为默认空值（54-56行），try 内依次执行 `queries.tail`→`openRuns`→`reliability`→`recentSessions`，任一环节抛错即被 catch（67-69行，第68行正是 `err = e?.message ?? String(e);`），其后尚未执行到的赋值语句都不会跑，对应字段停留在函数顶部声明的空默认值上。返回对象第72行确实把 `err` 塞进了快照。

2) 无消费者，全仓库核查：
   - `grep -rn "pushLocal\|snap\.err\|snapshot()" tui/` 显示 `store.snapshot()` 仅在三处被调用：index.mjs:34（--probe 模式）、app.mjs:218（初始 state）、app.mjs:231（`setInterval(() => setSnap(store.snapshot()), config.refreshMs)`，默认 800ms 轮询，见 config.mjs:33）。三处均未读取返回值的 `.err` 字段。
   - index.mjs 的 --probe 自检模式（我方记忆中提到的"自检"路径）逐字段打印 dbPath/health/runs/feed/reliability/sessions/ops.ready，唯独不打印 `snap.err`——连诊断路径都没有兜底。
   - app.mjs 的 Footer（188-206行）的 `flash` 完全由 `setFlash(...)` 显式调用驱动（仅在 dreaming/cron 运维动作的成功失败回调里出现，248/258/259/286行），与 `err` 无任何连接；StatusBar（14-32行）的健康点 `snap.health` 来自 health.mjs，只读 daemon.pid/daemon.log 判活，与 DB 读取健康度无关，同样不会露出这个错误。
   - 结论：`err` 字段从产生到返回，全链路零消费者，论断"app.mjs 全文无 snap.err 消费者，Footer 的 flash/错误位也未接线"精确成立。

3) 具体触发场景可构造，非纯理论：db.mjs 顶部注释自认"只读句柄在「WAL 且有活跃 writer」时可能开不了 -shm"，即作者本人已承认这条 DB 存在读写并发争用的真实风险类别；`openReadonlyDb` 对连接建立时的争用做了降级兜底，但 `snapshot()` 内后续每 800ms 一次的 5 条同步语句（tail/openRuns/4个reliability子查询/recentSessions）一旦撞上 SQLITE_BUSY（busy_timeout=2000ms 用尽）、WAL checkpoint 争用或磁盘 I/O 抖动，就会在这个未受保护的路径上抛出——这是 better-sqlite3 同步读在高频写主机上的标准失效模式，不是假设性风险。而且 ReasoningPanel/SessionsPanel 在空数组时分别渲染"（当前无进行中的推理）"「（无会话）」（app.mjs 45-46行、90-91行），与"读失败导致的空"在视觉上完全无法区分，precisely 印证"运维会误判为真的没数据"。

4) 非死代码：package.json:23 `"tui": "node --env-file-if-exists=.env tui/index.mjs"` 是实际维护中的运维监控入口（用户记忆亦有"mstd-tui-monitor"专项记录），不是废弃/实验代码。

5) 对照 project.md：全文档 grep "tui" 零命中，TUI 从未被记录为刻意设计的一部分；docs/ 下也无任何 TUI 相关规格。git log 显示整个 tui/ 目录是同一次提交（18ee827）新增，无历史行为基线可援引"这是已知取舍"。第五节"设计变更确认边界"针对的是小达对最终用户的可见行为/核心语义（路由、回复次数、人格、记忆、审批门等），TUI 是内部运维工具，不落在该确认边界内。

6) 建议改法（把 err 接到 Footer flash 或加一行错误提示）不涉及任何 CLAUDE.md 硬规则（不碰单测跑法、E2E 门控、.env 生产开关、Pi 扩展 globalThis、git checkout --、设计确认边界），纯粹是内部工具的可观测性修复，不改变小达对最终用户的行为。

综上，五步核查全部通过，判 CONFIRMED。

</details>

### MEDIUM-10 [正确性] mstd-ui/src/App.tsx:57

**问题**：中止按钮只调服务端 abortJob，App 从不给 openJobStream 传 signal，客户端 SSE 流与重连循环无法被取消。

**证据**：App.tsx:57 `await openJobStream(jobId, { onEvent, onDone, onError })` 未传 signal；onAbort（App.tsx:70-72）只调 `abortJob`。job-stream.ts:84 里唯一能在错误路径提前 return 的判断是 `if (signal?.aborted)`，对这个唯一调用方恒为 false。若服务端中止后直接关闭流（未发 message_done/error），job-stream.ts:82 抛“stream 意外关闭”→进入 for(;;) 用 sinceSeq 对已中止的 job 反复重连，最多 MAX_RETRIES=5 次退避；组件卸载同样无 cleanup，reader 继续读。openJobStream 已预留 signal 形参，属于接线遗漏。

**建议**：App 持有一个 AbortController，调用 openJobStream 时传入其 signal，onAbort 里 controller.abort()；触发新 job 或卸载时也 abort，避免僵尸重连。

<details><summary>对抗证伪核查记录</summary>

逐项核查，主张成立，但对具体触发机制的描述需要修正。

**代码事实核查（直接读取）**：
- App.tsx:57 `await openJobStream(jobId, {...})` 确实未传 `signal`；App.tsx:70-72 `onAbort` 确实只调用服务端 `abortJob`，不涉及任何客户端流控制。
- job-stream.ts:41 `signal?: AbortSignal` 是可选形参；:84 `if (signal?.aborted)` 确实是 catch 块里唯一能提前 return 的分支；由于 App.tsx 从不传 signal，该分支对生产环境唯一调用方恒为 false（`grep -rn "openJobStream"` 全仓库确认 App.tsx 是 mstd-ui/src 下唯一的生产调用点，另一处只在 job-stream.test.ts 测试里出现）。

**修正一处机制描述**：发现原文"若服务端中止后直接关闭流…抛 stream 意外关闭→重连 5 次退避"这个具体假设与本仓库服务端实现不符。追踪 `server/jobs/routes.mjs:81-91`（abort 路由）→ `server/jobs/event-bus.mjs`（publish 从不碰 res）→ `server/http/sse.mjs:47-50`（close 只在 `res.on("close")` 即客户端断开时触发）→ `server/jobs/orchestrator.mjs:69-72`（kill 子进程后 `failIfRunning` 因 job 状态已不是 running_readonly 而提前 return，不会 emit error/message_done）：**服务端 abort 后从不主动关闭 SSE 连接**，只发一条不在 `isTerminal` 判定范围内、且不在 `SseEvent` 联合类型里的 `job_status:aborted` 事件（`state/job-event-log.ts` 的 reduceJobEvent 对它落到 default 分支直接吞掉）。job-stream.ts:82 那行代码自己的注释也写着"服务端不主动关流；关了就当断线重连"，与原文假设的机制相反。

**实际后果比原文描述的"重连风暴"更持久**：不是有限的 5 次退避后放弃，而是客户端 fetch/reader 与服务端 SSE 响应（含 15s 心跳 `setInterval` 和 event-bus 订阅）**永久挂起**，直到浏览器 tab 关闭/刷新为止。这是可 100% 复现的具体场景（非纯理论风险）：点触发→点中止，Network 面板可见对应 `/api/jobs/:id/stream` 请求永远 pending；每一次触发+中止循环都会在服务端泄漏一个订阅+定时器。若中止后立刻重新触发新 job（`running` 已被 onAbort 置 false，触发按钮重新可点），旧流残留事件与新流共写同一个 `setLog` 状态，存在窄窗口的日志串扰风险。

**git 历史佐证非故意设计**：`signal` 形参在 `job-stream.ts` 里的存在早于中止按钮功能（commit 17fbcd9 引入重连时已带 signal），中止按钮本身由后续 commit 5c5de4a 引入，且该 commit 完全没有触碰 job-stream.ts 或引入 AbortController，是典型的"接口预留、接线遗漏"。workspace.test.tsx 里唯一的 onAbort 测试只是浅层验证 WorkspaceView 组件回调触发，未覆盖 App.tsx 真实实现或流生命周期。

**project.md / CLAUDE.md 核查**：project.md 全文围绕飞书常驻助理的应答机/调度器/推理机架构、SOUL 人格、双回复、审批门等展开，未提及 mstd-ui 调试台的 SSE 流生命周期管理，不存在"刻意设计"豁免。建议改法（App 持有 AbortController，signal 传入 openJobStream，onAbort 里 abort()）不改变用户可见行为（job-stream.ts 侧的 signal 处理逻辑已存在且被间接测试覆盖，无需改动；onError 回调触发时 running 早已被 onAbort 置 false，是幂等操作），不属于 project.md 第五节需项目负责人确认的范畴（不涉及路由/人格/记忆/审批语义），不违反 CLAUDE.md 硬规则。

综上判 CONFIRMED，但影响评级下修：该问题局限于 mstd-ui 内部调试/管理面板（非飞书用户可见的主产品链路），后果是资源泄漏（悬挂连接+心跳定时器+订阅）与窄窗口日志串扰，非崩溃、非数据丢失、非安全问题，且已持久化的 job 状态（DB 中的 aborted）不受影响，手动刷新页面即可缓解；但它是每次点击中止都 100% 确定复现的真实缺陷而非小概率边角情况，值得修。

</details>

## LOW（28 条）

### LOW-1 [正确性] mstd-orchestrator/pi-ext/lark-read.ts:23

**问题**：lark_read 每次调用给共享的 agent 级 AbortSignal 挂一个永不移除的 abort 监听器，随一回合内多次读飞书而累积

**证据**：runLark 第 23 行 `signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true })`，close 处理器（27-30 行）和 error 处理器（26 行）都只 clearTimeout，从不 removeEventListener。{once:true} 只在 abort 真正触发时自动摘除；正常完成路径下监听器永远留在 signal 上。该 signal 是 agent 级共享 signal（node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1816 `getSignal: () => this.agent.signal`），同一回合所有工具调用复用同一个对象；妙记抽取等回合里 lark_read 会被连续调用多次（search_minutes→get_transcript→read_file→chat_history→search_user…），每次泄漏一个监听器。对照：同目录 lark.ts:40-50 用具名 onAbort 并在 close 里 removeEventListener，SDK 自身 exec.js:60-69 也在 close/error 两条路径都移除——清理是既定模式，此处是遗漏。

**建议**：照 lark.ts 的写法：提取具名 const onAbort = () => child.kill("SIGTERM")，在 close 与 error 两个处理器里都 clearTimeout 后 signal?.removeEventListener("abort", onAbort)。

### LOW-2 [重复] mstd-orchestrator/pi-ext/memory.ts:24

**问题**：六个薄壳工具逐字复制同一套「内部通道」骨架，且已发生复制漂移导致 5 处错误文案有隐患

**证据**：reply.ts / memory.ts / session-search.ts / heartbeat.ts / background-job.ts / propose-actions.ts 的 execute 全部重复同一 12 行骨架：读 MSTD_INTERNAL_URL/TOKEN/SESSION_KEY 三个 env → 「no internal channel」兜底 → fetch POST（Bearer + body {session_key,...}）打 /internal/{memory,reply,session-search,heartbeat,background,propose-actions} → await resp.json() → if(!resp.ok||!data.ok) 报错 → catch 里 if(signal?.aborted) throw e。pi-ext 内无任何共享封装（已 grep 确认）。复制已漂移出真实缺陷：reply.ts:62 用 `typeof data.error==="string" ? data.error : JSON.stringify(data.error ?? resp.status)` 加固了错误提取，而 memory.ts:39、session-search.ts:34、heartbeat.ts:38、background-job.ts:48、propose-actions.ts:70 仍是 `${data.error ?? resp.status}`——当服务端返回结构化 error 对象时这 5 处会渲染成 `[object Object]`。

**建议**：在 pi-ext 内新增一个本地共享模块（如 pi-ext/internal-channel.ts，仿 turn-context.ts 守住 pi-ext 对 server/ 的零依赖边界），导出 postInternal(path, body, {signal})：内部完成三 env 校验、fetch、resp.json()、!ok 判定与统一的 error 提取（采用 reply.ts:62 的健壮版本），六个工具改为调用它。顺带修掉 5 处 [object Object] 漂移。

### LOW-3 [性能] mstd-orchestrator/server/gateway/turn-trace.mjs:68

**问题**：businessToTrace Map 在常驻 daemon 中只增不删，随每个 business turn 无界增长。

**证据**：第 68 行 `const businessToTrace = new Map()` 只在 record() 的 business_turn_admitted 分支（157 行）和 resolveTraceId 命中 DB 时（118 行）被 set；已 grep 整个文件确认无任何 businessToTrace.delete/clear。key 是每回合唯一的 turnId(UUID)，而 business_turn_terminal / business_turn_abandoned 等终态事件都不回收它。createTurnTrace 是进程级单例，存活于整个 daemon 生命周期，因此该缓存随处理量单调增长。

**建议**：在 business_turn_terminal / business_turn_abandoned 的 record 分支里 businessToTrace.delete(turnId)（终态后不再需要 turnId→traceId 反查），或改用有界 LRU。它只是省一次 byBusiness 查库的缓存，终态即可安全回收。

### LOW-4 [重复] mstd-orchestrator/server/http/admin-routes.mjs:113

**问题**：model-log 端点的 else 分支手抄了一份 model-log.mjs 的 list() 查询，生产永不触达、且与真实实现已经发生偏移。

**证据**：第 110 行 `if (typeof modelLog?.list === "function")` 命中时直接 return（第 111 行）；第 113-126 行的手写 filters/where/`SELECT * FROM model_log...` 只在 modelLog 缺失时才跑。生产装配（index.mjs:484/632 的 adminDeps）永远带 createModelLog(db)（其 return { record, list }），所以生产恒走 list()、这段 fallback 是死分支；只有 test/admin-routes.test.mjs:35 构造 admin 时不传 modelLog，才把这段当唯一路径测。更糟的是这份拷贝缺了 model-log.mjs list() 里的 `hasTaskCols` 守卫（model-log.mjs:119），两份已经不等价——测试测的不是生产跑的那条路径。

**建议**：删掉 113-126 的手写查询，端点统一调用 modelLog.list(...)；生产/测试都注入同一个 modelLog（测试传真实或桩 list），消除双实现与 schema 偏移风险。

### LOW-5 [死代码] mstd-orchestrator/server/index.mjs:350

**问题**：启动恢复路径里的 `agentStore.getById?.(...)` 前缀恒为 undefined，三处永远只走后面的 db.prepare 兜底。

**证据**：createSessionStore（sessions/store.mjs 尾部 return）导出的方法为 getOrCreate/append/transcript/recent/promptRecent/memoryTranscript/replaySet/quarantine/readQuarantine/appendSecurityTombstone/softDelete/bumpVersion/touch/peekMemoryNudge/claimMemoryNudge——没有 getById，全仓库（含 test）也无任何 getById 定义。因此 index.mjs:350、366、370 的 `agentStore.getById?.(sessionId) ?? db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(...)` 中，可选链恒返回 undefined，永远落到 db.prepare 分支。

**建议**：三处直接改成 `db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id)`（或抽一个 resolveSessionById 小函数复用），删掉误导性的 getById 前缀——现在读代码的人会误以为存在 store 缓存快路径。

### LOW-6 [重复] mstd-orchestrator/server/jobs/launcher.mjs:49

**问题**：launcher 与 background 各自复制了同一套并发闸（tryAcquire→launch 或 queue.push；pump: while queue && tryAcquire）

**证据**：launcher.mjs 的 pump(49-53)+submit 里 `const canRun = semaphore.tryAcquire(); ... if(canRun) launch(...); else queue.push(...)`（57-70）与 background.mjs 的 pump(90-95)+spawn(28-48) 逻辑同构，仅 launch 体与 job 语义不同。两份 queue+semaphore FIFO 编排是复制粘贴。

**建议**：抽一个共享 concurrency-gate helper（内部持 queue+semaphore，暴露 enqueue(runFn)/queueLength），两处复用，避免改一处漏改另一处。

### LOW-7 [死代码] mstd-orchestrator/server/jobs/orchestrator.mjs:124

**问题**：runWritePhase 包装器无任何生产引用，已被 execute/write-phase.mjs 直连路径取代

**证据**：jobs/orchestrator.mjs 的唯一生产 importer 是 launcher.mjs:2，且只取 runReadonlyPhase。此文件的 runWritePhase（签名取 opts.config，line 124-137）仅被 orchestrator.test.mjs 引用；真正的写执行走 execute/write-phase.mjs::runWritePhase（write-smoke.mjs:45 直连、confirm-flow 路径），这个 gating 包装在生产从未被调用。

**建议**：删除 orchestrator.mjs:124-137 的 runWritePhase（及其对应 test 用例）；写门控已由 execute/write-phase.mjs 承担。

### LOW-8 [死代码] mstd-orchestrator/server/jobs/reinjector.mjs:154

**问题**：进度心跳整套（trackProgress/progressTimers/outbound.editMessage/progressIntervalMs）在生产无调用者，是死代码或接线缺口

**证据**：index.mjs 只调用 reinjector.onJobComplete（439、464 行），从不调用 trackProgress；trackProgress 的唯一引用是 reinject.test.mjs:143。因此 progressTimers(line 48) 永不被填充，onJobComplete 里的 stopProgress(line 80/166) 恒为 no-op；构造参数 outbound 仅在 trackProgress(line 159) 使用，也随之全程无效。文件头声明的"进度心跳编辑"功能实际未接线。

**建议**：若不启用进度心跳，删除 trackProgress/progressTimers/stopProgress/outbound/progressIntervalMs 及 SAFE 相关；若要启用，需在 index.mjs job 启动处接线（当前漏接）。

### LOW-9 [重复] mstd-orchestrator/server/memory/files.mjs:83

**问题**：层文件与 user-journal 的『漂移校验+.bak 备份+写入』逻辑整段复制粘贴

**证据**：writeUserJournal（files.mjs:83-98）逐行重复 writeLayer（50-64）的 expectedHash 漂移校验、copyFileSync 到 `${p}.bak.${Date.now()}`（57 与 91 完全相同）、mkdirSync+writeFileSync+返回 snapshotHash 块，唯一差异是上限检查与 pathOf/userJournalPath 取路径不同；readUserJournal（77-81）也几乎是 readLayer（44-48）去掉 pathOf 后的逐字拷贝。同一份易错的『比对 hash→备份→落盘』规则维护在两处。

**建议**：抽出共享 helper，例如 readWithHash(path) 与 writeGuarded(path, content, { expectedHash, limit }), 让 writeLayer/writeUserJournal、readLayer/readUserJournal 复用同一实现，避免两份 drift/backup 逻辑各自漂移。

### LOW-10 [死代码] mstd-orchestrator/server/memory/scan.mjs:3

**问题**：memory/scan.mjs 是完全无引用的转发 shim，其声称服务的 legacy 调用方已不存在

**证据**：文件仅一行 export（scan.mjs:3）转发 safety/injection-signals 的 scanPromptInjection，注释自称『Compatibility boundary for legacy memory/cron callers』。但 canonical 树里 cron 调用方 ticker/cron-runner.mjs:4 已改为直接 import scanPromptInjection from '../safety/injection-signals.mjs'，连测试 test/memory-scan.test.mjs:2 也直接从 safety/injection-signals 导入。全仓库 grep（排除 .claude/worktrees）对 'memory/scan'、'/scan.mjs'、'scanForInjection' 的引用为零（仅剩 scan.mjs 自身的 export 行）。注释描述的兼容对象已不存在，属陈旧死文件。

**建议**：删除 mstd-orchestrator/server/memory/scan.mjs。

### LOW-11 [重复] mstd-orchestrator/server/models/responder.mjs:63

**问题**：renderItems 与 isAddressedOrPrivate 两个小助手在 models/ 与 gateway 内多份逐字复制。

**证据**：renderItems 三份近乎逐字复制：dispatcher.mjs:32、responder.mjs:63、triage.mjs:88（turn-handler.mjs:77 的 renderContext 同形，仅 fallback 文案 '用户'/'未知' 不同，triage 版少了 `?? []` 守卫）；isAddressedOrPrivate 在 responder.mjs:121 与 dispatcher.mjs:184 完全一致（`mode==='addressed'||'p2p'||'private'`）。

**建议**：抽到一个共享模块（如与 sessions/history-format.mjs 同层）导出 renderItems({ fallback }) 与 isAddressedOrPrivate，各处 import，消除多脑各写各的漂移风险。

### LOW-12 [可精简] mstd-orchestrator/server/models/token-window.mjs:104

**问题**：tokenWindow 的 truncated 表达式第二个操作数恒不改变结果，是死逻辑，却为它对整段 source 多跑一遍 format()。

**证据**：循环只有两个出口：完整消费(i<0)时 truncated 保持 false 且 selected 含全部非空行，故 `selected.length === source.filter(format).length`，第二项为 false；或命中预算在 `truncated=true` 之后 break，此时第一项已 true。因此 `truncated || selected.length < source.filter(row => String(format(row) ?? '')).length` 恒等于 truncated。而 `source.filter(...)` 会对全部 source 行再次调用 format——该函数由 turn-handler recentConversationBeforeTurn 以 formatHistoryLine 传入、source 上限 10,000 行，且 active/shadow 每回合都走一次。

**建议**：直接 `truncated: truncated`，删除 `|| selected.length < source.filter(...)`。行为逐位不变，且省掉每回合一次对整段历史的重复格式化（顺带可用循环里已累计的 used 代替 `estimateTokens(selected.join('\n'))` 的重算）。

### LOW-13 [重复] mstd-orchestrator/server/pi/capability-readiness.mjs:44

**问题**：capability-readiness.mjs 与 capability-probe.mjs 复制粘贴了同一套 Pi spawn+超时封装、marker 抽取与 session_start 观察扩展源码。

**证据**：两文件各自有近乎一字不差的 extractObservation（readiness.mjs:44 vs probe.mjs:71：split(/\r?\n/)→filter(startsWith marker)→new Set 去重→断言唯一→JSON.parse(slice(marker.length))）；各自的 spawn 包装 runOnce(readiness.mjs:30) 与 runProcess(probe.mjs:87) 都是 spawn(stdio ignore/pipe/pipe)+setTimeout SIGKILL+once error/close 的同构逻辑；两处 OBSERVER_SOURCE(readiness.mjs:15)/probeExtensionSource(probe.mjs:34) 的 session_start 上报 {activeTools,configuredTools} 也是同一段。这部分是与生产 launcher 无关的通用管道（probe 刻意不复用 buildPiArgs 的理由不适用于此）。

**建议**：把 spawn-with-timeout、marker extractObservation、观察扩展 session_start 源码抽到一个共享 helper（如 server/pi/probe-runtime.mjs），两个探针各自只保留参数拼装差异。

### LOW-14 [可精简] mstd-orchestrator/server/reasoning/task-store.mjs:332

**问题**：markDispatchSent 已被原子版 recordDispatchSent 取代，生产路径无任何调用者

**证据**：markDispatchSent（task-store.mjs:332，导出于 441）在 canonical 树里（排除 worktree）仅被测试引用：reasoning-task-store.test、reasoning-coordinator.test 调用它，turn-handler-active.test.mjs:135 更是把它 stub 成抛错以强制『active path must use atomic recordDispatchSent』。生产发送提交统一走事务版 recordDispatchSent（其内部复用同一 markPendingReview 预编译语句，故只有此包装函数被替代、语句本身仍在用）。与 transitionTask/mergeClosureMode 不同，markDispatchSent 没有任何『保留供回滚』的说明注释。

**建议**：确认无回滚需求后，随对应旧测试一并移除 markDispatchSent 及其导出，只保留 recordDispatchSent；若需保留则补一行与 transitionTask 同规格的『compatibility-only』注释以免误导。

### LOW-15 [死代码] mstd-orchestrator/server/safety/context-budget.mjs:33

**问题**：fitChars 是模块私有函数且全仓库零调用者，纯死代码。

**证据**：createContextBudget 的 fit 只调用 fitBytes（line 53-54）；对整仓库（排除 node_modules/.git/worktrees）grep `fitChars` 仅命中其自身定义 context-budget.mjs:33。文件顶部注释亦说明信封构造刻意是 byte-only、不支持 maxChars，fitChars 无存在依据。

**建议**：删除 fitChars（line 33-40）。

### LOW-16 [性能] mstd-orchestrator/server/safety/context-envelope.mjs:178

**问题**：createContextEnvelope 对原始内容多跑一次 scanInjectionSignals 却丢弃结果，是每轮对话都白跑的无效计算。

**证据**：line 178 `scanInjectionSignals(rawContent);` 的返回值未赋值、未使用；紧邻注释明示『only final-body signals are retained』，真正登记的 signals 来自 line 185 对归一化 content 的扫描。scanInjectionSignals 是纯函数（无副作用、不抛异常），此调用对至多 48KB 输入做 decodeOneEscapedLayer+Cf 剥离+4 模式×3 视图正则，纯属浪费。信封构造在 brain.mjs 的 resolveTurnContext 每轮（可能多次）触发。

**建议**：删除 line 178 这一行；若确需保留『归一化前也扫一遍』语义，应把其结果并入 signals 或用于告警，否则该调用无任何效果。

### LOW-17 [性能] mstd-orchestrator/server/safety/reply-egress.mjs:177

**问题**：revoke 只清 active、不清 taints，被回收的 resident/task 污点条目永久滞留于 Map。

**证据**：revoke（line 177-183）仅 `active.delete(key)`；taints Map（line 116）无任何 delete 路径（只有 markTainted 写、isTainted/taintReasons 读）。resident/task 被 revoke 后（brain.mjs:148/234），若此前经 lark_read restricted 打过污点，其 taints 条目按 `task:${taskId}` 等唯一键永久残留。epochs 的保留是 line 110-112 注释明示的刻意设计，但 taints 并非——revoke 后 isTainted 已恒为 false，条目只剩内存开销。

**建议**：在 revoke 内追加 `taints.delete(key)`（不改变对外语义，仅回收内存），随 task 数无界增长即被抑制。

### LOW-18 [死代码] mstd-orchestrator/server/sessions/active-turn.mjs:479

**问题**：brainTurns.finishTurn 是零引用的兼容包装方法，全仓库（生产+测试）无任何调用。

**证据**：全仓库 grep `finishTurn`（排除 node_modules 与 .claude/worktrees）仅命中 active-turn.mjs:479 的定义本身。真实收尾路径都直接用 closeAdmissions+finalizeTurn：brain.mjs:593/614、coordinator.mjs:192、turn-handler.mjs:146。注释自称 'Compatibility for non-business callers' 但没有这样的调用方。

**建议**：删除 finishTurn（478-483）。若确要保留对外兼容 API，应补测试或调用点，否则它只是与 closeAdmissions/finalizeTurn 语义重复的死封装。

### LOW-19 [正确性] mstd-orchestrator/server/sessions/store.mjs:86

**问题**：reactivateArchived 重算 memory_nudge_watermark 的 COUNT 缺少 nudgePoint 所用的 memory_eligible/security_label/provenance 过滤，两个本应同口径的计数已漂移。

**证据**：reactivate 子查询（store.mjs:86-89）为 `role='user' AND observed=0`；而 nudgePoint（store.mjs:326-331）额外要求 `memory_eligible=1 AND security_label='normal' AND provenance='conversation'`。migration 014_nudge_watermark 早于 017_security_quarantine 引入这三列，nudgePoint 更新了过滤条件、reactivate 子查询未同步。reactivate 因此把 watermark 设成 nudgePoint 口径的超集计数。

**建议**：让 reactivate 子查询复用与 nudgePoint 相同的三个过滤条件（或直接调用 nudgePoint 逻辑），使 watermark 基线与 peek/claim 的计数口径一致。

### LOW-20 [死代码] mstd-orchestrator/server/sessions/store.mjs:185

**问题**：store.recent 无任何生产调用方，被 promptRecent(prompt 路径) 与 transcript(operator/audit 路径) 取代，仅测试引用。

**证据**：`.recent(` 全仓库 grep（排除 worktrees/node_modules）只出现在 test/（ambient-gate、store-recent、turn-handler、session-store）；所有构造 prompt 的近期读取都走 store.promptRecent（triage.mjs、reply-pipeline.mjs、turn-handler.mjs、coordinator.mjs）。store.mjs:170-171 注释称 recent 保留给 'operator/audit'，但 admin-routes.mjs:31 的 audit 读取用的是 transcript 而非 recent，无任何消费方。

**建议**：删除 recent（185-193）及导出（361 行）；若确需 operator/audit 原文近期读取，让对应管理面接入并补消费点，避免留一个绕过安全 allowlist 的未使用原始读取器。

### LOW-21 [性能] mstd-orchestrator/server/simulator/auth.mjs:29

**问题**：simulator_nonces 表无界增长：清理函数 purgeExpired 从未被调用

**证据**：verify() 每次通过签名校验后都会 claimNonce.run(nonce, now())（auth.mjs:58）向 simulator_nonces 插入一行；purge/purgeExpired（auth.mjs:27、29-31）是唯一的删除路径，且在返回对象里暴露（auth.mjs:65）。全仓库 grep（排除 .claude/worktrees 旧副本与 node_modules）显示 purgeExpired 零调用者：simulator-routes.mjs:83 只调用 auth.verify，从不调用 auth.purgeExpired，也没有任何 ticker/定时器为它排期。因此每条注入的模拟消息都留下一行 nonce，进程生命周期内只增不减。

**建议**：在 verify() 内按概率/节流触发 purgeExpired()，或在 simulator-routes 挂载时用一个低频定时器周期调用 auth.purgeExpired()；若确认无需保留则删掉 purge/purgeExpired 死函数。注意此路径受 MSTD_ENABLE_SIMULATOR+MSTD_E2E 门控，影响面限于 E2E/压测长跑，但 20 并发压测这类场景会持续累积。

### LOW-22 [死代码] mstd-orchestrator/simulator/grader.mjs:61

**问题**：terminal 延迟统计里的 else-if 分支条件是前一个 if 条件的严格子集，永远不可达。

**证据**：grader.mjs:59-63：`if (trace.terminal_sent_at && trace.received_at) {...} else if (trace.status === "quick_reply" && trace.terminal_sent_at && trace.received_at) {...}`。else-if 额外要求的 `terminal_sent_at && received_at` 与 if 分支完全相同，只要进入 else 就说明二者至少一个为假，故 else-if 永假、且分支体与 if 体逐字重复。看起来是复制粘贴时丢失了本意（quick_reply 可能应改用 ack_sent_at 或其它字段计算延迟）。

**建议**：删除该 else-if 死分支；若确实想为 quick_reply 单独记一类延迟，则改用不同的时间戳字段，否则它对 percentiles 没有任何贡献。

### LOW-23 [死代码] mstd-orchestrator/simulator/process-owner.mjs:38

**问题**：createDaemonOwner 是一个从未接入生产流程的守护进程所有权抽象，只有单测在孤立地调用它的方法。

**证据**：runner.mjs:27 创建 daemonOwner 并在 194 行作为 runner 返回值暴露，但全仓库（含 cli.mjs、pi-ext、mstd-ui）没有任何生产代码读取 runner.daemonOwner 或调用 noteStarted/noteExisting/canStop/ownedPid——grep 显示这些方法仅出现在 test/simulator-runner.test.mjs:81-86。process-owner.mjs:4-7 的注释宣称“Never kills a daemon we did not start（停机权威）”，但代码库里没有任何地方真正用它来 kill/stop 守护进程。noteExisting() 只是把 ownedPid 设为 null（本就是初值），是空操作。

**建议**：删除 createDaemonOwner 及 runner 对 daemonOwner 的创建/返回（连同对应的孤立单测），或在真正需要 kill 守护进程的位置把它接上；当前它是纯装饰性的未用安全抽象。

### LOW-24 [死代码] mstd-orchestrator/tui/config.mjs:32

**问题**：TUI config 计算 maxReasonersPerSession，但没有任何 tui 文件读取它。

**证据**：grep maxReasonersPerSession：tui/ 目录内仅 config.mjs:32 定义(`intEnv(env,'MSTD_MAX_REASONERS_PER_SESSION',3)`)，无任何 tui 消费者。server 侧 config.mjs/coordinator.mjs 各自使用同名字段，与 TUI 无关，删除 tui 处不影响 server。

**建议**：从 tui/config.mjs 删除 maxReasonersPerSession 字段。

### LOW-25 [死代码] mstd-orchestrator/tui/data/db.mjs:106

**问题**：reliability() 每次轮询(800ms)执行 chainEvents 的 GROUP BY 查询，但结果从未在 UI 渲染。

**证据**：db.mjs 定义了 chainEvents 预编译语句(66-71 行 `GROUP BY chain WHERE kind IN('model_fallback','model_retry')...`)并在 reliability() 中 `chainEvents: stmt.chainEvents.all(sinceTs)`(106 行)执行。全仓库 grep `chainEvents` 只余 store.mjs:55 的空初值；app.mjs ReliabilityPanel 仅读 rel.fallbacks/kinds/latency，从不读 rel.chainEvents。整条链纯属 vestigial，却在每帧 snapshot 里跑一遍窗口 GROUP BY。

**建议**：删除 db.mjs 的 chainEvents 预编译语句与 reliability() 中的对应字段，以及 store.mjs 初值里的 chainEvents。

### LOW-26 [性能] mstd-orchestrator/tui/data/health.mjs:34

**问题**：健康探针每次轮询(默认800ms)都把整个 daemon.log 读进内存取末8行，而这8行从未被任何视图渲染。

**证据**：read() 里 `return { pid, up, uptimeMs..., log: logTail(8) }` 无条件求值；logTail = `readFileSync(logPath,'utf8').split('\n').filter(Boolean).slice(-n)`——每次都全文件读入+split。read() 仅在 store.snapshot() 被调用，snapshot 由 app.mjs `setInterval(store.snapshot, config.refreshMs)`(默认800ms)驱动。全仓库 grep：app.mjs(StatusBar)与 index.mjs(--probe)只用 health.up/.pid/.uptimeMs，`.log` 字段无任何消费者。daemon.log 随常驻进程无界增长，这是热路径上的无界同步全文件读，且结果被直接丢弃。

**建议**：从 read() 返回值删除 log 字段(连带 logTail)；若将来确需展示日志，改为仅在专门的日志视图里按需、增量(fstat+从尾部定长读)获取。

### LOW-27 [可精简] mstd-orchestrator/tui/store.mjs:4

**问题**：WARN_KINDS 的16项里13项已被同一分支的正则命中，集合可收敛到3项(或整体去掉)。

**证据**：classify() 第13行判定：`row.fallback_kind || WARN_KINDS.has(k) || /error|fallback|reject|invalid|abandon|rate_limit/.test(k)`。逐项核对 WARN_KINDS：仅 model_retry / reply_model_hash_mismatch / outbound_retry 三项不被该正则命中；其余13项(model_fallback、brain_fallback、brain_error、pipeline_error、dispatcher_fallback、dispatcher_invalid、responder_fallback、rate_limited、reply_egress_fallback、reply_egress_rejected、reply_target_rejected、reply_turn_rejected、business_turn_abandoned)均已被 fallback|error|reject|invalid|rate_limit|abandon 覆盖。

**建议**：把 WARN_KINDS 收敛为正则漏掉的3项(model_retry / reply_model_hash_mismatch / outbound_retry)，或把这3个词补进正则后直接删除整个集合。

### LOW-28 [正确性] mstd-ui/src/api/auth.ts:29

**问题**：apiFetch 在检查 response.ok 之前就无条件 JSON.parse，网关/代理返回非 JSON 错误体时抛 SyntaxError，吞掉友好的失败文案。

**证据**：auth.ts:28-30：先 `const text = await response.text(); const data = text ? JSON.parse(text) : {};`，再 `if (!response.ok) throw new Error(data.error || "请求失败")`。apiFetch 是全 UI 共享的请求入口。当网关/反代 502/503 返回 HTML 或纯文本（记忆里已记录 cz 网关宕机场景），parse 在第 29 行即抛，永远走不到第 30 行的友好分支；上层 catch（AdminBoard `setError(String(e))`、MemoryEditor `String(e.message)`）会把 'Unexpected token <' 这类原始报错直接显示给管理员。

**建议**：调整顺序：先按 response.status/ok 分流，再用 try/catch 包裹 JSON.parse；parse 失败时回退到 statusText 或“请求失败(<status>)”，保证错误文案稳定。
