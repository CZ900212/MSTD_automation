# 迭代二：全域感知 + 纪要派任务全自动 + 真组织接入准备

> 2026-07-12 定稿。前置：阶段一（人格运行时，Task 1-13）已完成——快慢机、20 并发、快机先应答、空行拆分、ambient 自然参与均真机验通。本文承接 `2026-07-09-feishu-resident-agent.md`（八 Phase 已全部收官），是其后的第一个能力迭代。

## 目标（用户原话口径）

1. **稳定读取公司在飞书中已有的信息**——群/单聊历史、云文档、日历、任务、妙记、attendance……"所有有权限的内容"。
2. **自动化**——会议纪要→提取行动项→派发任务，**全自动接管**形态：妙记一生成，小达自动读逐字稿、提行动项、逐条发确认卡（可改负责人）、确认即建任务、指定群播报。
3. **两条并行**：能力开发在测试组织（MSTD/成都民商通达）做；真公司（日晟行）接入的前置条件整理成清单交用户执行。

## 现状盘点（迭代起点）

- Pi 只读工具 `lark_read` 白名单仅 3 op：search_minutes / get_transcript / search_user（`server/safety/lark-read.mjs`）。
- user token 26 scope 已覆盖 im 消息/群、docx、日历、任务、妙记、vc、通讯录；**缺** attendance / drive / wiki / sheets / base / okr 等域。
- refresh token 仅 7 天有效（当前 07-19 到期）——"稳定"必须解决续期，否则每周哑火。
- 妙记触发链存在但独立：`minutes.minute.generated_v1` → `meeting_to_task` job 模板（`server/triggers/minutes-consumer.mjs`），未接常驻 agent，无确认卡/播报/会话记忆。
- 系统触发回合的成熟模式已有：`server/ticker/cron-runner.mjs`——新鲜会话 + brief + 投递 grants + propose_actions 纪律 + 注入扫描。**Track 2 复用此形状。**

## Track 1 · 全域只读感知层

### T1.1 scope 补齐与重授权
- 调研产出所需 scope 差集（lark-cli schema 逐命令核对）。
- 控制台"权限管理→批量处理→批量导入"JSON `{"scopes":{"tenant":[...],"user":[...]}}`；新 scope 须"创建版本并发布"后生效。
- device flow 重授权拿全量 user token（用户浏览器点一次）。

### T1.2 lark_read 白名单扩容（核心）
原则不变：**deny-by-default、具名参数、绝不接受自由 args[]**。新增 op（最终清单以调研为准）：
- im：list_chats（bot 所在群）、chat_history（指定 chat_id 拉历史，分页）
- docs/docx：read_document（doc token → 正文纯文本）
- drive：search_files / list_folder
- wiki：list_spaces / list_nodes / 节点正文（落到 docx 读）
- sheets / base：读取表格值 / 记录（如 scope 可得）
- calendar：list_events（时间窗）
- task：list_tasks（我的/指定人的）
- minutes：既有 3 op 保留
- attendance：查打卡记录（如 scope 可得）
- contact：search_user 保留，+ 部门/成员列表（如 scope 可得）
配套工程：
- 分页参数显式化（page_token 透传给 Pi，让中枢自己决定翻页）；
- 输出裁剪：保留 CLIP=20000，超长结果落盘 `out/` + read_file 续读（复用逐字稿模式）；
- `--jq` 预裁剪贵字段（如消息历史只留 sender/时间/文本）；
- 限流退避：lark 429/频控错误识别 + 一次退避重试。
TDD：safety/lark-read.mjs 每个 op 的 argv 构造 + 拒绝路径单测；pi-ext 描述同步。

### T1.3 token 稳定性（"稳定读取"的另一半）
- 验证 lark-cli 是否自动用 refresh token 续期（offline_access 已有）。
- ticker 挂周期巡检：auth status 读 expiresAt/refreshExpiresAt；
  - access 快到期 → 若 CLI 不自动刷则主动触发 refresh；
  - refresh 剩 <48h → 私聊 owner 提醒重授权（走既有 daemon 直投提醒通道）。
- 目标：正常使用下 token 永不哑火；必须人工介入时提前两天知道。

### T1.4 persona 与验收
- SOUL/persona 注入更新：小达知道自己有哪些"眼睛"、何时用（先答手头上下文，不够再翻；翻历史/文档要说"我翻了下…"）。
- 真机 E2E：群里问"XX 文档写了啥 / 上周聊了什么 / 今天有什么会 / 我有哪些任务"稳定答对。

## Track 2 · 妙记→派任务全自动接管

**盘点修正**：这条链大部分已存在（Phase E E7）——`minutes-consumer` → `meeting_to_task` job（Pi 只读阶段提取行动项 JSON）→ `agentOnActionsReady` → 确认卡（person_select 可改负责人）→ 确认即真建任务 → 卡片翻终态，且 `executeConfirmed` 已带 `onExecuted({jobId, sessionKey, resultsMd, ok})` 钩子。**不重建，只补缺口**：

### T2.1 执行后群播报
- 新配置 `MSTD_MINUTES_BROADCAST_CHAT`：妙记派发执行完（onExecuted）后，向指定群播报结果。
- 播报文案走 brain/reply 渲染（自然口吻、无空行拆分复用 deliverText），或先用受信直投打底、再升级渲染——实施时按最小可用取舍。
- 无配置时保持现状（仅确认卡终态 + owner 可见）。

### T2.2 确认人来源健壮化
- 现状 initiator = `params.host_open_id || config.alertOpenId`，妙记事件路径是否带 host_open_id 待核实；不带则用 minutes owner_id 反查补上，最后兜底 alertOpenId。
- `MSTD_ALERT_OPEN_ID` 落 .env（当前环境未配则整条链会静默跳过发卡——这就是"不稳定"点之一）。

### T2.3 真机全链复验
- calendar 建带 auto_record=true 的会 → 开会说几条带负责人的行动项 → 妙记生成 → 观察：自动读稿/确认卡/改负责人/点确认/任务真建/群播报。
- 阶段一改造（8899 端口、agent 运行时、C6 出口）之后这条链没再跑过，复验是主要工作量。

## Track 3 · 真公司（日晟行）接入前置清单

产出 `docs/runbooks/rsh-org-onboarding.md`，内容：
- 建应用（或用现有企业自建应用）+ 凭证交接方式；
- scope 终版清单（直接复用测试组织批量导入 JSON）；
- 服务账号硬要求：**持牌真人席位**（妙记 owner 不能是 bot，`feishu-pipeline-validation` 已验证）；
- 事件订阅（minutes.minute.generated_v1、im 消息、card.action.trigger）+ 长连接说明 + 发版规则；
- 灰度策略：先拉 1-2 个群 mention_only，ambient 后开；
- 风险与回滚：MSTD_ENABLE_WRITE 开关、群白名单、解散/移除即断。

## 里程碑顺序

1. ✅ T1.1 scope 补齐（48 user scope 全量到手，发版 1.0.4，2026-07-12）
2. ✅ T1.2 白名单扩容（3→27 op，commit 38dfc5c）+ ✅ T1.3 token 哨兵（token-watch，6h 巡检+48h 告警）
3. ✅ T1.4 真机验收（E2E群2 三题全过：my_tasks 列任务识别噪音 / search_docs+read_doc 搜 11 中 3 并概括 / agenda 一周窗空日历如实报；快机先应答全程正常）
4. ✅ T2.1-2.3 妙记接管全链真机通（commits 0bd6d2d/04d1d1f/6414e76；修复三个"从未真跑过"断点：select_person tag / consumer stdin 保活 / 扁平回调形状）
5. ✅ Track 3 清单文档（docs/superpowers/runbooks/rsh-org-onboarding.md）

## 附录：全域只读命令目录与 scope 差集（2026-07-12 调研）

### 白名单候选命令（按域）
- im：`+chat-list`✅ `+chat-search`✅ `+messages-mget`✅ | `+chat-members-list` `+chat-messages-list`（消息历史）`+messages-search`（跨群搜）❌缺 scope
- docs：`+fetch`（正文）✅ | `+search`❌（search:docs:read）
- drive：`+search` `files list` ❌
- wiki：`+space-list` `+node-list` `+node-get` ❌
- sheets：`+cells-get` `+workbook-info` ❌
- base：`+table-list` `+record-list` `+record-search` ❌（注意参数是 `--base-token` 非 `--app-token`）
- calendar：`+agenda` `+search-event` `+get` `+freebusy` **全部❌**——已授 `calendar:calendar:read` 不覆盖 `calendar.event:read`
- task：`+get-my-tasks` `+search` ✅
- minutes：`+search` `+detail` ✅
- vc/note：`+search`✅ `meeting get`✅ `note +detail/+transcript`✅ | `vc +detail`❌（meetingevent:read）
- attendance：`user_tasks query` ❌，且 CLI 标 **write**（底层 POST）——白名单需人工例外
- contact：`+search-user`✅ `+get-user`✅ | `user_profiles batch_query`❌
- okr：`+cycle-list` `+cycle-detail` ❌；mail：`+triage` `+message` `+thread` ❌（4 scope）

### scope 缺口（控制台批量导入 JSON）
```json
{"scopes":{"tenant":["im:chat.members:read","search:docs:read","space:document:retrieve","wiki:space:retrieve","wiki:node:retrieve","sheets:spreadsheet:read","base:table:read","base:record:read","calendar:calendar.event:read","calendar:calendar.free_busy:read","vc:meeting.meetingevent:read","attendance:task:readonly"],"user":["im:message.group_msg:get_as_user","im:message.p2p_msg:get_as_user","im:message.reactions:read","search:message","im:chat.members:read","search:docs:read","space:document:retrieve","wiki:space:retrieve","wiki:node:retrieve","sheets:spreadsheet:read","base:table:read","base:record:read","calendar:calendar.event:read","calendar:calendar.free_busy:read","vc:meeting.meetingevent:read","attendance:task:readonly","profile:user_profile:read","okr:okr.period:readonly","mail:user_mailbox.message:readonly","mail:user_mailbox.message.address:read","mail:user_mailbox.message.subject:read","mail:user_mailbox.message.body:read"]}}
```

### token 续期结论（T1.3 依据）
- lark-cli 无手动 refresh 子命令；每次 API 调用自动用 refresh token 静默换发 access token（2h 有效）。
- refresh token 7 天、疑似滚动续期（有成功刷新即推移）。**方案**：ticker 巡检 `auth status`（本地读、零网络），refresh 剩 <48h 时私聊 owner 提醒重授权；正常使用中理论上永不哑火。

### 坑备忘
- `--as bot --dry-run` 不校验 bot 权限，tenant 侧 scope 只能真调一次确认。
- `im +messages-search`/`docs +search`/`drive +search`/`vc +detail`/`calendar +search-event` **仅支持 user 身份**。
- docs/base 两域不在 `lark-cli schema` 目录里（内部封装 API），scope 只能 --dry-run 反推。
