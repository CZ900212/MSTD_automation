# 反幻觉机制调研：Hermes Agent × Codex CLI（2026-07-15）

> 调研对象：
> - **Hermes**（Nous Research hermes-agent，Python，本地路径 `~/.hermes/hermes-agent`）
> - **Codex CLI**（OpenAI，Rust v0.142.0，本地路径 `rsh-pricing-app/codex-rust-v0.142.0`）
>
> 目的：为小达（MSTD 常驻助手）的幻觉治理方案提供参照。配套外部研究 prompt 已另行提供给用户。

## 核心结论

两家的共同哲学一致：**prompt 层是软约束、兜底；真正可靠的是架构层"不信模型自述、只信真实执行证据"**。

- **Codex** 的重心：把"证据"做成不可伪造的——exec 的 exit_code/stdout 由 Rust 层真实捕获回注，apply_patch 找不到真实上下文行直接报错，模型只能引用不能编造；prompt 层强制 file:line 引用、review 结论必须带 confidence score、"完成"被定义为需逐项证据审计的断言（Completion Audit）。
- **Hermes** 的重心：**交叉验证模型的自述**——curator 用真实 tool_calls 日志审计模型的结构化自我汇报，声称合并到不存在的目标即判幻觉并降级；file-mutation verifier 在轮末基于真实工具结果自动追加"文件其实没改成"警告；子 agent 汇报被明确定义为"自述非事实"，父 agent 必须用可验证句柄（URL/路径/状态码）亲自复核。

两家都没有：通用的第二模型 verifier pass（成本原因，只在特定场景做审计）；带来源/置信度字段的通用记忆系统（Codex 在记忆**写入 prompt** 里要求保留认知状态标签，是 prompt 层做法）。

---

## Codex CLI 机制清单

### Prompt 层

1. **"Do NOT guess or make up an answer"** — 所有基础系统提示词的核心句（`core/gpt_5_1_prompt.md:138`、`protocol/src/prompts/base_instructions/default.md:125` 等）：
   > "You must keep going until the query or task is completely resolved... Only terminate your turn when you are sure that the problem is solved... **Do NOT guess or make up an answer.**"
2. **禁止伪造行内引用，强制真实可点击路径**（`core/gpt_5_1_prompt.md:160`）：
   > "NEVER output inline citations like "【F:README.md†L5-L14】"... Instead, if you output valid filepaths, users will be able to click on them."
3. **File References 规范**：最终回复引用文件必须带真实行号（`core/gpt_5_1_prompt.md:232-240`、`core/gpt_5_codex_prompt.md:61-67`）。
4. **Review rubric 要求可证伪证据 + 量化置信度**（`prompts/templates/review/rubric.md`）：
   - :17 "The bug does not rely on unstated assumptions..."
   - :18 "It is not enough to speculate that a change may disrupt another part of the codebase... one must identify the other parts of the code that are provably affected."
   - :24 不得夸大严重性；:68-79 每条 finding 必须 cite files/lines/functions，带 `confidence_score`（0.0–1.0）、`priority`（P0–P3）、`overall_confidence_score`。
5. **Completion Audit（声明完成前的证据审计）** — 全库最系统化的机制（`ext/goal/templates/goals/continuation.md:30-41`）：
   > "Before deciding that the goal is achieved, treat completion as unproven and verify it against the actual current state... Treat uncertain or indirect evidence as not achieved... The audit must prove completion, not merely fail to find obvious remaining work."
   > "Do not rely on intent, partial progress, memory of earlier work, or a plausible final answer as proof of completion."
6. **记忆写入的"证据优先 + 认知状态标注"**（`memories/write/templates/memories/stage_one_system.md`）：
   - :22 "Evidence-based only: do not invent facts or claim verification that did not happen."
   - :259-268 要求区分"verified from code/tool evidence / explicitly stated by the user / inferred / proposed by assistant"，用 "the user said ..." 这类 epistemically honest 措辞，禁止改写成无出处的事实。
   - :200 "Uncertain: no clear signal, or only the assistant claims success without validation."
7. **记忆读取的不确定性披露 + 强制引用坐标**（`ext/memories/templates/memories/read_path.md:63-115`）：
   > "If you rely on memory for a fact that you did not verify in the current turn, say so briefly... Do not present unverified memory-derived facts as confirmed-current."
   引用必须精确到 `<file>:<line_start>-<line_end>`，"only cite files actually used"。

### 架构层

8. **Plan 工具状态机**：schema + prompt 双重规定步骤只能 pending→in_progress→completed，禁止事后批量标完成（`core/src/tools/handlers/plan_spec.rs:44-47`、`core/gpt_5_1_prompt.md:73`）。
9. **Compaction 保留真实用户消息原文**：压缩后把最近真实 user messages 原文拼回历史，只截断不改写（`core/src/compact.rs:551-605`），"总结即失真"由架构补强。
10. **apply_patch 上下文匹配校验**：补丁声明的上下文行必须在真实文件中找到（seek_sequence），否则报错终止（`apply-patch/src/lib.rs:725-738`）——模型无法"假装打上了补丁"。
11. **exit_code 由真实 Result 决定**，不由模型自报（`core/src/tools/runtimes/apply_patch.rs:250-271`）；prompt 配套告诉模型"失败会真实报错，不用重读文件确认"。
12. **exec 真实 stdout/stderr 原样回注**：`format_exec_output_for_model` 输出 `Exit code:` / `Wall time:` / `Output:`，只做字节级截断、不做内容改写（`core/src/exec.rs:731-882`、`core/src/tools/mod.rs:77-102`）。
13. **sandbox denied 判定基于真实输出模式匹配**，非模型自报（`core/src/tools/runtimes/apply_patch.rs:274-278`）。

---

## Hermes Agent 机制清单

### Prompt 层

1. **TASK_COMPLETION_GUIDANCE（全模型注入，可配置开关）**（`agent/prompt_builder.py:286-299`）：
   > "NEVER substitute plausible-looking fabricated output (made-up data, invented file contents, synthesised API responses) for results you couldn't actually produce. Reporting a blocker honestly is always better than inventing a result."
2. **模型族定向的 anti-hallucination 块**（只给 GPT/Codex/Grok 注入，`agent/prompt_builder.py:351-366`，注入点 `agent/system_prompt.py:171-177` 注释明写 "anti-hallucination"）：
   > `<verification>` "Grounding: are factual claims backed by tool outputs or provided context?"
   > `<missing_context>` "If required context is missing, do NOT guess or hallucinate an answer... If you must proceed with incomplete information, label assumptions explicitly."
   —— **按模型对症下药**，而非一段话对所有模型。Gemini/Gemma 另有 "Verify first... Never guess at file contents"（:371-388）。
3. **mandatory_tool_use：可工具验证的事实禁止凭记忆回答**（`agent/prompt_builder.py:320-332`）：
   > "NEVER answer these from memory or mental computation — ALWAYS use a tool... Your memory and user profile describe the USER, not the system you are running on."
4. **默认 persona 要求 admit uncertainty**（`agent/prompt_builder.py:121-129`）。
5. **Kanban 多 agent 协议："Block on genuine ambiguity... Don't guess."**（`agent/prompt_builder.py:202-205`）；"Reviewing-then-completing is more honest than auto-completing"（:216-219）。
6. **子 agent 汇报 = 自述非事实**（`tools/delegate_tool.py:2591-2597`）：
   > "Subagent summaries are SELF-REPORTS, not verified facts... require the subagent to return a verifiable handle (URL, ID, absolute path, HTTP status) and verify it yourself — fetch the URL, stat the file, read back the content — before telling the user the operation succeeded."
7. **memory-context fence**：召回记忆标注为"权威参考数据、非用户新输入"（`agent/memory_manager.py:227-241`），grounding + 防注入一体。

### 架构层

8. **工具名幻觉检测与自动修复**：模型调不存在的工具→相似名修复，修不了→"Tool 'X' does not exist. Available tools: ..." 作为 tool 结果回注，重试 3 次（`agent/conversation_loop.py:3741-3792`）。
9. **Curator 双通道交叉验证（全库最完整的反幻觉架构）**（`agent/curator.py:795-923`）：模型输出结构化自述，系统**并行用真实 tool_calls 日志做 ground-truth audit**；模型声称合并到不存在的伞形技能 → 判定幻觉，回退到工具调用证据或标记 prune。专项单测 `tests/agent/test_curator_classification.py:479-521`（`test_reconcile_model_hallucinates_umbrella` 等）。
10. **file-mutation verifier footer**（`run_agent.py:2363-2497`）：轮末基于真实工具结果追踪 write_file/patch 失败，若模型措辞暗示已完成，自动追加确定性警告：
    > "⚠️ File-mutation verifier: N file(s) were NOT modified this turn despite any wording above that may suggest otherwise."
11. **x_search degraded 标志**（`tools/x_search_tool.py:21-37, 376-399`）：底层 API 无检索结果仍返回"编造答案"时，工具层解析 citations 为空 + 有过滤条件 → 标记 `degraded`，把"有引用的答案"和"模型编的答案"显式区分。
12. **schema 规范防跨工具幻觉引用**（`AGENTS.md:992-993`）：工具描述禁止硬编码其他工具名（可能未启用→诱导幻觉调用）。
13. **压缩保真**（`agent/context_compressor.py:1150-1339`）：摘要要求 "Be CONCRETE — include file paths, command outputs, error messages, line numbers... Avoid vague descriptions"；回退模板提醒 "The summary may be incomplete; prefer verifying current files... Verify state with tools before making claims."
14. **拒绝在历史中捏造占位文本**（`agent/agent_runtime_helpers.py:819-825`）："Fabricating '.' / '(continued)' text lies in the history"→选择 drop-and-merge。
15. **prompt 防退化单测**（`tests/agent/test_prompt_builder.py:1252-1255`）：断言提示词必须含 "hallucinate/guess" 关键词，防止重构误删。

---

## 对照小达的五种幻觉形态 → 可借鉴机制

| 小达幻觉形态 | Codex 借鉴 | Hermes 借鉴 |
|---|---|---|
| 1. 谎报工具执行/操作状态 | exit_code/stdout 真实回注（已有）；Completion Audit prompt | **file-mutation verifier footer**（轮末用真实 op 结果对账模型措辞）；子 agent 自述须可验证句柄 |
| 2. 引用记忆/文档时编造细节 | 记忆读取强制 file:line 引用 + "未验证需声明"；禁止伪造引用格式 | memory-context fence；mandatory_tool_use |
| 3. 没查就答 | "Do NOT guess or make up an answer" | `<missing_context>` 块（缺信息→先工具检索→仍缺才问→硬要继续须标注假设） |
| 4. dreaming 把猜测写成事实、污染长期记忆 | **记忆写入 stage_one prompt**："Evidence-based only" + 认知状态标签（verified/user-said/inferred/assistant-claimed-unvalidated） | curator 式 ground-truth audit：固化记忆前用真实事件日志交叉验证 |
| 5. 摘要/压缩失真 | compaction 保留真实用户消息原文，只截断不改写 | 摘要要求具体可核实 + "claim 前先工具重验"提醒 |

与 [[memory-overfitting-governance]] spec 直接相关：Codex 的认知状态标签（第 6 条）和 Hermes 的 curator 审计（第 9 条）正是 dreaming 自证闭环缺口的两个现成参照。
