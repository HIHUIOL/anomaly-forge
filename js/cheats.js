/* ============================================================
 * cheats.js —— 🎮 金手指数据表（只放数据，不放逻辑）
 *
 * ⭐ 以后要加新金手指，【只改这个文件】即可，不用动 quest.js / app.js。
 *
 * 字段说明：
 *   id      : 唯一标识（英文，程序内部用，别重复）
 *   name    : 面板上显示的大标题
 *   desc    : 面板上显示的说明
 *   type    : 类型
 *             'toggle' = 一个开关按钮（开 / 关）—— 改游戏代码
 *             'modes'  = 一排模式按钮（多选一）—— 改游戏代码
 *             'watch'  = 数值锁定（锁定 / 解除）—— 用 sys-botbase 的 freeze 反复写
 *
 *   ---- toggle / modes 用 ----
 *   items   : 要改的内存位置列表
 *             off     : 【相对 main NSO 的偏移】（用 peekMain / pokeMain 读写）
 *             orig    : 原始指令（用于"关闭/还原"）
 *             patched : toggle 类型：开启时要写的值
 *             note    : （可选）面板上显示的注释，比如反汇编含义
 *   modes   : （type='modes' 时用）模式列表
 *             key     : 模式标识（程序内部用）
 *             label   : 按钮文字
 *             value   : 该模式要写的指令值
 *             note    : （可选）注释
 *
 *   ---- watch（数值锁定）用 ----
 *   value   : 锁定的数值（每次 freeze 都写这个值）
 *   size    : 字节数（1 / 2 / 4 / 8）
 *   route   : 指针链（数组）。元素可以是：
 *               'main:0x12B157C0'  = 读 [mainBase + 0x12B157C0] 得到指针
 *               0x58               = 读 [上一个指针 + 0x58] 得到新指针
 *             最后一跳之后，再加 final 偏移 → 就是目标地址
 *   final   : 最后一跳之后的偏移（得到实际数据的地址）
 *
 * ⚠️ 地址必须是【相对 main NSO】的偏移（就是第 3 个 hex 串的值）
 *     - `04070000 xxxxxxxx yyyyyyyy` → off = 0xxxxxxx
 *     - `040B0000 xxxxxxxx yyyyyyyy` → off = 0xxxxxxx（也是 main）
 *
 * ⚠️ 指令值 = 第 4 个 hex 串按【小端】写。
 *     例如 `F940E428` → 内存字节 = 28 E4 40 F9
 * ============================================================ */

var CHEATS = [

  /* ---------------- 1. 任务直接完成 ---------------- */
  {
    id: 'missionDone',
    name: '任务直接完成',
    desc: '把「任务完成判定」函数改成 无条件返回 true',
    type: 'toggle',
    items: [
      {
        off: 0x0376A160,
        orig: 0xF940E428,       // ldr x8, [x1, #0x1C8]
        patched: 0x52800020,    // mov w0, #1
        note: 'ldr x8,[x1,#0x1C8]  →  mov w0,#1'
      },
      {
        off: 0x0376A164,
        orig: 0xF9401109,       // ldr x9, [x8, #0x20]
        patched: 0xD65F03C0,    // ret
        note: 'ldr x9,[x8,#0x20]  →  ret'
      }
    ]
  },

  /* ---------------- 2. 任务倒计时 ---------------- */
  {
    id: 'timer',
    name: '任务倒计时',
    desc: '改「时间递减」那条乘法指令（fmul s0, s0, s1）',
    type: 'modes',
    items: [
      {
        off: 0x03765258,
        orig: 0x1E213800,       // fmul s0, s0, s1（正常递减）
        note: '正常 = fmul s0,s0,s1'
      }
    ],
    modes: [
      {
        key: 'normal',
        label: '🔄 正常',
        value: 0x1E213800,      // fmul s0, s0, s1
        note: '时间正常流逝'
      },
      {
        key: 'freeze',
        label: '🧊 冻结',
        value: 0x1E204000,      // fmov s0, s0
        note: '时间不动'
      },
      {
        key: 'fast',
        label: '⏩ 加速',
        value: 0x1E203800,      // fmul s0, s0, s0
        note: '时间平方递减（更快归零）'
      }
    ]
  },

  /* ---------------- 3. 金钱锁定（数值锁定） ----------------
   *
   * 原始金手指：
   *   580F0000 12B157C0     reg0 = [main + 0x12B157C0]
   *   580F1000 00000058     reg0 = [reg0 + 0x58]
   *   780F0000 00000018     reg0 = reg0 + 0x18
   *   640F0000 ... 05F5E0FF [reg0] = 99999999
   * -------------------------------------------------------- */
  {
    id: 'money',
    name: '金钱锁定',
    desc: '锁定金钱 = 99999999',
    type: 'watch',
    value: 99999999,
    size: 4,
    route: ['main:0x12B157C0', 0x58],
    final: 0x18
  }

  /* ---------------- 4. 以后加新金手指就写在这里 ----------------
   *
   * 例子（一键写入固定值，没有开关）：
   * {
   *   id: 'infItem',
   *   name: '无限道具',
   *   desc: '把道具数量写成 99',
   *   type: 'toggle',
   *   items: [ { off: 0x00ABCDEF, orig: 0x........, patched: 0x........ } ]
   * }
   *
   * 例子（多模式）：
   * {
   *   id: 'speed',
   *   name: '移动速度',
   *   desc: '改移动速度系数',
   *   type: 'modes',
   *   items: [ { off: 0x00ABCDEF, orig: 0x........ } ],
   *   modes: [
   *     { key: 'x1', label: '1倍', value: 0x........ },
   *     { key: 'x2', label: '2倍', value: 0x........ }
   *   ]
   * }
   *
   * ------------------------------------------------------------ */
];

// 兼容：提供"按 id 查找"的辅助（quest.js 用）
var CHEATS_BY_ID = {};
(function () {
  for (var i = 0; i < CHEATS.length; i++) CHEATS_BY_ID[CHEATS[i].id] = CHEATS[i];
})();