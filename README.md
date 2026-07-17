# MSTD 小达 — 飞书常驻助理

小达是一个驻在飞书里的常驻助理。它收到消息后由应答机先行答复；独立调度器在答复之后评审本轮是否需要深入处理；需要深入时，推理机在按 task 隔离的 Pi 进程里带工具完成推理，结果再经应答机转述给用户。产品意图与刻意设计记录在 [project.md](project.md)，该文件对本仓库的开发者和 AI 会话具有最高优先级。

## 仓库结构

| 目录 | 内容 |
|---|---|
| `mstd-orchestrator/` | 服务端主体：事件网关、三角色编排、安全内核、mstd CLI 与监控 TUI |
| `mstd-ui/` | web 调试台前端 |
| `docs/` | 设计文档、实现规格、接入 runbook 与调研存档 |
| `project.md` | 产品意图与刻意设计，读代码之前先读它 |

## 服务器部署（Linux）

### 一键安装

```bash
curl -fsSL https://github.com/CZ900212/MSTD_automation/releases/latest/download/install.sh | bash
```

脚本负责准备运行环境：确认或下载 Node 22、克隆本仓库、安装依赖（含 lark-cli）、生成 `.env` 骨架、把 `mstd` 命令链接进 `~/.local/bin`。脚本不接触任何密钥，装完之后你还需要手工完成下面的"填配置"和"注册系统服务"两步。

安装位置默认为 `~/mstd`，通过环境变量修改：

```bash
curl -fsSL .../install.sh | MSTD_HOME=/opt/mstd bash
```

### 前置条件

- Linux x64 或 arm64，glibc 发行版。Alpine（musl）需要自备构建工具链编译 better-sqlite3。
- Node 22.19 及以上、23 以下。缺失时安装脚本会把 Node 下载到安装目录内，不改动系统环境。
- 一个飞书企业自建应用。建应用、批量导入 scope、配置长连接事件订阅、发版的完整清单见 [mstd-prod-onboarding.md](docs/superpowers/runbooks/mstd-prod-onboarding.md)。

### 手动部署

不用一键脚本时，等价的手工步骤如下：

1. 安装 Node 22 与 lark-cli：`npm install -g @larksuite/cli`。
2. 克隆仓库并安装依赖。devDependencies 必须一并安装，推理机在运行时依赖其中的 Pi 包：

   ```bash
   git clone https://github.com/CZ900212/MSTD_automation.git
   cd MSTD_automation/mstd-orchestrator
   npm ci
   ```

3. 配置 lark-cli profile。应用凭证只进 lark-cli 自己的配置文件，不进本仓库：

   ```bash
   lark-cli config init --profile mstd-prod --app-id <cli_...> --app-secret-stdin
   ```

4. 建立 `.env`：

   ```bash
   cp .env.example .env && chmod 600 .env
   ```

   生产口径的完整字段模板在 [mstd-prod.env.template](docs/superpowers/runbooks/mstd-prod.env.template)。

### 填配置

`.env` 里以下字段不填的话，服务无法启动，或启动后不会应答：

| 字段 | 说明 |
|---|---|
| `DEEPSEEK_KEY` / `CZ_GPT_KEY` | 模型网关 key |
| `LARK_PROFILE` | 上一步 init 使用的 profile 名 |
| `MSTD_LARK_CLI` | lark-cli 可执行文件的绝对路径（`which lark-cli` 的输出；一键脚本已代填） |
| `MSTD_ENABLE_AGENT` | 置 1，常驻 agent 总开关 |
| `MSTD_BOT_OPEN_ID` | `lark-cli --profile <名> api get /open-apis/bot/v3/info --as bot` 返回的机器人 open_id |
| `MSTD_BOT_NAME` | 机器人展示名，群聊点名判定依赖它 |
| `MSTD_SESSION_SECRET` | `openssl rand -hex 32` 生成 |

开关类配置必须写进 `.env`。只在 shell 里 export 的值会随服务重启丢失，之后小达会静默不回话。

### 注册系统服务

```bash
mstd install
```

`mstd install` 在 Linux 上注册 systemd user 服务，效果是开机自启加崩溃自动拉起。注册过程会执行 `loginctl enable-linger`；这一步失败时服务会随用户登出被杀，需要有权限的管理员补执行 `loginctl enable-linger <用户名>`。

只想先试跑、不注册服务：直接执行 `mstd`。

### 验证

```bash
mstd status      # 进程与消费者健康
mstd logs        # 跟随 daemon.log
mstd tui         # 只读监控台；mstd tui --probe 只做自检
```

日志出现 `agent gateway on` 表示事件消费已就绪。在测试群里 @机器人 发一句话，收到回复即部署完成。

## 日常运维

| 命令 | 作用 |
|---|---|
| `mstd` / `mstd start` | 启动。已注册系统服务时改经 systemd 拉起 |
| `mstd stop` | 停止服务及飞书事件消费子进程 |
| `mstd restart` | 重启 |
| `mstd status` | 运行状态与消费者健康 |
| `mstd logs` | 实时跟随日志 |
| `mstd tui` | 终端监控台 |
| `mstd install` / `mstd uninstall` | 注册、注销系统服务 |

## 常见问题

- 端口冲突：默认端口 8787。同机有其他服务占用时改 `.env` 里的 `PORT`。
- systemd 环境里找不到 node：`mstd install` 生成的服务定义已写入 node 绝对路径，无需处理；手工改过服务文件的话请保留 `MSTD_NODE_BIN` 一项。
- 改了 `.env` 不生效：执行 `mstd restart`。
- 部署完成后机器人不回消息：按 runbook 核对应用是否已发版、事件订阅是否为长连接模式、`MSTD_ENABLE_AGENT` 是否写在 `.env` 里。

## 开发

单测必须在 `mstd-orchestrator/` 目录内执行，在仓库根执行会连带扫出无关的假失败：

```bash
cd mstd-orchestrator && npm test
```

改动用户可见行为或核心语义之前，先读 project.md 第五节的确认边界。
