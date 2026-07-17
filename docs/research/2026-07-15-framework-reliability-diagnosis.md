# 框架可靠性诊断（2026-07-15）

> 背景：项目负责人指出四个症状——①模型幻觉巨高 ②速度不快 ③工具调用不稳定
> ④模型返回不可靠。本文是对整个代码框架的逐链路诊断，供后续会话与方案引用。
> 文中"建议"均为**待拍板**状态，未经项目负责人确认不得据此动代码。
>
> 注意：应答机兜底话术「收到，我先处理一下。」是刻意设计（project.md 第四节第 8 条），
> 不在问题清单内；问题在于它与调度器 silent_ok 兜底叠加时的闭环缺口（同条待拍板）。

## 一、五个结构性病根

### 病根 1：三套互相独立的模型栈，配置已漂移

- `server/models/caller.mjs` —— 应答机/调度器/渲染的裸 chat/completions；
- `server/models/brain.mjs:10`（REASON_PROVIDERS）+ `pi-ext/providers.ts` ——
  推理机是 spawn 的 Pi CLI 进程，自带另一套 provider 注册表；
- lark-cli 子进程 —— 第三套。

三套各有超时/重试/降级语义。"主脑是谁"三处说法不一致：brain.mjs 说 v4-pro
临时主脑，providers.ts 头注释仍写 gpt-5.6-sol 主脑，caller 的 CHAINS 另一套。

### 病根 2：自造裸 JSON 文本协议，未用原生结构化输出

caller.mjs 不传 `response_format`、不用原生 function calling。应答机/调度器
靠模型自觉输出裸 JSON，解析器主动拒绝 Markdown 围栏
（`responder.mjs:45`、`dispatcher.mjs:118`），而模型高频输出围栏。
解析失败静默滑向兜底 → 症状④的相当部分是协议造成而非模型造成。

### 病根 3：失败一律翻译成自信话术

单条消息路径上的兜底层：

| 失败点 | 兜底产物 |
|---|---|
| 应答机解析失败 | 「收到，我先处理一下。」（刻意设计，见 project.md 四.8） |
| 调度器失败/解析失败 | spawn `closure=silent_ok` 任务（`dispatcher.mjs:164`，owner 确认过） |
| 推理机空产出/超时 | DAEMON_TERMINAL_FALLBACK（`turn-handler.mjs:15`） |
| egress 拒绝 | SAFE_REPLY_FALLBACK |

关键缺口：应答机兜底作出承诺 + 调度器兜底 silent_ok ⇒ 承诺可无人闭环，
用户视角与"说谎/幻觉"不可区分。是否将调度器兜底 closure 升为 required：**待拍板**。

### 病根 4：事实过两张嘴，第一张嘴无证据

- 首条回复：应答机仅有 SOUL+最近 20 条对话，零工具零证据，non-thinking v4-pro，
  被鼓励"可直接完整回答" → 事实性问题靠参数记忆作答；
- 深度回复：推理机产出 brief → `responder.renderHandoff`（`responder.mjs:137`）
  用另一个模型自由改写成稿，"不编造事实"仅是提示词；
- 承诺闭环（closure）由调度器 LLM 裁决，条件闭环执行上仍是 prompt-only。
  hallucination-governance spec 的 receipt+done 状态机正是架构解，未落地。

### 病根 5：重试预算把"慢"写死在框架里

- caller 默认 retries=5、reason 链 retryDelayMs=10s、attemptTimeout=60s ⇒
  单 provider 最坏 ~5.7 分钟才降级；
- brain 再包一圈：spawn 重试 5×10s、turnTimeoutMs=240s，失败换 provider
  整回合重跑（`brain.mjs:459`）；
- 每个深度任务 = 冷启动完整 Pi 进程 + 历史重放 + xhigh thinking + renderHandoff
  又一次 LLM 调用 ⇒ 第二条回复天然分钟级。

## 二、症状归因表

| 症状 | 主因 | 次因 |
|---|---|---|
| ①幻觉巨高 | 病根3（失败→话术）+病根4（无证据首答+双重转述） | closure 靠 LLM；dreaming 以小达自述为证据 |
| ②速度不快 | 病根5（重试预算+每任务冷启动 Pi+≥3 次串行 LLM） | debounce 600ms；上游 503 重试 |
| ③工具不稳定 | 工具全在 Pi 进程内：jiti 隔离+内部 HTTP 回传+token/lease/epoch/admission 四重校验，任一失配→reply 拒→兜底 | steer 走 stdin 无回执；lark 又一层子进程 |
| ④返回不可靠 | CZ 网关持续 503 + 病根2（裸 JSON 拒围栏） | 降级链掩盖上游劣化；content 之外零校验 |

一句话：**能力层薄（non-thinking 廉价模型+不稳上游+自造协议），治理层厚，
且治理层每次拒绝的出口都是话术而非如实失败**。

## 三、建议动刀顺序（全部待拍板）

P0：
1. caller 加 `response_format:{type:"json_object"}`；解析改"剥围栏后解析"，保留字段白名单。
2. 重试预算重定：retries 5→2、reason delay 10s→2s、attemptTimeout 按链分级、总预算封顶。
3. CZ 网关拍板：换稳定上游或移出关键路径。
4. 落地 receipt+done 状态机（spec 已有，五个拍板项见该 spec）。

P1：
5. renderHandoff 降级为受约束渲染（brief 结构化，执笔只组织语言不增删事实）。
6. 应答机职责收紧：事实类问题不知道就明说+接任务，禁止即兴作答。
7. 模型配置收敛为单一来源，供 caller 与 providers.ts 共同消费。

前置：先拉 model_log 量化——responder 解析失败率、dispatcher fallback 率、
reply admission 拒绝率、各链 503/降级分布，确定 P0 内部的优先级。
