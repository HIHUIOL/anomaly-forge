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
echo "🐍 $PY"
echo "📄 $TARGET"
echo "----------------------------------------------------------"
exec "$PY" "$TARGET" "$@"