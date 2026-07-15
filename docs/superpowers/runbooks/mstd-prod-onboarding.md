# 真实公司（民商通达）飞书接入前置清单

> 2026-07-12 起草（迭代二 Track 3）。目标：把小达（mstd-orchestrator 常驻助手）接入民商通达的**正式飞书租户**（与验证环境是两个独立租户）。能力开发继续在验证租户（成都民商通达供应链管理有限公司，profile 由运维环境配置）进行；本清单是正式组织侧需要**人**去办的事，按顺序执行。

## 0. 决策前提（老板/管理员拍板）

- [ ] 确认接入范围：先只读观察（推荐）还是直接开放写操作（建任务/发消息，均有卡片确认门槛）。
- [ ] 指定**服务账号**：一个持牌真人席位（硬约束：妙记 owner 不能是 bot，`calendar` 建会的 owner 也必须是 user——已在测试组织验证）。可以是专门新开的账号（如"AI助理"），但必须占一个正式席位、能登录。
- [ ] 指定灰度群：1-2 个低风险群先跑 mention_only（@才应答），观察 1-2 周再谈 ambient（不@也参与）。

## 1. 建应用（管理员，约 15 分钟）

- [ ] 用管理员账号登录 [open.feishu.cn](https://open.feishu.cn) → 创建**企业自建应用**（名称建议"小达"，与测试组织应用同名同头像）。
- [ ] 记录 App ID / App Secret，通过安全渠道交付给运维方（不要走聊天明文）。
- [ ] 应用能力：开启**机器人**能力。

## 2. 权限（管理员，约 10 分钟）

- [ ] 权限管理 → 批量处理 → 批量导入，粘贴 **`mstd-prod-scope-import.json`**（本目录；2026-07-13 从测试组织应用线上版 v1.0.4 导出，tenant 54 + user 104，即"终版"）。
- [ ] 数据范围选"全部成员"（tenant 任务权限发版时要求）。
- [ ] 其中 `im:message.group_msg`（读群消息）是**敏感权限**，导入后可能需管理员在控制台单独审批通过。

## 3. 事件与回调（管理员，约 5 分钟）

- [ ] 事件与回调 → 订阅方式选**长连接**（免公网回调地址）。
- [ ] 事件订阅（与测试组织 v1.0.4 对齐，共 7 项）：接收消息（`im.message.receive_v1`）、妙记生成、纪要生成、参与的会议结束、消息已读、消息被 reaction、消息被取消 reaction。
- [ ] 回调订阅：`card.action.trigger`（确认卡按钮）。
- [ ] **创建版本并发布**（企业自建免审，管理员自过）。注意：之后每次加 scope/事件都要重新发版才生效。

## 4. 服务账号授权（服务账号本人，约 5 分钟）

- [ ] 服务账号加入所有灰度群、以及需要小达感知的群。
- [ ] 运维方在生产机建 profile：`lark-cli config init --profile mstd-prod --app-id <正式AppID> --app-secret-stdin`。
- [ ] 发起 device flow，服务账号扫码授权。scope 串用测试组织实测通过的 48 项（47 + offline_access）：

  ```
  lark-cli --profile mstd-prod auth login --scope "attendance:task:readonly auth:user.id:read base:record:read base:table:read calendar:calendar.event:create calendar:calendar.event:read calendar:calendar.free_busy:read calendar:calendar:create calendar:calendar:read contact:user.base:readonly contact:user.basic_profile:readonly contact:user:search docs:document.content:read docx:document:readonly docx:document:write_only im:chat.members:read im:chat:read im:chat:readonly im:message im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.reactions:read im:message.send_as_user im:message:readonly im:resource mail:user_mailbox.message.address:read mail:user_mailbox.message.body:read mail:user_mailbox.message.subject:read mail:user_mailbox.message:readonly minutes:minutes.artifacts:read minutes:minutes.basic:read minutes:minutes.search:read minutes:minutes.transcript:export okr:okr.period:readonly profile:user_profile:read search:docs:read search:message sheets:spreadsheet:read space:document:retrieve task:task:read task:task:write vc:meeting.meetingevent:read vc:meeting.search:read vc:meeting:readonly vc:note:read vc:record:readonly wiki:node:retrieve wiki:space:retrieve offline_access"
  ```

- [ ] 注意：refresh token 名义 7 天滚动，但**存在提前失效实例**（2026-07-13 测试组织 refresh 剩 7 天额度时被服务端以 code=20064 拒绝）。token-watch 哨兵会提前 48h 私聊告警；收到告警或发现读取失效，重新走一次扫码即可。

## 5. 灰度上线（运维方执行，管理员知情）

- [ ] 部署 orchestrator 生产实例（独立机器/进程，.env 换正式组织凭证与群白名单 MSTD_TEST_CHAT_IDS → 正式灰度群）。
- [ ] `group_policies` 全部初始为 mention_only；ambient 需逐群手动升档。
- [ ] MSTD_ENABLE_WRITE 初期 =0（纯只读观察），一周后按体验开 =1（写操作仍全部走确认卡）。
- [ ] 妙记自动派任务：MSTD_ENABLE_TRIGGER=1 + MSTD_MINUTES_BROADCAST_CHAT 指到项目群。

## 6. 回滚与安全阀

- 立即静默：把群里的小达移出群 / MSTD_ENABLE_AGENT=0 重启。
- 只断写：MSTD_ENABLE_WRITE=0 重启（所有写路径返回未启用）。
- 权限收回：管理员在控制台停用应用（分钟级生效）；服务账号 `lark-cli auth logout`。
- 所有写操作都有卡片确认 + 操作人绑定 + hash 锁定 payload，不存在静默真写路径。

## 常见问题

- **为什么必须占一个真人席位？** 妙记（会议纪要）的所有权模型限定 owner 必须是 user；bot 读不到别人的妙记。感知层整体跑在服务账号的 user token 上。
- **小达会不会乱说话？** 群参与默认 mention_only；ambient 档有分诊四选一 + 每小时主动发言限额（4 条）兜底。
- **数据出组织吗？** 模型调用走公司自有网关（cz-gpt/DeepSeek 渠道），逐字稿等大文件只落 orchestrator 本机工作目录。
