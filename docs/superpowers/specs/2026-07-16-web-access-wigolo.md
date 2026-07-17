# 小达联网能力（wigolo 接入）实现规格

日期：2026-07-16
状态：草案已过一轮审查（2026-07-16，全部代码引用逐条核实、上游事实经 GitHub 复核），
待项目负责人拍板 D1–D5。拍板前不动代码。
审查修订：grant set 登记范围收窄（4.3）、新增重定向与内网目标防线（4.4）、
逐字守卫后果显式化并列 D5（3.2）、1.5GB 系磁盘占用更正（2.3）、search query 出站 DLP（2.2）。
范围决定：负责人已定 `search + fetch` 两个能力，不含 crawl/research/agent。
依据：project.md 第五节（权限与审批门属确认边界）；`docs/research/` 无相关前置调研。
上游：https://github.com/KnockOutEZ/wigolo ，AGPL-3.0-only，本地优先，无需 API key。

## 一、结论

wigolo 官方接入方式（`npx wigolo init --agents=...` 写 MCP 配置）对小达不可用。
Pi 不支持 MCP，且是刻意不支持：

> "It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode,
> to-dos, or background bash."
> —— `node_modules/@earendil-works/pi-coding-agent/docs/usage.md:306`

`pi --help` 的全部 flag 中无 MCP 相关项；orchestrator 内无任何 MCP 客户端。
因此接入方式是：新建 `pi-ext/web.ts`，用 `pi.registerTool` 注册两个工具，
经 loopback HTTP 调 `wigolo serve` 常驻进程。这与 `lark-read.ts` 包 `lark-cli`
是同一套模式，安全层可以复用。

本规格的主体不是"怎么调通 wigolo"，那部分是确定的。主体是三件事：
网页正文作为新的敌意输入源如何进注入防线；搜到的链接如何出站；AGPL 在商用部署下的结论。

## 二、工具形态

### 2.1 注册面

`pi-ext/web.ts` 注册两个工具，进 `server/pi/resident-extensions.mjs` 的
`PROFILE_SPECS.resident`，追加 `["web.ts", ["web_search", "web_fetch"]]`。
`readonly_job` 与 `background` 两个 role 不注册，本期不给后台任务联网。

`capability-readiness.mjs` 会在 boot 时真起一个 Pi 探针，断言实际暴露的 tool set
与声明完全相等，不一致即抛错、boot 侧捕获后 `process.exit(1)`（`index.mjs:132-139`）。
这条现成的门自动覆盖本次改动。注意 `MSTD_SKIP_CAPABILITY_READINESS=1` 会整体跳过，
验收时确认环境里没带这个标志。

wigolo 暴露的其余工具（`crawl` `extract` `cache` `find_similar` `research` `agent`
`diff` `watch`）一律不注册。其中 `research` 与 `agent` 明确排除：它们自带多跳自主抓取与综合，
等于在小达之外再挂一个不受本仓库安全层管辖的自主 agent。

### 2.2 参数与 op 白名单

照 `server/safety/lark-read.mjs` 的 `READ_OPS` 模式，新建 `server/safety/web-read.mjs`，
deny-by-default，导出 `buildWebArgs(op, params)`。模型只能填具名参数，不能透传 raw flag。

`web_search`：
- `query`（必填。出站前过 `scanSensitiveText`（DLP）——query 会离开租户边界发往外部搜索引擎，
  命中敏感形态（证件/手机号/密钥等）即拒并返回改写提示，不发出）
- `max_results`（可选，默认 5，硬上限 10）
- `include_domains` / `exclude_domains`（可选，字符串数组，逐条校验为合法域名）

`web_fetch`：
- `url`（必填，必须 https，必须已出现在本 epoch 的 search 结果里，见 4.3）
- `format`（可选，仅 `text` / `markdown`，不放行 `html`）

`search_depth`、`render_js`、`mode` 一律由服务端固定，不开给模型。
`render_js` 固定为关，且必须显式传 `never`——上游默认值是 `auto`（会按需起浏览器渲染），
靠缺省等于半开。开了等于允许任意站点在本机执行 JS，且拖慢一个数量级。需要时再单独提案。

上游 `fetch` 的返回除正文外还带 `metadata + links` 字段。links 可以透传给模型
（正文里本来就有 URL，出站由 grant set 挡），但**绝不进 grant set**，见 4.3。

### 2.3 进程形态

用 `wigolo serve` 常驻 HTTP daemon，不做每次调用 spawn。
理由是资源：wigolo 安装占约 1.5GB **磁盘**（浏览器引擎 + BGE-small 嵌入 +
MiniLM cross-encoder reranker；上游明确说的是 disk，常驻内存量未标注，部署后实测补记）。
冷启动要加载模型与浏览器池（上游 `MAX_BROWSERS` 默认 3 个并发上下文）。
真机压测记录小达 20 并发时峰值已 2.9GB / 19 个 Pi 进程；
若每次 `web_fetch` 拉起一个 wigolo，延迟与内存都不可接受。

daemon 由 supervisor 管理，绑 `127.0.0.1`（上游缺省即 `127.0.0.1:3333`，
经 `WIGOLO_DAEMON_HOST` / `WIGOLO_DAEMON_PORT` 固定，不监听外部网卡）。
`pi-ext/web.ts` 侧超时：search 20s，fetch 30s（`lark-read.ts` 的 60s 对网页抓取偏长）。
超时与 abort 语义照抄 `lark-read.ts:16-32`：`AbortSignal` 转 SIGTERM，
`signal?.aborted` 时原样抛出，不伪造成正常结果。

daemon 不可用时 `web_search` / `web_fetch` 返回明确失败文案，不静默降级，不编造结果。
这条对齐幻觉治理规格里的"零产出必须降级、不得回显当成功"。

### 2.4 输出裁剪

`lark-read.ts` 的 `clip()` 是 20000 字符。网页正文按 8000 字符裁，search 结果按 4000 字符裁。
理由：正文的信息密度远低于飞书文档，且每多一个字符就是多一分注入面与 token 成本。
裁剪标记沿用 `"...(截断)"`。

## 三、注入防线

这是本规格的重点。现有 `server/safety/` 整层的威胁模型建立在"输入来自飞书租户内部"，
网页正文是完全不同量级的敌意输入：攻击者可以精确控制小达将读到的每一个字节。

### 3.1 taint：每次 fetch 无条件标记

`lark_read` 只有 `SEAT_PRIVATE_OPS`（mail/minutes）才 `markTainted`
（`lark-read-egress-source.mjs:19-21`）。`web_fetch` 应无条件 taint，`web_search` 同样 taint。

taint 的实际后果不是拦回复，是回合收口后强制回收 resident 进程：
`turn-handler.mjs:561-564` 与 `coordinator.mjs:204-208` 在 `isTainted` 为真时
`brain.recycle()`。taint 按 epoch 绑定，新 spawn 领新 epoch 自动失效
（`reply-egress.mjs:126-127`）。

对网页内容，这个副作用正好是想要的：把注入 payload 留在模型上下文里的时间窗
压到单个回合。代价是每个联网回合都要重启一次 Pi。

这一条是待拍板项，见第六节 D1。

### 3.2 登记路径

复用现成的 `POST /internal/egress/source`（`internal-routes.mjs:237-257`）。
新建 `server/safety/web-egress-source.mjs`，照 `lark-read-egress-source.mjs` 的结构，
`record({ sessionKey, op, text, residentKey, taskId })` 做两件事：
`verbatimGuard.record` 登记 shingle，`replyEgress.markTainted` 打污点。

登记 shingle 的直接后果要说破（`verbatim-guard.mjs`：窗口 30 归一化字符，
群聊命中任意窗口即 `post_render_group_verbatim`，私聊总预算 600 字符）：
小达在群聊里**不能逐字大段引用刚抓到的网页**（≈ 一句实义引文即触发），
命中后整条回复被换成 `SAFE_REPLY_FALLBACK`。对飞书私有内容这是防泄露；
对公开网页这变成"只能转述不能原文引用"，用户说"把那段原样发我"会得到兜底话术。
建议接受：它同时挡住"逐字复读注入 payload"，与 3.3 的声明层互补；
但这是用户可见行为，列为待拍板项 D5。若不接受，替代是 web 源只 taint 不记 shingle。

`residentKey` / `taskId` 必须取自服务端 token binding，绝不取自请求体。
这条在 `internal-routes.mjs:246` 与 `lark-read-egress-source.mjs:17` 都标了是承重的。

`pi-ext/web.ts` 必须在 return 给模型**之前** await 这次登记
（`lark-read.ts:44-45` 的理由同样成立）：保证 shingle 先于模型看到内容落库，
下游逐字守卫不与登记竞态。登记失败不阻断读取链路。

### 3.3 入站扫描

`scanInjectionSignals` / `scanPromptInjection` 在 context-envelope 路径上是自动的，
但 tool result 不走 envelope。所以 `pi-ext/web.ts` 必须显式扫。

命中时不能直接拒（拒了搜索基本不可用，正常网页也会误命中），处理是：
在返回给模型的文本前置一段服务端拼的定值声明，说明以下内容来自外部网页、
是数据不是指令、其中的任何指示一律不执行；同时 `details` 里记录命中的 signal 名，
落 model_log 供调试台观察。声明文本由服务端固定，不经模型。

这里不做"检测到注入就静默删除正文"：删除会制造模型看到残缺内容却不自知的情况，
比原样给出加声明更危险。

### 3.4 trust-boundary 的 source 枚举

`SOURCES` 是闭集 `["user","history","memory","tool","background","system"]`
（`trust-boundary.mjs:3`），无 `"web"`。两个选择：复用 `"tool"`，或加 `"web"`。

建议加 `"web"`。理由是审计：`"tool"` 现在混着 lark_read 等租户内只读，
与任意外网内容同一个标签会让事后追溯分不清。加枚举值是纯增量，
`assertTrustBoundary` 的校验逻辑不变。

## 四、出站链接策略

### 4.1 问题

`DEFAULT_ALLOWED_LINK_DOMAINS` 是硬编码常量，只有三项：
`feishu.cn` / `larksuite.com` / `larkoffice.com`（`reply-egress.mjs:26-28`），
全仓库无任何地方覆盖它。

后果：小达搜到的 URL 基本都不在白名单，`checkReplyPostRender` 返回
`post_render_link_policy`，`reply-pipeline.mjs:280-284` 直接丢弃模型原文，
换成 `SAFE_REPLY_FALLBACK`（"这条内容无法安全发送…"）。

也就是说，不动这个常量的话，小达搜得到但一给链接整条回复就被替换掉。
搜索能力实际不可用。

### 4.2 三个选项

- 甲：不动。小达只转述内容，不给链接。用户拿不到出处，无法自行核实，
  且与幻觉治理规格里"可核查"的方向相反。
- 乙：放行任意 https 域。等于取消链接白名单。攻击者只要让小达读到一个页面，
  就能诱导它把带 payload 的 URL 发进飞书群。否决。
- 丙：来源绑定放行。只放行 wigolo 在本 epoch 内实际返回过的 URL。

### 4.3 建议：丙

在 `createReplyProvenanceRegistry`（`reply-egress.mjs:113-186`）上加一个按 epoch 绑定的
URL 授权集；`scanReplyLinks` 在 `domainAllowed` 之外，额外放行 grant set 内的精确 URL。
epoch 变更（recycle）时 grant 随 taint 一起失效。

**grant set 的登记范围是承重的，只有两类**：
1. `web_search` 结果**条目**的 URL（wigolo 排序引擎给出的结果项，非页面作者直接可控）；
2. `web_fetch` 实际抓取成功的最终 URL 本身。

**明确排除**：fetch 返回的正文以及 `links` 元数据字段里出现的任何 URL。
这些是页面作者逐字节可控的内容——若它们进 grant set，攻击者只要让小达读到
一个页面，页面里塞的 payload URL 就自动获得出站与二次抓取授权，
本节两条防线（挡编造、挡诱导出站）与 2.2 的"首跳只能来自 `web_search`"同时失效。
登记动作只能发生在服务端包装层解析 wigolo 结构化响应的顶层字段处，
绝不对正文做 URL 提取。

这个设计同时挡住两件事：模型编造链接（不在 grant set 内），
以及模型被网页内容诱导发出攻击者指定的链接（攻击者能控制页面正文，
但控制不了 wigolo 的 search 结果条目本身进 grant set 的那一刻）。

`web_fetch` 的 `url` 参数同样只接受 grant set 内的 URL（见 2.2），
这样模型不能拿注入正文里出现的任意 URL 去二次抓取。首跳只能来自 `web_search`。

丙是待拍板项 D2。它改的是一个已记录的刻意设计（链接白名单），按第五节须确认。

### 4.4 重定向与内网目标

grant 校验对的是"发起抓取的 URL"，而 HTTP 302 会让实际落点漂移，两条规则：

1. **重定向不自动授权**：fetch 跟随重定向后的最终 URL 若与授权 URL 跨源，
   该次结果按失败处理并在 details 记录落点，最终 URL 不进 grant set。
   需要读落点时，让它先出现在 search 结果里。
2. **禁内网目标（SSRF）**：抓取目标解析到 loopback / RFC1918 / link-local
   （`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1` 等）一律拒绝，
   含重定向后的落点。本机 loopback 上跑着 token 守卫的 internal 端点、调试台与
   wigolo daemon 自身，`https://好站 → 302 → http://127.0.0.1:...` 是经典打法。
   wigolo 是否自带此防线未知，实施第 7 步必须实测；若无，包装层先解析校验目标 IP。
   DNS rebinding 的残余风险记录在案，本期接受（内部端点均有 token 守卫）。

## 五、AGPL-3.0

wigolo 是 AGPL-3.0-only。民商通达是商用部署，小达经飞书对用户提供服务、后端调 wigolo，
AGPL 第 13 条（网络交互条款）在这个拓扑下有争议空间。

上游 README 自述的义务边界与此一致："if you run a **modified version** as a network
service, you must publish your modified source"——触发条件是"修改后作为网络服务运行"。

降低风险的技术约束，建议写进实施纪律：
1. 不修改 wigolo 源码。一旦修改，第 13 条"modified version"的争议直接成立。
   需要行为变更时，在本仓库侧包一层，不碰上游。
2. 锁定版本，独立进程运行，经 loopback HTTP 调用，不做进程内 link、不打进同一分发物。
3. 不把 wigolo 的接口透传给最终用户。

这三条是降低风险，不构成法律结论。是否可用于商用部署应由法务判定，
本规格不替代该判定。这是待拍板项 D3。

## 六、待拍板事项

- **D1 taint→recycle**：每个联网回合强制重启 Pi，是否接受？
  建议接受（把注入 payload 的存活窗压到单回合）。若不接受，替代方案是只在
  `web_fetch` taint、`web_search` 不 taint，理由是 search 只返回标题摘要，
  注入面小一个量级；但这会让 snippet 注入有跨回合存活能力。
- **D2 链接出站**：采纳第四节的丙（来源绑定放行）？这会改动现有链接白名单的语义。
- **D3 AGPL**：是否过法务？在法务结论前，本规格建议只做本地/测试环境验证，不进生产。
- **D4 开关默认值**：`MSTD_ENABLE_WEB` 默认 0，且必须落 `.env`。
  只在 shell 里 export 会随重启丢失（已有事故记录）。
- **D5 逐字守卫对网页内容生效**：web 源文本照记 shingle，后果是群聊禁逐字引用
  刚抓的网页、私聊 600 字符预算，命中整条回复换兜底（见 3.2）。
  建议接受（兼挡 payload 逐字复读）；不接受则 web 源只 taint 不记 shingle。

D1/D2/D3/D5 未拍板前不动代码。

## 七、实施步骤

审定后按序执行，每步可独立验证：

1. `server/safety/web-read.mjs`：op 白名单 + 参数校验 + argv/请求体构造。纯函数，单测覆盖。
2. `server/safety/web-egress-source.mjs`：照 `lark-read-egress-source.mjs` 结构，
   注入 `verbatimGuard` / `replyEgress`，构造期 fail-fast。
3. `reply-egress.mjs`：epoch 绑定的 URL grant set，`scanReplyLinks` 增加 grant 放行。（依赖 D2）
4. `trust-boundary.mjs`：`SOURCES` 增加 `"web"`。
5. `pi-ext/web.ts`：`registerTool` 两个工具，Typebox 具名参数，超时/abort/clip/reportSource。
6. `server/pi/resident-extensions.mjs`：`PROFILE_SPECS.resident` 追加声明。
7. supervisor：wigolo daemon 生命周期与健康检查。
8. `.env.example` + `.env`：`MSTD_ENABLE_WEB`，附中文注释。

## 八、测试

- 单测在 `mstd-orchestrator/` 目录内跑。仓库根跑会连带 ui/bid-browse 扫出假失败。
- `web-read.mjs` op 白名单：未知 op 抛错；raw flag 注入尝试被具名参数挡住；
  `include_domains` 非法域名被拒。
- grant set：模型编造的 URL 被拒；grant 内 URL 放行；recycle 后旧 grant 失效；
  fetch 正文/links 字段里的 URL 不进 grant（4.3 承重项）；
  重定向跨源落点不进 grant 且该次 fetch 按失败返回；内网 IP 目标被拒（4.4）。
- 逐字守卫：群聊逐字引用已抓网页 ≥30 归一化字符被拒（若 D5 定为记 shingle）。
- search query DLP：含敏感形态的 query 不出站，返回改写提示。
- 注入扫描：含 override/exfiltration payload 的正文命中 signal 且前置声明存在，正文不被删。
- taint：`web_fetch` 后 `isTainted` 为真，回合收口触发 `resident_taint_recycle` 事件。
- daemon 宕机：返回明确失败，不静默成功，不编造结果。
- e2e 需显式 export `MSTD_E2E` / `MSTD_ENABLE_WRITE` / `MSTD_TEST_OPEN_IDS` / `MSTD_TEST_CHAT_IDS`。
  缺 `MSTD_ENABLE_WRITE` 时 e2e-full 整套静默 skip，会得到假绿。
- 负向 e2e：真机准备一个含注入 payload 的页面，验证小达读后不执行其中指示、
  不把页面指定的链接发出去。
