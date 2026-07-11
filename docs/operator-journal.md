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

## 2026-07-11 - 阶段一 Task 5:C2 入站 @ 单趟规范化(27d4fff)

TDD:normalize/inbox RED(模块不存在+includes 误判)→ 实现 → 全绿。核心:
gateway/normalize.mjs 把结构化 @_user_N 与纯文本 bot 名编进同一 alternation 单趟
replace,检测与替换同源;raw_content 落库(migration 013);md5 指纹用原文;
无边界 substring 判定退役。

### 双引擎审核

- **§5.1 opus 对抗审核**:6 缺陷。采纳 4——①(高中)裸 string id 造成检测/替换
  分脑(normalizer 阶梯与 inbox structuredBot 同源化);②(中低)边界洞(右边界补 _、
  左边界只排 ASCII——中场自查把初版 \p{L} 左边界改成 ASCII-only,否则"问@小达"
  中文粘连真 mention 会被误拦,结构化 key 免左边界;复审确认这是关键正确决策);
  ③(低)dup-key Map 覆盖(保首个);④(低)md5 基于规范化文本(改 rawContent)。
  部分驳回 1(官方路径纯文本 @名 扩大 addressed——判 P1 双名语义产品意图,README
  扩展局限备注+冻结测试);驳回 1(缺 name 保留 key,可审计)。复审全确认,两条
  低危残留备案(全角字母粘连、畸形 dup-key bot 被丢时 inbox 级技术性偏离,均 fail-safe)。
- **§5.2 Codex 审卷**:16 条(6 高 6 中 3 低)全采纳,补 24 测试——生产装配链集成
  (env→loadServerConfig→wireGateway→扁平事件 addressed+content 规范化;这是 4B 轮
  Codex 同类发现的复发,composition 断线变异已可击杀)、admit 假覆盖(回加 substring
  即红)、混合来源同 alternation、单趟不级联(他人恰名"小达"不得二次替换)、013 升级
  路径(012 时代旧表直接执行 013)、异常回退四种 metadata 形状、恰一次调用计数、
  md5 精确指纹+等长负例、边界字符类(左数字/下划线、右数字、合法标点后继)、
  escapeRe 全元字符、(?!\d) 与最长优先隔离杀手、buildBotNames 三序冲突数据。
- **变异复验**:wire 丢 botNames 转发 → 装配链测试红,击杀。

### 验证

- orchestrator 571 passed/4 gated skip(strict;545→571),UI 51 不受影响。
- E2E(改动触及入站链路,按 §6.2 真机重验):p2p PASS;group 首跑在 ambient 段失败
  (triage 判 no_reply 未接话,同一运行内 respond 链 opus-4.6 出现 HTTP 503 降级
  ——@必答段 mode=addressed 且 content 已规范化,Task 5 直接改动面工作正常),
  判网关抖动期模型判断波动;重跑 PASS(四段剧本全过)。若后续 ambient 接话率
  持续走低,再评估 [@我] 记法先于 triage 提示词(Task 9)落库的行为漂移假设。
- 教训一条:全量回归必须在 mstd-orchestrator 目录下跑——仓库根 npx vitest run 会
  把 mstd-ui/bid-browse 一起扫出 50 个假失败。

### 评分卡

真机人眼剧本未跑,不打分。指代理解维度新增代码棘轮:mention 同源规范化 50+ 专项
用例(级联替换事故矩阵全冻结)。

### 挂起问题

- [MSTD-R] 报告信仍待用户放行(权限分类器拦外发邮件;已给出用户自行执行的
  `!` 命令与允许规则两条路径)。
- 下一任务:阶段一 Task 6(C3.1/3.2 store.recent + replaySet + 统一历史行语义)。

## 2026-07-11 - 阶段一 Task 6:store.recent/replaySet + 统一历史行(cd7e572)

TDD:store-recent 新套件 + 四消费点集成断言 RED(11 failed)→ 实现 → 全绿。核心:
recent 修 transcript 取最早被误当近期的 bug;replaySet 全量摘要 join(多轮压缩不丢
早期历史);formatHistoryLine 四处同源(tool=[内部记录] 永不冒充用户);brain 重放
快照按回合冻结。

### 双引擎审核

- **§5.1 opus**:核心逻辑零高危(rowid/schema 核对、SQL 参数化、compact 多轮时序、
  第 5 消费点排查、fake store 面、铁律 5 均过)。3 低危全采纳修复——triage/
  turn-handler 的 recent 补 roles 过滤(system 摘要不得以 [用户] 泄入)、limit 非
  正整数钳制、roles=[] 显式空集;复审确认无遗留(独立全量复跑 584 一致)。
- **§5.2 Codex 审卷**:14 条(7 高 6 中)。10.5 条采纳补杀——头号发现:brain 降级
  重放非幂等(fallback 重读 replaySet,失败尝试落库的行造成两个 provider 看到不同
  历史;Codex 独立探针实测漂移)→ 实现改回合级快照冻结,变异复验击杀;另补摘要
  精确相等(防按 ts 去重逃逸)、会话隔离(铁律 5 此前零测试!)、摘要资格合取混合
  干扰、过滤先于 LIMIT、limit 矩阵内容精确化(防"取最早 50"逃逸)、brain 历史块
  全序、idle 回收重放恰一次、恶意 role 参数绑定、turn-handler 精确 roles spy、
  helper 组合真值表。3.5 条驳回/登记:rowid 显式子句在 (session_id,ts) 索引计划
  下与隐式序等价、黑盒不可判别,判计划防御保留+注释,拒造锁查询计划的过拟合测试;
  composition root 冒烟归运行时工厂重构(登记阶段二,与 4B/5 同源诉求第三次出现,
  阶段二应统一解决);sentinel/AST 结构性证明过重;skip 门禁属套件级流程项(登记)。

### 验证

- orchestrator 590 passed/4 gated skip(strict;582→590),UI 51 不受影响。
- E2E:本任务改动为读路径重构(入站/出站链路无接口变化),四套 E2E 已在本日
  Task 4B/5 后真机全过,不重复消耗配额;下批次任务末统一重跑。

### 评分卡

真机人眼剧本未跑,不打分。上下文完整维度新增代码棘轮:近期语义/重放完整性/
历史行归属 40+ 专项用例(含会话隔离首次显式锁定)。

### 挂起问题

- [MSTD-R] 报告信仍待用户放行。
- 下一任务:阶段一 Task 7(C3.3/3.4/3.5 群聊滚动窗口 + 跨目标回写 + observed
  消费机制退役)。

## 2026-07-11 - 阶段一 Task 7:群聊滚动窗口/跨目标回写/observed 退役(7326986)

TDD:8 RED → 实现 → 全绿。C3.3 滚动窗口(30 条/含自身/HH:MM,append 前取)取代
一次性 observed 消费——复述二连问不再丢料;C3.4 跨目标投递回写目标会话(带 meta,
仅 p2p/group,不耗限额);C3.5 持久 nudge 水位(migration 014)。

### 双引擎审核

- **§5.1 opus**:零高危 + 4 条全采纳——①(中)窗口是第五个历史行消费点违反同源
  原则 → who 标注上收 history-format.whoLabel(fallback 可定制);②(低中)nudge
  claim-before-use 在 brain 失败时提醒被消费未送达 → 改 peek(回合前)+claim
  (成功后),丢失变最坏重复一次(无害),计划文件记实施偏差;③注释陈旧;④quick_reply
  白算窗口 → verdict 条件。复审确认含竞态面分析:per-session 串行 actor 下无双
  nudge、无 point 漂移;一条信息级备案(claim 重算 point 而非认领 peek 点,当前
  架构不可达)。
- **§5.2 Codex 审卷**:17 条(8 高 8 中 1 低),14 采纳补杀 15 测试——claim 过滤
  逐项判别、1000+ 水位、文件库关连接重开(杀水位存内存变异)、会话隔离(铁律 5)、
  水位只进不退、二连问防缓存改写(第二问恰一次且在块后)、出站失败源/目标零回写、
  self-target 不双写、p2p 回写正向+debug 排除、记录完整断言(platform_message_id)、
  全行 HH:MM、system 排除、作用域负向(p2p addressed/群 ambient 无窗口)、旧定界符
  与退役 API 反向锁。3 条驳回记录理由:调用序锁定(先 append 再取 30+批过滤是行为
  等价变异,锁调用序属过拟合);双连接竞争(同步单进程不可达,同 4A claimDue 先例);
  TZ 子进程隔离(过重;本机 UTC+8 下时区变异不可判别的局限已注释)。Codex 输出
  尾部网关再次断流(清单完整送达,记网关稳定性观察)。
- **变异复验**:回写挪到出站前 → 出站失败测试红,击杀。

### 验证

- orchestrator 610 passed/4 gated skip(strict;601→610),UI 51 不受影响。
- 观察一条:提交批次期间一次全量回归出现 1 例瞬时失败(未捕获用例名),同代码
  前后共 4 次全绿判负载波动;若复发需捕名定位(疑似 card-callback 有界 sleep 竞态)。
- E2E:入站消费语义变化(窗口/回写),下批次任务末统一真机重验。

### 评分卡

真机人眼剧本未跑,不打分。上下文完整维度再加棘轮:滚动窗口/回写/nudge 状态机
50+ 专项用例。

### 挂起问题

- [MSTD-R] 报告信仍待用户放行。
- 下一任务:阶段一 Task 8(C1 persona 扩展——中枢系统提示词替换)。

## 2026-07-11 - 阶段一 Task 8:C1 persona 扩展——中枢系统提示词整体替换(9e9b65e)

### 做了什么

常驻中枢甩掉 coding-agent 默认词:persona-prompt.ts 纯函数三层拼装(SOUL 全文/
世界观含记号约定与日期 workspace/工具纪律),persona.ts 在 before_agent_start 整体
替换,工厂期读 SOUL 恰一次、字节稳定吃前缀缓存。resident-extensions.mjs 成为常驻
扩展清单唯一来源(persona 第一)。index.mjs:SOUL statSync fail-fast(缺失/零字节
exit 1)、agent-workspace 创建+piCwd 迁出源码树、piEnv 注 MSTD_SOUL_PATH。brain
记忆段去 soul。真机验证两路:persona-probe 直探 startPi+hook,e2e-persona 全链
(daemon→飞书 p2p→reply 出站,bot 以小达自居并正确解释 [@我] 记号)。

### 双引擎审核

- **§5.1 opus**:3 条确认——头条为 persona"reply 唯一通道"与 compact/expiry/后台
  brief 的"不要调用 reply"冲突(归档时不请自来发消息/后台任务静默失败)→ 加
  系统维护回合豁免条款+锁测试(比 persona-less brain 便宜且正确:flush 必须跑在
  会话自己的 Pi 上)。复审确认三处 brief 全命中豁免,另提两条低危补强均落地:
  ①豁免作用域钉死「## 任务」段,带 [名字]:/[@我] 记号的用户消息注入"【系统维护
  回合】"字样不得诱导拒答;②锁定测试从关键词袋升级为触发词+方向句,并对
  compact/expiry/index 三处 brief 做"不要调用 reply"跨文件字面耦合锁(cron-runner
  已有"不调用 reply"变体,漂移即静默失配的前车之鉴)。
- **§5.2 Codex 审卷**:17 条(8 严重 6 高 3 中)+4 无缺陷项。12 采纳补杀:default
  export 注册(fake pi.on 恰一次 before_agent_start)、SOUL fail-fast 子进程负例
  (缺失/零字节→exit 1,显式最小 env 防 E2E 批跑泄真实 profile)、brain 去 soul
  sentinel 锁、单夹具→互异 sentinel+三层顺序+动态值恰一次、关键词袋→方向性整句、
  readFile 锁(路径,"utf8")+时区杀(UTC 晚间=北京次日)、SOUL 空白表驱动、E2E 随机
  DB/workspace+afterAll 清理、清父环境 MSTD_SOUL_PATH、ready 加 HTTP 探活、
  SIGTERM→SIGKILL 兜底、否定式假绿守卫(不是小达/代码助手)。5 条拒绝备案:skip
  门控(套件级政策,四门控串行真机跑=发布仪式,CI 门禁 Phase 2)、全链事件绑定
  (重仪表化;[@我] 记号语义只在 persona prompt 定义,E2E 命中即路径证据)、index
  消费唯一清单/job 清单负断言(composition-root 注入,Phase 2 第三次复发项)、
  维护回合冲突(审卷时已修,即 §5.1 头条)。
- **变异复验**:3/3 杀——SOUL fail-fast 改 if(false)→子进程负例红;default export
  改错事件名→注册测试红;brain 把 soul 加回记忆段→sentinel 测试红。

### 事故记账

变异还原误用 `git checkout -- server/index.mjs`,把未提交的 Task 8 接线连同变异
一起回退。凭本会话审读记录逐行重建,diff 核对与设计一致后全量+E2E 重验通过。
**铁教训:未提交文件上的变异,还原只能用反向编辑(perl 正反对),严禁 git checkout。**

### 验证

- 全量 616→626 passed/5 skipped(strict,只增不减;+10 为审核补杀)。
- e2e-persona 真机 PASS(49.9s,随机隔离+探活+否定断言加固后)。
  中途一次假失败自查:E2E 网关四门控里 MSTD_TEST_OPEN_IDS/CHAT_IDS 必须显式
  export(.env 不含),缺了 daemon 直接 fail-fast 拒起——这正是 H2 清单在起作用。
- tsc:persona 文件零报错(既有 lark-read.ts 8 条历史报错未触碰)。

### 挂起问题

- [MSTD-R] 报告信仍待用户放行。
- Phase 2 新登记:reply_sent 事件绑定 message-ID 的全链归因(§5.2 #2 余量)。
- 下一任务:阶段一 Task 9(C4 SOUL.md 重写+triage 提示词+复述类代码 guard)。

## 2026-07-11 - 阶段一 Task 9:C4 SOUL 干练同事风+分诊记号化+复述 guard(6cbc555)

### 做了什么

TDD:9 RED → 实现 → 全绿。①RECAP_INTENT 导出+enforce(verdict,items,mode)——
非 ambient 下 items 命中复述/总结类,quick_reply(答不全)与 no_reply(静默)都强制
escalate,ambient 豁免;②SYSTEM_TEMPLATE 全文替换(记号说明/复述必升级/反客服腔/
口吻约束);③SOUL rev3 在 agent-memory 独立 git 仓两段式提交(基线→rev3→框定修),
主仓 soul-content.test.mjs 防客服风回退。

### 双引擎审核

- **§5.1 opus**:总体"可合入无高危"。1 中采纳——WRITE_INTENT×RECAP 碰撞("提醒我
  明天写总结")brief 误标复述误导中枢 → 写意图命中改中性 brief+测试锁;1 低采纳——
  ✗ 客服腔反例进弱模型有模仿风险 → SOUL 示例段标题显式框定"错误示范"。3 低备案:
  busy 补充消息升级(spec 明选绝不静默,turnTails 串行无并发危害)、裸词误伤宽
  (保守方向,真机成本痛再收)、triage 空 SOUL fail-open(分诊 fail-closed 会放大
  快照缺失为全线拒诊,Phase 2 composition-root 统一告警)。关键确认:Task 8/9 接缝
  完好——inject.mjs 仍产 snapshot.soul,triage/reply 各注入一次,brain 走 persona
  无双重注入;recap escalate 恰好落进群窗口 gating,复述类拿到所需上下文。
  复审:五项处置全过。
- **§5.2 Codex 审卷**:10 高 3 中(全是测试强度缺口,实现被其只读探针逐项确认
  "无实现缺陷")。11 采纳补杀 33 测试:SYSTEM_TEMPLATE 关键词袋→方向句+soul 前缀
  恰一次、recap 关键词重叠假绿→正则直测互不重叠正例、addressed 正例全带 [@我]→
  无记号 p2p 正例(杀 guard 偷看 marker)、动作集合防扩大→escalate/steer sentinel
  原样保留、parse→enforce 顺序、多 item 精确 brief(toEqual+slice)、ambient 豁免
  盖 quick_reply+observe_only 升级、text 不扫描、200/201 边界、WRITE_INTENT 16
  分支逐词、时间窗 12/13/跨行。2 部分拒绝:提示词优先级重排(ambient 沉默倾向与
  复述必升级不矛盾,模型主动升级本就允许,保留锁已加)、"在吗"真机风格场景入自动化
  (LLM 风格断言脆,归真机人眼剧本)。
- **变异复验**:3/3 杀(时间分支删除/动作集扩大/mode 条件收窄)。

### 验证

- 全量 626→668 passed/5 skipped(strict 只增不减;+42=Task 9 主体 9+§5.1 1+§5.2 33
  减重构归并)。
- e2e-persona 真机 PASS(63s,新 SOUL 生效:小达自居+懂记号+客服腔零出现;
  MSTD_MEMORY_DIR 钉死读真实 agent-memory)。
- agent-memory 独立仓:030ba3f init → 42567bb rev3 → 2785f6d 框定修。

### 挂起问题

- [MSTD-R] 报告信仍待用户放行。
- 下一任务:阶段一 Task 10(C4/C6 reply 出口提示词+deliverKind 投递感知)。

## 2026-07-12 - 阶段一 Task 10+11:出口场景感知+Markdown 卡片分流(591a441,合并交付)

### 做了什么

Task 10(C4):renderReply 加 deliverKind,SCENE 表注入长度策略(群三句/私聊展开),
SYSTEM 重写(自然同事腔+飞书渲染约定);turn-handler 由裁决后 deliverKey 解析场景。
Task 11(C6):hasRichMarkdown 冻结契约(强信号单命中/弱≥2类共现/转义哨兵不计)、
buildMarkdownMessageCard 固定结构、sendToSession 收敛为唯一出口 deliverText
(md→消息卡,否则纯 text,四路径统一)。

### 实施偏差(计划两提交→一提交)

§5.1 opus 判 Task 10 单独交付 BLOCKER:"含 Markdown 时系统会自动走卡片渲染"在
Task 11 分流落地前是假声明——提示词主动诱导出口吐表格,text 消息类型不渲染 md,
群里会看到字面 "| a | b |"。两任务共改 turn-handler 无法干净拆分,合并为单提交
消灭假声明窗口。教训:跨任务的提示词声明要与实现同批,spec 拆分粒度没预见这一点。

### 双引擎审核

- **§5.1 opus(T10)**:BLOCKER 如上;其余四项(deliverKind 与出站同源、场景边界、
  四层提示词一致性、旧措辞退役)无缺陷。SOUL"三句话以内"与 SCENE.group 逐字对齐。
- **§5.1 opus(T11)**:可合入+1 低危实缺陷——转义剥离删成空串会把 "\## x" 剥成
  "# x" 造出标题信号(实测证实);修复=U+0000 哨兵占位(非空白,挡行首锚定)+反例。
  注意坑:第一次修复用空格当哨兵——空格属 \s 会被行首锚吃掉,等于没修;第二次
  Edit 又写进裸 NUL 字节(4B 同款坑),perl 转成 U+0000 转义序列。deliverTrusted
  "提醒:"前缀遮首行标题备案(概率极低,降级纯文本无害)。sendCard 契约核实与
  确认卡同机制同白名单,idempotencyKey 透传,返回形状一致。ReDoS 实测 50-100k
  病态输入 <2ms。
- **§5.2 Codex(合并审卷,8 高 8 中全采纳,+31 测试)**:含 1 实现缺陷——表格分隔行
  正则不要求连字符,"|   |   |" 误判(修正为每列必须含连字符);其余为测试强度:
  零出站断言只盖 sendMessage(补 sendCard 双通道)、弱信号只有一对共现(补逐类
  正例+单发反例)、转义预处理整段删除无杀(补转义链接反例)、隐式幂等键删默认值
  无杀(补非空断言)、唯一出口无结构保护(补源码 outbound.send 计数锁,恰 2 处)、
  debug 语义只查 deliverKind(补双通道零出站+platform_message_id null)、
  targetArg guard 不可达(补 cron 自会话 rejects)、恶意卡 keySet 折叠数组(改
  toStrictEqual)、最近邻非法值矩阵(单行表格/7 井号/无空格引用/两连字符/URL
  空格/句中围栏/无空格列表)、≥2"类"语义(混用标记同类/同类重复不达阈)、
  deliverKind 四场景矩阵(杀"部分来源用 sessionKey"杂交变异)、parse 抛错兜底
  直测、SCENE 完整句+互斥+card_copy 场景不变性+未知场景等价 p2p、卡片
  message_id 落库+sendCard 失败零落库原子性。
- **变异复验**:3/3 杀(有序列表正则删除/幂等键默认值删除/分隔行正则回退——
  三个都是审卷前杀不死的变异,补杀后全红)。
- **Codex 审卷第一次跑超时被杀**(10min 上限),合并 10+11 重发一次成功;
  网关拥堵时段审卷要预留更长时限或拆小审核面。

### 验证

- 全量 668→719 passed/5 skipped(strict 只增不减;+51)。
- 真机直探:buildMarkdownMessageCard 经生产 outbound.sendCard 发测试群成功
  (om_x100b6a1...),表格+代码块以卡片渲染——飞书接受该 Card JSON 2.0 结构,
  Task 10 的渲染声明落地为真。
- e2e-persona 不受影响(纯文本问答);批末统一重跑四套门控。

### 挂起问题

- [MSTD-R] 报告信仍待用户放行。
- 下一任务:阶段一 Task 12(C5 机器人改名,实机严格顺序)——含浏览器后台操作与
  daemon PID 所有权规则。

## 2026-07-12 - 阶段一 Task 12:C5 机器人改名「小达」实机完成(024a0cc)

### 做了什么(严格顺序,全程真机)

1. **aliases 先行**:.env 写 MSTD_BOT_ALIASES="user613148's Feishu CLI"(zsh -n
   校验);临时验证 daemon(自有 PID,隔离 DB/workspace/端口 8795)+真机 @旧名 →
   日志 mode=addressed ✓。第一次发消息打到 bot 建的测试群报 230002(持牌 user
   不在群),改用 E2E 写目标群 oc_b67c… 通过——**教训:测试群有两个,user 只在
   oc_b67c 那个**。
2. **后台改名发版**(浏览器实机):开发者后台 国际化配置 应用名称→「小达」(应用
   描述必填,一并补写);创建版本 1.0.3(免审核,提交即生效,2026-7-12 1:18 已发布)。
3. **切主名**:.env MSTD_BOT_NAME=小达(旧名留 aliases);新验证 daemon 起后真机
   @小达 与 @旧名 各一条——两条均 mode=addressed,入库 content 均为"[@我] …"
   (C2 规范化+C5 双名 spec 验收原文,SELECT 实证)。
4. runbook 补改名 SOP(§4.5:顺序/免审说明/PID 所有权/回滚预案),.env.example 补
   MSTD_BOT_ALIASES 注释。

### 审核说明

本任务无生产代码/测试变更(纯实机操作+文档),双引擎代码审核不适用;验收即真机
双名 addressed+入库规范化的硬证据。PID 所有权全程遵守:pgrep 先查(一次瞬态误报
25594,ps 复核为已消失进程,未误杀),临时实例只清理自录 PID,结束后 pgrep CLEAN。

### 挂起问题

- [MSTD-R] 报告信仍待用户放行。
- 下一任务:阶段一 Task 13(文档同步+全量回归+真机验收剧本)——阶段一最后一项。

## 2026-07-12 - 阶段一 Task 13:文档同步+全量回归+真机验收剧本(920f273)【阶段一收官】

### 做了什么

- README 全面同步:respond 链 v4-pro、pi-ext 增 persona/lark-read、agent-workspace
  /scripts 目录、SOUL fail-fast+人格生效延迟(Pi 拉起才读 SOUL,改后需回收或重启)+
  进程所有权、消息记号约定全集、heartbeat 走 DB(旧 HEARTBEAT.md quarantine)、
  C6 deliverText 唯一出口、SQLite 方言例外、MSTD_BOT_ALIASES/静态 token 废弃、
  持牌 user 仅 oc_b67c 群的坑。
- scripts/e2e-serial.sh + e2e-one.sh:五套 E2E 串行 + Vitest JSON 门禁
  (success && passed>0 && passed==total && 无 failed/pending/todo),独占前置探测
  daemon/consumer 存在即退出不代杀。固化"skip 假绿判 FAIL"为可执行门禁。
- spec 状态改「已实施」。

### 验证

- 单测双绿:orchestrator 719 passed/5 skip + ui 51 passed。
- **五套真机 E2E 全 PASS(JSON 门禁)**:e2e-persona/write/p2p/group/full 逐套
  bash scripts/e2e-one.sh,每套 success+passed>0+无 pending/todo。
- **四幕真机剧本**(隔离 daemon,快 ticker+全时段 heartbeat):
  1. 群聊三话题(火锅外卖/评审会/打印机)→@小达 复述:第一次完整命中三件事、
     无旧应用名;二连问"再复述一遍"第二次仍完整有料(DB 两条 assistant 均全)。
  2. @小达 在吗 → "在,说。"零客服腔(对照 SOUL ✓例)。
  3. 私聊要对比表格 → 出站 msg_type=interactive 卡片(API 核实),表格正常渲染。
  4. 私聊"1分钟后提醒我喝水" → heartbeat 单条 owner=自会话,准时 delivered;
     "2分钟后在测试群提醒" → **先出确认卡,确认前 heartbeat 表无跨会话 row**
     (hb_count 恒为 1 只有喝水那条)。浏览器点确认返回"仅发起人可操作此卡片"
     ——第二道锁(operator 校验)正确拦非发起人(浏览器登录账号≠lark-cli 服务
     账号 ou_aca75bd),属额外安全验证;"确认后投目标群"链路由 e2e-write/group
     程序化覆盖(已 PASS),真机浏览器身份限制无法手点。

### 阶段一收官

Task 1-13 全部完成。总提交链(本会话段):18d40ea..920f273。单测基线 452→719。
双引擎审核全程:opus 证伪式代码审 + Codex 变异审卷,每任务补杀+变异复验+真机验证。
实施偏差已在 spec/plan/本日志留痕(T10/T11 合并交付、persona 系统维护回合豁免、
md 表格分隔行须含连字符、git checkout 还原事故等)。

### 挂起问题

- [MSTD-R] 阶段一收官报告信仍待用户放行(命令见下方交接)。
- 阶段二登记项(散见前期日志):确认后执行窗口崩溃缺口、cron 发起跨会话提醒发卡前
  拒绝 UX、index.mjs composition-root 注入统一(三次复发)、reply_sent 全链
  message-ID 归因、dateStr 冻结>24h、triage 空 SOUL 与 persona fail 策略对齐。
