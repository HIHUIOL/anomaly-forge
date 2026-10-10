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
  lockBodyScroll();
}
/** 关闭遮罩弹窗（自动恢复背景滚动位置）*/
function hideOverlay() {
  $('overlay').classList.remove('show');
  unlockBodyScroll();
}
/** 兜底：如果遮罩已隐藏但 body 还锁着，强制解锁（防卡死）*/
function ensureUnlocked() {
  var ov = $('overlay');
  if (ov && !ov.classList.contains('show')) unlockBodyScroll();
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
  var ids = ['reload', 'addBtn', 'batch', 'exportBtn', 'openBtn', 'writeBackBtn', 'cfgBtn'];
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
  pb.classList.add('show');
  pb.querySelector('.pbar-txt').textContent = '定位任务数组…';
  pb.querySelector('.pbar-fill').style.width = '0%';
  try {
    var st = await Bridge.status();
    if (!st.connected) { setDot('err', 'Switch 未连接'); }
    Mem.resetCache();

    await Store.loadFromSwitch(function (cur, total) {
      var pct = Math.round(cur / total * 100);
      pb.querySelector('.pbar-txt').textContent = '读取中 ' + cur + '/' + total +
        '（' + pct + '%，约剩 ' + Math.round((total - cur) * 0.11) + ' 秒）';
      pb.querySelector('.pbar-fill').style.width = pct + '%';
    });
    BASE = await Quest.questBase();
    ALL = Store.validTasks();
    setDot('ok', ALL.length + ' 个任务 · ' + st.ip + ':' + st.port);
    pb.classList.remove('show');
    updateModeTag();
    updateSeqStat();
    render();
  } catch (e) {
    pb.classList.remove('show');
    setDot('err', '未连接中转');
    $('loading').style.display = 'block';
    $('loading').innerHTML = '❌ 连不上中转<br><br>' +
      '当前地址：<b>' + Bridge.getBase() + '</b><br>' +
      '错误：' + e.message + '<br><br>' +
      '<button onclick="cfgAddr()">⚙️ 修改中转地址</button><br><br>' +
      '👉 或者点「📥 打开文件」，离线编辑任务文件（不需要 NS）';
  } finally {
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

  var rows = FIELDS.map(function (f) {
    var v = q[f.name] !== undefined ? q[f.name] : 0;   // 无符号位模式（用于查表）
    var disp = (f.size === 4 || f.size === 1) ? toSigned(v, f.size) : v;   // 有符号（用于显示）
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
    '<div class="sec">字段（均显示原始值，可直接改）</div>' + rows +
    '<div class="hint">⚠️ 保存只写入<b>这一个任务</b>。<br>' +
    '🐉 <b>点怪物的 📋 选择</b> → 自动把该怪等级填到对应「怪N级」（怪1用主等级，怪2~5/乱入用副等级）；<b>手动改 ID 不会</b>动等级。</div>' +
    '<div class="sheet-actions">' +
    '<button id="save" style="width:100%">💾 保存此任务</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();
  $('cancel').onclick = function () { hideOverlay(); };
  $('save').onclick = function () { saveOne(idx); };

  // 选择按钮
  $('sheet').querySelectorAll('[data-pick]').forEach(function (b) {
    b.onclick = function () {
      var field = b.dataset.field, kind = b.dataset.pick;
      var f = Quest.fieldByName(field);
      if (kind === 'enum') {
        openEnumPicker(f.enum, function (val) {
          var inp = $('sheet').querySelector('input[data-field="' + field + '"]');
          if (inp) inp.value = val;
          var nm = $('nm-' + field); if (nm) nm.textContent = Quest.enumName(f.enum, val);
        });
        return;
      }
      openPicker(kind, function (id) {
        var inp = $('sheet').querySelector('input[data-field="' + field + '"]');
        if (inp) inp.value = id;
        var nm = $('nm-' + field);
        if (nm) nm.textContent = (kind === 'mon') ? Quest.monName(id) : Quest.mapName(id);
        // 【联动】选怪自动带等级（含"无怪"(id=0) → 主/副都填 11）
        if (kind === 'mon') {
          var lv = MON_LEVELS[id];
          if (f && f.linked && lv) {
            var role = (f.slot === 1) ? 0 : 1;
            var lvinp = $('sheet').querySelector('input[data-field="' + f.linked + '"]');
            if (lvinp) lvinp.value = lv[role];
          }
        }
      });
    };
  });
  // 手改枚举提示
  $('sheet').querySelectorAll('input[data-field]').forEach(function (inp) {
    inp.addEventListener('input', function () {
      var f = Quest.fieldByName(inp.dataset.field);
      var nm = $('nm-' + inp.dataset.field);
      if (!nm || !f || f.kind !== 'enum') return;
      nm.textContent = Quest.enumName(f.enum, parseInt(inp.value, 10) || 0);
    });
  });
}

async function saveOne(idx) {
  var inputs = [].slice.call($('sheet').querySelectorAll('input[data-field]'));
  var changes = [];
  inputs.forEach(function (el) {
    var f = Quest.fieldByName(el.dataset.field); if (!f) return;
    var val = clampFieldVal(f, el.value);   // ← 夹到字段范围（防超限写坏内存）
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
      // 同步更新本地缓存
      var slot = Store.getSlot(idx);
      if (slot) { /* 下次 load 会重新读，无需手动同步 */ }
    } else toast('⚠️ 写入后校验不一致，请检查', 4000);
  } catch (e) {
    toast('❌ 保存失败：' + e.message, 4000);
  }
  busy(btn, false);
  if (Store.getMode() !== 'file') openQuest(idx);
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

  var rows = FIELDS.map(function (f) {
    var v = initVal(f);                                    // 无符号位模式（用于查表）
    var disp = (f.size === 4 || f.size === 1) ? toSigned(v, f.size) : v;   // 有符号（用于显示）
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
    '<div class="sec">字段（可改）</div>' + rows +
    '<div class="sheet-actions">' +
    '<button id="addSave" style="width:100%">💾 写入该空槽</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  showOverlay();
  $('cancel').onclick = function () { hideOverlay(); };
  $('addSave').onclick = function () { saveAdd(parseInt($('addSlot').value, 10) - 1); };

  // 换槽：手动改"第几个"（1~200），失焦时生效
  $('addSlot').addEventListener('change', function () {
    var s = parseInt($('addSlot').value, 10) - 1;   // 显示 1 起 → 内部 0 起
    if (isNaN(s) || s < 0 || s >= STRUCT.TASK_COUNT) { toast('范围 1~' + STRUCT.TASK_COUNT); return; }
    buildAddSheet(s);
  });
  $('pickSlot').onclick = function () { openSlotPicker(slot); };

  bindPickerRows($('sheet'), 'afield', 'anm-');
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

function renderSlotPicker(kw) {
  var slots = findEmptySlots();
  // 搜索：既支持"第几个"(1起)，也支持内部索引(0起)
  if (kw) {
    var kwNum = parseInt(kw, 10);
    slots = slots.filter(function (s) {
      return String(s).indexOf(kw) >= 0 || (!isNaN(kwNum) && (s + 1) === kwNum);
    });
  }
  if (!slots.length) { $('pkItems').innerHTML = '<div class="it">没有空槽</div>'; return; }
  $('pkItems').innerHTML = slots.map(function (s) {
    var on = (s === _slotCur) ? ' on' : '';
    return '<div class="it slot-it' + on + '" data-slot="' + s + '">' +
      '<span>第 ' + (s + 1) + ' 个</span>' +
      '<span class="id">' + (BASE + s * 0x74).toString(16).toUpperCase() + '</span></div>';
  }).join('');
  $('pkItems').querySelectorAll('.slot-it').forEach(function (el) {
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

  var inputs = [].slice.call($('sheet').querySelectorAll('input[data-afield]'));
  var changes = [], vmap = {};
  inputs.forEach(function (el) {
    var f = Quest.fieldByName(el.dataset.afield); if (!f) return;
    var val = clampFieldVal(f, el.value);   // ← 夹到字段范围
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
  root.querySelectorAll('[data-pick]').forEach(function (b) {
    b.onclick = function () {
      var field = b.dataset.field, kind = b.dataset.pick;
      var f = Quest.fieldByName(field);
      if (kind === 'enum') {
        openEnumPicker(f.enum, function (val) {
          var inp = root.querySelector('input[' + inputAttr + '="' + field + '"]');
          if (inp) inp.value = val;
          var nm = $(nmPrefix + field); if (nm) nm.textContent = Quest.enumName(f.enum, val);
        });
        return;
      }
      openPicker(kind, function (id) {
        var inp = root.querySelector('input[' + inputAttr + '="' + field + '"]');
        if (inp) inp.value = id;
        var nm = $(nmPrefix + field);
        if (nm) nm.textContent = (kind === 'mon') ? Quest.monName(id) : Quest.mapName(id);
        if (kind === 'mon') {
          var lv = MON_LEVELS[id];
          if (f && f.linked && lv) {
            var role = (f.slot === 1) ? 0 : 1;
            var lvinp = root.querySelector('input[' + inputAttr + '="' + f.linked + '"]');
            if (lvinp) lvinp.value = lv[role];
          }
        }
      });
    };
  });
  // 手改数值时刷新枚举名提示
  root.querySelectorAll('input[' + inputAttr + ']').forEach(function (inp) {
    inp.addEventListener('input', function () {
      var f = Quest.fieldByName(inp.getAttribute(inputAttr));
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
  var html = '';
  if (_pkKind === 'enum') {
    var en = ENUMS[_pkEnumKey] || {};
    var list = Object.keys(en).map(function (k) { return { id: k, name: en[k] }; });
    if (kw) { kw = kw.toLowerCase(); list = list.filter(function (o) { return o.name.toLowerCase().indexOf(kw) >= 0 || String(o.id).indexOf(kw) >= 0; }); }
    html = list.map(function (o) {
      return '<div class="it" data-id="' + o.id + '"><span>' + o.name + '</span><span class="id">' + o.id + '</span></div>';
    }).join('');
  } else {
    var table = (_pkKind === 'mon') ? MONSTERS : MAPS;
    var lst = Object.keys(table).map(function (k) { return { id: k, name: table[k] }; });
    if (kw) { kw = kw.toLowerCase(); lst = lst.filter(function (o) { return o.name.toLowerCase().indexOf(kw) >= 0 || String(o.id).indexOf(kw) >= 0; }); }
    lst.sort(function (a, b) { return (+a.id) - (+b.id); });
    html = '<div class="it" data-id="0"><span>— 无 (0) —</span><span class="id">0</span></div>';
    html += lst.map(function (o) {
      var lv = (_pkKind === 'mon') ? MON_LEVELS[o.id] : null;
      var lvTxt = lv ? ('主' + lv[0] + '/副' + lv[1]) : '';
      return '<div class="it" data-id="' + o.id + '"><span>' + o.name +
        (lvTxt ? (' <span class="id">' + lvTxt + '</span>') : '') + '</span>' +
        '<span class="id">' + o.id + ' (0x' + (+o.id).toString(16).toUpperCase() + ')</span></div>';
    }).join('');
  }
  $('pkItems').innerHTML = html;
  $('pkItems').querySelectorAll('.it').forEach(function (el) {
    el.onclick = function () {
      var id = parseInt(el.dataset.id, 10);
      if (_pkCb) _pkCb(id);
      $('picker').classList.remove('show');
    };
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
  bind('filterBtn', openFilter);               // 🔎 筛选面板
  bind('addBtn', function () { openAdd(); });   // ⚠️ 不传事件对象，让 openAdd 自己找第一个空槽
  bind('batch', openBatch);
  bind('exportBtn', doExport);
  bind('openBtn', openDataFile);
  bind('writeBackBtn', doWriteBack);
  bind('cfgBtn', cfgAddr);
  bind('seqStat', editSeqCounter);

  $('overlay').addEventListener('click', function (e) {
    if (e.target.id === 'overlay') hideOverlay();
  });
  $('picker').addEventListener('click', function (e) {
    if (e.target.id === 'picker') $('picker').classList.remove('show');
  });

  load();
});