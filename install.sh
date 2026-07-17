#!/usr/bin/env bash
# install.sh — MSTD 小达服务器一键安装（Linux 为主，macOS 可用）。
# 用法：
#   curl -fsSL https://github.com/CZ900212/MSTD_automation/releases/latest/download/install.sh | bash
# 可调环境变量：
#   MSTD_HOME  安装目录，默认 ~/mstd
#   MSTD_REPO  仓库地址，默认 https://github.com/CZ900212/MSTD_automation.git
#   MSTD_REF   检出的分支或 tag，默认与本脚本同版本的 tag（每次发 release 时同步改）
# 脚本只准备运行环境，不接触任何密钥。装完后按屏幕提示补 .env 再 mstd install。
set -euo pipefail

MSTD_HOME="${MSTD_HOME:-$HOME/mstd}"
MSTD_REPO="${MSTD_REPO:-https://github.com/CZ900212/MSTD_automation.git}"
MSTD_REF="${MSTD_REF:-v0.1.0}"
APP_DIR="$MSTD_HOME/app"
ORCH_DIR="$APP_DIR/mstd-orchestrator"
TOOLS_DIR="$MSTD_HOME/tools"

say()  { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

# —— 平台判定 ——
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux)  node_os=linux ;;
  Darwin) node_os=darwin ;;
  *) fail "不支持的系统 $OS。Windows 请用仓库内 mstd-orchestrator/bin/mstd.cmd。" ;;
esac
case "$ARCH" in
  x86_64)        node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail "不支持的架构 $ARCH（需要 x86_64 或 arm64）。" ;;
esac
for cmd in curl tar git; do
  command -v "$cmd" >/dev/null || fail "缺少 $cmd，请先用系统包管理器安装。"
done

mkdir -p "$MSTD_HOME"

# —— Node 22：系统 node 版本符合就用，否则下载到安装目录内 ——
node_ok() {
  command -v node >/dev/null || return 1
  local v major minor
  v="$(node -v)"; v="${v#v}"
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [ "$major" = 22 ] && [ "$minor" -ge 19 ]
}
if node_ok; then
  say "▶ 使用系统 Node $(node -v)"
else
  say "▶ 系统无符合版本的 Node（需要 22.19 至 22.x），下载官方发行版…"
  shasums="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)"
  tarball="$(printf '%s\n' "$shasums" | grep -o "node-v22\.[0-9.]*-${node_os}-${node_arch}\.tar\.xz" | head -1)"
  [ -n "$tarball" ] || fail "在 nodejs.org 没有找到 ${node_os}-${node_arch} 的 Node 22 发行包。"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/${tarball}" -o "$MSTD_HOME/$tarball"
  expected="$(printf '%s\n' "$shasums" | grep " ${tarball}\$" | awk '{print $1}')"
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum "$MSTD_HOME/$tarball" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$MSTD_HOME/$tarball" | awk '{print $1}')"
  fi
  [ "$expected" = "$actual" ] || fail "Node 发行包校验失败（预期 $expected，实际 $actual）。"
  rm -rf "$MSTD_HOME/node"
  mkdir -p "$MSTD_HOME/node"
  tar -xJf "$MSTD_HOME/$tarball" -C "$MSTD_HOME/node" --strip-components=1
  rm -f "$MSTD_HOME/$tarball"
  export PATH="$MSTD_HOME/node/bin:$PATH"
  say "  已安装 $(node -v) 到 $MSTD_HOME/node（不影响系统环境）"
fi

# —— 拉取仓库 ——
if [ -d "$APP_DIR/.git" ]; then
  say "▶ 更新已有检出（$APP_DIR，$MSTD_REF）…"
  git -C "$APP_DIR" fetch --depth 1 origin "$MSTD_REF"
  git -C "$APP_DIR" checkout -q FETCH_HEAD
else
  say "▶ 克隆仓库到 $APP_DIR（$MSTD_REF）…"
  git clone --depth 1 --branch "$MSTD_REF" "$MSTD_REPO" "$APP_DIR"
fi

# —— 安装依赖（devDependencies 必须装：推理机运行时依赖其中的 Pi 包） ——
say "▶ npm ci（mstd-orchestrator）…"
(cd "$ORCH_DIR" && npm ci --no-fund --no-audit)

# —— lark-cli：装进安装目录，不污染全局 ——
say "▶ 安装 lark-cli（@larksuite/cli）到 $TOOLS_DIR …"
mkdir -p "$TOOLS_DIR"
npm install --prefix "$TOOLS_DIR" --no-fund --no-audit @larksuite/cli >/dev/null
LARK_CLI_BIN="$TOOLS_DIR/node_modules/.bin/lark-cli"
[ -x "$LARK_CLI_BIN" ] || fail "lark-cli 安装后不可执行：$LARK_CLI_BIN"

# —— 原生模块自检（better-sqlite3 预编译包在个别发行版上装不上） ——
(cd "$ORCH_DIR" && node -e "import('better-sqlite3').then(m => { new m.default(':memory:'); })") \
  || fail "better-sqlite3 加载失败。musl 发行版需要安装 python3/make/g++ 后重跑本脚本。"

# —— .env 骨架：仅在不存在时生成，绝不覆盖已有配置 ——
if [ -f "$ORCH_DIR/.env" ]; then
  say "▶ 已存在 .env，保持不动"
else
  say "▶ 生成 .env 骨架（$ORCH_DIR/.env）…"
  cp "$ORCH_DIR/.env.example" "$ORCH_DIR/.env"
  chmod 600 "$ORCH_DIR/.env"
  awk -v cli="$LARK_CLI_BIN" '/^MSTD_LARK_CLI=/ { print "MSTD_LARK_CLI=" cli; next } { print }' \
    "$ORCH_DIR/.env" > "$ORCH_DIR/.env.tmp" && mv "$ORCH_DIR/.env.tmp" "$ORCH_DIR/.env"
  chmod 600 "$ORCH_DIR/.env"
fi

# —— mstd 命令入口 ——
# 写 wrapper 而不是 symlink：Node 装在安装目录内时，用户 shell 的 PATH 里没有 node，
# wrapper 负责把它接上并注入 MSTD_NODE_BIN（systemd 服务定义也依赖这个绝对路径）。
mkdir -p "$HOME/.local/bin"
{
  printf '#!/usr/bin/env bash\n'
  printf 'if [ -x "%s/node/bin/node" ]; then\n' "$MSTD_HOME"
  printf '  export PATH="%s/node/bin:$PATH" MSTD_NODE_BIN="%s/node/bin/node"\n' "$MSTD_HOME" "$MSTD_HOME"
  printf 'fi\n'
  printf 'exec "%s/bin/mstd" "$@"\n' "$ORCH_DIR"
} > "$HOME/.local/bin/mstd"
chmod +x "$HOME/.local/bin/mstd"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) mstd_hint="mstd" ;;
  *) mstd_hint="$HOME/.local/bin/mstd"; say "提示：~/.local/bin 不在 PATH 里，请把它加进 shell 配置。" ;;
esac

say ""
say "安装完成。剩余步骤需要你手工执行："
say ""
say "1. 配置 lark-cli profile（应用凭证在飞书开放平台后台获取）："
say "   $LARK_CLI_BIN config init --profile mstd-prod --app-id <cli_...> --app-secret-stdin"
say ""
say "2. 编辑 $ORCH_DIR/.env，至少填齐："
say "   DEEPSEEK_KEY / CZ_GPT_KEY、LARK_PROFILE、MSTD_ENABLE_AGENT=1、"
say "   MSTD_BOT_OPEN_ID、MSTD_BOT_NAME、MSTD_SESSION_SECRET"
say "   字段说明与飞书应用侧清单见仓库 README 与 docs/superpowers/runbooks/。"
say ""
say "3. 注册系统服务（开机自启、崩溃拉起）："
say "   $mstd_hint install"
say ""
say "4. 验证：$mstd_hint status；日志：$mstd_hint logs"
