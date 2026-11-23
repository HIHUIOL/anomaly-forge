#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
#  中转服务.sh
# =============================================================================
#  用途（很简单）：
#      MT 管理器点 .py 文件执行不了，只能执行 .sh。
#      所以这个脚本唯一的职责就是 —— 用 Termux 的 python 环境，
#      跑掉和它同名的那个 .py 文件（中转服务.py）。
#
#  逻辑：
#      1. 找到 Termux 里的 python
#      2. 切到脚本自己所在的目录
#      3. 执行同名 .py
#
#  没有额外参数，没有交互，点开就跑。
# =============================================================================

# ---- 脚本所在目录（从哪点都能找到同目录的 .py）------------------------------
cd "$(dirname "$0")" || exit 1

# ---- 同名 .py ---------------------------------------------------------------
SELF="$(basename "$0")"          # 中转服务.sh
NAME="${SELF%.*}"                # 中转服务
TARGET="$NAME.py"                # 中转服务.py

# ---- 找 Termux 的 python ----------------------------------------------------
#  MT 里执行时 PATH 通常不含 Termux 的 bin，所以显式列候选路径。
TERMUX_PREFIX="/data/data/com.termux/files/usr"
PY=""

for c in \
    "$(command -v python3 2>/dev/null)" \
    "$(command -v python 2>/dev/null)" \
    "$TERMUX_PREFIX/bin/python3" \
    "$TERMUX_PREFIX/bin/python"
do
  if [ -n "$c" ] && [ -x "$c" ]; then
    PY="$c"
    break
  fi
done

# ---- 检查 -------------------------------------------------------------------
if [ -z "$PY" ]; then
  echo "❌ 没找到 python"
  echo
  echo "  这个脚本靠 Termux 的 Python 环境跑。"
  echo "  先在 Termux 里装："
  echo
  echo "      pkg update && pkg install python"
  echo
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "❌ 找不到 $TARGET"
  echo "   （它应该和本脚本放在同一个文件夹里）"
  echo
  exit 1
fi

# ---- 补上 Termux 的环境 -----------------------------------------------------
#  从 MT 启动时，python 可能找不到 Termux 的动态库，显式加进去更稳。
if [ -d "$TERMUX_PREFIX/lib" ]; then
  export LD_LIBRARY_PATH="$TERMUX_PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export PATH="$TERMUX_PREFIX/bin:$PATH"

# ---- 执行 -------------------------------------------------------------------
#  ⚠️ 关键：必须让中转进程【脱离 MT 的会话】
#     早先直接 `exec python` 会让 python 变成 MT 会话的子进程，
#     MT 一退出，Android 就按会话把整组进程清掉 → 中转跟着死。
#     现在用 setsid 新开会话 + nohup 忽略 SIGHUP + 输入重定向到 /dev/null，
#     这样进程彻底独立，MT 关掉照样跑。
#
#  ⚠️ 两个模式：
#     直接点开（没有任何参数）          → 后台启动，立刻返回
#     带参数（--foreground / -f 例外）  → 前台跑，方便看日志

FOREGROUND=0
for a in "$@"; do
  case "$a" in
    -f|--foreground) FOREGROUND=1 ;;
  esac
done

# 去掉 -f/--foreground，避免传给 python 报错
ARGS=()
for a in "$@"; do
  case "$a" in
    -f|--foreground) ;;
    *) ARGS+=("$a") ;;
  esac
done

echo "🐍 $PY"
echo "📄 $TARGET"

if [ "$FOREGROUND" = "1" ]; then
  echo "----------------------------------------------------------"
  echo "（前台模式，Ctrl+C 退出）"
  echo
  exec "$PY" "$TARGET" "${ARGS[@]}"
fi

# ---- 后台模式：脱离会话 ----
echo "----------------------------------------------------------"

# 优先用 setsid（Termux 自带）；没有就退回 nohup
# ⚠️ 输出写到日志文件，出问题能回查（/dev/null 会看不到报错）
LOG="$(pwd)/.relay.log"
: > "$LOG" 2>/dev/null || LOG="/dev/null"

if command -v setsid >/dev/null 2>&1; then
  setsid "$PY" "$TARGET" "${ARGS[@]}" </dev/null >>"$LOG" 2>&1 &
  BGPID=$!
else
  nohup "$PY" "$TARGET" "${ARGS[@]}" </dev/null >>"$LOG" 2>&1 &
  BGPID=$!
fi

# 给它一点时间起来
sleep 2

if kill -0 "$BGPID" 2>/dev/null; then
  echo "✅ 中转已在后台启动（PID $BGPID）"
  echo
  echo "   关闭 MT 管理器【不会】中断它。"
  echo
  echo "   停止方式：再点一次本脚本（会自动关闭）"
  echo "   查看日志：$LOG"
  echo
else
  echo "❌ 进程没能保持运行。日志内容："
  echo "----------------------------------------------------------"
  tail -n 20 "$LOG" 2>/dev/null
  echo "----------------------------------------------------------"
  echo
  echo "   也可以前台跑，直接看报错："
  echo "   bash 中转服务.sh -f"
  echo
  exit 1
fi