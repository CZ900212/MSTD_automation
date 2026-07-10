# 常驻助手提示词工程与人格运行时(设计)

日期:2026-07-10 · 分支:feat/resident-agent · 状态:已与用户对齐,待实施计划

## 1. 背景与病灶

真机群聊表现"刻板、笨"(用户截图佐证),解剖出四个根因 + 两个顺带发现:

| # | 病灶 | 症状 | 根因位置 |
|---|---|---|---|
| P1 | @ 文本污染 | 把自己的应用名当群聊话题("群里主要聊了 Feishu CLI") | lark-cli 把 @ 转写为纯文本 `@user613148's Feishu CLI` 留在 content,全链无清洗 |
| P2 | 错误的"本我" | 行为像刻板的工具执行器 | 中枢 5.5 跑在 Pi 默认 coding-agent 系统提示词上;人格只是 user message 里的「## 记忆」段落,pi-ext 无一触碰 systemPrompt |
| P3 | 人格太薄 | 客服腔、官腔("从我能查到的记录来看") | SOUL.md 仅四句正经话,零示例、零反刻板指令 |
| P4 | 上下文供给断粮 | "没检索到更多了";复述漏错 | ①群 pending observed 一次性消费,复述类问题第二次就没料;②`store.transcript` 为 `ORDER BY ts LIMIT n`,取的是**最早** n 条——triage 近期对话/中枢重放/出口上下文在长会话里全拿最旧消息 |
| S1 | 安全注记 | — | 中枢 Pi 带 bash/read 跑在 orchestrator 代码目录,被注入的模型理论上可 `cat .env` |
| S2 | 出站渲染 | Markdown 以纯文本裸奔(星号可见);表格必挂 | 出口一律 `--text` 纯文本发送 |

Hermes(~/.hermes,本机源码)调研结论直接输入本设计:三层 system prompt(stable→context→volatile)全部服务前缀缓存;群聊身份用 `[名字]` 标签编码进 user 消息、@ 进 prompt 前一律人类可读化、bot 自己的发言绝不自我打标签;平台渲染能力显式声明(PLATFORM_HINTS);记忆写陈述句不写指令句;"该不该说话"尽量交给确定性代码而非提示词。

## 2. 目标 / 非目标

**目标**:群聊表现自然(干练同事风)、@ 语义正确、复述类问题可靠、出站 Markdown 正确渲染。全部可单测,不破坏七条铁律(reply 唯一出站、模型不可信、四道锁、fail-closed 写闸、记忆隔离、密钥红线、argv 白名单)。

**非目标**:不做 Pi 工具白名单收缩(用户定案:保留 bash/read,中枢定位是云端 harness——ChatGPT 式全能力 + Hermes 式长期功能);不做 OS 级沙箱(记为后续项);不改 admit/triage 的"该不该说话"决策架构。

## 3. 组件设计

### C1 中枢系统提示词替换(persona)

- **新增** `pi-ext/persona.ts`:`before_agent_start` 钩子把 Pi coding-agent 系统提示词**整体替换**。组装逻辑抽为纯函数模块(`pi-ext/persona-prompt.ts`,无 Pi 依赖)供 vitest 直测。
- 三层结构,按缓存稳定度排序(仿 Hermes,spawn 一次构建、会话生命周期内字节稳定):
  1. **身份层**:SOUL.md 全文。经 `MSTD_SOUL_PATH` env(daemon 在 createBrain piEnv 注入)spawn 时读一次。
  2. **世界观层**:常驻公司飞书的场景说明;消息记号约定——`[名字]:`=群成员发言、`[@我]`=这句话是对你说的**不是在讨论你**、重放块中 `[我]`=你自己说过的话;行为准则:检索不到就直说没有,禁止编造群聊内容。
  3. **工具纪律层**:reply 是唯一出口、整回合不调用=自然静默;写操作只走 propose_actions;记忆写陈述句不写指令句("User prefers X"✓/"Always do X"✗,抄 Hermes MEMORY_GUIDANCE);bash/read 保留但明令禁读 orchestrator 内部与任何 `.env`(软约束)。
- **piCwd 迁移**:`agent-workspace/`(gitignore,启动时确保存在),不再是 orchestrator 代码目录——bash 的默认作用面离开代码与密钥所在地(S1 的轻量缓解;真沙箱后续项)。
- brain 回合注入的「## 记忆」段**去掉 soul**(已在 system 层),保留 org/journalDigest/scoped。triage/reply 是无状态单次调用,SOUL 注入方式不变。

### C2 入站 @ 规范化

- **新增** `server/gateway/normalize.mjs`:`normalizeContent(content, { botNames })` 把 `@<botName>`(数组,支持改名过渡期新旧双名)替换为统一记号 `[@我]`,压缩多余空白。botNames 来源:`MSTD_BOT_NAME` + 逗号分隔的 `MSTD_BOT_ALIASES`(可选,过渡期放旧应用名)。
- 接入点:inbox 事件解析处,**在 mentionsBot 检测之后**规范化,落库前完成——store/transcript/triage/brain/journal/session-search 全链从此只见统一记号。原始 content 留在 `inbox_events` payload 供审计。
- 其他人的 @(如 `@张三`)保留原样(人类可读,无歧义)。

### C3 上下文供给修复

1. **新增** `store.recent(sessionId, { limit })`:`ORDER BY ts DESC LIMIT n` 后反转为时序。换用点:triage 近期对话(20)、brain 重放(50)、handleReply 出口上下文(20)。`transcript()` 保留给全量场景(compact、nudge 计数)。
2. **群聊滚动窗口**:addressed 群回合废弃"pending observed 一次性消费"注入,改为注入最近 30 条群消息(观察+正式、含小达自己的发言、带 `HH:MM` 时间戳)。`store.recentObserved`/`markObservedConsumed` 随之退役删除(nudge 计数不受影响——它只看 `observed` 标记,与 consumed 无关);`observed_consumed` 列保留不迁移(历史数据兼容)。复述类问题从此始终有料。

### C4 提示词文本重写(干练同事风,用户定案)

- **SOUL.md**:身份「小达」;人格=干练同事——正事直接给结论、不绕场面话、有温度不装热情;配三组好/坏示例对(被@打招呼、复述群聊、正事求助);明令禁止:客服腔、八股免责声明、"从我能查到的记录来看"式官腔、无意义的"如果需要我可以…"尾巴。
- **triage SYSTEM**(`server/models/triage.mjs`):加入记号说明([@我] 语义);复述/总结/回顾类一律 escalate(需要完整上下文,V4 手里没有);quick_reply 话术贴人格。
- **reply SYSTEM**(`server/models/reply.mjs`):自然中文措辞;长度贴场景(群里默认短、私聊可展开);禁模板腔;声明飞书渲染约定(见 C6)。

### C5 机器人改名(实机操作,用户已全权授权)

- 派 subagent 到飞书开发者后台把机器人名字改为「小达」并发新版本(发版才生效,参照应用 1.0.2 先例)。
- `.env` 的 `MSTD_BOT_NAME` 同步为「小达」;C2 的双名数组(新名+旧应用名)兜住过渡期(飞书端生效有延迟,群成员消息里两种 @ 文本都可能出现)。

### C6 出站渲染通道(用户补充需求)

- **判定**:服务端确定性检测(正则:`**`、`` ` ``、`#`、`|` 表格、`- `/`1. ` 列表、`[](链接)` 等),**不靠模型自觉**。含 Markdown 结构 → 走卡片;短平纯文本 → 照旧 text 气泡(群聊更自然)。
- **通道**:`server/cards/templates.mjs` 新增消息卡模板(Card JSON 2.0 `markdown` 组件包一段 md 文本)——结构服务端生成,模型照旧碰不到卡片 JSON(铁律 2);经既有 `outbound.sendCard`(幂等 key、重试均复用)。接入点:turn-handler `handleReply` 出站分支。quick_reply/预算拒绝等短文本路径不变。
- **提示词侧**(进 reply SYSTEM 与 persona 平台层):显式声明飞书支持的 Markdown 子集;**表格必须走卡片**(Post 接口发纯 Markdown 字符串渲染不可靠,明令避免);图片:外部 URL 通常可渲染,`img_key` 仅飞书体系内有效;数学公式等飞书不支持的格式禁止输出。

## 4. 测试与验收

- **单测(TDD,全量必须全绿)**:normalize 替换矩阵(单@/多@/双名/不含@/他人@不动);persona-prompt 纯函数形状(三层齐全、SOUL 注入、记号说明在场);`store.recent` 排序与边界;滚动窗口注入(含自身发言、带时间戳、不依赖 consumed);triage 复述类 escalate;C6 判定矩阵(表格/加粗/纯文本/代码块)与卡片模板形状;brain 记忆段无 soul。
- **真机验收剧本**(复刻用户截图场景):测试群闲聊数句(不同话题)→ @小达 复述——断言回复非空、不含旧应用名字样;@小达 打招呼——回复无客服腔模板(人工评判)。挂到 e2e-group 可自动化的部分自动化,口吻类人工验收。
- 改 `server/safety/`/`server/execute/`?本设计不触碰,但 C2/C3 动入站链路,照例全量回归。

## 5. 风险与后续

- **改名过渡**:飞书端 @ 文本切换有窗口期,C2 双名兜底;`MSTD_BOT_NAME` 未同步会导致 mentionsBot 漏检,列入实施 checklist。
- **SOUL 热更新**:persona 层 SOUL 每次 spawn 读一次,改 SOUL 后已存活的 Pi 进程沿用旧人格直至回收(≤ idleMs)——可接受,文档注明。
- **缓存**:systemPrompt per-spawn 稳定;滚动窗口在 user turn 内,不伤 system 前缀缓存。
- **后续项(不在本次)**:中枢 bash 的 OS 级沙箱;observe_only 周报口径随人格更新;dreaming 提示词与新 SOUL 的一致性复查。
