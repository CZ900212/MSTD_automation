# 常驻助手提示词工程与人格运行时(设计,rev2)

日期:2026-07-10 · 分支:feat/resident-agent · 状态:rev2(按用户评审修订:安全承诺对齐、双名检测、双 actor 硬化、契约补严),待转实施计划

## 1. 背景与病灶

真机群聊表现"刻板、笨"(用户截图佐证),解剖出四个提示词根因 + 四个顺带发现:

| # | 病灶 | 症状 | 根因位置(已逐条对代码核实) |
|---|---|---|---|
| P1 | @ 文本污染 | 把自己的应用名当群聊话题("群里主要聊了 Feishu CLI") | lark-cli 把 @ 转写为纯文本 `@user613148's Feishu CLI` 留在 content,全链无清洗;结构化事件另有 `@_user_N` 占位 + `mentions[].key/open_id` 形态 |
| P2 | 错误的"本我" | 行为像刻板的工具执行器 | 中枢 5.5 跑在 Pi 默认 coding-agent 系统提示词上;人格只是 user message 里的「## 记忆」段,pi-ext 无一触碰 systemPrompt |
| P3 | 人格太薄 | 客服腔、官腔("从我能查到的记录来看") | SOUL.md 仅四句正经话,零示例、零反刻板指令 |
| P4 | 上下文供给断粮 | "没检索到更多了";复述漏错 | ①群 pending observed 一次性消费(`turn-handler.mjs:121-126`);②`store.transcript` 为 `ORDER BY ts LIMIT n` 取**最早** n 条(`store.mjs:38`)——triage/中枢重放/出口在长会话里全拿最旧消息 |
| S1 | 安全:bash 作用面 | — | 中枢 Pi 带 bash/read 跑在 orchestrator 代码目录,可读代码与 `.env` |
| S2 | 安全:内部通道信任客户端 | — | `internal-routes.mjs` 单一共享 Bearer token,全部路由信任 body 自带的 `session_key`——任一会话的 Pi 可冒名任意会话调 memory/reply/target,跨会话记忆与投递路径存在 |
| S3 | 并发:同会话双 actor | — | 网关(`wire.mjs:15`)与回注/后台(`index.mjs:205`)各建一个 actor pool;`brain.ensure()` 无 spawn/run 互斥——同一 session 可能双 Pi 并行 |
| S4 | 出站渲染 | Markdown 以纯文本裸奔;表格必挂 | 出口一律 `--text` 纯文本发送 |

Hermes(~/.hermes,本机源码)调研结论直接输入本设计:三层 system prompt(stable→context→volatile)服务前缀缓存;群聊身份用 `[名字]` 标签编码进 user 消息、@ 进 prompt 前一律人类可读化、bot 自己的发言绝不自我打标签;平台渲染能力显式声明;记忆写陈述句不写指令句;"该不该说话"尽量交给确定性代码。

## 2. 目标 / 非目标 / 安全表述

**目标**:群聊表现自然(干练同事风)、@ 语义正确、复述类问题可靠、出站 Markdown 正确渲染;同会话执行严格串行;内部通道会话绑定。全部可单测。

**安全表述(诚实版)**:本设计**收紧**内部通道与会话边界(C0),但用户定案保留中枢无限制 bash/read(云端 harness 定位)。因此"模型永远不可信"在 bash 面只能做**纵深缓解**(cwd 迁移 + 提示词纪律 + 内部通道硬化),不是绝对保证;OS 级沙箱列为后续项。其余铁律(reply 唯一出站、四道锁、fail-closed 写闸、记忆隔离、密钥不进代码、argv 白名单)不受本设计削弱,其中记忆隔离与出站授权经 C0 从"约定"升级为"服务端强制"。

**非目标**:不做 OS 级沙箱;不做外链图片转 img_key 管线;不改 admit 的"该不该说话"决策架构。

## 3. 组件设计

### C0 会话执行与内部通道硬化(前置阻塞项,先于其余组件实施)

1. **单一 actor 注册表**:daemon 全局唯一 actor pool,网关、卡片回注、后台 job、cron/heartbeat 全部经它串行同一 sessionKey 的执行。`wire.mjs` 改为接收注入的 pool,`index.mjs:205` 的第二个 pool 删除。
2. **brain 互斥**:`ensure()` 加 in-flight spawn 合并(同 sessionKey 并发 ensure 共享同一 spawn promise);`turn()` 加 per-session 互斥——busy 时排队等待,绝不对同一 Pi 并行 runJob(steer 注入语义不变)。
3. **内部通道会话绑定**:每次 spawn 生成随机会话绑定 token,daemon 侧维护 token→sessionKey 映射(spawn 注入 `MSTD_INTERNAL_TOKEN`,进程回收即吊销);internal routes 由 token 反查 sessionKey,body 的 `session_key` 仅做一致性校验(不一致 403 并落 model_log)。job Pi 绑定其 job session。
4. **读写统一授权(服务端强制)**:memory 工具 scoped 层按绑定会话限定——群会话只可读写本群 group 层,私聊只可读写本人 user 层,cron/job 无 scoped 写;`reply.target` 默认仅当前会话,跨目标投递仅限 cron/heartbeat 类会话且 target 必须等于任务声明的 `deliver_to`(服务端比对)。

### C1 中枢系统提示词替换(persona)

- **新增** `pi-ext/persona.ts`:`before_agent_start` 钩子替换系统提示词。**运行时契约**:该钩子每回合触发、返回值链式拼接——扩展在加载时构建一次提示词字符串,每回合返回同一字节稳定字符串(前缀缓存不受影响);集成测试断言:钩子确实加载、默认 coding-agent 提示词被整体替换、SOUL 每进程只读一次。
- **安装范围**:persona.ts 只加入常驻 brain 的 extensions 列表;任何其他 Pi 拉起点(只读 job 等)不注入,实施时逐点核对。
- 组装逻辑抽为纯函数模块(`pi-ext/persona-prompt.ts`,无 Pi 依赖)供 vitest 直测。三层结构,按缓存稳定度排序:
  1. **身份层**:SOUL.md 全文(经 `MSTD_SOUL_PATH` 读取)。**SOUL 缺失或空 → fail-fast**:daemon 启动时校验,扩展内再兜底抛错,绝不以空人格运行。
  2. **世界观层**:常驻公司飞书的场景说明;**运行环境信息**(替换掉默认 prompt 后补回:日期仅到"日"精度保缓存、时区 Asia/Shanghai、workspace 路径);消息记号约定——`[名字]:`=群成员发言、`[@我]`=这句话是对你说的**不是在讨论你**、重放块中 `[我]`=你自己说过的话;行为准则:检索不到就直说没有,禁止编造群聊内容。
  3. **工具纪律层**:reply 是唯一出口、整回合不调用=自然静默;写操作只走 propose_actions;记忆写陈述句不写指令句("User prefers X"✓/"Always do X"✗);bash/read 保留但明令禁读 orchestrator 内部与任何 `.env`(软约束,见 §2 安全表述)。
- **piCwd 迁移**:`agent-workspace/`(gitignore,启动确保存在)。pi-ext 以绝对路径传入,不受影响(已核实 `index.mjs:99-101`)。
- brain 回合注入的「## 记忆」段**去掉 soul**(已在 system 层),保留 org/journalDigest/scoped。triage/reply 无状态单次调用,SOUL 注入方式不变。

### C2 入站 @ 规范化

- **新增** `server/gateway/normalize.mjs`。botNames 来源:`MSTD_BOT_NAME` + 逗号分隔 `MSTD_BOT_ALIASES`(过渡期放旧应用名)。matcher 契约:正则元字符转义、名单去重、**最长名称优先**匹配。
- **两种输入形态都处理**:①纯文本 `@<botName>` → `[@我]`;②结构化 `@_user_N` 占位 + `mentions[].key/open_id` 映射 → 命中 bot open_id 的替换为 `[@我]`,其他人替换为可读 `@名字`。
- **mentionsBot 检测升级(阻塞项修复)**:文本兜底从单名 `content.includes` 改为 botNames 数组任一命中;结构化 `mentions[].open_id` 检测不变。检测在规范化**之前**完成。
- **数据兼容**:migration `012_inbox_raw.sql` 给 `inbox_events` 加 `raw_content` 审计列(原文全保留);normalize 抛错时保底原文入库并打日志(宁脏勿丢)。历史 `agent_messages` 与 FTS **不迁移**,读时兼容:旧行含旧 @ 文本属预期,session_search 对旧形态的召回不做承诺(注明即可)。

### C3 上下文供给修复

1. **新增** `store.recent(sessionId, { limit })`:`ORDER BY ts DESC, id DESC LIMIT n` 后反转为时序(同 ts 以 id 定序,稳定)。换用点:triage 近期对话(20)、handleReply 出口上下文(20)。
2. **brain 重放组合**:重放 = **有效 compact 摘要 +** `recent(50)`,不能只取 recent(压缩过的长会话必须带摘要头,否则重放丢失早期结论)。
3. **群聊滚动窗口**:addressed 群回合注入"**当前 batch 之前的**最近 30 条"群消息;仅 `role IN (user, assistant)`(排除 tool/system 内部记录);含小达自己的发言;时间戳 `HH:MM` 固定 Asia/Shanghai。窗口每回合重注入、跨回合与 Pi 会话内历史有重复——**有意取舍**(几 KB 换复述可靠,不采用 ts 水位线方案),注明给实施者定调。
4. **跨目标出站回写**:cron/heartbeat 经 `reply.target` 投递到群/私聊时,出站消息必须同步 append 到**目标 session** 的 transcript(否则目标会话窗口缺小达自己的发言)。
5. `store.recentObserved`/`markObservedConsumed` 退役删除(nudge 计数只看 `observed` 标记不受影响,已核实 `compact.mjs:11`);`observed_consumed` 列保留不迁移。
6. 实施 checklist 可选项:`shouldNudge` 用 `transcript(limit:1000)`,超长会话计数冻结在最早 1000 条——顺手换 `recent` 可修。

### C4 提示词文本重写(干练同事风,用户定案)

- **SOUL.md**:身份「小达」;干练同事人格——正事直接给结论、不绕场面话、有温度不装热情;三组好/坏示例对(被@打招呼、复述群聊、正事求助);明令禁止:客服腔、八股免责、"从我能查到的记录来看"式官腔、无意义"如果需要我可以…"尾巴。
- **triage SYSTEM**:加记号说明([@我] 语义);复述/总结/回顾类一律 escalate;quick_reply 话术贴人格。
- **代码级 guard(不靠提示词自觉)**:`enforce()` 增加输入侧判定——batch 命中复述/总结/回顾类关键词(正则)时,即使 V4 返回 quick_reply 也强制 escalate。
- **reply SYSTEM + 投递感知**:`renderReply` 增加 `deliverKind`(group/p2p/card_copy)参数,由 turn-handler 从最终投递目标解析传入——群聊默认短、私聊可展开的长度策略以此落实,不靠模型猜。

### C5 机器人改名(实机操作,用户已全权授权)

**上线顺序(严格)**:①先部署 C2 aliases 支持(`MSTD_BOT_ALIASES=旧应用名`)并重启 daemon;②派 subagent 到飞书开发者后台改名「小达」并发新版本;③过渡期真机验证新旧两种 @ 文本都触发 addressed;④稳定后 `MSTD_BOT_NAME=小达`、旧名保留在 aliases。
**回滚**:恢复 `.env` 双名配置 → 重启 daemon → 飞书后台重新发布旧显示名版本。

### C6 出站渲染通道(用户补充需求)

- **检测契约(冻结,服务端确定性,不靠模型自觉)**:
  - 强信号,单命中即走卡片:表格(一行内 ≥2 个 `|` 且含表头分隔行 `|---|` 形态)、代码围栏 ` ``` `、行首 `#{1,6} ` 标题、行首 `> ` 引用、独行分隔线 `---`/`***`、`[文本](url)` 链接。
  - 弱信号,需 **≥2 类共现**才走卡片:行首 `- `/`* `/`1. ` 列表、`**加粗**`、`` `行内代码` ``。
  - 反例矩阵(必须不误判走卡片):`#话题` 无空格、中文破折号"——"、句中单竖线("A|B 两案")、单个星号、长纯文本(无任何标记)。转义字符(`\*`)不计信号。
  - **统一分流入口**:出站文本(escalate 经 reply、quick_reply、预算拒绝等)全部经同一 `deliverText()` 入口做检测分流——quick_reply 含 Markdown 时同样走卡片,消除"quick_reply 固定 text 但可能带 md"的不一致。
- **通道**:`server/cards/templates.mjs` 新增消息卡模板(Card JSON 2.0 `markdown` 组件),结构服务端生成、模型碰不到 JSON(铁律 2);经既有 `outbound.sendCard`(幂等 key、重试复用)。
- **提示词侧**(reply SYSTEM 与 persona 平台层):声明飞书支持的 Markdown 子集;表格类内容尽量输出规范 md 表格(由分流走卡片);**不承诺图片**——外链图片在卡片 markdown 组件中不保证渲染,`img_key` 管线本期不做,提示词明令不输出图片语法;数学公式等不支持格式禁止输出。

## 4. 测试与验收

- **C0**:token→session 绑定矩阵(正确 token 通过、错 token 403、body session_key 不一致 403 且落 model_log);memory scoped 跨会话读写拒绝;reply.target 越权拒绝、cron 会话匹配 deliver_to 放行;同 sessionKey 并发 ensure 只 spawn 一次;并发 turn 串行执行(完成顺序断言)。
- **C1**:persona-prompt 纯函数形状(三层齐全、SOUL 注入、记号说明、日期"日"精度、workspace 信息);SOUL 缺失 fail-fast;集成测试(真 Pi 或 harness 桩):钩子加载、默认提示词被整体替换、SOUL 每进程读一次。
- **C2**:替换矩阵(单@/多@/双名/最长名优先/正则元字符名/他人@保留/`@_user_N`+mentions 映射/无@不动);mentionsBot 双名与结构化检测;normalize 抛错保底入库;migration 012 形状。
- **C3**:`recent` 排序与同 ts 稳定性;重放=摘要+recent 组合;滚动窗口(batch 之前、role 过滤、含自身发言、Asia/Shanghai 时间戳);跨目标出站回写目标 session。
- **C4**:复述类关键词强制 escalate(V4 返回 quick_reply 也升级);renderReply 按 deliverKind 注入长度策略。
- **C6**:检测矩阵全量(强信号各项、弱信号共现规则、全部反例行);卡片模板形状;`deliverText()` 统一分流(quick_reply 带 md 走卡片)。
- **真机验收**(复刻用户截图剧本):测试群闲聊数句(不同话题)→ @小达 复述——回复非空、不含旧应用名字样、话题命中;@小达 打招呼——无客服腔(人工评判);发含表格回复——卡片渲染正常。
- 动入站链路与内部通道,全量回归 `npx vitest run` 必须全绿。

## 5. 风险与后续

- **实施顺序**:C0 前置(其余组件建立在"同会话单 Pi 串行 + 通道会话绑定"之上),再 C2/C3(数据与上下文),再 C1/C4(提示词),C5/C6 收尾。
- **改名过渡**:见 C5 顺序;`MSTD_BOT_NAME` 未同步会漏检 mentionsBot,列实施 checklist。
- **SOUL 热更新**:persona 每进程读一次,改 SOUL 后已存活 Pi 沿用旧人格直至回收(≤ idleMs)——可接受,文档注明。
- **缓存**:systemPrompt 字节稳定(日期只到"日");滚动窗口在 user turn 内,不伤 system 前缀。
- **后续项(不在本期)**:中枢 bash 的 OS 级沙箱;外链图片→img_key 管线;observe_only 周报口径随人格更新;dreaming 提示词与新 SOUL 一致性复查。
