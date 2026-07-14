# 真公司（日晟行）飞书接入前置清单

> 2026-07-12 起草（迭代二 Track 3）。目标：把小达（mstd-orchestrator 常驻助手）接入日晟行正式飞书组织。能力开发继续在测试组织（成都民商通达）进行；本清单是正式组织侧需要**人**去办的事，按顺序执行。

## 0. 决策前提（老板/管理员拍板）

- [ ] 确认接入范围：先只读观察（推荐）还是直接开放写操作（建任务/发消息，均有卡片确认门槛）。
- [ ] 指定**服务账号**：一个持牌真人席位（硬约束：妙记 owner 不能是 bot，`calendar` 建会的 owner 也必须是 user——已在测试组织验证）。可以是专门新开的账号（如"AI助理"），但必须占一个正式席位、能登录。
- [ ] 指定灰度群：1-2 个低风险群先跑 mention_only（@才应答），观察 1-2 周再谈 ambient（不@也参与）。

## 1. 建应用（管理员，约 15 分钟）

- [ ] 用管理员账号登录 [open.feishu.cn](https://open.feishu.cn) → 创建**企业自建应用**（名称建议"小达"，与测试组织应用同名同头像）。
- [ ] 记录 App ID / App Secret，通过安全渠道交付给运维方（不要走聊天明文）。
- [ ] 应用能力：开启**机器人**能力。

## 2. 权限（管理员，约 10 分钟）

- [ ] 权限管理 → 批量处理 → 批量导入，粘贴 scope JSON（终版以测试组织跑通后导出为准；当前版本见 `docs/superpowers/specs/2026-07-12-perception-and-automation.md` 附录的差集 JSON + 已授 26 scope 的并集）。
- [ ] tenant（bot）侧至少含：im:message:send_as_bot、im:resource、im:chat、im:chat:delete。
- [ ] 数据范围选"全部成员"（tenant 任务权限发版时要求）。

## 3. 事件与回调（管理员，约 5 分钟）

- [ ] 事件与回调 → 订阅方式选**长连接**（免公网回调地址）。
- [ ] 事件订阅：`im.message.receive_v1`（接收消息）、`minutes.minute.generated_v1`（妙记生成）。
- [ ] 回调订阅：`card.action.trigger`（确认卡按钮）。
- [ ] **创建版本并发布**（企业自建免审，管理员自过）。注意：之后每次加 scope/事件都要重新发版才生效。

## 4. 服务账号授权（服务账号本人，约 5 分钟）

- [ ] 服务账号加入所有灰度群、以及需要小达感知的群。
- [ ] 运维方发起 device flow（`lark-cli auth login --scope "..."`），服务账号在浏览器扫码/确认授权（user 身份全量只读 scope + offline_access）。
- [ ] 注意：refresh token 7 天滚动，正常使用不会断；服务端有到期告警，收到提醒后重新走一次授权即可。

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
