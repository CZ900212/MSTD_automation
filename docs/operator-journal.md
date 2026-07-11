# Fable 操作员工作日志

> 双引擎版操作员(Claude Fable 5)的跨会话状态记忆。每轮追加:日期、做了什么、
> 双引擎审核结论、验证结果、评分卡、挂起的问题信编号。姊妹日志:`docs/codex-journal.md`
> (Codex 操作员时期,Task 1 记录在那边)。

## 2026-07-11 - 上线接管 + Task 2 关停加固收口

### 状态恢复

- Codex 操作员(CCB agent1/agent2/agent3)于 2026-07-10 因模型网关
  `direct.cz900212.com/responses` 持续 503 停摆。停摆点:agent1 已完成 Task 2
  (C0.2)关停加固的 GREEN(26/26 + 变异验证),卡在 agent2 最终只读复审一步,
  四个文件(brain.mjs、brain.test.mjs、brain-concurrency.test.mjs、
  brain-shutdown.test.mjs)留在工作树未提交。
- Fable 操作员按 §12 启动清单接管:基线全绿(orchestrator 402 passed/4 gated skip,
  UI 51),分支 feat/resident-agent 无误。
- `docs/prompts/` 两个总提示词文件的未提交改动是用户本人编辑(GPT-5.6 terra high
  措辞更新 + CCB 桥接说明),沿袭前任惯例不代提交。

### 本轮内容:Task 2 遗留收口

接手 agent1 的未提交工作(shutdown 可中断 sleep:closedController+closedPromise+
sleepWhileOpen;shutdown 等待在途 spawn settle;测试按主题拆分为 brain /
brain-concurrency / brain-shutdown 三个文件)。

**§5.1 对抗性代码审核(opus 独立 subagent)**:
- 缺陷 1 条(低):共享 AbortSignal 上并发 sleep 监听器可超默认 10 个,触发
  MaxListenersExceededWarning 噪声。已修:`setMaxListeners(0, closedController.signal)`。
- 拆分完整性:旧 brain.test.mjs 23 用例 → 14 原样迁移 + 2 加强(P2/P9,旧断言全保留)
  + 3 新增(P10/P11/P12),无静默丢弃。
- 其余逐项(TOCTOU 窗口、快照时机、lease 泄漏、监听器/timer 清理、七条铁律)均未发现缺陷。

**§5.2 测试审卷**:Codex 不可用(网关 503,见下),按预案降级为独立 fable 审核
subagent 做变异测试审卷(13 个变异注入,10 击杀 + 1 近等价)。缺陷 5 条,处置:
- 【高】defaultSleep 自然到点路径监听器摘除零覆盖 → 已修:导出 defaultSleep,
  新增 P13 锁三条路径(自然到点/中止/预中止)的监听器与定时器卫生;变异复验击杀。
- 【中】setMaxListeners 修复零覆盖 → 已修:新增 P14 多等待者用例(12 会话等
  semaphore,shutdown 一次全解挂)。诚实备注:实测 Node 22 的 AbortSignal 默认
  无监听器上限,原"告警噪声"前提在本机运行时不成立;该行保留为对旧运行时
  (默认上限 10)的跨版本防御,P14 告警断言在 Node 22 无判别力,注释已注明。
- 【低】×3(首个 assertOpen 近等价、末次尝试尾部 sleep 行为锚定、错误正则偏松)
  → 拒绝修改,理由记入 commit 18d40ea。

**提交**:`18d40ea`(四文件:brain.mjs + 三个测试文件)。全量回归
`--unhandled-rejections=strict` 404 passed / 4 gated skip。

### Codex 引擎状态

- `codex exec`(0.144.1)两次自检均 503(网关根路径 200,`/responses` 上游不可用)。
- 已降级 1 个任务;若下一任务仍不可用,按 §5.2 触发问题信(但问题信信道本身受阻,见下)。

### 邮件信道(§9)阻塞

- 前任已在 bid-browse 完成信道代码(commit 18bffb8,operator.ts + 624 行测试,
  worker 全量 166 绿),但**未部署**:线上 D1 无 operator_qa 表、OPERATOR_TOKEN
  secret 未设、worker 未重新 deploy。
- 本会话权限层拦截了 `wrangler d1 execute --remote`(生产目标需用户点名授权)。
  邮件信道上线被阻塞,待用户授权三步:线上建表(schema.sql 163-180 幂等 DDL)→
  `wrangler secret put OPERATOR_TOKEN` → `wrangler deploy`。
- 在此之前,问题信/报告信无法发出,改为在本日志与会话答复中备案。

### 登记的后续项

- agent1 终审遗留裁定:active runJob 不响应 close、最长由 240s turn timeout 收口。
  判定为登记项而非阻断(生产尚无 brain.shutdown 调用点),归入阶段二可靠性计划评估。
- expiry 候选顺序等待与 params_json LIKE 扫描(承接 codex-journal Task 1 残余风险)。

### 评分卡

未跑真机剧本,不虚构分数(同 Task 1 轮惯例)。可靠性维度获得可验证代码棘轮
(shutdown 主动中断 + 资源不泄漏,26 个专项测试)。

### 挂起问题

- [待发问题信] 邮件信道部署三步授权(上文)。
- 下一任务:阶段一 Task 3(C0.3 会话绑定 token),规格已读(计划文件 192-368 行)。

## 2026-07-11 - 阶段一 Task 3:C0.3 会话绑定 token(2d11bdd)

- TDD 全程:RED(3 文件 import 失败)→ 实现 → 421 passed/4 gated skip(strict)。
- §5.1 代码审核(opus):高危 reply.target / heartbeat deliver_to+match 跨会话投递
  ——属实但系 Task 4A/4B 既定范围,仲裁为"下一任务立即做",commit 不宣称 S2 全收口;
  低危"未解析 token 零留痕"当场修(sessionKey=null 留痕,token 值不落日志)。
- §5.2 测试审卷(Codex 仍 503,连续第二任务降级 fable;按规程应发问题信,但邮件
  信道被部署权限阻塞,以本日志+会话答复代为上报):变异 8 个 2 存活,已补杀——
  六路由 guard 全覆盖(无 token 先于 501/冒名 403/绑定注入)、有效 token 嵌畸形头
  锚定 strict 正则;补 spawn-after-shutdown 吊销锚定;复验两变异均击杀。
- E2E(真机):write PASS、p2p PASS——p2p bot 回复即证 per-spawn token 回连
  全链真机工作。group FAIL:gpt-5.5 上游 503(api.cz900212.com,与 Codex 同源),
  @必答超窗,判网关阻塞非代码缺陷;group+full 待网关恢复重跑。
- 环境修正:.env 补 MSTD_SESSION_SECRET(E2E 写闸/审批链必填,原缺失);
  E2E 正确姿势 = 先 `set -a; source .env; set +a` 再带四个门控变量跑。
- 评分卡:未跑真机剧本(网关故障中),不打分;安全维度新增代码棘轮
  (内部通道冒名 403,24 个专项用例)。

## 2026-07-11 - 阶段一 Task 4A:C0.4 投递面授权(1e5adae)

封堵 C0.3 审核暴露的 reply.target / heartbeat 跨会话面。fable 实现 subagent
承接(单实现线程),TDD 全程,净增 33+ 用例。

- §5.1 opus 对抗审核:安全维度未发现可被 Pi 触发的越权(deliverTrusted 不挂路由、
  grant 生命周期 finally revoke 无泄漏、owner_session_key 无 UPDATE 面、claim 三重
  限定、strict-iso 恶意 ISO 矩阵全 fail-closed、CHECK+FK 挡普通 Pi 造跨会话 row)。
  唯一可靠性缺陷(releaseStale 仅启动跑一次→崩溃遗留 delivering 永久卡死)当场修:
  改每 tick 先回收,补 P 用例+变异复验。其余为 Task 4B 接线前的惰性悬置项(addApproved
  未接线)与文案面,记录不阻断。
- §5.2 fable 变异审卷(Codex 仍 503,连续第三任务降级):8 变异 7 击杀。存活项
  = claimDue 去 `AND status='pending'` 守卫;opus 已独立确认 better-sqlite3 同步单
  进程下并发双 claim 架构性不可达,判近等价变异(纵深防御未来 async/多进程);
  已补 claim-once 契约(锚 SELECT status 过滤)+ owner 不可变全生命周期回归两条强化。
- 验证:orchestrator 452 passed/4 gated skip(strict);E2E full 待网关恢复重跑。
- 阶段一进度:Task 1(codex 期,54ff304 等)、Task 2(18d40ea)、Task 3(2d11bdd)、
  Task 4A(1e5adae)完成;下一 = Task 4B(schedule_reminder 接四道锁,把 addApproved
  接上确认卡 executor)。

### Codex 引擎连续三任务不可用(§5.2 应发问题信,信道受阻)

按 §5.2「连续两任务无法用 Codex 就发问题信」,现已连续三任务降级 fable。
但问题信信道本身被 wrangler 部署权限阻塞(见首条日志),无法发出。改在此备案,
并列为最高优先级待用户处理项:恢复 Codex(网关)或授权邮件信道部署二选一,
否则测试审卷将长期单靠 fable 独立 subagent(异族互审结构性要求打折)。

## 2026-07-11 - 阶段一 Task 4B:schedule_reminder 四道锁(0bf28df)+ 两大阻塞项解除

用户会话中授予全部权限并指示"继续迭代直到完成所有任务"。本轮三线并进。

### 阻塞项解除

- **Codex 恢复**:网关 `/responses` 上游恢复,`codex exec` 自检在线。本任务 §5.2
  测试审卷回归 Codex(GPT-5.6),异族互审重新成立;连三降级备案关闭。
- **邮件信道上线**(用户授权后我亲手执行三步):operator_qa 线上建表(幂等 DDL,
  d1 execute --remote 成功)→ OPERATOR_TOKEN secret 设置(token 生成后直入
  worker secret 与 .env 的 MSTD_OPERATOR_TOKEN,零回显零日志,临时文件即删)→
  `wrangler deploy`(版本 47e717d2)。验证:worker 166 测试绿、伪 token POST
  /operator/send 401、远程轮询 SELECT 通。问题信/报告信信道自此可用。

### Task 4B 本体

接手前任中止的工作树(3 个 RED 测试文件),补齐 write-target/execute-action/
write-phase/card-callback/card-execute 五文件 RED(42 failed 起步),TDD 实现:
- DSL 闭合 schedule_reminder(canonical round-trip deliver_to/严格 ISO 归一 UTC/
  text 边界/未知字段拒),canonicalDeliverableKey 上收 session-key.mjs 与 heartbeat 同源。
- 确认回调重构为单事务 approveTx:token 消费(tokenId 回传)→form 重算→immutable
  decision→card/job 翻 executing,任一步失败整体回滚(含 used_at)。
- executor 只认最新 decision 批准 hash(ts DESC,rowid DESC),缺失 not_approved;
  schedule_reminder 走 heartbeat.addApproved adapter(source_action_id 幂等,
  canonical 重建 dry validation 取代 lark --dry-run,绝不构造 argv)。

### 双引擎审核

- **§5.1 opus 对抗审核**:3 缺陷全采纳当场修——①(中)approveTx 翻 executing 但
  hasActiveJob 不含该状态→执行窗口会话可能被过期归档(我引入的回归;提取
  ACTIVE_JOB_STATUSES 共享常量并纳入 executing);②(低中)reconcile 对本地 DB 写
  误用 lark task 指纹→按 heartbeat_items.source_action_id 对账;③(低)owner 未
  canonical 校验→cron/debug 发起 fail-closed(与 addOwned 同标准)。复审确认
  三修复有效、无新缺陷。驳回 1 条文案 nit(heartbeat_update 工具名属实存在)。
- **§5.2 Codex 测试审卷**(恢复后首单):16 缺陷(6 高 7 中 3 低),14 条采纳补杀
  13 个测试——事务原子性用 SQLite trigger ABORT 证明全回滚、两 action 半程回滚、
  只改 JSON 保留 hash 的 tamper 杀 dry validation、decision 缺项 not_approved、
  ts DESC 保护、幂等键不过宽(同 payload 双 action 双行)、reconcile 指纹按 action
  区分、group owner≠发起人、testTargetFromEnv 交叉映射、五表零断言、ISO ±14:00
  极限、topic group 正向、schema const 精确集合、orchestrator wrapper 透传。
  2 条部分采纳记录理由:①index.mjs 生产装配无单测(composition root 不可单测,
  缺口交真机剧本第 6 条设提醒场景覆盖,登记);②负向异步 sleep 无法证伪
  "不发生",正向链路改 onExecuted 事件等待,负向保留有界 sleep(注释说明)。
- **变异复验**:删 dry validation→tamper 测试红;按 Codex 原版变异 diff 拆分
  确认事务→trigger 测试红。两头号变异击杀,源码还原后全绿。

### 验证

- orchestrator 521 passed/4 gated skip(strict;基线 452→521),UI 51。
- E2E 真机四套全 PASS:write/p2p(前轮)+group/full(本轮网关恢复后重跑)。
  group 首跑瞬时失败(lark 发消息一步,判网关恢复期抖动),重跑 143s 全过;
  full 首跑因缺 MSTD_ENABLE_WRITE=1 整套 skip(假绿判 FAIL),补第四门控后
  355s 全过。**E2E 正确姿势更正:四个门控 = MSTD_E2E + MSTD_ENABLE_WRITE +
  MSTD_TEST_OPEN_IDS + MSTD_TEST_CHAT_IDS,e2e-full 缺 ENABLE_WRITE 会静默 skip。**

### 登记的后续项(阶段二评估)

- 崩溃窗口:approveTx 提交后、executeConfirmed 收尾前进程崩溃→job 永久停
  'executing',reconcileOnBoot 不收口该状态(且修复①后该 job 会让 owner 会话
  永久豁免过期归档);处理时须连带 enableWrite=false 时本地指纹对账被 runLark
  gating 跳过的小缝。
- cron 发起 schedule_reminder 的 UX 缝:现为确认卡批准后才 no_owner_session
  失败;更优是发卡前拒绝(安全语义已正确,属体验优化)。
- index.mjs 生产装配(heartbeat 注入 confirmFlow)以真机剧本第 6 条为验收面。

### 评分卡

真机人眼剧本(§5.3 Codex computer-use)本轮未跑,按惯例不打分。安全维度新增
代码棘轮:跨会话提醒四道锁 60+ 专项用例,含事务原子性与 tamper 双层防线。

### 挂起问题

- [MSTD-R] 报告信(接管状态+Task 4B+信道上线合并汇报)已撰写并尝试经
  POST /operator/send 发出,被本会话权限分类器拦截(外发邮件含内部细节判高危)。
  信道本身已验证可用(伪 token 401/轮询通),仅"发信"这一步需用户放行:
  在 Claude Code 设置加对应 Bash 允许规则,或会话中明示确认后我重试。
  在此之前报告以本日志与会话答复代为送达。
- 下一任务:阶段一 Task 5(C2 入站 @ 单趟规范化 + 同源 mentionsBot + migration 013)。
