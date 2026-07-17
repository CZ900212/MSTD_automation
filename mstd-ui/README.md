# mstd-ui — 小达 Web 调试台

面向运维/开发的六 tab 调试前端，对接 `mstd-orchestrator` 的 `/api/admin/*` 与 OAuth 会话。

## 快速开始

```bash
# 1. 先在 mstd-orchestrator 起 daemon（需 .env：PORT、MSTD_SESSION_SECRET、MSTD_ADMIN_OPEN_IDS 等）
cd ../mstd-orchestrator && mstd start

# 2. 本目录
npm install
npm run dev          # 默认 http://localhost:5173 ，代理到 http://127.0.0.1:8787
```

环境变量：

| 变量 | 含义 |
|---|---|
| `MSTD_API_URL` | 覆盖 vite 代理目标（默认 `http://127.0.0.1:8787`） |

```bash
npm test             # vitest
npm run build
```

## 六 tab 职责

| Tab | 用途 |
|---|---|
| **工作台** | 选 job、看事件时间线（工具调用/进度）、审批相关操作 |
| **看板** | cron 管理、后台 job 列表、写动作审计、**模型链路事件**（可按 kind/taskId/decision 筛选） |
| **会话** | 全会话列表 + transcript 回放 + admit 判定徽标；勾选「实时刷新」会轮询列表与当前会话 |
| **记忆** | 记忆文件浏览/编辑（需 admin） |
| **调试对话** | `debug:` 会话直接聊 agent，不出飞书；debugId 持久化在 localStorage，可「新开会话」 |
| **（其它）** | 登录与权限相关入口以当前路由为准 |

## 登录与 admin token

1. 用飞书 OAuth 登录 orchestrator 暴露的 auth 端点。
2. 回调把 token 放在 **URL fragment**，前端 `auth.ts` bootstrap 后写入 `localStorage`。
3. 访问 `/api/admin/*` 需要：
   - 有效会话 token
   - 用户 `open_id` 在服务端 `MSTD_ADMIN_OPEN_IDS` 白名单内（admin 角色）

没有 admin 时，看板/会话等接口会 401/403。

## 相关文档

- 产品与架构：`../project.md`、`../mstd-orchestrator/README.md`
- 运维启停：`mstd status` / `mstd tui`（见 orchestrator `.env.example` 的 TUI 段）
