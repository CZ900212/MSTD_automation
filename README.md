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
- 一个飞书企业自建应用，按下节"飞书应用配置"逐步配好。
- 国内服务器注意：安装过程需要访问 github.com、nodejs.org、npm registry 三个境外源。直连拉不动时先配好代理或镜像再跑脚本。

## 飞书应用配置（详细教程）

小达接入飞书走的是"企业自建应用 + 机器人 + 长连接事件订阅"这条路，全程不需要公网回调地址。
本节按**纯聊天最小权限**口径写（只收消息、只回消息，不读云文档/日历/任务，不写任何东西），
这是新租户接入的推荐起点；读写全能力的升级流程见
[mstd-prod-onboarding.md](docs/superpowers/runbooks/mstd-prod-onboarding.md) 阶段二。
以下操作需要**飞书租户管理员**权限，总耗时约 15 分钟。

### 第 1 步：创建（或复用）企业自建应用

1. 用管理员账号登录 [open.feishu.cn](https://open.feishu.cn) → 开发者后台。
2. 点"创建企业自建应用"，名称随意（建议"小达"），传个头像。
   已有闲置的企业自建应用也可以直接复用，跳过创建，从第 2 步开始把配置补齐即可。
   注意**商店应用 / ISV 应用不能用**，必须是本租户的自建应用。
3. 进入应用详情页 → 左侧"凭证与基础信息"，记下 **App ID**（`cli_` 开头）和 **App Secret**。
   这两样是部署时的唯一凭证，走安全渠道交付（密码管理器/当面），不要在聊天里明文发。

### 第 2 步：开启机器人能力

左侧"应用能力"→"机器人"→ 开启。不开这一项，应用收不到消息也发不出消息。

### 第 3 步：导入权限（scope）

1. 左侧"权限管理"→ 右上"批量处理"→"批量导入"。
2. 粘贴仓库内 [mstd-prod-scope-import.chat-only.json](docs/superpowers/runbooks/mstd-prod-scope-import.chat-only.json) 的完整内容，确认导入。共 5 项 tenant 权限：

   | scope | 用途 |
   |---|---|
   | `application:bot.basic_info:read` | 查机器人自身 open_id（填 `.env` 的 `MSTD_BOT_OPEN_ID` 用） |
   | `im:message:send_as_bot` | 回复消息 |
   | `im:message.p2p_msg:readonly` | 接收私聊消息事件 |
   | `im:message.group_at_msg:readonly` | 接收群聊中 @机器人 的消息事件 |
   | `im:message.group_msg` | 接收群聊全部消息事件（敏感权限，见下） |

3. `im:message.group_msg` 是**敏感权限**，导入后需要管理员单独审批一次，
   完整操作见下面"敏感权限审批教程"。
4. "数据权限范围"选**全部成员**。

### 敏感权限审批教程（`im:message.group_msg`）

**这个权限是干什么的**：让小达能收到群聊里的全部消息事件，从而在被 @ 时
看得到前后文、给出贴合语境的回复。群策略仍然是 @ 才应答，小达不会主动插话。

**不开行不行**：行。管理员对"应用可读群内全部消息"有顾虑可以先不审批——
代价是小达在群里只能看到 @它 的那一条消息，回复会缺上下文；私聊完全不受影响。
之后想开随时可以补审批（补完记得重新发版）。

**审批操作步骤**（需要租户超级管理员，约 2 分钟）：

1. **发起申请**：在开发者后台该应用的"权限管理"页，找到
   `im:message.group_msg`（中文名"接收群聊中所有消息"）。批量导入后它的状态
   通常显示为"待申请"或"需管理员审批"，点它右侧的**申请开通**。
   页面会要求填写申请理由，如实写即可，例如：
   "AI 助理需要读取群上下文以便在被 @ 时给出贴合语境的回复"。
2. **管理员审批**：超级管理员打开**飞书管理后台**
   [feishu.cn/admin](https://feishu.cn/admin)（注意不是开发者后台）→
   左侧"工作台"→"应用管理"→ 找到本应用 → 进入应用详情的**权限管理**标签，
   在待审批列表里找到这条敏感权限申请 → 点**通过**。
   管理员也会同时收到"审批小助手"机器人推送的待办消息，从消息卡片进去审批亦可。
3. **确认生效**：回到开发者后台"权限管理"页刷新，该权限状态变为"已开通"。
4. **重新发版**：若审批发生在第 5 步发版之后，需要再创建一个版本并发布，
   权限才真正生效（见第 5 步的警告）。
5. **真机验证**：在试点群里**不 @** 小达随便发一句话，然后 @小达 问
   "刚才群里在聊什么"。答得上来说明群消息事件已通；只答得出被 @ 那句，
   说明权限还没生效，按第 4 步检查发版。

**常见卡点**：

- 开发者后台找不到"申请开通"入口：确认当前账号是应用的开发者/协作者，
  且权限确实已通过批量导入加入了申请列表。
- 管理后台待审批列表是空的：大概率第 1 步没点"申请开通"——批量导入只是把
  权限加进列表，敏感权限还要显式发起申请才会进入管理员的审批队列。
- 审批通过了小达还是看不到群消息：九成是没重新发版，剩下一成是机器人
  没在群里（第 6 步）。

### 第 4 步：配置事件订阅（长连接）

1. 左侧"事件与回调"→"事件配置"→ 订阅方式选**使用长连接接收事件**。
   选了长连接就不需要配置任何回调 URL，服务器也不需要公网入口。
2. "添加事件"→ 搜索并添加**接收消息 `im.message.receive_v1`**。
   页面会提示该事件依赖的权限，第 3 步已导入，直接确认。
3. 切到"回调配置"→ 同样选长连接 → 添加**卡片回传交互 `card.action.trigger`**。
   纯聊天阶段不会有任何带按钮的卡片发出，但服务端消费者按固定事件集建立长连接，
   缺这一项订阅会导致消费子进程反复重启刷日志，**必须订上**。

### 第 5 步：创建版本并发布

左侧"版本管理与发布"→"创建版本"→ 填个版本号（如 1.0.0）→ 申请发布。
企业自建应用免飞书审核，管理员在管理后台自行通过即可，分钟级生效。

> ⚠️ 这是最容易漏的一步，也是"部署完机器人不回话"的头号原因：
> **权限和事件订阅只对已发布版本生效，之后每次增删 scope 或事件都要重新创建版本并发布。**

### 第 6 步：把机器人拉进会话

- 群聊：群设置 → 群机器人 → 添加机器人 → 搜应用名添加。建议先拉进 1-2 个试点群。
- 私聊：成员在飞书搜索应用名，直接发起对话即可。

### 应用侧就绪自查清单

- [ ] App ID / App Secret 已安全交付给部署方
- [ ] 机器人能力已开启
- [ ] 5 项 scope 已导入，`im:message.group_msg` 已过管理员审批（或明确决定不开）
- [ ] 事件订阅为长连接模式，已订 `im.message.receive_v1` 与 `card.action.trigger`
- [ ] **已创建版本并发布**
- [ ] 机器人已加入试点群

应用侧到此完毕，接下来回到服务器执行上面的"一键安装"和下面的"填配置"。

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

纯聊天最小权限部署时，同时确认三闸全关（与应用侧权限面一致）：
`MSTD_ENABLE_WRITE=0`、`MSTD_ENABLE_TRIGGER=0`、`MSTD_BACKFILL=0`。

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
