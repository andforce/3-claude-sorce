#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BUILD=true
BUILD_ONLY=false
RUNTIME="node"
INSPECT_MODE=""
INSPECT_HOST="${INSPECT_HOST:-127.0.0.1}"
INSPECT_PORT="${INSPECT_PORT:-9229}"
BUN_VERSION="${BUN_VERSION:-1.3.11}"
CLI_ARGS=()
BUN_CMD=()

usage() {
  cat <<'EOF'
用法:
  ./run-dev.sh [选项] [--] [CLI 参数...]

常用:
  ./run-dev.sh -- --version
  ./run-dev.sh --debug -- --version
  ./run-dev.sh --inspect -- -p "hello"
  ./run-dev.sh --no-build -- --help

选项:
  --debug              构建后用 Inspector 启动，并在第一行暂停
  --inspect            构建后用 Inspector 启动，不主动暂停
  --port <端口>        Inspector 端口，默认 9229
  --host <地址>        Inspector 监听地址，默认 127.0.0.1
  --bun                用 Bun 运行 dist/cli.js
  --node               用 Node.js 运行 dist/cli.js（默认）
  --no-build           跳过构建，直接运行已有 dist/cli.js
  --build-only         只构建，不运行
  -h, --help           显示帮助

说明:
  这个项目不能稳定地直接跑 src/entrypoints/cli.tsx，因为 MACRO 常量、
  bun:bundle feature() 和内部包 stub 都是在 build.ts 里注入的。
  因此调试路径是：bun run build.ts -> dist/cli.js + sourcemap -> Inspector。
EOF
}

set_bun_cmd() {
  if [[ -n "${BUN_BIN:-}" ]]; then
    BUN_CMD=("$BUN_BIN")
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    BUN_CMD=("$(command -v bun)")
    return 0
  fi

  for candidate in \
    "$HOME/.bun/bin/bun" \
    "$HOME/.bun/bin/bun-darwin-aarch64/bun" \
    "$HOME/.bun/bin/bun-linux-x64/bun"; do
    if [[ -x "$candidate" ]]; then
      BUN_CMD=("$candidate")
      return 0
    fi
  done

  if command -v npx >/dev/null 2>&1; then
    BUN_CMD=(npx --yes "bun@${BUN_VERSION}")
    return 0
  fi

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug)
      INSPECT_MODE="debug"
      shift
      ;;
    --inspect)
      INSPECT_MODE="inspect"
      shift
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "错误：--port 需要端口号" >&2; exit 1; }
      INSPECT_PORT="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || { echo "错误：--host 需要监听地址" >&2; exit 1; }
      INSPECT_HOST="$2"
      shift 2
      ;;
    --bun)
      RUNTIME="bun"
      shift
      ;;
    --node)
      RUNTIME="node"
      shift
      ;;
    --no-build)
      BUILD=false
      shift
      ;;
    --build-only)
      BUILD_ONLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      CLI_ARGS+=("$@")
      break
      ;;
    *)
      CLI_ARGS+=("$1")
      shift
      ;;
  esac
done

set_bun_cmd || {
  echo "错误：找不到 Bun。请先安装 Bun ${BUN_VERSION}+，或用 BUN_BIN=/path/to/bun 指定。" >&2
  echo "提示：如果已安装 Node.js/npm，本脚本也可通过 npx 自动下载临时 Bun。" >&2
  exit 1
}

if [[ "$BUILD" == true ]]; then
  echo "==> 构建 dist/cli.js"
  "${BUN_CMD[@]}" run build.ts
fi

if [[ "$BUILD_ONLY" == true ]]; then
  exit 0
fi

if [[ ! -f "$ROOT_DIR/dist/cli.js" ]]; then
  echo "错误：dist/cli.js 不存在，请先运行 ./run-dev.sh 或 bun run build.ts。" >&2
  exit 1
fi

echo "==> 运行 dist/cli.js"

if [[ "$RUNTIME" == "bun" ]]; then
  CMD=("${BUN_CMD[@]}")
  case "$INSPECT_MODE" in
    debug) CMD+=("--inspect-brk=${INSPECT_HOST}:${INSPECT_PORT}") ;;
    inspect) CMD+=("--inspect=${INSPECT_HOST}:${INSPECT_PORT}") ;;
  esac
  CMD+=("dist/cli.js")
  if [[ ${#CLI_ARGS[@]} -gt 0 ]]; then
    CMD+=("${CLI_ARGS[@]}")
  fi
else
  if ! command -v node >/dev/null 2>&1; then
    echo "错误：找不到 Node.js。你可以改用 ./run-dev.sh --bun。" >&2
    exit 1
  fi

  CMD=(node --enable-source-maps)
  case "$INSPECT_MODE" in
    debug) CMD+=("--inspect-brk=${INSPECT_HOST}:${INSPECT_PORT}") ;;
    inspect) CMD+=("--inspect=${INSPECT_HOST}:${INSPECT_PORT}") ;;
  esac
  CMD+=("dist/cli.js")
  if [[ ${#CLI_ARGS[@]} -gt 0 ]]; then
    CMD+=("${CLI_ARGS[@]}")
  fi
fi

if [[ -n "$INSPECT_MODE" ]]; then
  echo "==> Inspector: ${INSPECT_HOST}:${INSPECT_PORT}"
fi

exec "${CMD[@]}"
