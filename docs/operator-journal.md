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
