#!/usr/bin/env bash
set -euo pipefail

echo "清理 Claude 应用及相关缓存/配置（危险操作，执行前请确认）"

HOME_DIR="${HOME:-$PWD}"

# 固定要清理的路径（有的可能不存在）
paths=(
  "/Applications/Claude.app"
  "$HOME_DIR/.claude"
  "$HOME_DIR/.claude.json"
  "$HOME_DIR/Library/Application Support/Claude"
  "$HOME_DIR/Library/Caches/com.anthropic.claude"
  "$HOME_DIR/Library/Caches/Claude"
  "$HOME_DIR/Library/Saved Application State/com.anthropic.claude.savedState"
  "$HOME_DIR/Library/Preferences/com.anthropic.claude.plist"
  "$HOME_DIR/Library/Logs/Claude"
)

# 查找 $HOME 下以 .claude.json.backup 开头的所有文件
backup_files=()
if [[ -d "$HOME_DIR" ]]; then
  while IFS= read -r -d '' f; do
    backup_files+=( "$f" )
  done < <(find "$HOME_DIR" -maxdepth 1 -type f -name '.claude.json.backup*' -print0 2>/dev/null || true)
fi

if ((${#backup_files[@]} > 0)); then
  paths+=( "${backup_files[@]}" )
fi

# 去重
paths_uniq=()
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  paths_uniq+=( "$p" )
done < <(printf '%s\n' "${paths[@]}" | sort -u)

paths=( "${paths_uniq[@]}" )

echo "将删除以下路径（若存在）："
for p in "${paths[@]}"; do
  echo "  $p"
done

if ((${#backup_files[@]} == 0)); then
  echo "未发现以 .claude.json.backup 开头的备份文件。"
fi

read -r -p "输入 YES 并回车以继续删除（其他任意内容为取消）: " confirm < /dev/tty
if [[ "$confirm" != "YES" ]]; then
  echo "已取消，不执行任何删除操作。"
  exit 0
fi

echo "开始删除..."

for p in "${paths[@]}"; do
  if [[ -e "$p" ]]; then
    if [[ "$p" == "/Applications/Claude.app" ]]; then
      echo "删除（需要 sudo）：$p"
      sudo rm -rf "$p"
    else
      echo "删除：$p"
      rm -rf "$p"
    fi
  else
    echo "不存在：$p"
  fi
done

echo "清理完成。"
