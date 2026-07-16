# 记忆治理：防过拟合生命周期（episode → candidate → active）

> 2026-07-15 草案，待用户评审。素材三源：外部深度研究报告（六结论 + P0/P1/P2 机制清单）、Hermes 实地调查（~/.hermes）、Codex 实地调查（~/.codex）。方案对着 `server/memory/*` 与 `server/ticker/dreaming.mjs` 的真实代码写。

## 问题重述（一句话口径）

记忆系统的目标不是"存下来、搜回来"，而是**判断一段经验在什么条件下仍然成立、召回它是否改善本次决策**。五个症状：过度特化、错误泛化、过度触发、陈旧不失效、自我强化。

## 现状盘点：哪些已经对了，哪些是真缺口

### 已落地且方向正确（不动）

| 机制 | 现状 | 对应研究结论 |
|---|---|---|
| scope 硬隔离 | 五层（soul/org/group/user/journal）+ 会话域门禁 fail-closed（`server/memory/tool.mjs` authorize/authorizeRead），群 A 原文绝不进群 B | P0 机制 2（scope 强制声明）的"分层即硬过滤"形态 |
| consolidation 只出 proposal | dreaming 生产强制 shadow、报告落 `memory/dreams/`、apply 仅测试可开（`dreaming.mjs:34`） | P0 机制 10（proposal 不直改真相）——业界普遍缺失，咱们已有 |
| append-only + 失效标记 | 矛盾走"新条目 add + 旧条目 〔invalidated:时间〕"，绝不静默覆盖（`dreaming.mjs applyLayer`） | 机制 9（supersession 不原地覆盖）的简化版 |
| 写入安全扫描 | 敏感数据 + 注入信号双扫，拒绝即零 I/O（`tool.mjs validatePersistentEntry`） | 防 memory poisoning 基线 |
| 容量硬顶 + 漂移检测 | org 4000 / group 2200 / user 1375 字符，超限报错逼合并；hash 快照防外部漂移 | 被动整理压力（Hermes 同款，实证有效但粗暴） |
| 陈述句纪律 | persona 要求写陈述句不写指令句（`persona-prompt.ts:30`） | 防"记忆内容被当指令执行"（Codex ad_hoc 同思路） |

### 真缺口（本 spec 要解决的）

1. **没有生命周期状态**：条目只有"存在/invalidated"两态。会话内模型一次 `add` 就直接进入下次注入——单一 episode 直通永久规则，这是过度特化的主通道。
2. **没有失效条件/复核期限**："七天内会过期的信息不进记忆"只写在 prompt 里（Hermes/Codex 调查的核心教训：**只写在 prompt 里的机制等于没有**）。workaround 类条目没有 review_after，环境一变就是陈旧不失效。
3. **自我强化通路是打开的**：dreaming 切片含 assistant 消息（`dreaming.mjs:56` role IN ('user','assistant')），小达按某条记忆说的话可以被提取成支持该记忆的新证据——正是研究报告说的最危险闭环。
4. **注入无过滤**：`inject.mjs` 整层裸读进快照，invalidated 条目也照常注入（invalidated 标记只加不筛）。
5. **没有效用回路**：不知道哪条记忆被用了、用了之后是好是坏；用户纠错不影响任何条目的命运。

### 明确不做的（研究报告里有、但不适配咱们形态）

- **向量检索/知识图谱/相关性排序**：各层有字符硬顶（≤4000），全量注入 + 层级硬过滤已满足"硬过滤 + 小预算"，加检索层是负复杂度。
- **每条目完整 YAML frontmatter**（研究报告第七节）：1375 字符的 user 层塞不下，用紧凑元数据尾巴替代（见下）。
- **完整 provenance DAG / counterfactual 评测**：P2，先把最低可行版做了（记录来源类型 + 派生证据不计数），效果数据攒够再说。

## 设计

### D1 · 条目元数据尾巴 + 三态生命周期（P0，核心）

现有条目尾巴 `〔来源:xxx 时间:ISO〕` 扩展为紧凑结构化尾巴，机器可解析、人可读：

```
条目正文 〔s:candidate|active|invalidated a:user|inferred|dreaming t:fact|pref|decision|workaround r:2026-08-10 src:feishu:p2p:ou_xxx ts:2026-07-15T…〕
```

| 字段 | 含义 | 规则 |
|---|---|---|
| `s` 状态 | candidate / active / invalidated | 见 D2 晋升规则；invalidated 保留原有时间戳语义 |
| `a` 权威 | user（用户明示）/ inferred（模型推断）/ dreaming（夜间蒸馏） | 决定初始状态与晋升门槛 |
| `t` 类型 | fact / pref / decision / workaround | workaround 强制要求 `r` |
| `r` 复核期限 | review_after 日期 | 到期→软失效：不再注入但不删（见 D3） |
| `src`/`ts` | 来源与时间 | 沿用现状 |

实现落点：
- `tool.mjs`：`add`/`replace` 增加 `authority`、`kind`、`review_after` 参数；服务端组装尾巴（模型只报字段不拼字符串）。`kind=workaround` 而缺 `review_after` → 拒绝写入（代码强制，不靠 prompt）。
- `files.mjs`：字符上限改为**按正文计数**（元数据尾巴不占预算），否则治理字段会挤掉内容。
- 存量条目迁移：一次性脚本把现有条目统一标 `s:active a:inferred`（既成事实，宽进），旧 `〔invalidated:…〕` 映射到 `s:invalidated`。

### D2 · 权威分级写入 + 引文核验（P0，斩断"一次即规则"）

写入时按权威定初始状态：

| 权威 | 初始状态 | 核验 |
|---|---|---|
| `a:user`（用户明确要求记住 / 明确长期性指示） | **active** 立即生效 | 必须附 `quote` 参数（用户原话子串），daemon 对照本会话 `agent_messages` 中 role=user 的近期消息核验命中，不命中→拒绝按 user 权威写入（可降级为 inferred） |
| `a:inferred`（模型自己觉得值得记） | **candidate** | 无需核验，但 candidate 不注入（见 D3） |
| `a:dreaming` | **candidate** | 走 D4 晋升 |

引文核验是把"权威由模型自报"变成"权威可服务端验证"的关键一步——daemon 手里有完整消息库，验证成本一次子串匹配。

对应研究报告的晋升条件表：用户明确指示 1 次即 active（但 scope 已由层级限定）；推断类必须走 corroboration。

### D3 · 注入过滤（P0，一处小改，堵住三个症状）

`inject.mjs buildMemorySnapshot` 在拼快照前按条目过滤：

```
注入 = s:active 且 (无 r 或 r 未到期)
不注入 = candidate / invalidated / r 已到期（软失效：文件里保留，模型 read 时仍可见全量并看到状态标记）
```

- 冻结快照机制不变（保 prefix cache）。
- 软失效条目在下一次 dreaming 中作为"待裁决"复审：环境仍成立→续期 `r`；已失效→标 invalidated。
- `memory read` 返回带状态全量，模型能看见 candidate/过期条目并主动维护——但它们不再默认污染每次会话。

### D4 · dreaming 升级：独立证据晋升 + 斩断自证（P0/P1）

1. **证据来源收紧（P0）**：`sliceChunks` 保留 assistant 行做上下文，但 EXTRACT_SYSTEM 要求 `evidence` 引文必须出自 `[用户名]:` 行；daemon 对提取结果做服务端核验——evidence 子串必须命中该切片内 role=user 的消息，命中失败的候选直接丢弃。**小达自己的话永远不能成为证据**（对应研究结论 6 的第四条：派生行为不得自证）。
2. **晋升规则（P1）**：dreaming 合并阶段对既有 candidate 条目做证据配对——新候选与既有 candidate 语义重合时不再"丢弃重复"，而是记一次独立证据（不同日期/不同 session_key 才算独立组）。**candidate 满 2 个独立证据组 → 提案晋升 active**。
3. **apply 通路（P1，替代现在的永久 shadow）**：dreaming 产出结构化 proposal（add/invalidate/promote/extend-review），落 `memory/dreams/` 的 JSON + 人读报告；**调试台加一页 diff 审批，管理员点确认才 apply**（复用现有 git 备份 + append-only 写入）。生产自动 apply 暂不开——先跑一个月人审，攒精确率数据，再讨论对低风险类（t:fact 且 ≥2 证据组）放开自动。

### D5 · 最小效用回路（P1）

不做 counterfactual（P2），先攒数据：

- 快照注入时把本次注入的条目指纹（正文 hash 前 8 位）记入 model_log（现有可观测体系直接挂）。
- 检测强信号：用户纠错语（"不对/不是这样/我说过"）出现的会话 → 该会话注入过的条目全部记一次 `flagged`，进下一次 dreaming 的"待裁决"清单，人审时优先看。
- 弱信号一律不自动动条目（研究报告的缓解：只对强信号大幅更新）。

## 五症状 → 机制映射

| 症状 | 本方案的对应 |
|---|---|
| 过度特化 | D2（inferred 只进 candidate）+ D4.2（2 独立证据组晋升） |
| 错误泛化 | 层级 scope 已有 + D1 `t:` 类型字段 + workaround 强制 review_after |
| 过度触发 | D3（candidate/过期不注入）；层级+容量硬顶已天然限预算 |
| 陈旧不失效 | D1 `r:` 复核期限 + D3 软失效 + D4 复审续期/失效裁决 |
| 自我强化 | D4.1（证据必须出自用户消息，服务端核验）+ D5（纠错降权入口） |

## 实施切分

| 阶段 | 内容 | 改动面 |
|---|---|---|
| Phase 1（P0） | D1 元数据尾巴 + D2 权威分级/引文核验 + D3 注入过滤 + 存量迁移脚本 + D4.1 证据收紧 | `tool.mjs` / `files.mjs` / `inject.mjs` / `dreaming.mjs` EXTRACT 段 / `pi-ext/memory.ts` 参数 / persona 记忆纪律段；全部有单测，E2E 走既有四门控 |
| Phase 2（P1） | D4.2 晋升规则 + D4.3 proposal JSON + 调试台审批页 + D5 效用日志 | `dreaming.mjs` / 调试台 / model_log |
| Phase 3（P2，另立项） | counterfactual 抽样、自动 apply 放开、provenance 完整化 | 攒够 Phase 2 数据后再评估 |

## 待用户拍板

1. **candidate 是否完全不注入**（本方案立场：不注入，模型 read 可见）——备选：注入但加"未经证实"前缀。前者干净，后者让小达会话内能用上新推断。
2. **引文核验失败的处理**：拒绝写入 vs 自动降级为 inferred candidate（本方案倾向后者，宽进严出）。
3. **Phase 2 的 dreaming apply 是否必须人审**（本方案立场：是，先人审一个月）——这决定调试台审批页是不是 Phase 2 的硬依赖。
4. 存量条目一律标 active 宽进，还是全部打回 candidate 重新晋升（本方案倾向宽进，避免小达"失忆"一个月）。
