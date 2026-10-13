/* ============================================================
 * app.js —— 界面逻辑（渲染、编辑、选择器、批量）
 * 依赖：data.js / bridge.js / memory.js / quest.js
 * ============================================================ */

var $ = function (id) { return document.getElementById(id); };
var ALL = [];      // 已读取的任务
var VISIBLE = [];  // 当前列表（经筛选/搜索/排序后，给"批量改"用）
var BASE = null;   // 任务数组基址（缓存）

// ---------- 弹窗开关（锁定/恢复背景滚动，避免"关掉弹窗后列表位置变了"）----------
var _bodyLocked = false;    // 是否已锁定（用独立标志，不能用 0 当哨兵！）
var _bodyScrollY = 0;
function lockBodyScroll() {
  if (_bodyLocked) return;   // 已经锁过
  _bodyScrollY = window.scrollY || window.pageYOffset || 0;
  _bodyLocked = true;
  document.body.style.position = 'fixed';
  document.body.style.top = (-_bodyScrollY) + 'px';
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
}
function unlockBodyScroll() {
  if (!_bodyLocked) return;   // 没锁过 → 什么都不做
  _bodyLocked = false;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  window.scrollTo(0, _bodyScrollY);
}

/** 显示遮罩弹窗（自动锁定背景滚动）*/
function showOverlay() {
  $('overlay').classList.add('show');
  _overlayCloseHook = null;     // 每次开新面板，先清掉上一次的关闭钩子
  lockBodyScroll();
}
/** 关闭遮罩弹窗（自动恢复背景滚动位置 + 解除忙碌锁）
 *  ⚠️ 这里必须一起解除 _busy，否则"点遮罩外面关闭"会让所有按钮永久变灰
 */
function hideOverlay() {
  $('overlay').classList.remove('show');
  unlockBodyScroll();
  if (_busy) setBusy(false);
}
/** 兜底：如果遮罩已隐藏但 body 还锁着，强制解锁（防卡死）*/
function ensureUnlocked() {
  var ov = $('overlay');
  if (ov && !ov.classList.contains('show')) {
    unlockBodyScroll();
    if (_busy) setBusy(false);
  }
}

// 当前面板的"关闭钩子"（比如截图面板要 revoke Blob URL）
var _overlayCloseHook = null;
/** 统一关闭入口：点"取消/关闭"按钮 or 点遮罩外面，都走这里 */
function closeOverlay() {
  var hook = _overlayCloseHook;
  _overlayCloseHook = null;
  hideOverlay();
  if (typeof hook === 'function') { try { hook(); } catch (e) { /* 钩子出错不影响关闭 */ } }
}

// ---------- 输入框限制（按字段字节数）----------
// size=4 → 有符号 int32: -2147483648 ~ 2147483647
// size=1 → 有符号 int8 : -128 ~ 127
function fieldMax(f) {
  return (f && f.size === 1) ? 127 : 2147483647;
}
/** 生成 input 的公共属性（有符号上下限 + 只能整数）*/
function numAttrs(f) {
  return ' type="number" min="' + fieldMin(f) + '" max="' + fieldMax(f) + '" step="1"'
       + ' inputmode="numeric" oninput="clampInput(this)"';
}
/** 输入时把值夹到 [min, max] */
function clampInput(el) {
  if (el.value === '') return;
  var v = parseInt(el.value, 10);
  if (isNaN(v)) { el.value = ''; return; }
  var lo = parseInt(el.min, 10), hi = parseInt(el.max, 10);
  if (!isNaN(lo) && v < lo) v = lo;
  if (!isNaN(hi) && v > hi) v = hi;
  if (String(v) !== el.value) el.value = v;
}

/** 让一个输入框"闪一下"（用于联动反馈） */
function flashEl(el) {
  if (!el) return;
  el.classList.add('flash');
  setTimeout(function () { el.classList.remove('flash'); }, 700);
}
/** 取字段值并夹到该字段的合法范围（写入前的最后一道防线）——返回【无符号位模式】*/
function clampFieldVal(f, raw) {
  var v = parseInt(raw, 10);
  if (isNaN(v)) v = 0;
  var lo = fieldMin(f), hi = fieldMax(f);
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return toUnsigned(v, f && f.size);   // 转为无符号位模式，供写入
}

// ---------- 有符号 / 无符号转换 ----------
// 内存里按"位模式"存储（补码），显示与输入按"有符号"解释。
// 业务判断（如空槽 === 0xFFFFFFFF）仍然用无符号，避免失效。
/** 无符号位模式 → 有符号数（用于显示）*/
function toSigned(u, size) {
  u = (u >>> 0);
  if (size === 1) return (u & 0xFF) << 24 >> 24;              // int8
  return (u & 0xFFFFFFFF) | 0;                                // int32（JS 位运算天然 32 位有符号）
}
/** 有符号数 → 无符号位模式（用于写入）*/
function toUnsigned(v, size) {
  v = parseInt(v, 10) || 0;
  if (size === 1) return (v & 0xFF) >>> 0;
  return (v >>> 0);
}
/** 字段的最小子值（有符号）*/
function fieldMin(f) { return (f && f.size === 1) ? -128 : -2147483648; }

function toast(msg, ms) {
  ms = ms || 2400;
  var t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, ms);
}
function setDot(cls, text) { $('dot').className = 'dot ' + (cls || ''); $('stat').textContent = text; }

/** 更新按钮进度文本 */
function busy(btn, on, text) {
  if (on) { btn.disabled = true; btn._t = btn.textContent; btn.textContent = text; }
  else { btn.disabled = false; if (btn._t) btn.textContent = btn._t; }
}

// ---------- 加载 ----------

var _busy = false;   // 全局忙碌锁：读取/写入期间禁止重复操作

/** 禁用/启用一组按钮 */
function setBusy(on) {
  _busy = on;
  var ids = ['reload', 'addBtn', 'batch', 'exportBtn', 'openBtn', 'writeBackBtn', 'cfgBtn', 'shotBtn', 'swapBtn', 'cheatBtn'];
  for (var i = 0; i < ids.length; i++) {
    var b = $(ids[i]);
    if (b) b.disabled = on;
  }
}

/** 在线加载：从 Switch 读 200 槽 */
async function load() {
  if (_busy) return;          // ← 防止重复点击
  setBusy(true);
  setDot('', '读取中…');
  $('loading').style.display = 'none';
  $('list').innerHTML = '';
  var pb = $('progressbar');

  // ---- 注入「取消」按钮（只在本函数内用，不改 index.html）----
  var cancelBtn = document.getElementById('loadCancelBtn');
  if (!cancelBtn) {
    cancelBtn = document.createElement('button');
    cancelBtn.id = 'loadCancelBtn';
    cancelBtn.textContent = '✖ 取消';
    cancelBtn.style.cssText =
      'position:absolute;right:12px;top:6px;padding:5px 12px;font-size:12px;' +
      'border-radius:8px;border:1px solid #f85149;background:#2d1618;' +
      'color:#f85149;cursor:pointer;font-weight:600;z-index:1';
    pb.appendChild(cancelBtn);
  }
  cancelBtn.style.display = 'inline-block';
  cancelBtn.disabled = false;

  // 开始可取消操作（后续所有请求共用这个 signal）
  Bridge.beginCancelable();
  var _cancelled = false;
  cancelBtn.onclick = function () {
    _cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = '取消中…';
    pb.querySelector('.pbar-txt').textContent = '正在取消…';
    Bridge.cancel();          // abort 掉进行中的请求 → 循环快速退出
  };

  pb.classList.add('show');
  pb.querySelector('.pbar-txt').textContent = '定位任务数组…';
  pb.querySelector('.pbar-fill').style.width = '0%';
  try {
    var st = await Bridge.status();
    if (!st.connected) { setDot('err', 'Switch 未连接'); }
    Mem.resetCache();

    await Store.loadFromSwitch(function (cur, total) {
      if (_cancelled) return;
      var pct = Math.round(cur / total * 100);
      pb.querySelector('.pbar-txt').textContent = '读取中 ' + cur + '/' + total +
        '（' + pct + '%，约剩 ' + Math.round((total - cur) * 0.11) + ' 秒）';
      pb.querySelector('.pbar-fill').style.width = pct + '%';
    });
    if (_cancelled) throw new Error('已取消');
    BASE = await Quest.questBase();
    ALL = Store.validTasks();
    setDot('ok', ALL.length + ' 个任务 · ' + st.ip + ':' + st.port);
    pb.classList.remove('show');
    updateModeTag();
    updateSeqStat();
    render();
  } catch (e) {
    pb.classList.remove('show');
    if (_cancelled) {
      // 用户主动取消：不报错，回到"待连接"的友好界面
      setDot('', '已取消');
      $('loading').style.display = 'block';
      $('loading').innerHTML = '⏹️ 已取消读取<br><br>' +
        '<button onclick="load()">🔄 重新读取</button>　' +
        '<button onclick="cfgAddr()">⚙️ 修改中转地址</button><br><br>' +
        '👉 或者点「📥 打开文件」，离线编辑任务文件（不需要 NS）';
    } else {
      setDot('err', '未连接中转');
      $('loading').style.display = 'block';
      $('loading').innerHTML = '❌ 连不上中转<br><br>' +
        '当前地址：<b>' + Bridge.getBase() + '</b><br>' +
        '错误：' + e.message + '<br><br>' +
        '<button onclick="load()">🔄 重试</button>　' +
        '<button onclick="cfgAddr()">⚙️ 修改中转地址</button><br><br>' +
        '👉 或者点「📥 打开文件」，离线编辑任务文件（不需要 NS）';
    }
  } finally {
    Bridge.endCancelable();   // 清除取消态（后续正常操作不受影响）
    cancelBtn.style.display = 'none';
    setBusy(false);           // ← 无论如何都解锁
  }
}

/** 从"数据源"刷新界面（不读内存）——用于文件模式 */
function refreshFromStore() {
  ALL = Store.validTasks();
  if (Store.getMode() === 'online') {
    // 在线模式基址已存在
  } else {
    BASE = null;   // 文件模式没有真实基址
  }
  updateModeTag();
  updateSeqStat();
  render();
}

/** 更新顶部"序号计数器"显示 */
function updateSeqStat() {
  var el = $('seqStat');
  if (!el) return;
  var v = Store.getSeqCounter();
  if (v === null || v === undefined) {
    el.textContent = '🔢 —';
    el.style.color = '#888';
    el.title = '序号计数器：未知（读一下 Switch 或打开带它的文件）';
  } else {
    el.textContent = '🔢 ' + v;
    el.style.color = '#58a6ff';
    el.title = '序号计数器 = ' + v + '（游戏获得新怪异任务时会取用此值作为任务序号）\n点击修改';
  }
}

/** 点击顶部"序号计数器" → 修改 */
async function editSeqCounter() {
  if (_busy) return;
  var cur = Store.getSeqCounter();
  var s = prompt('修改「序号计数器」\n\n= 游戏在【获得新的怪异任务】时会取用的序号（取走后自己+1）\n\n当前值：' + (cur === null || cur === undefined ? '未知' : cur) + '\n\n输入新值（十进制）：', cur === null || cur === undefined ? '' : String(cur));
  if (s === null) return;                 // 取消
  s = s.trim();
  if (!/^\d+$/.test(s)) { toast('❌ 请输入非负整数', 3000); return; }
  var v = parseInt(s, 10) >>> 0;

  // 在线模式：直接写进 Switch
  if (Store.getMode() === 'online') {
    setBusy(true);
    try {
      var ok = await Quest.writeSeqCounter(v);
      Store.setSeqCounter(v);
      updateSeqStat();
      toast(ok ? ('✅ 序号计数器已设为 ' + v) : '⚠️ 写入后校验不一致，请检查', ok ? 2500 : 4000);
    } catch (e) {
      toast('❌ 写入失败：' + e.message, 4000);
    } finally { setBusy(false); }
  } else {
    // 文件模式：只改本地（导出时会带上）
    Store.setSeqCounter(v);
    updateSeqStat();
    toast('📄 已改（文件模式，导出时带上）', 3000);
  }
}

/** 顶部状态：在线/文件 */
function updateModeTag() {
  var el = $('modeTag');
  if (!el) return;
  if (Store.getMode() === 'file') {
    el.textContent = '📄 文件编辑模式';
    el.style.color = '#d29922';
    el.title = Store.getSource();
  } else if (Store.getMode() === 'online') {
    el.textContent = '';
    el.style.color = '';
  } else {
    el.textContent = '';
  }
}

/** 打开一个导出的 JSON 文件（离线编辑） */
function openDataFile() {
  var inp = $('importFile');
  inp.value = '';
  inp.onchange = function () {
    var f = inp.files && inp.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var d;
      try { d = JSON.parse(reader.result); }
      catch (e) { toast('❌ 不是有效的 JSON：' + e.message, 5000); return; }
      if (!Store.loadFile(d, f.name)) { toast('❌ 文件里没有任务数据', 4500); return; }
      refreshFromStore();
      var st = Store.getSlots();
      toast('📄 已打开文件：' + f.name + '（' + ALL.length + ' 个任务）', 3500);
    };
    reader.onerror = function () { toast('❌ 读取文件失败', 4000); };
    reader.readAsText(f);
  };
  inp.click();
}

// ---------- 列表渲染 ----------

function typeLabel(t) {
  var n = Quest.enumName('任务类型', t);
  if (t === 1) return '<span class="ty hunt">' + (n || '狩猎') + '</span>';
  if (t === 2) return '<span class="ty slay">' + (n || '讨伐') + '</span>';
  return '<span class="ty other">' + t + '</span>';
}

// 列表里的怪物标签
//  - 第一个怪：突出（.primary）
//  - 目标数量决定"主要怪"个数，其余主要怪稍微突出（.secondary）
//  - 乱入怪：.inv
//  - 列表不显示怪物级别
function monChip(m) {
  var extra = '';
  if (m.name.indexOf('乱入') === 0) extra = 'inv';
  else if (m.pos === 0) extra = 'primary';
  else if (m.pos > 0 && m.pos < m.target) extra = 'secondary';
  return '<span class="mon ' + extra + '">' + m.name + '</span>';
}

// ---------- 筛选 ----------
// 多选组合：状态 / 等级区间 / 怪异★区间 / 地图 / 怪物 / 目标数量
// 只有被明确"选中"的项目才参与筛选；空 = 不筛该项。
var FILTER = {
  status: {},        // 键: lock | new | sprClear | sprAllow | sprNew
  levelMin: null, levelMax: null,
  weirdMin: null, weirdMax: null,
  maps: {},          // 键: 地图ID
  mons: {},          // 键: 怪物ID
  targets: {}        // 键: 目标数量
};

var FILTER_STATUS = [
  { key: 'lock',     label: '🔒 锁定' },
  { key: 'new',      label: '❗ 新任务' },
  { key: 'sprClear', label: '✔ 超特通关' },
  { key: 'sprAllow', label: '✦ 超特许可' },
  { key: 'sprNew',   label: '✦ 超特新' }
];

/** 该任务是否满足某个状态 */
function questHasStatus(q, key) {
  if (key === 'lock')     return !!q['锁定'];
  if (key === 'new')      return !!q['叹号'];
  if (key === 'sprClear') return !!q['超特通过'];
  if (key === 'sprAllow') return !!q['超特许可'];
  if (key === 'sprNew')   return !!q['超特叹号'];
  return false;
}

/** 筛选是否处于"激活"状态（有任何条件） */
function filterActive() {
  return Object.keys(FILTER.status).length > 0
    || Object.keys(FILTER.maps).length > 0
    || Object.keys(FILTER.mons).length > 0
    || Object.keys(FILTER.targets).length > 0
    || FILTER.levelMin !== null || FILTER.levelMax !== null
    || FILTER.weirdMin !== null || FILTER.weirdMax !== null;
}

/** 单个任务是否通过筛选 */
function passFilter(q) {
  // 状态：选中的状态必须【全部满足】（AND）
  var stKeys = Object.keys(FILTER.status);
  for (var i = 0; i < stKeys.length; i++) {
    if (!questHasStatus(q, stKeys[i])) return false;
  }
  // 目标数量：选中之一即可（OR）
  var tKeys = Object.keys(FILTER.targets);
  if (tKeys.length) {
    if (tKeys.indexOf(String(q['目标数量'])) < 0) return false;
  }
  // 地图：选中之一即可（OR）
  var mKeys = Object.keys(FILTER.maps);
  if (mKeys.length) {
    if (mKeys.indexOf(String(q['地图'])) < 0) return false;
  }
  // 怪物：任务里含任一选中怪即可（OR）
  var mnKeys = Object.keys(FILTER.mons);
  if (mnKeys.length) {
    var mine = Quest.monsterList(q).map(function (m) {
      return { id: m.id, inv: m.inv };
    });
    var hit = false;
    for (var j = 0; j < mnKeys.length; j++) {
      var key = mnKeys[j];                    // 可能是 "12" 或 "inv:45"
      if (key.indexOf('inv:') === 0) {
        var iid = parseInt(key.slice(4), 10);
        for (var a = 0; a < mine.length; a++) if (mine[a].inv && mine[a].id === iid) { hit = true; break; }
      } else {
        var mid = parseInt(key, 10);
        for (var b = 0; b < mine.length; b++) if (!mine[b].inv && mine[b].id === mid) { hit = true; break; }
      }
      if (hit) break;
    }
    if (!hit) return false;
  }
  // 等级区间
  var lv = toSigned(q['等级'], 4);
  if (FILTER.levelMin !== null && lv < FILTER.levelMin) return false;
  if (FILTER.levelMax !== null && lv > FILTER.levelMax) return false;
  // 怪异★（怪1级 + 1）
  var wd = toSigned(q['怪1级'], 4) + 1;
  if (FILTER.weirdMin !== null && wd < FILTER.weirdMin) return false;
  if (FILTER.weirdMax !== null && wd > FILTER.weirdMax) return false;
  return true;
}

/** 打开筛选面板 */
function openFilter() {
  // ---- 统计可选值（从当前全部任务里收集）----
  var mapSet = {}, monSet = {}, invSet = {}, tgtSet = {}, lvMin = null, lvMax = null, wdMin = null, wdMax = null;
  ALL.forEach(function (q) {
    var mid = q['地图']; if (mid) mapSet[mid] = true;
    var t = q['目标数量']; if (t) tgtSet[t] = true;
    Quest.monsterList(q).forEach(function (m) {
      if (m.inv) invSet[m.id] = true; else monSet[m.id] = true;
    });
    var lv = toSigned(q['等级'], 4);
    if (lvMin === null || lv < lvMin) lvMin = lv;
    if (lvMax === null || lv > lvMax) lvMax = lv;
    var wd = toSigned(q['怪1级'], 4) + 1;
    if (wdMin === null || wd < wdMin) wdMin = wd;
    if (wdMax === null || wd > wdMax) wdMax = wd;
  });

  function chk(group, key, label, checked) {
    return '<label class="fchip"><input type="checkbox" data-fg="' + group + '" data-fk="' + key + '"'
      + (checked ? ' checked' : '') + ' /><span>' + label + '</span></label>';
  }
  function num(group, key, label, val) {
    return '<label class="fnum"><span>' + label + '</span>'
      + '<input type="number" inputmode="numeric" data-fg="' + group + '" data-fk="' + key + '" value="'
      + (val === null ? '' : val) + '" placeholder="—" /></label>';
  }

  // 状态
  var stHtml = FILTER_STATUS.map(function (s) {
    return chk('status', s.key, s.label, !!FILTER.status[s.key]);
  }).join('');

  // 目标数量
  var tgtKeys = Object.keys(tgtSet).map(Number).sort(function (a, b) { return a - b; });
  var tgtHtml = tgtKeys.length
    ? tgtKeys.map(function (t) { return chk('targets', t, Quest.enumName('目标数量', t) || (t + '只'), !!FILTER.targets[t]); }).join('')
    : '<span class="sub">（暂无数据）</span>';

  // 地图
  var mapKeys = Object.keys(mapSet).map(Number).sort(function (a, b) { return a - b; });
  var mapHtml = mapKeys.length
    ? mapKeys.map(function (m) { return chk('maps', m, Quest.mapName(m), !!FILTER.maps[m]); }).join('')
    : '<span class="sub">（暂无数据）</span>';

  // 怪物（普通怪）
  var monKeys = Object.keys(monSet).map(Number).sort(function (a, b) { return a - b; });
  var monHtml = monKeys.length
    ? monKeys.map(function (m) { return chk('mons', m, Quest.monName(m), !!FILTER.mons[m]); }).join('')
    : '<span class="sub">（暂无数据）</span>';

  // 乱入怪
  var invKeys = Object.keys(invSet).map(Number).sort(function (a, b) { return a - b; });
  var invHtml = invKeys.length
    ? invKeys.map(function (m) { return chk('mons', 'inv:' + m, Quest.monName(m) + '（乱入）', !!FILTER.mons['inv:' + m]); }).join('')
    : '<span class="sub">（暂无）</span>';

  $('sheet').innerHTML =
    '<h2>🔎 筛选任务</h2>' +
    '<div class="sub">勾选即生效（多选）；留空的区域不参与筛选</div>' +

    '<div class="sec">状态</div>' +
    '<div class="fchips">' + stHtml + '</div>' +

    '<div class="sec">目标数量</div>' +
    '<div class="fchips">' + tgtHtml + '</div>' +

    '<div class="sec">等级 / 怪异★ 区间</div>' +
    '<div class="fchips">' +
      num('level', 'min', '等级 ≥', FILTER.levelMin) +
      num('level', 'max', '等级 ≤', FILTER.levelMax) +
      num('weird', 'min', '怪异★ ≥', FILTER.weirdMin) +
      num('weird', 'max', '怪异★ ≤', FILTER.weirdMax) +
    '</div>' +
    '<div class="hint">当前数据范围：等级 ' + (lvMin === null ? '—' : lvMin) + '~' + (lvMax === null ? '—' : lvMax) +
      ' · 怪异★ ' + (wdMin === null ? '—' : wdMin) + '~' + (wdMax === null ? '—' : wdMax) + '</div>' +

    '<div class="sec">地图</div>' +
    '<div class="fchips">' + mapHtml + '</div>' +

    '<div class="sec">怪物</div>' +
    '<div class="fchips">' + monHtml + '</div>' +

    (invKeys.length ? '<div class="sec">乱入怪</div><div class="fchips">' + invHtml + '</div>' : '') +

    '<div class="sheet-actions">' +
    '<button id="fApply" style="width:100%">✅ 应用筛选</button>' +
    '<button class="ghost" id="fClear" style="margin-top:8px;width:100%">🧹 清空条件</button>' +
    '<button class="ghost" id="fCancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();

  $('fCancel').onclick = function () { hideOverlay(); };
  $('fClear').onclick = function () {
    $('sheet').querySelectorAll('[data-fg]').forEach(function (el) {
      if (el.type === 'checkbox') el.checked = false; else el.value = '';
    });
  };
  $('fApply').onclick = function () {
    // 重置
    FILTER.status = {}; FILTER.maps = {}; FILTER.mons = {}; FILTER.targets = {};
    FILTER.levelMin = FILTER.levelMax = FILTER.weirdMin = FILTER.weirdMax = null;
    // 收集勾选
    $('sheet').querySelectorAll('[data-fg]').forEach(function (el) {
      var g = el.dataset.fg, k = el.dataset.fk;
      if (el.type === 'checkbox') {
        if (!el.checked) return;
        if (g === 'status') FILTER.status[k] = true;
        else if (g === 'maps') FILTER.maps[k] = true;
        else if (g === 'mons') FILTER.mons[k] = true;
        else if (g === 'targets') FILTER.targets[k] = true;
      } else {
        var v = el.value.trim();
        var n = v === '' ? null : parseInt(v, 10);
        if (isNaN(n)) n = null;
        if (g === 'level' && k === 'min') FILTER.levelMin = n;
        else if (g === 'level' && k === 'max') FILTER.levelMax = n;
        else if (g === 'weird' && k === 'min') FILTER.weirdMin = n;
        else if (g === 'weird' && k === 'max') FILTER.weirdMax = n;
      }
    });
    hideOverlay();
    updateFilterDot();
    render();
    toast(filterActive() ? '🔎 已应用筛选' : '已清空筛选', 2000);
  };
}

/** 更新工具栏"筛选"按钮上的小圆点（有筛选时提示） */
function updateFilterDot() {
  var d = $('filterDot');
  if (d) d.style.display = filterActive() ? 'inline' : 'none';
}

function render() {
  var kw = $('search').value.trim().toLowerCase();
  var arr = ALL.slice();
  // 先过"筛选面板"的条件
  if (filterActive()) arr = arr.filter(passFilter);
  if (kw) {
    arr = arr.filter(function (q) {
      var hay = [String(q['编号']), Quest.mapName(q['地图'])]
        .concat(Quest.monsterList(q).map(function (m) { return m.name; }))
        .join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }
  var parts = $('sort').value.split('-');
  var dir = parts[1] === 'desc' ? -1 : 1;
  var field = parts[0];
  // 排序也按"有符号"比较（序号/编号/index 均为正数，行为不变；负数会正确排在前）
  arr.sort(function (a, b) {
    var va = (field === 'index') ? a.index : toSigned(a[field], 4);
    var vb = (field === 'index') ? b.index : toSigned(b[field], 4);
    return (va - vb) * dir;
  });

  VISIBLE = arr;   // 记下"当前列表"（筛选+搜索+排序后的结果），供批量改使用

  $('list').innerHTML = arr.map(function (q) {
    var tags = [];
    if (q['锁定']) tags.push('<span class="tag lock">🔒锁定</span>');
    if (q['叹号']) tags.push('<span class="tag new">❗新</span>');
    if (q['超特通过']) tags.push('<span class="tag spc">✔超特通关</span>');
    if (q['超特许可']) tags.push('<span class="tag sp">✦超特许可</span>');
    if (q['超特叹号']) tags.push('<span class="tag sp">✦超特新</span>');

    // 怪物列表（带位置/目标数量，供突出用）
    var mons = Quest.monsterList(q).map(function (m) { return m; });
    var target = q['目标数量'] || 1;
    mons.forEach(function (m, i) { m.pos = i; m.target = target; });
    var monsHtml = mons.map(monChip).join('') || '<span class="mon">无怪</span>';

    // 怪异等级 = 怪物1级 + 1
    // 卡片上的数值统一按"有符号"显示（4 字节字段）
    var sGrade = toSigned(q['等级'], 4);
    var sTime  = toSigned(q['时间限制'], 4);
    var sCart  = toSigned(q['猫车'], 4);
    var sPlayers = toSigned(q['人数'], 4);
    var sLv1   = toSigned(q['怪1级'], 4);
    var weird = sLv1 + 1;
    // 有符号显示（正值不变；0xFFFFFFFF 会显示成 -1，符合有符号观感）
    var sNo = toSigned(q['编号'], 4), sSeq = toSigned(q['序号'], 4);

    return '<div class="q" data-idx="' + q.index + '">' +
      '<button class="del" data-del="' + q.index + '" title="删除此任务">🗑️</button>' +
      '<div class="top"><span class="no">#' + sNo + '</span>' +
      '<span class="idx">序号 ' + sSeq + ' · 第' + (q.index + 1) + '个</span>' +
      '<span class="lv">怪异 ' + weird + '★</span></div>' +
      '<div class="map">🗺️ ' + Quest.mapName(q['地图']) + ' · Lv' + sGrade +
        ' · ' + sTime + '分 · 猫车' + sCart + ' · ' + sPlayers + '人</div>' +
      '<div class="mons">' + monsHtml + '</div>' +
      (tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '') +
      '</div>';
  }).join('') || '<div class="loading">没有匹配的任务</div>';
}

// ---------- 单任务编辑 ----------

var _curIdx = null;
var _fieldVals = {};      // 单任务面板：所有字段的"当前值"缓存
var _addFieldVals = {};   // 添加任务面板：同上

// ===== 简洁模式（只显示核心字段）=====
var SIMPLE_KEY = 'af.simpleMode';
// 简洁模式"只显示"这些字段（等级等仍会联动/仍会写入，只是不显示）
var SIMPLE_FIELDS = [
  '目标数量',
  '怪1ID', '怪2ID', '怪3ID', '怪4ID', '怪5ID', '乱入ID',
  '地图', '时间限制', '猫车', '人数'
];
function isSimpleMode() { return localStorage.getItem(SIMPLE_KEY) === '1'; }
function setSimpleMode(on) { localStorage.setItem(SIMPLE_KEY, on ? '1' : '0'); }
function toggleSimpleMode() {
  setSimpleMode(!isSimpleMode());
  toast(isSimpleMode() ? '✅ 简洁模式已开' : '✅ 完整模式已开', 2000);
  if (_curIdx !== null) openQuest(_curIdx);   // 立即重绘当前面板
}

async function openQuest(idx) {
  var q;
  try {
    if (Store.getMode() === 'file') {
      // 文件模式：从本地数据取
      var slot = Store.getSlot(idx);
      if (!slot) { toast('该槽不存在'); return; }
      q = Store.rawToFields(slot.raw);
      q.index = idx;
      q.addr = (idx * STRUCT.TASK_SIZE).toString(16).toUpperCase();
    } else {
      if (!BASE) BASE = await Quest.questBase();
      q = await Quest.getQuest(BASE, idx);
    }
  } catch (e) { toast('读取失败: ' + e.message); return; }
  if (!q) { toast('任务不存在'); return; }
  _curIdx = idx;

  // 字段值缓存：所有字段的"当前显示值（有符号）"
  // 用途：简洁模式下"隐藏字段"没有输入框，但仍要参与联动/写入
  _fieldVals = {};
  FIELDS.forEach(function (f) {
    var raw = q[f.name] !== undefined ? q[f.name] : 0;
    _fieldVals[f.name] = (f.size === 4 || f.size === 1) ? toSigned(raw, f.size) : raw;
  });

  var simple = isSimpleMode();
  var rows = FIELDS.filter(function (f) {
    if (!simple) return true;
    return SIMPLE_FIELDS.indexOf(f.name) >= 0;
  }).map(function (f) {
    var v = q[f.name] !== undefined ? q[f.name] : 0;   // 无符号位模式（用于查表）
    var disp = _fieldVals[f.name];                     // 有符号（用于显示）
    var btn = '', nm = '';
    if (f.kind === 'mon') {
      btn = '<button class="pick" data-pick="mon" data-field="' + f.name + '">📋</button>';
      nm = '<span class="nm" id="nm-' + f.name + '">' + (v ? Quest.monName(v) : '') + '</span>';
    } else if (f.kind === 'map') {
      btn = '<button class="pick" data-pick="map" data-field="' + f.name + '">📋</button>';
      nm = '<span class="nm" id="nm-' + f.name + '">' + (v ? Quest.mapName(v) : '') + '</span>';
    } else if (f.kind === 'enum') {
      btn = '<button class="pick" data-pick="enum" data-enumkey="' + f.enum + '" data-field="' + f.name + '">📋</button>';
      nm = '<span class="hintv" id="nm-' + f.name + '">' + Quest.enumName(f.enum, v) + '</span>';
    } else {
      nm = '<span class="hintv" id="nm-' + f.name + '">' + (f.hint || '') + '</span>';
    }
    return '<div class="frow f"><label>' + f.name + '</label>' +
      '<input data-field="' + f.name + '" value="' + disp + '"' + numAttrs(f) + ' />' +
      (btn || '<span class="nobtn"></span>') + nm + '</div>';
  }).join('');

  $('sheet').innerHTML =
    '<h2>任务 #' + q['编号'] + '</h2>' +
    '<div class="sub">第 ' + (q.index + 1) + ' 个 · 地址 ' + q.addr + '</div>' +
    '<div class="sec">字段（均显示原始值，可直接改）' +
      '<button id="simToggle" title="切换简洁/完整模式（会记住）" style="float:right;font-size:11px;padding:2px 8px;' +
        'border-radius:6px;border:1px solid var(--line);background:' +
        (simple ? 'var(--ok)' : '#21262d') + ';color:' +
        (simple ? '#04110a' : 'var(--sub)') + ';cursor:pointer">' +
        (simple ? '⚡ 简洁 : 开' : '⚡ 简洁 : 关') + '</button>' +
    '</div>' + rows +
    '<div class="hint">' +
      (simple
        ? '⚡ <b>简洁模式</b>：只显示核心字段。<br>🐉 点怪物的 📋 会<b>自动改对应等级</b>（等级不显示，但已写入）。<br>💾 保存时<b>所有 32 个字段都会写入</b>（隐藏字段保持原值）。'
        : '') +
      '⚠️ 保存只写入<b>这一个任务</b>。<br>' +
      '🐉 <b>点怪物的 📋 选择</b> → 自动把该怪等级填到对应「怪N级」（怪1用主等级，怪2~5/乱入用副等级）；<b>手动改 ID 不会</b>动等级。</div>' +
    '<div class="sheet-actions">' +
    '<button id="save" style="width:100%">💾 保存此任务</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();
  $('cancel').onclick = function () { hideOverlay(); };
  $('save').onclick = function () { saveOne(idx); };
  // 简洁/完整 切换按钮
  var st = $('simToggle');
  if (st) st.onclick = function () { toggleSimpleMode(); };

  // 选择按钮
  $('sheet').querySelectorAll('[data-pick]').forEach(function (b) {
    b.onclick = function () {
      var field = b.dataset.field, kind = b.dataset.pick;
      var f = Quest.fieldByName(field);

      // 统一写值：有输入框就写框 + 缓存，没框就只写缓存（简洁模式的隐藏字段）
      function setVal(fname, val) {
        _fieldVals[fname] = val;
        var inp = $('sheet').querySelector('input[data-field="' + fname + '"]');
        if (inp) { inp.value = val; flashEl(inp); }
        var nm = $('nm-' + fname);
        if (nm) {
          var ff = Quest.fieldByName(fname);
          if (ff && ff.kind === 'mon') nm.textContent = Quest.monName(val);
          else if (ff && ff.kind === 'map') nm.textContent = Quest.mapName(val);
          else if (ff && ff.kind === 'enum') nm.textContent = Quest.enumName(ff.enum, val);
        }
      }

      if (kind === 'enum') {
        openEnumPicker(f.enum, function (val) { setVal(field, val); });
        return;
      }
      openPicker(kind, function (id) {
        setVal(field, id);
        // 【联动】选怪自动带等级（含"无怪"(id=0) → 主/副都填 11）
        if (kind === 'mon') {
          var lv = MON_LEVELS[id];
          if (f && f.linked && lv) {
            var role = (f.slot === 1) ? 0 : 1;
            setVal(f.linked, lv[role]);
            if (lv[0] === 0 && lv[1] === 0) {
              toast('⚠️ ' + Quest.monName(id) + ' 无怪异等级，' + f.linked + ' 填 0', 2500);
            } else {
              toast('✅ ' + Quest.monName(id) + ' → ' + f.linked + ' = ' + lv[role] + '（已自动写入，可在完整模式查看）', 2500);
            }
          }
        }
      });
    };
  });
  // 手改字段 → 同步更新缓存
  $('sheet').querySelectorAll('input[data-field]').forEach(function (inp) {
    inp.addEventListener('input', function () {
      var fname = inp.dataset.field;
      _fieldVals[fname] = inp.value;
      var f = Quest.fieldByName(fname);
      var nm = $('nm-' + fname);
      if (!nm || !f || f.kind !== 'enum') return;
      nm.textContent = Quest.enumName(f.enum, parseInt(inp.value, 10) || 0);
    });
  });
}

async function saveOne(idx) {
  // ✅ 全字段都写：可见字段用输入框的值，隐藏字段（简洁模式）用 _fieldVals 缓存的值
  var changes = [];
  FIELDS.forEach(function (f) {
    var inp = $('sheet').querySelector('input[data-field="' + f.name + '"]');
    var v;
    if (inp) {
      v = inp.value;                                   // 可见字段：读输入框
    } else if (_fieldVals[f.name] !== undefined) {
      v = _fieldVals[f.name];                          // 隐藏字段：读缓存
    } else {
      v = 0;
    }
    var val = clampFieldVal(f, v);   // ← 夹到字段范围（防超限写坏内存）
    changes.push({ off: f.off, size: f.size, value: val });
  });
  var btn = $('save');
  busy(btn, true, '⏳ 保存中…（写入 ' + changes.length + ' 个字段）');
  try {
    if (Store.getMode() === 'file') {
      // 离线文件模式：只改本地
      Store.setSlotFields(idx, changes);
      toast('✅ 已保存到文件（本地）', 2500);
      busy(btn, false);
      refreshFromStore();
      openQuest(idx);
      return;
    }
    // 在线模式：写内存
    if (!BASE) BASE = await Quest.questBase();
    var r = await Quest.setQuestFields(BASE, idx, changes);
    if (r.ok) {
      toast('✅ 已保存 ' + changes.length + ' 个字段（已回读校验）', 3000);
    } else toast('⚠️ 写入后校验不一致，请检查', 4000);
  } catch (e) {
    toast('❌ 保存失败：' + e.message, 4000);
  }
  busy(btn, false);
  if (Store.getMode() !== 'file') {
    // ✅ 重新读内存刷新主列表（这样关掉弹窗后，列表就是最新的）
    await load();
    // load() 会 render()，但弹窗会被它清掉 → 重新打开单任务面板
    openQuest(idx);
  }
}

// ---------- 批量改任务（主界面）----------

/** 根据字段类型，生成"改成"这一行的控件 */
function buildBatchValueRow(f, val) {
  var extra = '';
  if (f.kind === 'mon') {
    extra = '<button class="pick" id="bPick">📋</button>' +
      '<span class="nm" id="bValName">' + (val ? Quest.monName(val) : '') + '</span>';
  } else if (f.kind === 'map') {
    extra = '<button class="pick" id="bPick">📋</button>' +
      '<span class="nm" id="bValName">' + (val ? Quest.mapName(val) : '') + '</span>';
  } else if (f.kind === 'enum') {
    extra = '<button class="pick" id="bPick">📋</button>' +
      '<span class="hintv" id="bValName">' + Quest.enumName(f.enum, val) + '</span>';
  } else {
    extra = '<span class="nobtn"></span><span class="hintv">' + (f.hint || '') + '</span>';
  }
  var vstr = (val === null || val === undefined) ? '' : toSigned(val, f.size);
  var ph = (vstr === '') ? ' placeholder="填写数值"' : '';

  var html = '<div class="frow f"><label>改成</label>' +
    '<input id="bValue" value="' + vstr + '"' + numAttrs(f) + ph + ' />' + extra + '</div>';

  // 怪物字段：追加"同时改等级"勾选
  if (f.kind === 'mon' && f.linked) {
    html += '<div class="frow"><label>同时改等级</label>' +
      '<input type="checkbox" id="bSetLv" checked style="width:auto;flex:none" />' +
      '<span class="hintv">按怪物表给「' + f.linked + '」填主/副等级</span></div>';
  }
  return html;
}

/** 绑定"改成"行的选择器按钮 + 手改提示 */
function bindBatchValueRow(f) {
  var pick = $('bPick');
  if (pick) {
    pick.onclick = function () {
      var cb = function (v) {
        $('bValue').value = v;
        var nm = $('bValName');
        if (nm) nm.textContent = (f.kind === 'mon') ? Quest.monName(v)
          : (f.kind === 'map') ? Quest.mapName(v) : Quest.enumName(f.enum, v);
      };
      if (f.kind === 'enum') openEnumPicker(f.enum, cb); else openPicker(f.kind, cb);
    };
  }
  var inp = $('bValue');
  inp.addEventListener('input', function () {
    var nm = $('bValName');
    if (!nm || f.kind !== 'enum') return;
    nm.textContent = Quest.enumName(f.enum, parseInt(inp.value, 10) || 0);
  });
}

/** 默认值：不同字段给个合理的初始值；数字字段留空（避免误填 300 这种）*/
function batchDefaultValue(f) {
  if (f.kind === 'enum') {
    var k = Object.keys(ENUMS[f.enum] || {})[0];
    return k === undefined ? null : parseInt(k, 10);
  }
  if (f.kind === 'mon') return 1;
  if (f.kind === 'map') return 1;
  return null;   // 普通数字字段：留空，让用户自己填
}

function openBatch() {
  var fopt = FIELDS.map(function (f) {
    return '<option value="' + f.name + '">' + f.name + '</option>';
  }).join('');
  $('sheet').innerHTML =
    '<h2>⚡ 批量改任务</h2>' +
    '<div class="sub">把很多个任务的「同一个字段」一次改成相同值</div>' +
    '<div class="frow"><label>要改的字段</label><select id="bField" style="width:130px">' + fopt + '</select></div>' +
    '<div id="bValWrap"></div>' +
    '<div class="frow"><label>逐个变化</label>' +
    '<input type="number" id="bStep" value="" placeholder="0" style="width:64px;text-align:center" />' +
    '<span class="hintv">填 +1/-1… 空=全部同值</span></div>' +
    '<div class="frow" id="bOrderRow" style="display:none"><label>谁先拿值</label><select id="bOrder" style="width:150px">' +
    '<option value="index">默认（列表/槽位顺序）</option>' +
    '<option value="序号">按序号从小到大</option>' +
    '<option value="编号">按编号从小到大</option>' +
    '</select></div>' +
    '<div class="frow"><label>范围</label><select id="bRange" style="width:150px">' +
    '<option value="visible">当前列表（' + VISIBLE.length + ' 个）</option>' +
    '<option value="all">全部（' + ALL.length + ' 个）</option>' +
    '<option value="ids">槽位区间</option>' +
    '<option value="empty">空槽位（' + findEmptySlots().length + ' 个）</option>' +
    '</select></div>' +
    '<div id="bIdRange" style="display:none">' +
    '<div class="frow"><label>起始</label><input type="number" id="bFrom" value="1" min="1" max="' + STRUCT.TASK_COUNT + '" /><span class="hintv">第几个（1~' + STRUCT.TASK_COUNT + '）</span></div>' +
    '<div class="frow"><label>结束</label><input type="number" id="bTo" value="' + STRUCT.TASK_COUNT + '" min="1" max="' + STRUCT.TASK_COUNT + '" /><span class="hintv">含这一位</span></div>' +
    '</div>' +
    '<div class="hint">⚠️ 会一次改多个任务，每个约 1.5 秒，请确认无误再点。</div>' +
    '<div class="sheet-actions">' +
    '<button id="bGo" class="warn" style="width:100%">⚡ 开始批量修改</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();
  $('cancel').onclick = function () { hideOverlay(); };

  // 切换字段 → 重建"改成"行
  function rebuildValueRow() {
    var f = Quest.fieldByName($('bField').value);
    if (!f) return;
    $('bValWrap').innerHTML = buildBatchValueRow(f, batchDefaultValue(f));
    bindBatchValueRow(f);
  }
  rebuildValueRow();
  $('bField').onchange = rebuildValueRow;

  $('bRange').onchange = function () {
    $('bIdRange').style.display = ($('bRange').value === 'ids') ? 'block' : 'none';
  };
  // 填了步长 → 显示"按此排序"；清空 → 隐藏
  $('bStep').oninput = function () {
    $('bOrderRow').style.display = ($('bStep').value.trim() === '') ? 'none' : 'flex';
  };
  $('bGo').onclick = doBatch;
}

async function doBatch() {
  if (_busy) return;
  var f = Quest.fieldByName($('bField').value);
  if (!f) { toast('字段无效'); return; }
  // 留空校验（数字字段默认留空，必须填）
  var rawVal = $('bValue').value.trim();
  if (rawVal === '') { toast('❌ 请先填「改成」的数值'); return; }
  var value = clampFieldVal(f, rawVal);   // ← 夹到字段范围
  // 怪物字段：是否同时改等级
  var setLv = !!(f.kind === 'mon' && f.linked && $('bSetLv') && $('bSetLv').checked);
  var stepRaw = $('bStep') ? $('bStep').value.trim() : '';
  var step = stepRaw === '' ? 0 : parseInt(stepRaw, 10);
  if (isNaN(step)) step = 0;
  var inc = step !== 0;          // 有步长 = 逐个变化
  var orderBy = inc && $('bOrder') ? $('bOrder').value : 'index';
  var idxs;
  var rk = $('bRange').value;
  if (rk === 'ids') {
    // 用户填的是"第几个"（1~200），内部索引是 0~199 → 减 1
    var from = parseInt($('bFrom').value, 10) - 1;
    var to = parseInt($('bTo').value, 10) - 1;
    if (isNaN(from)) from = 0;
    if (isNaN(to)) to = STRUCT.TASK_COUNT - 1;
    if (from > to) { var tmp = from; from = to; to = tmp; }   // 填反了自动纠正
    idxs = ALL.filter(function (q) { return q.index >= from && q.index <= to; })
      .map(function (q) { return q.index; });
    if (!idxs.length) { toast('该槽位区间内没有任务'); return; }
  } else if (rk === 'visible') {
    idxs = VISIBLE.map(function (q) { return q.index; });
    if (!idxs.length) { toast('当前列表为空（可能筛选后没结果）'); return; }
  } else if (rk === 'empty') {
    idxs = findEmptySlots();
    if (!idxs.length) { toast('没有空槽位'); return; }
  } else {
    idxs = ALL.map(function (q) { return q.index; });
  }
  // 逐个变化 → 决定"谁先拿值"
  // · 当前列表：默认保持"列表顺序"（跟界面对应）；除非用户显式选了别的排序
  // · 其它范围：按「按此排序」（默认槽位顺序）
  if (inc) {
    var byVisible = (rk === 'visible' && orderBy === 'index');
    if (!byVisible) {
      if (orderBy === 'index') {
        idxs.sort(function (a, b) { return a - b; });
      } else {
        var valOf = {};
        ALL.forEach(function (q) { valOf[q.index] = toSigned(q[orderBy], 4); });
        idxs.sort(function (a, b) { return (valOf[a] - valOf[b]) || (a - b); });
      }
    }
  }

  // 预览前 3 个变化
  var preview = '';
  if (inc) {
    var idxInfo = {};
    ALL.forEach(function (q) { idxInfo[q.index] = q; });
    var pv = idxs.slice(0, 3).map(function (ix, i) {
      var slotLabel = idxInfo[ix] ? ('#' + idxInfo[ix]['编号']) : ('槽' + ix);
      return slotLabel + '→' + toSigned((value + step * i) >>> 0, f.size);
    }).join('，');
    if (idxs.length > 3) pv += ' …（共 ' + idxs.length + ' 个）';
    preview = '\n\n预览：' + pv;
  }
  var dirTxt = step > 0 ? ('+' + step) : String(step);
  var orderTxt = (rk === 'visible' && orderBy === 'index')
    ? '列表顺序（跟界面一致）'
    : (orderBy === 'index' ? '槽位顺序' : orderBy);
  var tip = inc
    ? '确定把 ' + idxs.length + ' 个任务的「' + f.name + '」从 ' + toSigned(value, f.size) + ' 开始每次 ' + dirTxt + ' 吗？\n（顺序：' + orderTxt + '）' + preview + '\n约需 ' + Math.round(idxs.length * 1.6) + ' 秒。'
    : '确定把 ' + idxs.length + ' 个任务的「' + f.name + '」改成 ' + toSigned(value, f.size) + ' 吗？\n约需 ' + Math.round(idxs.length * 1.6) + ' 秒。';
  if (!confirm(tip)) return;

  var btn = $('bGo');
  busy(btn, true, '⏳ 修改中 0/' + idxs.length);
  setBusy(true);
  btn.disabled = true;
  try {
    if (!BASE) BASE = await Quest.questBase();
    var ok = 0;
    if (inc) {
      // 逐个变化：构造每个索引对应的值，一次大块写（支持任意步长，含负数）
      var vals = {};
      for (var i = 0; i < idxs.length; i++) {
        vals[idxs[i]] = (value + step * i) >>> 0;   // 保持无符号位模式
      }
      if (Store.getMode() === 'file') {
        idxs.forEach(function (ix) {
          Store.setSlotFields(ix, [{ off: f.off, size: f.size, value: vals[ix] }]);
        });
        ok = idxs.length;
      } else {
        ok = await Quest.setManyQuestsDiff(BASE, idxs, f.off, f.size, vals, function () {});
      }
    } else {
      // 统一同值：一次大块写（快）
      if (Store.getMode() === 'file') {
        idxs.forEach(function (ix) {
          Store.setSlotFields(ix, [{ off: f.off, size: f.size, value: value }]);
        });
        ok = idxs.length;
      } else {
        ok = await Quest.setManyQuests(BASE, idxs, f.off, f.size, value, function (c, t) {
          btn.textContent = '⏳ 修改中 ' + c + '/' + t;
        });
      }
    }
    // 怪物字段：同时按怪物表设置等级（再跑一遍，改 f.linked 字段）
    if (setLv) {
      var lf = Quest.fieldByName(f.linked);
      if (lf) {
        var role = (f.slot === 1) ? 0 : 1;      // 怪1用主等级，其余用副等级
        var lvPair = MON_LEVELS[value];
        var lv = lvPair ? lvPair[role] : 0;
        btn.textContent = '⏳ 正在设置「' + f.linked + '」…';
        if (Store.getMode() === 'file') {
          idxs.forEach(function (ix) {
            Store.setSlotFields(ix, [{ off: lf.off, size: lf.size, value: lv >>> 0 }]);
          });
        } else {
          await Quest.setManyQuests(BASE, idxs, lf.off, lf.size, lv >>> 0, function () {});
        }
      }
    }
    toast('✅ 批量完成：' + ok + '/' + idxs.length + ' 个成功' + (setLv ? '（含等级）' : ''), 3500);
  } catch (e) {
    toast('❌ 批量失败：' + e.message, 4000);
  }
  busy(btn, false);
  setBusy(false);              // 先解锁，load() 里要检查 _busy
  hideOverlay();
  // 文件模式不重新读内存，只刷新列表
  if (Store.getMode() === 'file') { ALL = Store.validTasks(); render(); }
  else load();   // 重新拉取
}

// ---------- 删除任务 ----------
// 游戏"删除"的做法：把 序号(0x00)、编号(0x04) 写成 0xFFFFFFFF，叹号(0x68) 写成 256
var DEL_MARK = 0xFFFFFFFF;

async function delQuest(idx) {
  var q = ALL.filter(function (x) { return x.index === idx; })[0];
  var label = q ? ('#' + q['编号']) : ('第' + (idx + 1) + '个');
  if (!confirm('确定删除任务 ' + label + ' 吗？\n\n（写入：序号=FFFFFFFF、编号=FFFFFFFF、叹号=256）')) return;
  var changes = [
    { off: 0x00, size: 4, value: DEL_MARK },
    { off: 0x04, size: 4, value: DEL_MARK },
    { off: 0x68, size: 4, value: 256 }
  ];
  try {
    if (Store.getMode() === 'file') {
      // 文件模式：只改本地
      Store.setSlotFields(idx, changes);
      toast('🗑️ 已从文件删除 ' + label, 2500);
      refreshFromStore();
      return;
    }
    if (!BASE) BASE = await Quest.questBase();
    var r = await Quest.setQuestFields(BASE, idx, changes);
    if (r.ok) toast('🗑️ 已删除 ' + label, 2500);
    else toast('⚠️ 写入后校验不一致，请检查', 4000);
  } catch (e) {
    toast('❌ 删除失败：' + e.message, 4000);
  }
  load();
}

// ---------- 清空所有任务（保留最靠前的一个）----------
/** 弹框 → 输入"清空"确认 → 逐个写入删除标记
 *  规则：保留【第 1 个有任务的槽】（若槽 0 空，就保留最靠前的那个有任务的槽）
 */
async function clearAllQuests() {
  if (_busy) { toast('正在忙，稍等一下'); return; }

  // 找出"要保留"的那一个 = 最靠前的有任务槽
  var keep = null;
  for (var s = 0; s < STRUCT.TASK_COUNT; s++) {
    var hit = ALL.filter(function (x) { return x.index === s; })[0];
    if (hit) { keep = hit; break; }
  }
  if (!keep) { toast('当前没有任务（不用清空）'); return; }

  var others = ALL.filter(function (q) { return q.index !== keep.index; });
  if (!others.length) { toast('只有 1 个任务，无需清空'); return; }

  // ---- 面板：输入"清空"确认 ----
  $('sheet').innerHTML =
    '<h2>🧨 清空所有任务</h2>' +
    '<div class="sub" style="color:var(--err)">⚠️ 危险操作，不可撤销</div>' +
    '<div class="hint" style="margin:12px 0">' +
    '• 将删除 <b>' + others.length + '</b> 个任务（共 ' + ALL.length + ' 个）<br>' +
    '• <b>保留</b>：第 <b>' + (keep.index + 1) + '</b> 个槽（编号 #' + keep['编号'] + '）' +
    '<br>• 游戏要求至少保留 1 个任务，所以留最靠前的那个<br>' +
    '• 写入方式与单个删除一致：序号=FFFFFFFF、编号=FFFFFFFF、叹号=256<br>' +
    '• ⚡ 大块写入，约 <b>2~5 秒</b>，请勿中途退出</div>' +
    '<div class="frow"><label>请输入"清空"</label>' +
    '<input id="clrWord" type="text" style="width:auto;flex:1;text-align:left" placeholder="清空" /></div>' +
    '<div class="sheet-actions">' +
    '<button id="clrGo" class="warn" style="width:100%">🧨 确认清空</button>' +
    '<button class="ghost" id="clrCancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();
  $('clrCancel').onclick = function () { hideOverlay(); };
  $('clrGo').onclick = async function () {
    var w = ($('clrWord').value || '').trim();
    if (w !== '清空') { toast('❌ 请准确输入「清空」两个字', 3500); return; }
    // 二次确认
    if (!confirm('最后确认：删除 ' + others.length + ' 个任务，只留第 ' + (keep.index + 1) + ' 个？')) return;

    var btn = $('clrGo');
    busy(btn, true, '⏳ 清空中…');
    setBusy(true);
    var ok = 0, fail = 0;
    try {
      var changes = [
        { off: 0x00, size: 4, value: DEL_MARK },
        { off: 0x04, size: 4, value: DEL_MARK },
        { off: 0x68, size: 4, value: 256 }
      ];
      if (Store.getMode() === 'file') {
        others.forEach(function (q) {
          Store.setSlotFields(q.index, changes);
          ok++;
        });
      } else {
        if (!BASE) BASE = await Quest.questBase();
        // ⚡ 大块写：把所有要删的槽一起处理（含区间内空槽，它们本来就是删除标记，无影响）
        var list = others.map(function (q) { return q.index; });
        btn.textContent = '⏳ 读取中…';
        ok = await Quest.clearManyQuests(BASE, list, function (c, t) {
          btn.textContent = '⏳ 清空中 ' + c + '/' + t;
        });
      }
    } catch (e) {
      fail = others.length - ok;
      toast('❌ 清空失败：' + e.message, 4000);
    }
    setBusy(false);
    hideOverlay();
    toast('✅ 清空完成：删除 ' + ok + ' 个' + (fail ? ('，失败 ' + fail + ' 个') : '') +
      '（保留第 ' + (keep.index + 1) + ' 个）', 5000);
    if (Store.getMode() === 'file') { ALL = Store.validTasks(); render(); }
    else load();
  };
}
window.clearAllQuests = clearAllQuests;

// ---------- 恢复所有已删除的任务 ----------
/**
 * 恢复条件（两条都满足）：
 *   ① 编号 == 0xFFFFFFFF      （这是个"空槽"）
 *   ② 怪1ID 能在怪物表里查到   （说明这槽"曾经真的有过任务"，不是纯占位）
 * 恢复内容：
 *   · 序号 = 从"序号计数器"往后发号（cur, cur+1, ...）
 *   · 编号 = 700000 + 槽位
 *   · 叹号 = 1（显示"新任务"）
 *   · 计数器最后写回 cur + 恢复数量
 * ⚡ 大块读 + 大块写，约 2~5 秒
 */
async function restoreAllQuests() {
  setBusy(true);
  try {
    // 用 Store.getSlots()：它存着全部 200 槽（含空槽），两种模式都适用
    var src = Store.getSlots().map(function (s) {
      var t = {};
      for (var k in s.fields) t[k] = s.fields[k];
      t.index = s.index;
      return t;
    });
    var cand = [];
    for (var i = 0; i < src.length; i++) {
      var q = src[i];
      var num = q['编号'] >>> 0;
      if (num !== 0xFFFFFFFF) continue;                 // ① 必须是空槽
      var m1 = q['怪1ID'] >>> 0;
      if (!m1 || m1 === 0xFFFFFFFF) continue;           // ② 怪1ID 不能是 0 / FFFFFFFF
      if (!Quest.monName(m1) || Quest.monName(m1).indexOf('未知') === 0) continue; // ③ 必须在怪物表里
      cand.push(q.index);
    }
    cand.sort(function (a, b) { return a - b; });        // 槽位从小到大

    if (!cand.length) { toast('没有「可恢复」的槽（编号=FFFFFFFF 且怪1ID合法）'); setBusy(false); return; }

    var cur = Store.getSeqCounter();
    if (cur === null || cur === undefined) {
      // 在线模式：现读一次
      cur = await Quest.readSeqCounter();
      if (cur === null || cur === undefined) { toast('❌ 读不到序号计数器'); setBusy(false); return; }
    }
    cur = cur >>> 0;

    $('sheet').innerHTML =
      '<div class="sec">♻️ 恢复所有已删除任务</div>' +
      '<div class="hint" style="margin:6px 0 10px;line-height:1.8">' +
      '• 将恢复 <b style="color:var(--accent)">' + cand.length + '</b> 个槽' +
      '<br>• 判定：编号=FFFFFFFF <b>且</b> 怪1ID 在怪物表里' +
      '<br>• 序号：从 <b>' + cur + '</b> 开始依次 +1（共 ' + cand.length + ' 个）' +
      '<br>• 编号：700000 + 槽位；叹号：1（显示新任务）' +
      '<br>• 计数器最后写成 <b>' + (cur + cand.length) + '</b>' +
      '<br>• ⚡ 大块读写，约 <b>2~5 秒</b></div>' +
      '<div class="hint" style="color:var(--warn)">前 5 个：' +
      cand.slice(0, 5).map(function (ix) { return '第' + (ix + 1) + '个→序号' + (cur + cand.indexOf(ix)); }).join('，') +
      (cand.length > 5 ? ' …' : '') + '</div>' +
      '<div class="sheet-actions">' +
      '<button id="rstGo" style="width:100%">♻️ 开始恢复</button>' +
      '<button class="ghost" id="rstCancel" style="margin-top:8px;width:100%">取消</button>' +
      '</div>';
    showOverlay();
    $('rstCancel').onclick = function () { hideOverlay(); setBusy(false); };

    $('rstGo').onclick = async function () {
      if (!confirm('确认恢复 ' + cand.length + ' 个任务？\n序号 ' + cur + ' ~ ' + (cur + cand.length - 1))) return;
      var btn = $('rstGo');
      busy(btn, true, '⏳ 恢复中…');
      try {
        var items = {};
        for (var k = 0; k < cand.length; k++) {
          items[cand[k]] = { seq: (cur + k) >>> 0, num: (STRUCT.TASK_ID_BASE + cand[k]) >>> 0 };
        }
        if (Store.getMode() === 'file') {
          Object.keys(items).forEach(function (ix) {
            var it = items[ix];
            Store.setSlotFields(Number(ix), [
              { off: 0x00, size: 4, value: it.seq },
              { off: 0x04, size: 4, value: it.num },
              { off: 0x68, size: 4, value: 1 }
            ]);
          });
          Store.setSeqCounter((cur + cand.length) >>> 0);
        } else {
          if (!BASE) BASE = await Quest.questBase();
          btn.textContent = '⏳ 读取中…';
          await Quest.restoreManyQuests(BASE, items, function (c, t) {
            btn.textContent = '⏳ 恢复中 ' + c + '/' + t;
          });
          await Quest.writeSeqCounter((cur + cand.length) >>> 0);   // 计数器推到最后
        }
        toast('✅ 已恢复 ' + cand.length + ' 个任务，序号 ' + cur + ' ~ ' + (cur + cand.length - 1), 4000);
      } catch (e) {
        toast('❌ 恢复失败：' + e.message, 4000);
      }
      hideOverlay();
      setBusy(false);
      if (Store.getMode() === 'file') { ALL = Store.validTasks(); render(); }
      else load();
    };
  } catch (e) {
    toast('❌ ' + e.message, 4000);
    setBusy(false);
  }
}
window.restoreAllQuests = restoreAllQuests;

// ---------- 📷 截取 NS 屏幕 ----------
/** 截一张 Switch 当前画面，弹窗显示（可保存 / 再截一张） */
async function shotScreen() {
  if (Store.getMode() !== 'online') { toast('截屏需要「在线」模式（连 Switch）'); return; }
  setBusy(true);
  var overlayHtml =
    '<div class="sec">📷 截取 NS 屏幕</div>' +
    '<div class="hint" id="shotTip" style="margin:6px 0 10px">⏳ 正在截图…（约 1 秒）</div>' +
    '<div id="shotBox" style="text-align:center"></div>' +
    '<div class="sheet-actions">' +
    '<button id="shotSave" style="width:100%;display:none">💾 保存到相册/下载</button>' +
    '<button class="ghost" id="shotAgain" style="margin-top:8px;width:100%;display:none">🔄 再截一张</button>' +
    '<button class="ghost" id="shotClose" style="margin-top:8px;width:100%">关闭</button>' +
    '</div>';
  $('sheet').innerHTML = overlayHtml;
  showOverlay();
  // 关闭钩子：不管从哪个入口关（按钮 / 点外面），都要 revoke 掉 Blob URL
  _overlayCloseHook = function () { revokeShot(); };
  $('shotClose').onclick = function () { closeOverlay(); };
  $('shotAgain').onclick = function () { doShot(); };

  var _shotUrl = null;
  function revokeShot() { if (_shotUrl) { URL.revokeObjectURL(_shotUrl); _shotUrl = null; } }

  async function doShot() {
    var tip = $('shotTip'), box = $('shotBox');
    var btnA = $('shotAgain'), btnS = $('shotSave');
    tip.textContent = '⏳ 正在截图…（约 1 秒）';
    btnA.style.display = 'none'; btnS.style.display = 'none';
    box.innerHTML = '';
    try {
      var bytes = await Quest.captureScreen();
      var blob = new Blob([bytes], { type: 'image/jpeg' });
      revokeShot();
      _shotUrl = URL.createObjectURL(blob);
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      box.innerHTML = '<img id="shotImg" style="max-width:100%;border-radius:10px;border:1px solid var(--line)" />';
      var img = $('shotImg');
      img.src = _shotUrl;
      img.alt = 'NS 截图';
      tip.innerHTML = '✅ 已截图（' + Math.round(bytes.length / 1024) + ' KB，1280×720）';
      btnA.style.display = 'block'; btnS.style.display = 'block';
      // 保存
      btnS.onclick = function () {
        var a = document.createElement('a');
        a.href = _shotUrl;
        a.download = 'NS_' + ts + '.jpg';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        toast('💾 已保存（看浏览器下载）', 2500);
      };
    } catch (e) {
      tip.innerHTML = '<span style="color:var(--err)">❌ 截图失败：' + e.message + '</span>';
      btnA.style.display = 'block';
    }
  }
  doShot();
}
window.shotScreen = shotScreen;

// ---------- 🔄 交换两个任务 ----------
/**
 * 把「第 A 个」和「第 B 个」两个槽的 116 字节**整体对调**：
 *   · 序号 / 编号 / 怪 / 等级 / 地图 … 全都跟着走
 *   · 因为编号本来就是 700000+槽位，所以交换后仍然对得上 ✅
 *   · 如果其中一个是空槽，等于「把任务移动到那个槽」✅
 */
function openSwap() {
  if (Store.getMode() !== 'online' && !Store.getSlots().length) {
    toast('请先读取任务或打开文件'); return;
  }
  var A = -1, B = -1;
  var autoNum = true;     // ✅ 默认：自动重算编号（= 700000 + 槽位）

  function labelOf(s) {
    if (s < 0) return '<span style="color:var(--sub)">未选</span>';
    var lb = slotLabel(s);
    return '第 <b>' + (s + 1) + '</b> 个' + (lb.empty ? ' <span style="color:var(--sub)">(空槽)</span>' : (' · ' + lb.txt));
  }

  function renderSheet() {
    $('sheet').innerHTML =
      '<h2>🔄 交换两个任务</h2>' +
      '<div class="sub">两个槽的<b>全部数据</b>整体对调（含序号/编号/怪/等级）</div>' +
      '<div class="frow" style="border-bottom:1px solid var(--line)">' +
        '<label>第 1 个</label>' +
        '<input id="swA" type="number" value="' + (A >= 0 ? A + 1 : '') + '" min="1" max="' + STRUCT.TASK_COUNT + '" placeholder="填 ' + 1 + '~' + STRUCT.TASK_COUNT + '" />' +
        '<button class="pick" id="swAPick">📋</button>' +
        '<span class="hintv">' + labelOf(A) + '</span>' +
      '</div>' +
      '<div class="frow" style="border-bottom:1px solid var(--line)">' +
        '<label>第 2 个</label>' +
        '<input id="swB" type="number" value="' + (B >= 0 ? B + 1 : '') + '" min="1" max="' + STRUCT.TASK_COUNT + '" placeholder="填 1~' + STRUCT.TASK_COUNT + '" />' +
        '<button class="pick" id="swBPick">📋</button>' +
        '<span class="hintv">' + labelOf(B) + '</span>' +
      '</div>' +
      '<div class="hint" style="margin:10px 0 0">' +
      '• 两个槽的 <b>116 字节整体对调</b>：序号、怪物、等级、地图… 全部跟着走<br>' +
      '• <b>编号自动重算</b> = <span style="color:var(--ok)">700000 + 该槽位</span>（游戏规律，永远正确）<br>' +
      '• 其中一个若是<b>空槽</b> → 效果 = <b>把任务挪到那个槽</b><br>' +
      '• ⚡ 大块读 + 大块写，约 <b>1~2 秒</b>' +
      '</div>' +
      '<div class="frow" style="border-top:1px solid var(--line);margin-top:10px">' +
        '<label>编号</label>' +
        '<input type="checkbox" id="swAutoNum" style="width:auto;flex:none" ' + (autoNum ? 'checked' : '') + ' />' +
        '<span class="nobtn"></span>' +
        '<span class="hintv" style="white-space:normal">' +
        (autoNum
          ? '✅ 自动重算 = 700000 + 槽位（推荐）'
          : '⚠️ 不重算：保留对调过来的原编号') +
        '</span>' +
      '</div>' +
      '<div class="sheet-actions">' +
      '<button id="swGo" style="width:100%">🔄 开始交换</button>' +
      '<button class="ghost" id="swCancel" style="margin-top:8px;width:100%">取消</button>' +
      '</div>';
    showOverlay();

    $('swCancel').onclick = function () { closeOverlay(); };

    // 手填 1 起 → 内部 0 起（用 input 即时生效，不等失焦）
    function readSlotInput(id, setter) {
      var el = $(id);
      var s = parseInt(el.value, 10) - 1;
      if (el.value.trim() === '') { setter(-1); return; }
      if (isNaN(s) || s < 0 || s >= STRUCT.TASK_COUNT) { setter(-1); return; }
      setter(s);
    }
    $('swA').addEventListener('input', function () {
      readSlotInput('swA', function (s) { A = s; });
      $('swA').parentNode.querySelector('.hintv').innerHTML = labelOf(A);
    });
    $('swB').addEventListener('input', function () {
      readSlotInput('swB', function (s) { B = s; });
      $('swB').parentNode.querySelector('.hintv').innerHTML = labelOf(B);
    });

    $('swAPick').onclick = function () {
      openAnySlotPicker({
        title: '选第 1 个任务（全部槽）', cur: A,
        onPick: function (s) { A = s; renderSheet(); }
      });
    };
    $('swBPick').onclick = function () {
      openAnySlotPicker({
        title: '选第 2 个任务（全部槽）', cur: B,
        onPick: function (s) { B = s; renderSheet(); }
      });
    };

    // 编号是否自动重算（默认勾上）
    var an = $('swAutoNum');
    if (an) {
      an.onchange = function () {
        autoNum = !!an.checked;
        var tip = an.parentNode.querySelector('.hintv');
        if (tip) tip.innerHTML = autoNum
          ? '✅ 自动重算 = 700000 + 槽位（推荐）'
          : '⚠️ 不重算：保留对调过来的原编号';
      };
    }

    $('swGo').onclick = doSwap;
  }

  async function doSwap() {
    console.log('[swap] doSwap 触发', { A: A, B: B });
    if (A < 0 || B < 0) { toast('❌ 两个都要选（第 1~' + STRUCT.TASK_COUNT + ' 个）'); return; }
    if (A === B) { toast('❌ 两个不能是同一个槽'); return; }
    var la = slotLabel(A), lb2 = slotLabel(B);
    var txt = '确认交换？\n\n' +
      '第 ' + (A + 1) + ' 个：' + (la.empty ? '空槽' : la.txt) + '\n' +
      '第 ' + (B + 1) + ' 个：' + (lb2.empty ? '空槽' : lb2.txt) + '\n\n' +
      '编号：' + (autoNum ? '自动重算 = 700000 + 各槽位' : '不重算（保留对调过来的原编号）') + '\n' +
      '（两个槽的其余数据整体对调）';
    if (!confirm(txt)) return;

    var btn = $('swGo');
    if (btn) busy(btn, true, '⏳ 交换中…');
    setBusy(true);
    var doneMsg = '';
    try {
      if (Store.getMode() === 'file') {
        // 文件模式：本地对调 raw
        var sa = Store.getSlot(A), sb = Store.getSlot(B);
        if (!sa || !sb) throw new Error('文件里缺少这两个槽');
        var rawA = sa.raw, rawB = sb.raw;
        Store.setSlot(A, rawB);
        Store.setSlot(B, rawA);
        if (autoNum) {
          // ✅ 只对【有效任务】重算编号（空槽不动：序号=FFFFFFFF、编号=FFFFFFFF）
          // 判断依据：对调后该槽的「序号」是否为 FFFFFFFF
          function isBlank(slot) {
            var sl = Store.getSlot(slot);
            if (!sl) return true;
            return (Mem.u32(Mem.hexToBytes(sl.raw), 0x00) === 0xFFFFFFFF);
          }
          if (!isBlank(A)) {
            Store.setSlotFields(A, [{ off: 0x04, size: 4, value: (STRUCT.TASK_ID_BASE + A) >>> 0 }]);
          }
          if (!isBlank(B)) {
            Store.setSlotFields(B, [{ off: 0x04, size: 4, value: (STRUCT.TASK_ID_BASE + B) >>> 0 }]);
          }
        }
        doneMsg = '✅ 已交换（文件）：第 ' + (A + 1) + ' 个 ↔ 第 ' + (B + 1) + ' 个' +
          (autoNum ? '（编号已重算）' : '');
      } else {
        if (!BASE) BASE = await Quest.questBase();
        await Quest.swapQuests(BASE, A, B, autoNum);
        // ⚡ 立刻回读校验：确认内存真的变了
        var chkA = await Quest.getQuest(BASE, A);
        var chkB = await Quest.getQuest(BASE, B);
        doneMsg = '✅ 已交换：第 ' + (A + 1) + ' 个(现 ' + Quest.monName(chkA['怪1ID']) + ' 编号' + chkA['编号'] + ') ↔ 第 ' + (B + 1) + ' 个(现 ' + Quest.monName(chkB['怪1ID']) + ' 编号' + chkB['编号'] + ')';
        console.log('[swap] 回读校验 A=', chkA['编号'], 'B=', chkB['编号']);
      }
    } catch (e) {
      console.error('[swap] 失败', e);
      toast('❌ 交换失败：' + e.message, 4000);
      hideOverlay();
      setBusy(false);
      return;
    }
    hideOverlay();
    setBusy(false);
    toast(doneMsg, 4000);
    // ✅ 重新读取内存刷新列表（眼见为实：显示的就是内存里的真数据）
    if (Store.getMode() === 'file') {
      ALL = Store.validTasks();
      render();
    } else {
      await load();   // 重新读一遍 200 槽（约 2 秒）
    }
  }

  renderSheet();
}
window.openSwap = openSwap;

// ============================================================
//  🎮 金手指面板（通用：按 js/cheats.js 的数据自动渲染）
// ============================================================

/** 单个金手指的"状态文案" */
function cheatStateText(c, st) {
  if (!st) return '读取失败';
  if (c.type === 'toggle') {
    if (st.state === 'off') return '⭕ 未启用（原始指令）';
    if (st.state === 'on') return '✅ 已启用';
    var vs = st.values.map(function (v) {
      return (v === null || v === undefined) ? 'null' : ('0x' + v.toString(16).toUpperCase());
    }).join(' / ');
    return '⚠️ 状态异常：' + vs;
  }
  if (c.type === 'modes') {
    if (st.modeKey === 'unknown') {
      var v0 = st.values[0];
      return '⚠️ 未知值：' + ((v0 === null || v0 === undefined) ? 'null' : ('0x' + v0.toString(16).toUpperCase()));
    }
    // 找对应模式的 label
    for (var i = 0; i < c.modes.length; i++) {
      if (c.modes[i].key === st.modeKey) return c.modes[i].label + '  （' + (c.modes[i].note || '') + '）';
    }
    return st.modeKey;
  }
  return '';
}

/** 渲染一个金手指区块的 HTML */
function cheatBlockHtml(c, st) {
  var h = '<div class="sec" style="margin-top:14px">' + escapeHtml(c.name) + '</div>';
  h += '<div class="hint" style="margin:0 0 10px">' + (c.desc || '') + '<br>';
  // 地址列表
  h += '地址：' + c.items.map(function (it) {
    return '<code>0x' + it.off.toString(16).toUpperCase() + '</code>';
  }).join(' + ') + '（main NSO）<br>';

  if (c.type === 'toggle') {
    var on = st && st.state === 'on';
    h += '状态：<b>' + cheatStateText(c, st) + '</b></div>';
    h += '<button id="chGo-' + c.id + '" data-cheat="' + c.id + '" data-act="toggle" ' +
      'style="width:100%' + (on ? ';background:#f85149;border-color:#f85149' : '') + '">' +
      (on ? '⛔ 关闭（恢复原始指令）' : ('✅ 开启（' + escapeHtml(c.name) + '）')) + '</button>';
  } else if (c.type === 'modes') {
    var cur = st ? st.modeKey : null;
    h += '状态：<b>' + cheatStateText(c, st) + '</b></div>';
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    for (var i = 0; i < c.modes.length; i++) {
      var m = c.modes[i];
      var active = (cur === m.key);
      h += '<button data-cheat="' + c.id + '" data-act="mode" data-mode="' + m.key + '" ' +
        'style="flex:1;min-width:80px' +
        (active ? ';background:var(--ok);border-color:var(--ok);color:#04110a' : '') + '">' +
        escapeHtml(m.label) + '</button>';
    }
    h += '</div>';
    // 模式注释
    if (c.modes.length) {
      h += '<div class="hint" style="margin:8px 0 0">';
      for (var j = 0; j < c.modes.length; j++) {
        h += '· <b>' + escapeHtml(c.modes[j].label) + '</b>：' + escapeHtml(c.modes[j].note || '') + '<br>';
      }
      h += '</div>';
    }
  }
  return h;
}

/** 渲染一个"数值锁定"区块的 HTML */
function watchBlockHtml(c, info) {
  var frozen = info.frozen;
  var cur = info.cur;    // { addr, value } 或 null
  var h = '<div class="sec" style="margin-top:14px">🔒 ' + escapeHtml(c.name) + '</div>';
  h += '<div class="hint" style="margin:0 0 10px">' + (c.desc || '') + '<br>';
  h += '锁定值：<b>' + c.value + '</b>';
  if (cur) {
    h += '<br>当前值：<b>' + cur.value + '</b>' + (cur.value === c.value ? ' ✅' : '');
    h += '<br>地址：<code>0x' + cur.addr.toString(16).toUpperCase() + '</code>';
  }
  h += '</div>';
  if (frozen) {
    h += '<button data-cheat="' + c.id + '" data-act="unlock" ' +
      'style="width:100%;background:#f85149;border-color:#f85149">🔥 解除锁定</button>';
    h += '<div class="hint" style="margin:8px 0 0;color:var(--ok)">❄️ 已锁定（NS 端每 3ms 写一次）</div>';
  } else {
    h += '<button data-cheat="' + c.id + '" data-act="lock" style="width:100%">❄️ 锁定</button>';
  }
  return h;
}

async function renderCheatPanel() {
  var defs = Quest.cheatDefs();
  var html = '<h2>🎮 金手指</h2>' +
    '<div class="sub">直接改游戏代码（main NSO），无需按键。⚠️ 改完可能需要重进任务/重启游戏才生效。</div>';

  if (Store.getMode() === 'file') {
    html += '<div class="hint">⚠️ 当前是<b>文件模式</b>，金手指需要连上 Switch（在线模式）才能用。</div>';
  }

  if (!defs || !defs.length) {
    html += '<div class="hint">（还没有金手指，请在 js/cheats.js 里添加）</div>';
  }

  // 逐个读状态
  var states = [];
  for (var i = 0; i < defs.length; i++) {
    var c = defs[i];
    if (c.type === 'watch') {
      var info = { frozen: Quest.watchIsFrozen(c.id), cur: null };
      try { info.cur = await Quest.watchRead(c.id); } catch (e) { info.cur = null; }
      states.push(info);
      html += watchBlockHtml(c, info);
    } else {
      var st = null;
      try { st = await Quest.cheatStatus(c.id); } catch (e) { st = null; }
      states.push(st);
      html += cheatBlockHtml(c, st);
    }
  }

  html += '<div class="hint" style="margin-top:16px">' +
      '⚠️ <b>修改的是游戏代码/数值</b>，请谨慎使用，建议先备份存档。<br>' +
      '💾 都是<b>立即写入内存</b>，随时可以点「关闭 / 正常 / 解除」还原。<br>' +
      '➕ 想加新金手指？只改 <code>js/cheats.js</code> 一个文件即可。' +
    '</div>' +
    '<div class="sheet-actions">' +
    '<button class="ghost" id="chClear" style="width:100%;margin-bottom:8px">🧹 清除所有数值锁定</button>' +
    '<button class="ghost" id="chClose" style="width:100%">关闭</button>' +
    '</div>';

  $('sheet').innerHTML = html;
  showOverlay();

  $('chClose').onclick = function () { hideOverlay(); };
  var clr = $('chClear');
  if (clr) clr.onclick = async function () {
    if (!confirm('确定要清除【所有】数值锁定吗？\n（会调用 NS 的 freezeClear）')) return;
    busy(clr, true, '⏳ 清除中…');
    try {
      await Quest.watchClearAll();
      toast('🧹 已清除所有数值锁定', 2500);
    } catch (e) {
      toast('❌ 清除失败：' + e.message, 4000);
    }
    busy(clr, false);
    renderCheatPanel();
  };

  // ---- 通用事件绑定 ----
  $('sheet').querySelectorAll('button[data-cheat]').forEach(function (btn) {
    btn.onclick = async function () {
      if (Store.getMode() === 'file') { toast('需要在线模式（连上 Switch）'); return; }
      var id = btn.dataset.cheat;
      var act = btn.dataset.act;
      var c = Quest.cheatDef(id);

      if (act === 'toggle') {
        var st = await Quest.cheatStatus(id);
        var turnOn = !(st && st.state === 'on');
        if (turnOn && !confirm('确定要【开启】' + c.name + ' 吗？\n\n' + (c.desc || ''))) return;
        busy(btn, true, '⏳ 写入中…');
        try {
          await Quest.cheatApply(id, turnOn ? 'on' : 'off');
          var chk = await Quest.cheatStatus(id);
          toast((turnOn ? '✅ 已开启' : '✅ 已关闭') + '（回读：' + cheatStateText(c, chk) + '）', 3000);
        } catch (e) {
          toast('❌ 写入失败：' + e.message, 4000);
        }
        busy(btn, false);
        renderCheatPanel();
        return;
      }

      if (act === 'mode') {
        var mk = btn.dataset.mode;
        busy(btn, true, '⏳ 写入中…');
        try {
          await Quest.cheatApply(id, mk);
          var chk2 = await Quest.cheatStatus(id);
          toast('✅ 已切换（回读：' + cheatStateText(c, chk2) + '）', 3000);
        } catch (e) {
          toast('❌ 写入失败：' + e.message, 4000);
        }
        busy(btn, false);
        renderCheatPanel();
        return;
      }

      if (act === 'lock') {
        busy(btn, true, '⏳ 锁定中…');
        try {
          var r = await Quest.watchFreeze(id);
          var cnt = await Quest.watchCount();   // 回读验证（freezeCount 是读命令，会等回复）
          Quest.watchSetFrozen(id, true);
          toast('❄️ 已锁定 ' + c.name + ' = ' + c.value +
            '（地址 0x' + r.addr.toString(16).toUpperCase() + '，冻结数 ' + cnt + '）', 3500);
        } catch (e) {
          toast('❌ 锁定失败：' + e.message, 4000);
        }
        busy(btn, false);
        renderCheatPanel();
        return;
      }

      if (act === 'unlock') {
        busy(btn, true, '⏳ 解除中…');
        try {
          await Quest.watchUnfreeze(id);
          var cnt2 = await Quest.watchCount();
          Quest.watchSetFrozen(id, false);
          toast('🔥 已解除锁定（剩余冻结数 ' + cnt2 + '）', 2500);
        } catch (e) {
          toast('❌ 解除失败：' + e.message, 4000);
        }
        busy(btn, false);
        renderCheatPanel();
        return;
      }
    };
  });
}
window.openCheat = function () {
  renderCheatPanel().catch(function (e) { toast('打开失败：' + e.message, 4000); });
};

// ---------- 添加任务 ----------
// 空槽来源：文件模式看 Store，在线看 ALL
function findEmptySlot() {
  var all = findEmptySlots();
  return all.length ? all[0] : -1;
}

function findEmptySlots() {
  if (Store.getMode() === 'file') return Store.emptySlots();
  var used = {};
  for (var i = 0; i < ALL.length; i++) used[ALL[i].index] = true;
  var out = [];
  for (var s = 0; s < STRUCT.TASK_COUNT; s++) if (!used[s]) out.push(s);
  return out;
}

async function openAdd(slot) {
  // ⚠️ 按钮点击时 slot 收到的是 MouseEvent 对象，必须过滤成合法数字
  if (typeof slot !== 'number' || isNaN(slot)) {
    slot = findEmptySlot();
    if (slot < 0) {
      toast('没有空位了，请先删除一些任务', 4000);
      return;
    }
  }
  await buildAddSheet(slot);
}
/** 渲染"添加任务"面板（slot 可改，点 📋 重选） */
async function buildAddSheet(slot) {
  _addSlot = slot;

  // 读一次空槽的"遗留数据"（游戏删除只改了 3 个字段，其它还在）
  var q = {};
  try {
    if (Store.getMode() === 'file') {
      var slot0 = Store.getSlot(slot);
      if (slot0) q = Store.rawToFields(slot0.raw);
    } else {
      if (!BASE) BASE = await Quest.questBase();
      q = (await Quest.getQuest(BASE, slot)) || {};
    }
  } catch (e) { /* 读失败就按全 0 填 */ }

  // 每个字段的初值：用遗留数据；但 序号/编号/叹号 是"删除标记"，给合理默认
  // 🔢 「序号」默认用"序号计数器"当前值（跟游戏一致：游戏获得新怪异任务时也取用该值）
  var seqNow = Store.getSeqCounter();
  var seqDefault = (seqNow === null || seqNow === undefined) ? 1 : (seqNow >>> 0);
  // 🏷 「编号」默认 = 700000 + 空槽索引（实测规律：195/195 个非空槽都满足 编号==700000+槽）
  //     但保留可手动改（万一规律有个别例外，用户能纠正）
  var idDefault = STRUCT.TASK_ID_BASE + slot;
  function initVal(f) {
    if (f.name === '序号') {
      return seqDefault;   // ← 自动填计数器当前值（可手动改）
    }
    if (f.name === '编号') {
      // 万一同槽位的遗留数据里已有"合法且匹配当前槽"的编号，就用它；否则用规律值
      var n = q['编号'];
      if (typeof n === 'number' && n !== 0xFFFFFFFF && !isNaN(n) && n === idDefault) return n;
      return idDefault;    // ← 700000 + 槽索引（可手动改）
    }
    if (f.name === '叹号') {
      // ❗「叹号」= 新任务标记，添加新任务时一律默认 1（不沿用它槽的遗留数据）
      return 1;
    }
    var v = q[f.name];
    return (v === undefined || v === null) ? 0 : v;
  }

  // 字段值缓存：所有字段的"当前值（有符号显示值）"
  // 用途：简洁模式下"隐藏字段"没有输入框，但仍要参与联动/写入
  _addFieldVals = {};
  FIELDS.forEach(function (f) {
    var v = initVal(f);
    _addFieldVals[f.name] = (f.size === 4 || f.size === 1) ? toSigned(v, f.size) : v;
  });

  var simpleAdd = isSimpleMode();
  var rows = FIELDS.filter(function (f) {
    if (!simpleAdd) return true;
    return SIMPLE_FIELDS.indexOf(f.name) >= 0;
  }).map(function (f) {
    var v = initVal(f);                                    // 无符号位模式（用于查表）
    var disp = _addFieldVals[f.name];                      // 有符号（用于显示）
    var btn = '', nm = '';
    if (f.kind === 'mon') {
      btn = '<button class="pick" data-pick="mon" data-field="' + f.name + '">📋</button>';
      nm = '<span class="nm" id="anm-' + f.name + '">' + (v ? Quest.monName(v) : '') + '</span>';
    } else if (f.kind === 'map') {
      btn = '<button class="pick" data-pick="map" data-field="' + f.name + '">📋</button>';
      nm = '<span class="nm" id="anm-' + f.name + '">' + (v ? Quest.mapName(v) : '') + '</span>';
    } else if (f.kind === 'enum') {
      btn = '<button class="pick" data-pick="enum" data-enumkey="' + f.enum + '" data-field="' + f.name + '">📋</button>';
      nm = '<span class="hintv" id="anm-' + f.name + '">' + Quest.enumName(f.enum, v) + '</span>';
    } else {
      nm = '<span class="hintv" id="anm-' + f.name + '">' + (f.hint || '') + '</span>';
    }
    return '<div class="frow f"><label>' + f.name + '</label>' +
      '<input data-afield="' + f.name + '" value="' + disp + '"' + numAttrs(f) + ' />' +
      (btn || '<span class="nobtn"></span>') + nm + '</div>';
  }).join('');

  var empty = findEmptySlots();
  $('sheet').innerHTML =
    '<h2>➕ 添加任务</h2>' +
    '<div class="frow" style="border-bottom:1px solid var(--line)">' +
      '<label>空槽位</label>' +
      '<input type="number" id="addSlot" value="' + (slot + 1) + '" min="1" max="' + STRUCT.TASK_COUNT + '" />' +
      '<button class="pick" id="pickSlot">📋</button>' +
      '<span class="hintv" style="min-width:110px">第几个（1~' + STRUCT.TASK_COUNT + '）· 共 ' + empty.length + ' 个空槽</span>' +
    '</div>' +
    '<div class="sub" id="addSlotAddr">地址 ' +
      (BASE + slot * 0x74).toString(16).toUpperCase() + '</div>' +
    '<div class="hint" style="margin:0 0 12px">📥 <b>已读取该空槽遗留数据</b>，请在此基础上修改。<br>' +
    '🔢 <b>「序号」已自动填当前计数器值 ' + seqDefault + '</b>（游戏获得新怪异任务时也是取用该值），写入成功后会 +1 并写回游戏。<br>' +
    '🏷 <b>「编号」已自动填 ' + idDefault + '</b>（= 700000 + 槽位序号 ' + slot + '），也可手动改。<br>' +
    '💡 改「空槽位」或点 📋 换槽 → 会重新读遗留数据。<br>' +
    '🐉 点怪物 📋 选择 → 自动带等级（怪1用主等级，怪2~5/乱入用副等级）。</div>' +
    (simpleAdd
      ? '<div class="hint" style="margin:0 0 10px">⚡ <b>简洁模式</b>：只显示核心字段。' +
        '点怪物 📋 会<b>自动改对应等级</b>（等级不显示，但已写入）。' +
        '💾 写入时<b>所有 32 个字段都会写</b>（隐藏字段保持默认/遗留值）。</div>'
      : '') +
    '<div class="sec">字段（可改）' +
      '<button id="simToggleAdd" title="切换简洁/完整模式（会记住）" style="float:right;font-size:11px;padding:2px 8px;' +
        'border-radius:6px;border:1px solid var(--line);background:' +
        (simpleAdd ? 'var(--ok)' : '#21262d') + ';color:' +
        (simpleAdd ? '#04110a' : 'var(--sub)') + ';cursor:pointer">' +
        (simpleAdd ? '⚡ 简洁 : 开' : '⚡ 简洁 : 关') + '</button>' +
    '</div>' + rows +
    '<div class="sheet-actions">' +
    '<button id="addSave" style="width:100%">💾 写入该空槽</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();
  $('cancel').onclick = function () { hideOverlay(); };
  $('addSave').onclick = function () { saveAdd(parseInt($('addSlot').value, 10) - 1); };
  // 简洁/完整 切换
  var sta = $('simToggleAdd');
  if (sta) sta.onclick = function () {
    setSimpleMode(!isSimpleMode());
    toast(isSimpleMode() ? '✅ 简洁模式已开' : '✅ 完整模式已开', 2000);
    buildAddSheet(_addSlot);   // 立即重绘（保持当前槽）
  };

  // 换槽：手动改"第几个"（1~200），失焦时生效
  $('addSlot').addEventListener('change', function () {
    var s = parseInt($('addSlot').value, 10) - 1;   // 显示 1 起 → 内部 0 起
    if (isNaN(s) || s < 0 || s >= STRUCT.TASK_COUNT) { toast('范围 1~' + STRUCT.TASK_COUNT); return; }
    buildAddSheet(s);
  });
  $('pickSlot').onclick = function () { openSlotPicker(slot); };

  bindPickerRows($('sheet'), 'data-afield', 'anm-');
}

/** 空槽选择器：列出所有空槽，点一个就切过去 */
function openSlotPicker(cur) {
  var slots = findEmptySlots();
  _slotCur = cur;
  $('pkTitle').textContent = '选择空槽（共 ' + slots.length + ' 个）';
  $('pkSearch').value = '';
  $('pkSearch').oninput = function () { renderSlotPicker($('pkSearch').value.trim()); };
  renderSlotPicker('');
  $('picker').classList.add('show');
}
var _slotCur = -1;

/** 通用槽选择器：列出**全部 200 个槽**（含空槽），点一个就回调
   *  opts = { title, cur, withAddr, onPick }
   */
function openAnySlotPicker(opts) {
  opts = opts || {};
  _anyPickCb = opts.onPick || null;
  _anyCur = (typeof opts.cur === 'number') ? opts.cur : -1;
  $('pkTitle').textContent = opts.title || '选择槽位';
  $('pkSearch').value = '';
  $('pkSearch').oninput = function () { renderAnySlotPicker($('pkSearch').value.trim()); };
  renderAnySlotPicker('');
  $('picker').classList.add('show');
}
var _anyPickCb = null, _anyCur = -1;

/** 槽位状态：'空' 或 简要描述（怪/等级）*/
function slotLabel(s) {
  var q = null;
  if (Store.getMode() === 'file') {
    var sl = Store.getSlot(s);
    if (sl) { q = {}; for (var k in sl.fields) q[k] = sl.fields[k]; }
  } else {
    q = ALL.filter(function (x) { return x.index === s; })[0] || null;
  }
  if (!q) return { empty: true, txt: '空' };
  var lv = toSigned(q['等级'] >>> 0, 4);
  var m1 = q['怪1ID'] >>> 0;
  var nm = m1 ? Quest.monName(m1) : '无怪';
  return { empty: false, txt: nm + ' Lv' + lv };
}

function renderAnySlotPicker(kw) {
  injectPickerGridCss();   // 首次调用时注入网格样式（不改 index.html）
  var list = [];
  for (var s = 0; s < STRUCT.TASK_COUNT; s++) list.push(s);
  if (kw) {
    var k = kw.trim().toLowerCase();
    var kwNum = (/^[0-9]+$/.test(k)) ? parseInt(k, 10) : null;
    var kwHex = /^0x[0-9a-f]+$/.test(k) ? parseInt(k, 16) : null;
    list = list.filter(function (s) {
      // 支持：槽号（1起）/ 内部索引 / 编号 / 0x 十六进制
      if (String(s).indexOf(k) >= 0) return true;
      if (kwNum !== null && ((s + 1) === kwNum || (STRUCT.TASK_ID_BASE + s) === kwNum)) return true;
      return false;
    });
  }
  if (!list.length) { $('pkItems').innerHTML = '<div class="it">没有匹配的槽</div>'; return; }
  $('pkItems').innerHTML = '<div class="slotgrid">' + list.map(function (s) {
    var on = (s === _anyCur) ? ' on' : '';
    var lb = slotLabel(s);
    var m1 = 0, lv = 0, name = '';
    if (!lb.empty) {
      var q = null;
      if (Store.getMode() === 'file') {
        var sl = Store.getSlot(s);
        if (sl) q = sl.fields;
      } else {
        q = ALL.filter(function (x) { return x.index === s; })[0] || null;
      }
      if (q) { m1 = q['怪1ID'] >>> 0; lv = toSigned(q['等级'] >>> 0, 4); }
      name = m1 ? Quest.monName(m1) : '无怪';
    }
    var stars = !lb.empty && lv >= 100 ? (lv >= 300 ? '🔴' : '🟡') : '';
    return '<div class="slotcell' + on + '" data-slot="' + s + '">' +
      '<div class="sc-no">' + (s + 1) + '</div>' +
      (lb.empty
        ? '<div class="sc-name" style="opacity:.45">空槽</div>'
        : ('<div class="sc-name">' + (stars ? stars + ' ' : '') + escapeHtml(name) + '</div>' +
           '<div class="sc-lv">Lv' + lv + '</div>')) +
      '<div class="sc-id">' + (lb.empty ? '—' : (STRUCT.TASK_ID_BASE + s)) + '</div>' +
      '</div>';
  }).join('') + '</div>';
  $('pkItems').querySelectorAll('.slotcell').forEach(function (el) {
    el.onclick = function () {
      var s = parseInt(el.dataset.slot, 10);
      $('picker').classList.remove('show');
      if (_anyPickCb) _anyPickCb(s);
    };
  });
}

/** 注入"槽位网格"的样式（只注入一次），不改 index.html */
var _gridCssDone = false;
function injectPickerGridCss() {
  if (_gridCssDone) return;
  _gridCssDone = true;
  var st = document.createElement('style');
  st.textContent =
    '.slotgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));' +
      'gap:6px;padding:8px}' +
    '.slotcell{background:#1b2029;border:1px solid var(--line);border-radius:9px;' +
      'padding:7px 5px;text-align:center;cursor:pointer;' +
      'display:flex;flex-direction:column;justify-content:center;min-height:70px;' +
      '-webkit-tap-highlight-color:transparent}' +
    '.slotcell:active{transform:scale(.96)}' +
    '.slotcell.on{border-color:var(--accent);background:#1d2a3a;' +
      'box-shadow:0 0 0 1px var(--accent) inset}' +
    '.slotcell .sc-no{font-size:10px;color:var(--sub);line-height:1.2}' +
    '.slotcell .sc-name{font-size:11px;font-weight:600;line-height:1.25;' +
      'margin:2px 0;word-break:break-all}' +
    '.slotcell .sc-lv{font-size:10px;color:var(--ok);line-height:1.2}' +
    '.slotcell .sc-id{font-size:9px;color:var(--sub);opacity:.7;line-height:1.2}' +
    '.slotgrid .empty-tip{grid-column:1/-1;text-align:center;padding:20px;color:var(--sub)}' +
    /* ---- 怪物 / 地图 / 枚举 的二维网格 ---- */
    '.itemgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));' +
      'gap:7px;padding:8px}' +
    '.itemgrid.enum2{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}' +
    '.itemcell{background:#1b2029;border:1px solid var(--line);border-radius:9px;' +
      'padding:9px 11px;cursor:pointer;text-align:left;' +
      'display:flex;flex-direction:column;justify-content:center;gap:2px;' +
      '-webkit-tap-highlight-color:transparent}' +
    '.itemcell:active{transform:scale(.97)}' +
    '.itemcell:hover{border-color:var(--accent)}' +
    '.itemcell .ic-name{font-size:13px;font-weight:600;line-height:1.3;' +
      'word-break:break-all}' +
    '.itemcell .ic-sub{font-size:10px;color:var(--sub);line-height:1.3}' +
    '.itemcell .ic-id{font-size:10px;color:var(--sub);opacity:.75;line-height:1.3}' +
    '.itemcell.itemcell-none{border-style:dashed}';
  document.head.appendChild(st);
}

/** 极简 HTML 转义（怪名可能有特殊字符） */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' }[c];
  });
}

function renderSlotPicker(kw) {
  injectPickerGridCss();   // 网格样式
  var slots = findEmptySlots();
  // 搜索：既支持"第几个"(1起)，也支持内部索引(0起) / 编号 / 模糊数字
  if (kw) {
    var k = kw.trim().toLowerCase();
    var kwNum = (/^[0-9]+$/.test(k)) ? parseInt(k, 10) : null;
    slots = slots.filter(function (s) {
      if (String(s).indexOf(k) >= 0) return true;
      if (kwNum !== null && ((s + 1) === kwNum || (STRUCT.TASK_ID_BASE + s) === kwNum)) return true;
      return false;
    });
  }
  if (!slots.length) { $('pkItems').innerHTML = '<div class="it">没有空槽</div>'; return; }
  $('pkItems').innerHTML = '<div class="slotgrid">' + slots.map(function (s) {
    var on = (s === _slotCur) ? ' on' : '';
    return '<div class="slotcell' + on + '" data-slot="' + s + '">' +
      '<div class="sc-no">' + (s + 1) + '</div>' +
      '<div class="sc-name" style="opacity:.45">空槽</div>' +
      '<div class="sc-id">' + (STRUCT.TASK_ID_BASE + s) + '</div>' +
      '</div>';
  }).join('') + '</div>';
  $('pkItems').querySelectorAll('.slotcell').forEach(function (el) {
    el.onclick = function () {
      var s = parseInt(el.dataset.slot, 10);
      $('picker').classList.remove('show');
      buildAddSheet(s);
    };
  });
}

/** 找一个未被使用的编号（700000 起）
 *  备注：实测规律是"编号 == 700000 + 槽索引"，所以添加任务时通常直接用
 *        STRUCT.TASK_ID_BASE + slot 即可；本函数保留作后备（如规律有例外时）。 */
function nextFreeId() {
  var used = {};
  for (var i = 0; i < ALL.length; i++) used[ALL[i]['编号']] = true;
  for (var n = STRUCT.TASK_ID_BASE; n <= STRUCT.TASK_ID_BASE + STRUCT.TASK_COUNT; n++) {
    if (!used[n]) return n;
  }
  return STRUCT.TASK_ID_BASE;
}

var _addSlot = -1;

async function saveAdd(slot) {
  // 校验：目标槽必须是"空槽"（避免覆盖已有任务）
  if (isNaN(slot) || slot < 0 || slot >= STRUCT.TASK_COUNT) {
    toast('❌ 槽位必须在 1~' + STRUCT.TASK_COUNT + ' 之间', 4500);
    return;
  }
  var used = {};
  for (var u = 0; u < ALL.length; u++) used[ALL[u].index] = true;
  if (used[slot]) {
    toast('❌ 第 ' + (slot + 1) + ' 个槽已被占用（不是空槽），请换一个', 4500);
    return;
  }

  // ✅ 全字段都写：可见字段读输入框，隐藏字段（简洁模式）读 _addFieldVals 缓存
  var changes = [], vmap = {};
  FIELDS.forEach(function (f) {
    var inp = $('sheet').querySelector('input[data-afield="' + f.name + '"]');
    var v;
    if (inp) {
      v = inp.value;                                    // 可见字段
    } else if (_addFieldVals[f.name] !== undefined) {
      v = _addFieldVals[f.name];                        // 隐藏字段：缓存
    } else {
      v = 0;
    }
    var val = clampFieldVal(f, v);   // ← 夹到字段范围
    vmap[f.name] = val;
    changes.push({ off: f.off, size: f.size, value: val });
  });

  // 校验：编号必填 + 不重复
  var num = vmap['编号'] || 0;
  if (num < STRUCT.TASK_ID_BASE || num > STRUCT.TASK_ID_BASE + STRUCT.TASK_COUNT) {
    toast('❌ 编号必须是 ' + STRUCT.TASK_ID_BASE + ' ~ ' + (STRUCT.TASK_ID_BASE + STRUCT.TASK_COUNT) + ' 之间', 4500);
    return;
  }
  var dup = ALL.filter(function (x) { return x['编号'] === num; })[0];
  if (dup) { toast('❌ 编号 ' + num + ' 已存在（第 ' + (dup.index + 1) + ' 个）', 4500); return; }

  var btn = $('addSave');
  busy(btn, true, '⏳ 写入中…');
  try {
    if (Store.getMode() === 'file') {
      // 文件模式：本地写（把空槽变成有效任务）
      Store.setSlotFields(slot, changes);
      await bumpSeqCounter();   // 🔢 计数器 +1（只改本地）
      toast('✅ 已添加到文件（第 ' + (slot + 1) + ' 个，编号 ' + num + '）序号已 +1', 3000);
      busy(btn, false);
      hideOverlay();
      refreshFromStore();
      return;
    }
    if (!BASE) BASE = await Quest.questBase();
    var r = await Quest.setQuestFields(BASE, slot, changes);
    if (r.ok) {
      await bumpSeqCounter();   // 🔢 计数器 +1（在线：写回 Switch）
      toast('✅ 已写入第 ' + (slot + 1) + ' 个槽（编号 ' + num + '）序号已 +1', 3000);
    } else toast('⚠️ 写入后校验不一致，请检查', 4000);
  } catch (e) {
    toast('❌ 写入失败：' + e.message, 4000);
  }
  busy(btn, false);
  hideOverlay();
  load();
}

/** 🔢 序号计数器 +1（在线写回 Switch；文件模式只改本地） */
async function bumpSeqCounter() {
  var cur = Store.getSeqCounter();
  if (cur === null || cur === undefined) return;
  var next = (cur + 1) >>> 0;
  if (Store.getMode() === 'file') {
    Store.setSeqCounter(next);          // 只改本地（导出文件里带上）
    updateSeqStat();
    return;
  }
  try {
    var ok = await Quest.writeSeqCounter(next);   // 写回 Switch
    Store.setSeqCounter(ok ? next : cur);
    updateSeqStat();
  } catch (e) { /* 写失败就保持原值 */ }
}

// ---------- 导出 / 导入（备份 & 分享）----------

/** 导出当前数据源为 JSON 文件（秒出：数据已在内存里） */
function doExport() {
  if (!Store.getSlots().length) { toast('还没有数据，先加载或打开文件'); return; }
  var name = prompt('文件名（不含扩展名）：', '怪异任务_' + tsName());
  if (!name) return;
  name = name.replace(/[\\/:*?"<>|]/g, '_');
  if (!/\.json$/i.test(name)) name += '.json';

  try {
    var data = Store.toExport();
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    toast('✅ 已导出 ' + data.quests.length + ' 个槽 → ' + name, 3500);
  } catch (e) {
    toast('❌ 导出失败：' + e.message, 4000);
  }
}

function tsName() {
  var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
    p(d.getHours()) + p(d.getMinutes());
}

/** 上传到游戏：把当前数据（含文件编辑的）写进 Switch 内存 */
async function doWriteBack() {
  if (_busy) return;
  var slots = Store.getSlots();
  if (!slots.length) { toast('没有数据'); return; }

  // ⚠️ 上传只看"Switch 是否连上"，与数据来源（文件/在线）无关
  //    （以前这里错误地检查 Store.getMode()==='file' 就拦住，导致"打开了文件就传不回去"）
  try {
    var st = await Bridge.status();
    if (!st.connected) {
      toast('⚠️ 没连上 Switch。请确认：中转已启动 + 游戏已开 + 设置里的地址正确');
      return;
    }
  } catch (e) {
    toast('⚠️ 连不上中转：' + e.message + '（请先启动中转服务）', 4500);
    return;
  }

  if (!confirm('把当前 ' + slots.length + ' 个任务全部上传到游戏吗？\n\n⚠️ 会覆盖游戏里的任务！\n（大块写入，约 1~3 秒）')) return;
  setBusy(true);
  var btn = $('writeBackBtn');
  busy(btn, true, '⏳ 上传中…');
  var pb = $('progressbar'); pb.classList.add('show');
  pb.querySelector('.pbar-txt').textContent = '大块写入中…';
  pb.querySelector('.pbar-fill').style.width = '30%';
  try {
    BASE = await Quest.questBase();   // 上传必须重新定位（ASLR）
    if (!BASE) throw new Error('定位任务数组失败（游戏没开？）');
    var ok = await Quest.writeAllRaw(slots, function (c, t) {});
    pb.querySelector('.pbar-fill').style.width = '100%';
    pb.classList.remove('show');
    toast('✅ 已上传 ' + ok + ' 个任务到游戏', 3500);
  } catch (e) {
    pb.classList.remove('show');
    toast('❌ 上传失败：' + e.message, 4000);
  }
  busy(btn, false);
  setBusy(false);
  // 上传后：按当前数据源刷新（file 模式保持文件数据，不强行读回游戏）
  if (Store.getMode() === 'online') load();
  else refreshFromStore();
}

// 给"字段行"统一绑定 📋 选择器（前缀用于区分单任务编辑/添加）
function bindPickerRows(root, inputAttr, nmPrefix) {
  var isAdd = (nmPrefix === 'anm-');   // 添加任务面板
  var cache = isAdd ? _addFieldVals : _fieldVals;

  // 统一写值：有输入框就写框 + 缓存，没框（简洁模式隐藏字段）就只写缓存
  function setVal(fname, val) {
    cache[fname] = val;
    var inp = root.querySelector('input[' + inputAttr + '="' + fname + '"]');
    if (inp) { inp.value = val; flashEl(inp); }
    var nm = $(nmPrefix + fname);
    if (nm) {
      var ff = Quest.fieldByName(fname);
      if (ff && ff.kind === 'mon') nm.textContent = Quest.monName(val);
      else if (ff && ff.kind === 'map') nm.textContent = Quest.mapName(val);
      else if (ff && ff.kind === 'enum') nm.textContent = Quest.enumName(ff.enum, val);
    }
  }

  root.querySelectorAll('[data-pick]').forEach(function (b) {
    b.onclick = function () {
      var field = b.dataset.field, kind = b.dataset.pick;
      var f = Quest.fieldByName(field);
      if (kind === 'enum') {
        openEnumPicker(f.enum, function (val) { setVal(field, val); });
        return;
      }
      openPicker(kind, function (id) {
        setVal(field, id);
        // 【联动】选怪自动带等级（怪1 用主等级，怪2~5/乱入 用副等级）
        if (kind === 'mon') {
          var lv = MON_LEVELS[id];
          if (f && f.linked && lv) {
            var role = (f.slot === 1) ? 0 : 1;
            setVal(f.linked, lv[role]);
            var hasBox = !!root.querySelector('input[' + inputAttr + '="' + f.linked + '"]');
            var nmon = Quest.monName(id);
            if (lv[0] === 0 && lv[1] === 0) {
              toast('⚠️ ' + nmon + ' 无怪异等级，' + f.linked + ' 填 0', 2500);
            } else {
              toast('✅ ' + nmon + ' → ' + f.linked + ' = ' + lv[role] +
                (hasBox ? '' : '（已自动写入，可在完整模式查看）'), 2500);
            }
          }
        }
      });
    };
  });
  // 手改数值时同步缓存 + 刷新枚举名提示
  root.querySelectorAll('input[' + inputAttr + ']').forEach(function (inp) {
    inp.addEventListener('input', function () {
      var fname = inp.getAttribute(inputAttr);
      cache[fname] = inp.value;              // ← 同步到缓存
      var f = Quest.fieldByName(fname);
      var nm = $(nmPrefix + (f ? f.name : ''));
      if (!nm || !f || f.kind !== 'enum') return;
      nm.textContent = Quest.enumName(f.enum, parseInt(inp.value, 10) || 0);
    });
  });
}

// ---------- 选择器（怪物 / 地图 / 枚举）----------

var _pkCb = null, _pkKind = null, _pkEnumKey = null;

function openPicker(kind, cb) {
  _pkKind = kind; _pkCb = cb; _pkEnumKey = null;
  $('pkTitle').textContent = (kind === 'mon') ? '选择怪物' : '选择地图';
  $('pkSearch').value = '';
  renderPicker('');
  $('picker').classList.add('show');
  $('pkSearch').oninput = function () { renderPicker($('pkSearch').value.trim()); };
  // 不自动聚焦（避免弹键盘）
}
function openEnumPicker(enumKey, cb) {
  _pkKind = 'enum'; _pkCb = cb; _pkEnumKey = enumKey;
  $('pkTitle').textContent = '选择「' + enumKey + '」';
  $('pkSearch').value = '';
  renderPicker('');
  $('picker').classList.add('show');
  $('pkSearch').oninput = function () { renderPicker($('pkSearch').value.trim()); };
  // 不自动聚焦（避免弹键盘）
}
function renderPicker(kw) {
  injectPickerGridCss();   // 确保网格样式已注入
  var html = '';
  if (_pkKind === 'enum') {
    // ---- 枚举：2 列格子 ----
    var en = ENUMS[_pkEnumKey] || {};
    var list = Object.keys(en).map(function (k) { return { id: k, name: en[k] }; });
    if (kw) { list = filterByIdName(list, kw); }
    html = '<div class="itemgrid enum2">' + list.map(function (o) {
      return '<div class="itemcell" data-id="' + o.id + '">' +
        '<div class="ic-name">' + escapeHtml(o.name) + '</div>' +
        '<div class="ic-id">' + o.id + '</div>' +
        '</div>';
    }).join('') + '</div>';
  } else {
    // ---- 怪物 / 地图：2 列格子 ----
    var table = (_pkKind === 'mon') ? MONSTERS : MAPS;
    var lst = Object.keys(table).map(function (k) { return { id: k, name: table[k] }; });
    if (kw) { lst = filterByIdName(lst, kw); }
    lst.sort(function (a, b) { return (+a.id) - (+b.id); });
    // "无 (0)" 只在没搜索时显示（搜索时避免干扰）
    var cells = '';
    if (!kw) {
      cells += '<div class="itemcell itemcell-none" data-id="0">' +
        '<div class="ic-name" style="opacity:.6">— 无 —</div>' +
        '<div class="ic-id">0</div></div>';
    }
    cells += lst.map(function (o) {
      var lv = (_pkKind === 'mon') ? MON_LEVELS[o.id] : null;
      var lvTxt = (lv && (lv[0] || lv[1])) ? ('主' + lv[0] + '/副' + lv[1]) : '';
      return '<div class="itemcell" data-id="' + o.id + '">' +
        '<div class="ic-name">' + escapeHtml(o.name) + '</div>' +
        '<div class="ic-sub">' + (lvTxt ? (lvTxt + ' · ') : '') +
          '0x' + (+o.id).toString(16).toUpperCase() + '</div>' +
        '</div>';
    }).join('');
    html = '<div class="itemgrid">' + cells + '</div>';
    if (!lst.length) html = '<div class="it">没有匹配的结果</div>';
  }
  $('pkItems').innerHTML = html;
  $('pkItems').querySelectorAll('.itemcell').forEach(function (el) {
    el.onclick = function () {
      var id = parseInt(el.dataset.id, 10);
      if (_pkCb) _pkCb(id);
      $('picker').classList.remove('show');
    };
  });
}

/** 选择器搜索：支持「名字」/「十进制ID」/「0x十六进制ID」 */
function filterByIdName(list, kw) {
  var k = kw.trim().toLowerCase();
  if (!k) return list;
  // 如果输入像 0x 开头的十六进制，或纯数字，就按数值匹配
  var num = null;
  if (/^0x[0-9a-f]+$/.test(k)) num = parseInt(k, 16);
  else if (/^[0-9]+$/.test(k)) num = parseInt(k, 10);

  return list.filter(function (o) {
    // 名字匹配
    if (o.name.toLowerCase().indexOf(k) >= 0) return true;
    // ID 匹配（十进制字符串 / 十六进制字符串都试）
    var idn = +o.id;
    var idHex = idn.toString(16).toLowerCase();
    if (String(o.id).indexOf(k) >= 0) return true;
    if (idHex.indexOf(k) >= 0) return true;
    if (num !== null && idn === num) return true;
    return false;
  });
}

// ---------- 设置中转地址（面板，可测试连接）----------

function cfgAddr() {
  $('sheet').innerHTML =
    '<h2>⚙️ 中转地址</h2>' +
    '<div class="sub">中转（Termux 里跑的 中转服务.py）的地址</div>' +
    '<div class="frow"><label>地址</label>' +
    '<input id="cfgUrl" type="text" inputmode="url" style="width:auto;flex:1;text-align:left" ' +
    'value="' + Bridge.getBase() + '" placeholder="http://127.0.0.1:6001" /></div>' +
    '<div class="hint">' +
    '• 手机浏览器直接开中转网页：填 <b>http://127.0.0.1:6001</b>（中转和浏览器同环境）<br>' +
    '• 从别的 App / 别的设备访问：填 <b>http://手机局域网IP:6001</b>（如 http://192.168.1.5:6001）<br>' +
    '• 不带端口默认 6001' +
    '</div>' +
    '<div id="cfgTest" class="hint" style="min-height:20px"></div>' +
    '<div class="sec">危险操作</div>' +
    '<div class="hint" style="margin:4px 0 8px">游戏要求至少保留 1 个任务，所以只会留下<b>最靠前的那个</b>。</div>' +
    '<div class="sheet-actions">' +
    '<button id="cfgSave" style="width:100%">💾 保存并重连</button>' +
    '<button class="ghost" id="cfgTestBtn" style="margin-top:8px;width:100%">🔍 测试连接</button>' +
    '<button class="ghost" id="cfgClear" style="margin-top:8px;width:100%;color:var(--err);border-color:var(--err)">🧨 清空所有任务（保留 1 个）</button>' +
    '<button class="ghost" id="cfgRestore" style="margin-top:8px;width:100%">♻️ 恢复所有已删除任务</button>' +
    '<button class="ghost" id="cfgCancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();
  $('cfgCancel').onclick = function () { hideOverlay(); };
  $('cfgTestBtn').onclick = testCfg;
  $('cfgClear').onclick = function () { hideOverlay(); clearAllQuests(); };
  $('cfgRestore').onclick = function () { hideOverlay(); restoreAllQuests(); };
  $('cfgSave').onclick = function () {
    var u = ($('cfgUrl').value || '').trim();
    if (!u) { toast('请填写地址'); return; }
    if (!/^https?:\/\//.test(u)) u = 'http://' + u;         // 自动补协议
    if (!/:\d+$/.test(u)) u = u.replace(/\/+$/, '') + ':6001'; // 没端口补 6001
    Bridge.setBase(u);
    hideOverlay();
    toast('已保存：' + u);
    load();
  };
}
window.cfgAddr = cfgAddr;   // 供内联 onclick 调用

async function testCfg() {
  var u = ($('cfgUrl').value || '').trim();
  if (!u) { toast('请填写地址'); return; }
  if (!/^https?:\/\//.test(u)) u = 'http://' + u;
  if (!/:\d+$/.test(u)) u = u.replace(/\/+$/, '') + ':6001';
  var box = $('cfgTest');
  box.innerHTML = '⏳ 测试中…';
  try {
    var r = await fetch(u.replace(/\/+$/, '') + '/status');
    var j = await r.json();
    if (j.ok && j.connected) box.innerHTML = '✅ 通了！中转在线，Switch 也连上了（' + j.ip + ':' + j.port + '）';
    else if (j.ok) box.innerHTML = '⚠️ 中转通了，但 Switch 没连上（检查游戏是否开着）';
    else box.innerHTML = '❓ 有响应但格式不对：' + JSON.stringify(j);
  } catch (e) {
    box.innerHTML = '❌ 连不上：' + e.message + '<br>（地址对了吗？中转在跑吗？）';
  }
}

// ---------- 版本号 & 更新 ----------

/** 显示版本号；点击 = 检查更新（重新拉取页面 / 让 Service Worker 刷新）*/
function initVersion() {
  var el = $('verEl');
  if (!el) return;
  var cur = (typeof APP_VERSION !== 'undefined') ? APP_VERSION : 'v?';
  el.textContent = cur;
  el.title = '当前 ' + cur + '（点击检查更新）';

  el.onclick = function () {
    el.textContent = '检查中…';
    checkUpdate().then(function (r) {
      if (r.updated) {
        el.textContent = '🔄 更新中…';
        // 稍等一下让用户看到，再刷新
        setTimeout(function () { doReload(); }, 500);
      } else {
        el.textContent = cur;
        if (r.msg) toast(r.msg, 3000);
      }
    }).catch(function () {
      el.textContent = cur;
      doReload();
    });
  };
}

/** 检查更新：
 *  ① 问一遍 index.html（拿最新内联版本，比对 APP_VERSION）
 *  ② 不等结果也能强刷 —— 用户手动点就是要更新
 */
async function checkUpdate() {
  try {
    var base = Bridge.getBase().replace(/\/+$/, '');
    var r = await fetch(base + '/?_t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { updated: true, msg: '' };
    var html = await r.text();
    // 从页面里抓 APP_VERSION
    var m = html.match(/var\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    var cur = (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '';
    if (m && m[1] && cur && m[1] !== cur) {
      return { updated: true, msg: '发现新版本 ' + m[1] };
    }
  } catch (e) { /* 拉不到就直接刷新 */ }
  // 没发现版本变化，也提示一下（并允许顺手刷新）
  return { updated: false, msg: '已是最新（' + ((typeof APP_VERSION !== 'undefined') ? APP_VERSION : '?') + '）' };
}

/** 强制刷新：清 SW 缓存后 reload */
function doReload() {
  var done = false;
  function go() { if (!done) { done = true; location.reload(); } }
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      // 通知 SW 清缓存，然后刷新
      navigator.serviceWorker.controller.postMessage({ type: 'skip-waiting-clear' });
      setTimeout(go, 300);
      return;
    }
  } catch (e) { /* ignore */ }
  go();
}

// ---------- 事件绑定 ----------

document.addEventListener('DOMContentLoaded', function () {
  // JS 跑到了 → 隐藏"JS没执行"警告
  var jc = $('jsCheck');
  if (jc) jc.style.display = 'none';
  // 版本号：显示 + 点击检查更新
  initVersion();

  // 全局错误捕获：任何 JS 错误直接显示出来（方便排查）
  window.addEventListener('error', function (e) {
    var b = document.getElementById('errBox');
    if (!b) {
      b = document.createElement('div');
      b.id = 'errBox';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#f85149;color:#fff;padding:8px 12px;font-size:12px;white-space:pre-wrap';
      document.body.appendChild(b);
    }
    b.textContent = '⚠️ JS 错误：' + e.message + '  (' + (e.filename || '') + ':' + (e.lineno || '') + ')';
  });

  // 逐个绑定（每个都 try，避免一个失败挡住后面）
  function bind(id, fn) {
    try {
      var el = $(id);
      if (!el) { console.warn('缺少元素 #' + id); return; }
      el.addEventListener('click', fn);
    } catch (err) { console.error('绑定 ' + id + ' 失败: ' + err); }
  }

  bind('list', function (e) {
    // 先判断是不是点了删除按钮
    var del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); delQuest(parseInt(del.dataset.del, 10)); return; }
    var el = e.target.closest('.q');
    if (el) openQuest(parseInt(el.dataset.idx, 10));
  });
  bind('search', function () { render(); });   // 改为 click/input
  $('search').addEventListener('input', render);
  $('sort').addEventListener('change', render);
  bind('reload', load);
  bind('shotBtn', shotScreen);                 // 📷 截取 NS 屏幕
  bind('swapBtn', openSwap);                   // 🔄 交换两个任务
  bind('filterBtn', openFilter);               // 🔎 筛选面板
  bind('addBtn', function () { openAdd(); });   // ⚠️ 不传事件对象，让 openAdd 自己找第一个空槽
  bind('batch', openBatch);
  bind('exportBtn', doExport);
  bind('openBtn', openDataFile);
  bind('writeBackBtn', doWriteBack);
  bind('cfgBtn', cfgAddr);
  bind('seqStat', editSeqCounter);

  // 🎮 动态注入「金手指」按钮（不改 index.html）
  (function injectCheatBtn() {
    var bar = $('swapBtn') ? $('swapBtn').parentNode : null;
    if (!bar || $('cheatBtn')) return;
    var b = document.createElement('button');
    b.id = 'cheatBtn';
    b.className = 'ghost warn';
    b.textContent = '🎮 金手指';
    // 插在「交换任务」后面
    var anchor = $('swapBtn');
    if (anchor && anchor.nextSibling) bar.insertBefore(b, anchor.nextSibling);
    else bar.appendChild(b);
    b.onclick = openCheat;
  })();

  $('overlay').addEventListener('click', function (e) {
    if (e.target.id === 'overlay') closeOverlay();
  });
  $('picker').addEventListener('click', function (e) {
    if (e.target.id === 'picker') $('picker').classList.remove('show');
  });

  load();
});