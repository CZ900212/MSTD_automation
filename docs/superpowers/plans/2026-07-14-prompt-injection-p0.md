# 小达提示词注入 P0 修复实施计划

> 基准：2026-07-14 架构评审与当前 `feat/resident-agent` 脏树。
> 原则：保留现有唯一 reply 出口、finalText 隔离、Action DSL/审批哈希、active-turn reservation；新增控制必须由 daemon 持有，模型输出只作为不可信数据。

## 已探索与问题定位

- 入站主链是 `normalize -> markSeen -> admit -> debounce -> actor -> triage -> brain`。`scanPromptInjection()` 只用于离线评测/cron，没有接入 `server/gateway/wire.mjs`，因此明显攻击仍会进入模型并受 actor/maintenance 阻塞。
- triage 仍返回单一 `action`，`write_intent` 可覆盖 prompt injection / secret exfiltration，复现结果与事故一致。
- `agent_messages` 无 `replayable`、`prompt_eligible`、`memory_eligible` 或安全类别。攻击原文和 brain `finalText`（role=tool）会进入 replay、reply render、compact、dreaming。
- `SECURITY_REFUSED` 不存在。当前只有通用 daemon fallback，无法表达安全判定，也无法保证攻击只得到一次固定拒绝。
- reply 正式路径已有 pre/post egress、epoch fence、target grant 和 terminal reservation，但 quick reply、ACK、trusted reminder、部分卡片旁路统一策略。
- maintenance 虽有独立 purpose，却仍在 `handleTurn()` 内 await；actor 只有 FIFO tail，所以用户回合终态后仍可能被维护阻塞。
- capability token 主要按 resident/session，而非 turn/tool；memory/background/search 等副作用缺少统一 turn/lease/epoch commit fence。
- SQLite 没有统一 reply outbox；物理发送成功、receipt 落库前崩溃会留下重复发送窗口。

## 完成标准

第一交付批次完成时必须满足：

1. 真实事故文案及编码/Unicode 变体在 triage、actor、brain、maintenance 之前被确定性识别。
2. 私聊/已 @ 群聊只发送一次 daemon 固定安全拒绝，终态为 `SECURITY_REFUSED`；未 @ 群聊仅隔离、不回复。
3. 攻击原文只进入 security quarantine；transcript 仅有无正文 tombstone，且不可 replay、不可进入 prompt、不可进入 memory/compact/FTS。
4. brain 内部 finalText 不再进入任何模型上下文。
5. 正常业务负对照不被阻断；目标安全测试、现有全量测试均通过。
6. fast path 不等待 debounce/actor/triage/brain；单元级处理预算 p99 < 3 秒。

完整 P0 收口还必须满足：统一出站 reference monitor、独立可取消 maintenance、全副作用 capability fence、持久 reply outbox、kill switches、缩短且可取消的 job timeout；这些拆为后续独立提交，避免与事故链修复混成一个不可审阅改动。

## Task 1：确定性、多标签安全分类器

**文件**

- 新增：`mstd-orchestrator/server/safety/security-fast-path.mjs`
- 修改：`mstd-orchestrator/server/safety/injection-signals.mjs`
- 新增：`mstd-orchestrator/test/security-fast-path.test.mjs`
- 扩充：`mstd-orchestrator/test/fixtures/prompt-injection/`

**测试先行**

- 真实事故提示同时返回 `prompt_injection`、`secret_exfiltration`，不得被 `write_intent` 覆盖。
- 覆盖 Unicode Cf、NFKC/NFC、JSON/Unicode escape、受限 Base64/Hex 解码；解码必须有长度/层数上限。
- 管理员讨论“系统提示词工程”、正常配置迁移、普通安全培训是负对照。
- 输出为 `{ decision, flags[], primaryFlag, confidence, normalizedHash }`；权威优先级为 credential/cross_scope/secret_exfiltration > prompt_injection/policy_bypass > write intent。

**实现**

- fast-path 使用独立高置信规则集，不复用 egress 的广义 instructional-payload 阻断语义。
- 只记录规则 ID、flags、长度、哈希和处理耗时；日志不得包含原文或解码后的秘密。

## Task 2：quarantine 与不可回放 transcript

**文件**

- 新增：`mstd-orchestrator/server/db/migrations/017_security_quarantine.sql`
- 修改：`mstd-orchestrator/server/sessions/store.mjs`
- 修改：`mstd-orchestrator/server/gateway/inbox.mjs`
- 修改：`mstd-orchestrator/server/memory/compact.mjs`
- 修改：`mstd-orchestrator/server/ticker/dreaming.mjs`
- 新增：`mstd-orchestrator/test/security-quarantine.test.mjs`
- 新增：`mstd-orchestrator/test/session-replay-security.test.mjs`

**测试先行**

- security event 原文只存在 quarantine，`inbox_events.raw_content`、agent transcript、FTS 均无攻击字节。
- tombstone 固定为服务端文案，`replayable=0`、`prompt_eligible=0`、`memory_eligible=0`。
- `recentForPrompt()` / `replaySet()` / compact / dreaming 默认只读 allowlisted 行。
- role=tool 的内部 finalText 明确不可 prompt/replay/memory；已有普通用户/助手历史语义保持不变。

**实现**

- 新增 `security_quarantine`：event/session/sender、ciphertext-or-raw payload、content hash、flags、rule version、timestamps。首批若尚无密钥管理，至少独立表、最小查询 API、禁止 FTS，并在代码/文档标明待加密迁移；不可伪称已加密。
- `agent_messages` 增加显式 eligibility 字段和 `security_class/provenance`；store 写入必须明确内部/安全行策略。
- 不改变 `recent()` 的历史通用语义；新增 prompt/memory 专用 allowlist 查询，逐个替换模型输入调用点，降低兼容风险。

## Task 3：wire fast lane 与 SECURITY_REFUSED

**文件**

- 修改：`mstd-orchestrator/server/gateway/wire.mjs`
- 修改：`mstd-orchestrator/server/gateway/reply-pipeline.mjs`
- 修改：`mstd-orchestrator/server/gateway/turn-handler.mjs`
- 修改：`mstd-orchestrator/server/index.mjs`
- 修改：`mstd-orchestrator/server/sessions/active-turn.mjs`
- 新增：`mstd-orchestrator/test/gateway-security-fast-path.test.mjs`
- 新增：`mstd-orchestrator/test/security-refusal-idempotency.test.mjs`

**测试先行**

- 私聊真实攻击：actor/debounce/triage/brain 调用均为 0，固定拒绝一次，事件 `security_refused`，terminal state `SECURITY_REFUSED`。
- 未 @ 群攻击：只 quarantine，不出站。
- 重复 event：不重复拒绝；安全终态不能再触发 daemon fallback。
- 出站失败时保持可恢复审计状态，不把攻击重新投给模型。

**实现**

- fast path 放在 normalize/admit 之后、`markSeen` 原文持久化与 debounce 之前；dedupe 仅使用 event ID/hash。
- 安全拒绝文案由 daemon 常量提供，不经过 LLM 渲染，不带攻击原因细节。
- 独立 security lane 不进入 session actor，但必须经统一物理出口和幂等键 `security:<eventId>`。
- 安全 receipt/audit 持久记录 terminal state；不复用 generic fallback。

## Task 4：triage 第二道防线

**文件**

- 修改：`mstd-orchestrator/server/models/triage.mjs`
- 修改：`mstd-orchestrator/test/triage.test.mjs`

**实现与验证**

- schema 拆为 `intent` 与 `securityFlags[]`；模型 flags 只能补充/升级，不能清除 daemon flags。
- 安全优先级在所有 intent guard 前执行；高风险判定不得发 ACK、不得进入 brain。
- 即使 fast path 被配置成 shadow，triage 仍 fail-closed 到安全拒绝。

## Task 5：统一出站策略与 DLP

**文件**

- 修改：`server/gateway/reply-pipeline.mjs`、`server/safety/reply-egress.mjs`、`server/safety/sensitive-text.mjs`
- 接入：quick reply、ACK、trusted reminder、confirm/status/observe 卡片最终字节
- 扩充：`test/reply-egress.test.mjs`、`test/reply.test.mjs`、`test/card-templates.test.mjs`

**实现与验证**

- 新增单一 `prepareOutbound`，所有文本与序列化 card JSON 在物理发送前通过。
- DLP 覆盖 `MSTD_TURN_CONTEXT_V1`、session/turn/lease/epoch、内部 URL、Feishu internal IDs、动态 canary/fingerprint 和有界编码表示。
- 禁 Markdown 图片/HTML/协议相对 URL；URL userinfo/path/query/fragment 也做敏感检查；最终发送字节二次扫描。
- 固定服务端模板可标 `trustedTemplateId`，调用者不能自行声明 trusted。

## Task 6：interactive 与 maintenance 解耦

**文件**

- 新增：`server/maintenance/scheduler.mjs`、`server/memory/snapshot-ref.mjs`
- 修改：`server/gateway/turn-handler.mjs`、`server/models/brain.mjs`、`server/index.mjs`
- 新增：`test/maintenance-scheduler.test.mjs`

**实现与验证**

- business receipt 终态后 `handleTurn()` 立即返回并释放 actor。
- maintenance 使用不可变 allowlisted snapshot ref、独立队列/无状态 worker、10–20 秒超时；新用户消息取消同 session 旧维护。
- abort/timeout/version/hash 漂移时 memory/compact 零提交；上报 queue wait、service time、blocking time。
- 测试用永不 resolve 的 maintenance，第二条用户消息仍在 <100ms 获得 actor。

## Task 7：全副作用 capability fence 与取消

**文件**

- 修改：`server/internal-routes.mjs`、`server/sessions/session-tokens.mjs`、`server/sessions/active-turn.mjs`
- 修改：Pi extensions、memory/action/background/heartbeat adapters、`supervisor/pi-client.mjs`

**实现与验证**

- token 绑定 allowedTools/purpose/turnId/lease/epoch/expiry；每条 route 统一 authorize。
- 工具前、异步返回后、commit 前均重查；取消先原子 close/revoke/bump epoch，再终止进程组。
- 旧 epoch/lease 对 reply/action/memory/background/search/heartbeat 全部 403 且零副作用。
- Action proposal token 绑定用户所见 proposal/preview digest；执行状态用 CAS 只允许一个 executor。

## Task 8：持久 reply outbox、kill switches 与发布门禁

**文件**

- 新增迁移与 `server/gateway/reply-outbox.mjs`
- 修改：reply pipeline、startup reconcile、config/health
- 新增：crash recovery、并发发送和 kill-switch tests

**实现与验证**

- `UNIQUE(turn_id, reply_kind)`，claim -> send(idempotency key) -> CAS delivered；启动恢复已发送未落 receipt 的记录。
- quick/ack/final/security refusal 全进 outbox。
- 增加 read-only、disable-memory、disable-URL、disable-resident 开关；危险配置 fail-closed 并在 health 可见。
- PR gate 运行 prompt corpus、真实 gateway E2E、secret-bytes-out、unauthorized side-effect 与 utility/FPR 评测。

## 验证命令

```bash
cd mstd-orchestrator
npx vitest run test/security-fast-path.test.mjs test/security-quarantine.test.mjs test/session-replay-security.test.mjs test/gateway-security-fast-path.test.mjs test/security-refusal-idempotency.test.mjs
npx vitest run test/prompt-injection-corpus.test.mjs test/policy-eval.test.mjs test/reply-egress.test.mjs test/business-turn-terminal.test.mjs test/session-actor.test.mjs test/context-envelope.test.mjs
npm test -- --run
```

真实飞书 E2E 使用测试账号发送：事故原文、Unicode/Cf 变体、合法管理员讨论负对照。验证飞书仅出现固定安全拒绝，model log 中 triage/brain 为 0，quarantine 有哈希/flags，transcript/replay/memory/FTS 无攻击正文。
