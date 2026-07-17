# 小达幻觉治理 Spec（草案，待拍板）

日期：2026-07-15
状态：草案——四来源调研已收敛，方案定型，落地前待用户拍板
证据来源：
1. 外部深度研究报告 A（英文，覆盖 OpenAI/Anthropic/Gemini/Devin/Manus 官方指南 + 学术研究，本次会话中用户提供）
2. 外部深度研究报告 B（中文，含证据分级标签 + benchmark 综述 + 落地蓝图，本次会话中用户提供）
3. 本地调研：[Hermes/Codex 反幻觉机制](../../research/2026-07-15-anti-hallucination-hermes-codex.md)
4. 相关 spec：[记忆防过拟合治理](2026-07-15-memory-overfitting-governance.md)（记忆部分与本 spec 交叉）

## 一句话原则（四个来源共同收敛）

> **让模型负责提出计划和组织语言，让程序负责证明发生了什么，让来源负责证明什么是真的。**

Prompt 是软约束兜底；真正可靠的是架构层"不信模型自述、只信真实执行证据"。这一点 OpenAI（Codex exec 真实回注）、Hermes（curator 双通道审计）、两份外部报告（receipt + done gate 全部排 P0）完全一致。

## 五类幻觉形态 × 治理机制总表

| # | 形态 | 核心机制 | 小达现状 | 缺口 |
|---|------|---------|---------|------|
| 1 | 谎报操作已执行 | 不可变 Tool Receipt + done 状态机 + 程序化完成文案 | action DSL + hash 绑定审批、幂等对账（`safety/action-store.mjs`、`execute/reconcile-startup.mjs`）已是半成品 receipt | "已完成"仍由应答机自由生成；无 PLANNED→SUBMITTED→EXECUTED→VERIFIED 状态机；无 read-after-write |
| 2 | 引用记忆/文档编造细节 | Claim–Evidence 绑定 + 来源 span + 引用 ID 程序校验 | verbatim-guard（`safety/verbatim-guard.mjs`）只管注入不管事实 | 无 claim schema；记忆召回无来源/时间/状态元数据 |
| 3 | 没查就答 | tool-required 意图路由 + 无成功读取即 abstain | 意图路由存在（`jobs/intent-parse.mjs`） | 无"企业状态类问题必须先工具"的硬门；无 abstention 状态枚举 |
| 4 | dreaming 把猜测写成事实 | dreaming 只产 candidate diff + 来源血缘 + 晋升门 | `ticker/dreaming.mjs` 直写记忆——**正是 memory-overfitting spec 指出的最危险缺口** | 全部缺 |
| 5 | 摘要/压缩失真 | 不可压缩事件日志 + 结构化 checkpoint + 保真回归测试 | journal（`memory/journal.mjs`）近似事件日志；compact（`memory/compact.mjs`）是自由文本 | checkpoint 无结构化 schema；无摘要保真测试集 |

## 关键外部证据（浓缩）

- **Prompt 层有效措辞**（有实证）：OpenAI 报告 persistence + "use tools instead of guessing" + planning 三条 reminder 在 SWE-bench Verified 上提升近 20%；"Do NOT promise to call a function later" 直接针对形态 1；泛泛"请诚实/不要幻觉"无稳定实证。
- **反例警示**：ChatGPT Agent 系统卡显示带工具的配置在事实性评测上仍可能更差——**有工具 ≠ 回答被工具结果 grounding**；2025-26 研究发现增强推理反而可能系统性提高工具幻觉（高 effort 必须配更强 grounding，不能单独用）。
- **Receipt 研究**：HMAC 签名执行回执方案检出 94.2% 伪造工具引用 / 87.6% 计数错报 / 91.3% 虚假"不存在"声明，验证开销 ~15ms。
- **Verifier 成本**："Verify when Uncertain"：self-consistency 已接近黑盒 oracle，二段式（只对不确定案例上 verifier）保留大部分收益同时控住成本——**不要全量二审，按风险触发**。
- **压缩**：Factory 评测：结构化分节摘要（intent/修改/决策/下一步）保真优于 OpenAI/Anthropic 内置压缩；外部项目状态层在 Claude Code 上恢复 90% 忠实度缺口。
- **记忆**：OpenAI cookbook 明言 consolidation 是"最敏感最易错"阶段，会造成长期幻觉；Zep 的 valid_at/invalid_at（矫正不删除历史）、Letta 的 git-backed 版本化记忆、MemIR 的"证据/线索/claim 原子分离"是三个可抄的公开设计。
- **模型层**：无公开可靠的跨模型 agentic 幻觉排名；结论是"选控制面匹配治理架构的模型"，温度/logprob 不能当安全门，风险特征（工具是否成功、证据覆盖率、来源冲突、是否不可逆写）比解码置信度有用。
- **Hermes 独有可抄**：file-mutation verifier footer（轮末用真实工具结果对账模型措辞，不符则加确定性警告）；curator 双通道审计（模型自述 vs tool_calls 日志 ground-truth）；按模型族定向注入反幻觉 prompt（GPT/Grok 一套、Gemini 一套）。
- **Codex 独有可抄**：Completion Audit prompt（"把完成当作未证明的断言，逐项找权威证据"）；记忆写入认知状态标签（verified / user-said / inferred / assistant-claimed-unvalidated）；compaction 保留真实用户消息原文只截断不改写。

## 方案：四阶段落地（对齐两份外部报告的一致排序）

### 阶段一（P0）：消灭"谎报完成"——收益最高、直接踩现有地基
1. `execute/execute-action.mjs` 每次写操作产出不可变 receipt（action_id、args_hash、execution_status、resource_id、postcondition_status），落 `store/`，与现有幂等对账打通。
2. 引入 done 状态机（PLANNED→SUBMITTED→EXECUTED→VERIFIED→SUCCEEDED / FAILED / UNKNOWN），"已完成/已发送/已创建"类文案由 `execute/render-card.mjs` 按状态枚举渲染，**应答机无权自由生成完成声明**。
3. 高风险写操作 read-after-write（建日程后重新查询到才算 VERIFIED）。
4. fallback 路径（DeepSeek 降级）不得绕过状态机——降级分"能力降级"（换模型但同一门控）与"安全降级"（模板输出"状态未知"）。
5. 轮末对账 footer（抄 Hermes）：工具实际失败但回复措辞暗示成功 → 卡片自动追加确定性警告。

### 阶段二（P0）：事实可追溯
1. claim schema：人名/时间/数字/企业状态/完成声明必须带 evidence_id（工具回执 ID 或来源 span）。
2. reasoner→应答机之间传结构化"已批准声明集合"，应答机只能改写不能新增事实。
3. 引用 ID / 数字 / 日期由程序校验（确定性检查器，非 LLM）。
4. 无证据声明：自动降级为"推断"标注或删除。
5. prompt 收紧（配合而非替代）：注入"事实与状态规则"块——立即调用不预告、三态区分（调用已发出≠返回成功≠状态已验证）、缺证据输出 not_checked/checked_not_found/unknown 而非补全。抄 Codex "Do NOT guess or make up an answer" + `<missing_context>`（Hermes）措辞；按模型族定向（GPT 主脑一套、DeepSeek 降级一套）。

### 阶段三（P0，与 memory-overfitting spec 合并推进）：封住 dreaming 污染
1. `ticker/dreaming.mjs` 失去正式记忆直写权限，只产 candidate diff（operation/claim/source_event_ids/confidence）。
2. 记忆条目加 provenance schema：source_kind（user_statement/tool/document/model_inference）、observed_at、valid_from/valid_to、status（candidate/verified/disputed/retracted/expired）、supersedes 链。
3. 硬规则四条：事件日志是证据而语义记忆只是派生视图；无新外部证据不得因重复召回提升置信度；模型输出/摘要/旧记忆互相引用不构成独立来源（来源血缘去重）；召回返回"事实+来源+有效期+状态"而非裸句子。
4. 晋升门：工具事实/用户明述可晋升（带 ID 和时间）；模型推断只能 candidate + 短 TTL；"任务成功经验"须有成功回执才转 episodic；矫正用 retracted 标记不静默覆盖。

### 阶段四（P1）：verifier + 持续评测
1. 全量确定性检查（状态/ID/参数/引用存在性）先行；独立模型 verifier 只按风险触发（写操作、完成声明、记忆写入、来源冲突、新版本 canary），verifier 只看"请求+候选声明+证据"，不看 reasoner 长篇叙述。
2. 核心 SLO：False Completion Rate（写操作目标≈0）、Unsupported Claim Rate、Tool Bypass Rate、Memory Transition Error（omission/corruption/hallucination/stale recall）、Compression Fidelity。挂进现有 model_log 看板。
3. 事故重放集：每次线上幻觉事故转化为可重放测试（分别打 reasoner/应答机/fallback/compact/dreaming）。
4. 摘要保真回归：人名/日期/否定词/完成状态/来源 ID 的 probe 测试集，换模型或改 compact prompt 时必跑。

## 待拍板项

1. **完成文案收权**：接受"已完成"类措辞由 render-card 按状态枚举生成、应答机只负责其余文案？（这是阶段一的核心，改动应答机职责边界）
2. **claim-evidence 范围**：阶段二先只覆盖"写操作+完成声明+企业状态查询"，还是一步到位覆盖所有人名/时间/数字？（推荐先窄后宽）
3. **与 memory-overfitting spec 的合并**：阶段三与该 spec 的四点拍板高度重叠，是否合并为一份、一次拍板？
4. **verifier 模型选型与预算**：风险触发的独立 verifier 用哪个模型（DeepSeek 便宜 / GPT 同族有共谋风险 / Opus 贵）、每日预算上限？
5. **read-after-write 范围**：所有写操作 vs 仅高风险白名单 op？（有 API 配额成本）
