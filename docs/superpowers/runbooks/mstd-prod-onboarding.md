# 真实公司（民商通达）飞书接入前置清单

> 2026-07-12 起草（迭代二 Track 3）；**2026-07-17 改为两阶段接入（用户拍板）：当前只做"阶段一：纯聊天最小权限"，除收消息+回消息外的全部权限一律不开**。目标：把小达（mstd-orchestrator 常驻助手）接入民商通达的**正式飞书租户**（与验证环境是两个独立租户）。能力开发继续在验证租户（成都民商通达供应链管理有限公司）进行；本清单是正式组织侧需要**人**去办的事，按顺序执行。

---

## 阶段一：纯聊天最小权限（当前执行）

**范围**：小达只收消息、只回消息。不读云文档/日历/任务/邮箱/妙记，不写任何东西，
不需要服务账号扫码（纯聊天路径全程 bot token，已按代码逐行核实：事件消费
`event consume --as bot`，出站 `im +messages-send --as bot`，非文本消息在入口即丢弃，
不拉任何用户/群资料 API）。

### 1. 建应用（管理员，约 15 分钟）

- [ ] 用管理员账号登录 [open.feishu.cn](https://open.feishu.cn) → 创建**企业自建应用**（名称建议"小达"，与测试组织应用同名同头像）。
- [ ] 记录 App ID / App Secret，通过安全渠道交付给运维方（不要走聊天明文）。
- [ ] 应用能力：开启**机器人**能力。

### 2. 权限（管理员，约 5 分钟）

- [ ] 权限管理 → 批量处理 → 批量导入，粘贴 **`mstd-prod-scope-import.chat-only.json`**（本目录）。tenant 仅 5 项、user 为空：

  | scope | 用途 |
  |---|---|
  | `application:bot.basic_info:read` | 查机器人自身 open_id（填 `MSTD_BOT_OPEN_ID` 用） |
  | `im:message:send_as_bot` | 回复消息（文本 + 无按钮的 markdown 卡片） |
  | `im:message.p2p_msg:readonly` | 接收私聊消息事件 |
  | `im:message.group_at_msg:readonly` | 接收群聊中 @机器人 的消息事件 |
  | `im:message.group_msg` | 接收群聊全部消息事件（**唯一敏感权限**，见下） |

- [ ] `im:message.group_msg` 是**敏感权限**，导入后需管理员在控制台单独审批。它的用途是让小达看到灰度群的完整上下文（应答机每回合注入最近聊天记录；群策略仍是 mention_only，@ 才应答）。若管理员对这一项有顾虑可以先不开——代价是小达在群里只能看到 @它 的那一条，回复会缺上下文；私聊不受影响。
- [ ] 数据范围选"全部成员"。

### 3. 事件与回调（管理员，约 5 分钟）

- [ ] 事件与回调 → 订阅方式选**长连接**（免公网回调地址）。
- [ ] 事件订阅：仅 **接收消息（`im.message.receive_v1`）** 一项。
- [ ] 回调订阅：**`card.action.trigger`**。注意：这一项不是权限，本阶段也不会有任何带按钮的卡片发出（写路径关闭），但 orchestrator 的消费者按固定事件集起长连接，缺订阅会导致该子进程反复重启刷日志，所以**必须订上**。
- [ ] **创建版本并发布**（企业自建免审，管理员自过）。注意：之后每次加 scope/事件都要重新发版才生效。

### 4. 服务账号授权 —— 本阶段跳过

纯聊天不需要 user token，**不做扫码授权**。（原全能力扫码流程保留在阶段二 §B4。）
机器人以 bot 身份进群即可：

- [ ] 把机器人（应用）拉进 1-2 个正式灰度群 + 允许的私聊范围。

### 5. 灰度上线（运维方执行，管理员知情）

- [ ] 部署 orchestrator 生产实例（独立机器/进程），`.env` 用本目录 `mstd-prod.env.template`，按"阶段一"注释填写。硬要求：
  - `MSTD_ENABLE_WRITE=0`、`MSTD_ENABLE_TRIGGER=0`、`MSTD_BACKFILL=0`（三闸全关，与本阶段权限面一致）。
  - `MSTD_PRIVATE_DATA_OWNER_OPEN_ID` 留空（无 user token，席位私有数据不存在）。
  - `MSTD_BOT_OPEN_ID`：`lark-cli --profile mstd-prod api get /open-apis/bot/v3/info --as bot` 从返回里取。
- [ ] `group_policies` 全部初始为 mention_only；ambient 需逐群手动升档。

### 阶段一已知行为（bot-only 运行的三个无害噪声，已核实代码，不影响收发）

1. **lark profile 健康检查**（每 10 分钟 `auth status`）：无 user 身份时输出可能命中
   "not logged in" 正则 → 启动后告警一次"profile 异常"然后保持静默（仅边沿告警）。
   属误报，可无视。
2. **token-watch 哨兵**：找不到 user 身份时每 6h 记一行日志 `user 身份缺
   refreshExpiresAt（未授权？）`，不发告警、不退出。
3. **推理机 `lark_read` 工具**：能力集中硬编码、无开关；本阶段所有调用会被租户侧
   缺 scope + 缺 user token 双重拒绝，工具优雅返回失败文本，模型按诚实失败话术处理。
   服务端权限即真实边界，提示词不承担守门职责。
   （已转交代码侧的改进项：给 lark_read 加 env 级禁用开关 + 健康检查区分 bot-only 模式。）

### 回滚与安全阀（两阶段通用）

- 立即静默：把群里的小达移出群 / `MSTD_ENABLE_AGENT=0` 重启。
- 权限收回：管理员在控制台停用应用（分钟级生效）。
- 本阶段不存在任何写路径：租户侧没有写 scope，`MSTD_ENABLE_WRITE=0`，双重关死。

---

## 阶段二：全能力升级（观察稳定后，另行拍板才执行）

> 以下为 2026-07-13 备好的全能力接入流程，**本阶段不执行**。升级时机和范围需项目负责人重新确认。

### B0. 决策前提（老板/管理员拍板）

- [ ] 确认升级范围：开放读感知（妙记/日历/任务/云文档）还是同时开放写操作（建任务/发消息，均有卡片确认门槛）。
- [ ] 指定**服务账号**：一个持牌真人席位（硬约束：妙记 owner 不能是 bot，`calendar` 建会的 owner 也必须是 user——已在测试组织验证）。可以是专门新开的账号（如"AI助理"），但必须占一个正式席位、能登录。

### B2. 权限升级（管理员）

- [ ] 权限管理 → 批量处理 → 批量导入，粘贴 **`mstd-prod-scope-import.json`**（本目录；2026-07-13 从测试组织应用线上版 v1.0.4 导出，tenant 54 + user 104，即"终版"）。
- [ ] 重新发版。

### B3. 事件升级（管理员）

- [ ] 补订事件（与测试组织 v1.0.4 对齐，共 7 项）：妙记生成、纪要生成、参与的会议结束、消息已读、消息被 reaction、消息被取消 reaction（`im.message.receive_v1` 与 `card.action.trigger` 阶段一已有）。
- [ ] 重新发版。

### B4. 服务账号授权（服务账号本人，约 5 分钟）

- [ ] 服务账号加入所有灰度群、以及需要小达感知的群。
- [ ] 发起 device flow，服务账号扫码授权。scope 串用测试组织实测通过的 48 项（47 + offline_access）：

  ```
  lark-cli --profile mstd-prod auth login --scope "attendance:task:readonly auth:user.id:read base:record:read base:table:read calendar:calendar.event:create calendar:calendar.event:read calendar:calendar.free_busy:read calendar:calendar:create calendar:calendar:read contact:user.base:readonly contact:user.basic_profile:readonly contact:user:search docs:document.content:read docx:document:readonly docx:document:write_only im:chat.members:read im:chat:read im:chat:readonly im:message im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.reactions:read im:message.send_as_user im:message:readonly im:resource mail:user_mailbox.message.address:read mail:user_mailbox.message.body:read mail:user_mailbox.message.subject:read mail:user_mailbox.message:readonly minutes:minutes.artifacts:read minutes:minutes.basic:read minutes:minutes.search:read minutes:minutes.transcript:export okr:okr.period:readonly profile:user_profile:read search:docs:read search:message sheets:spreadsheet:read space:document:retrieve task:task:read task:task:write vc:meeting.meetingevent:read vc:meeting.search:read vc:meeting:readonly vc:note:read vc:record:readonly wiki:node:retrieve wiki:space:retrieve offline_access"
  ```

- [ ] 注意：refresh token 名义 7 天滚动，但**存在提前失效实例**（2026-07-13 测试组织 refresh 剩 7 天额度时被服务端以 code=20064 拒绝）。token-watch 哨兵会提前 48h 私聊告警；收到告警或发现读取失效，重新走一次扫码即可。

### B5. 能力开闸（运维方执行，管理员知情）

- [ ] `MSTD_ENABLE_WRITE=1`（写操作仍全部走确认卡；`MSTD_TEST_*` 白名单先只放运营者本人 + 灰度群）。
- [ ] 妙记自动派任务：`MSTD_ENABLE_TRIGGER=1` + `MSTD_MINUTES_BROADCAST_CHAT` 指到项目群。
- [ ] `MSTD_PRIVATE_DATA_OWNER_OPEN_ID` 填服务账号本人 open_id。
- 只断写：`MSTD_ENABLE_WRITE=0` 重启（所有写路径返回未启用）；服务账号 `lark-cli auth logout` 收回 user 侧全部读能力。
- 所有写操作都有卡片确认 + 操作人绑定 + hash 锁定 payload，不存在静默真写路径。

---

## 常见问题

- **为什么阶段一不需要真人席位服务账号？** 纯聊天收发全程 bot token。真人席位只在阶段二需要：妙记（会议纪要）的所有权模型限定 owner 必须是 user，感知层读能力整体跑在服务账号的 user token 上。
- **小达会不会乱说话？** 群参与默认 mention_only；ambient 档有分诊四选一 + 每小时主动发言限额（4 条）兜底。
- **数据出组织吗？** 模型调用走公司自有网关（cz-gpt/DeepSeek 渠道），聊天记录只落 orchestrator 本机工作目录。
