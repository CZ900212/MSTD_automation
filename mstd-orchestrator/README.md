# mstd-orchestrator（基于 Pi 的自动管理系统 · 本地验证）

把已验证的飞书链路做成 **Pi agent** 驱动的自动管理系统。本目录是 **本地验证版**，核心闭环已端到端跑通（2026-07-08）。

## ✅ 已验证跑通（本地，真实数据）

- Pi 0.80.3（`@earendil-works/pi-coding-agent`）装好，网关三 provider 配好。
- **GPT-5.5 主脑经 Pi 真实触发工具**（工具循环成立，推理强度始终 medium）。
- **lark 工具**：Pi 通过它调已授权 `lark-cli`，真实搜妙记 / 导逐字稿 / 可发卡片建任务。
- **draft_zh 工具**：Opus 4.6 执笔面向用户的高质量中文（消息/卡片文案/报告）。
- **RPC 无头驱动**（`supervisor/pi-client.mjs`）：Node 程序化驱动 Pi，解析事件流，取最终产出。
- **端到端 demo**（`demo/run-meeting-job.mjs`，~86s）：GPT-5.5 编排 → lark 导真实逐字稿 → 抽 action items → Opus 执笔飞书确认卡片文案，全程无人工。

## 🔴 关键发现（决定架构）

**曾经**：CZ 聚合网关（api.cz900212.com）不支持工具调用，两种格式的 tools 参数都被吃掉，一度被迫用 DeepSeek 直连当主脑。
**现在（2026-07-09）**：网关侧已开通工具调用。实测：
- **GPT-5.5 / gpt-5.4 / gpt-5.4-mini** 经网关返回**干净** `tool_calls`（args 正常，多轮工具循环通）→ 可当主脑。
- **Claude 路由**的 `tool_calls.arguments` 会多拼一个前导空对象 `{}`（如 `{}{"city":"北京"}`），但 **Pi 的解析器实测能容忍**（Opus 调 bash 工具正常）。

→ 架构据此定型（回归"opus 对用户表达 / gpt 推理"的分工）：
| 角色 | 模型 | 接线 | 备注 |
|---|---|---|---|
| **主脑 / 工具循环 / 编排推理** | **GPT-5.5**（CZ 网关，`$CZ_GPT_KEY`） | Pi 主模型 | 推理强度**始终 medium**（thinkingLevelMap 全档钉死） |
| **与用户交互 / 对外中文表达** | **Claude Opus 4.6**（CZ 网关，`$CZ_CLAUDE_KEY`） | `draft_zh` 工具 | 所有给人看的中文成品必经此工具 |
| **图像识别 / OCR** | GPT-5.5（多模态，同一 key） | 视觉工具（待建） | |
| **备用主脑** | DeepSeek（`api.deepseek.com`） | 网关不可用时兜底 | 已降级，非默认 |

## 结构

```
pi-ext/providers.ts  # 注册 cz-gpt(gpt-5.5 主脑) + cz-claude(opus-4-6 交互) + deepseek(备用)
pi-ext/lark.ts       # lark 工具：shell 到 lark-cli（默认拦写，LARK_ALLOW_WRITE=1 放行）
pi-ext/draft.ts      # draft_zh 工具：Opus 4.6 执笔中文（与用户交互唯一出口）
supervisor/pi-client.mjs  # RPC 无头驱动 Pi（严格 JSONL，agent_end 判完成）
demo/run-meeting-job.mjs  # 端到端 demo
.env                 # 密钥（gitignore）：CZ_GPT_KEY / CZ_CLAUDE_KEY / DEEPSEEK_KEY / LARK_PROFILE
```

## 运行

```bash
cd mstd-orchestrator
set -a; . ./.env; set +a          # 加载密钥到环境

# 单跑 opus-4-6（对用户交互文本）
pi -e pi-ext/providers.ts -a --provider cz-claude --model claude-opus-4-6 --thinking medium --no-session -p "..."

# GPT-5.5 主脑 + 工具（真实 agent，推理始终 medium）
pi -e pi-ext/providers.ts -e pi-ext/lark.ts -e pi-ext/draft.ts -a --provider cz-gpt --model gpt-5.5 --thinking medium --no-session -p "..."

# 无头端到端 demo
node demo/run-meeting-job.mjs
```

## 待办（迁移到上海服务器前）

- ✅ ~~补 GPT key~~（已到位，`$CZ_GPT_KEY`）；下一步用同 key 的 gpt-5.5 多模态建视觉工具。
- guard hook（`tool_call` 门禁 + 审计入库）替换 lark.ts 里的粗过滤。
- 状态层（SQLite 本地 / Postgres 服务器）：orch_jobs / decisions / events。
- 触发层：`lark-cli event consume` 长连接（妙记生成 / card.action.trigger）。
- 部署：见 `../docs/superpowers/plans/2026-07-08-pi-orchestrator-migration.md`（注意服务器 1GB 内存约束）。
```
