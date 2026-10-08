/* ============================================================
 * app.js —— 界面逻辑（渲染、编辑、选择器、批量）
 * 依赖：data.js / bridge.js / memory.js / quest.js
 * ============================================================ */

var $ = function (id) { return document.getElementById(id); };
var ALL = [];      // 已读取的任务
var BASE = null;   // 任务数组基址（缓存）

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
  render();
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

function render() {
  var kw = $('search').value.trim().toLowerCase();
  var arr = ALL.slice();
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
  arr.sort(function (a, b) { return (a[field] - b[field]) * dir; });

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
    var weird = (q['怪1级'] || 0) + 1;

    return '<div class="q" data-idx="' + q.index + '">' +
      '<button class="del" data-del="' + q.index + '" title="删除此任务">🗑️</button>' +
      '<div class="top"><span class="no">#' + q['编号'] + '</span>' +
      '<span class="idx">序号 ' + q['序号'] + ' · 内存#' + q.index + '</span>' +
      '<span class="lv">怪异 ' + weird + '★</span></div>' +
      '<div class="map">🗺️ ' + Quest.mapName(q['地图']) + ' · Lv' + q['等级'] +
        ' · ' + q['时间限制'] + '分 · 猫车' + q['猫车'] + ' · ' + q['人数'] + '人</div>' +
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
    var v = q[f.name] !== undefined ? q[f.name] : 0;
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
    return '<div class="frow"><label>' + f.name + '</label>' +
      '<input type="number" data-field="' + f.name + '" value="' + v + '" />' + btn + nm + '</div>';
  }).join('');

  $('sheet').innerHTML =
    '<h2>任务 #' + q['编号'] + '</h2>' +
    '<div class="sub">索引 ' + q.index + ' · 地址 ' + q.addr + '</div>' +
    '<div class="sec">字段（均显示原始值，可直接改）</div>' + rows +
    '<div class="hint">⚠️ 保存只写入<b>这一个任务</b>。<br>' +
    '🐉 <b>点怪物的 📋 选择</b> → 自动把该怪等级填到对应「怪N级」（怪1用主等级，怪2~5/乱入用副等级）；<b>手动改 ID 不会</b>动等级。</div>' +
    '<div style="margin-top:16px">' +
    '<button id="save" style="width:100%">💾 保存此任务</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  $('overlay').classList.add('show');
  $('cancel').onclick = function () { $('overlay').classList.remove('show'); };
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
        // 【联动】选怪自动带等级
        if (kind === 'mon' && id) {
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
    var val = parseInt(el.value, 10);
    if (isNaN(val)) return;
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
    extra = '<span class="hintv">' + (f.hint || '') + '</span>';
  }
  return '<div class="frow"><label>改成</label>' +
    '<input type="number" id="bValue" value="' + val + '" />' + extra + '</div>';
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

/** 默认值：不同字段给个合理的初始值 */
function batchDefaultValue(f) {
  if (f.kind === 'enum') return parseInt(Object.keys(ENUMS[f.enum])[0], 10);
  if (f.kind === 'mon') return 1;
  if (f.kind === 'map') return 1;
  return 300;
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
    '<div class="frow"><label>逐个累加</label>' +
    '<input type="checkbox" id="bInc" style="width:auto;flex:none" />' +
    '<span class="hintv">勾上后：第1个=改成值，之后每个 +1</span></div>' +
    '<div class="frow"><label>范围</label><select id="bRange" style="width:150px">' +
    '<option value="all">全部（' + ALL.length + ' 个）</option>' +
    '<option value="ids">任务编号区间</option>' +
    '</select></div>' +
    '<div id="bIdRange" style="display:none">' +
    '<div class="frow"><label>编号起</label><input type="number" id="bFrom" value="700000" /></div>' +
    '<div class="frow"><label>编号止</label><input type="number" id="bTo" value="700199" /></div>' +
    '</div>' +
    '<div class="hint">⚠️ 会一次改多个任务，每个约 1.5 秒，请确认无误再点。</div>' +
    '<div style="margin-top:16px">' +
    '<button id="bGo" class="warn" style="width:100%">⚡ 开始批量修改</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  $('overlay').classList.add('show');
  $('cancel').onclick = function () { $('overlay').classList.remove('show'); };

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
  $('bGo').onclick = doBatch;
}

async function doBatch() {
  if (_busy) return;
  var f = Quest.fieldByName($('bField').value);
  if (!f) { toast('字段无效'); return; }
  var value = parseInt($('bValue').value, 10) || 0;
  var inc = $('bInc').checked;   // 逐个累加
  var idxs;
  if ($('bRange').value === 'ids') {
    var from = parseInt($('bFrom').value, 10), to = parseInt($('bTo').value, 10);
    idxs = ALL.filter(function (q) { return q['编号'] >= from && q['编号'] <= to; })
      .map(function (q) { return q.index; });
    if (!idxs.length) { toast('没有匹配的任务'); return; }
  } else {
    idxs = ALL.map(function (q) { return q.index; });
  }
  // 按索引升序，累加才有稳定顺序
  if (inc) idxs.sort(function (a, b) { return a - b; });

  var tip = inc
    ? '确定把 ' + idxs.length + ' 个任务的「' + f.name + '」从 ' + value + ' 开始逐个 +1 吗？\n约需 ' + Math.round(idxs.length * 1.6) + ' 秒。'
    : '确定把 ' + idxs.length + ' 个任务的「' + f.name + '」改成 ' + value + ' 吗？\n约需 ' + Math.round(idxs.length * 1.6) + ' 秒。';
  if (!confirm(tip)) return;

  var btn = $('bGo');
  busy(btn, true, '⏳ 修改中 0/' + idxs.length);
  setBusy(true);
  btn.disabled = true;
  try {
    if (!BASE) BASE = await Quest.questBase();
    var ok = 0;
    if (inc) {
      // 逐个累加：构造每个索引对应的值，一次大块写
      var vals = {};
      for (var i = 0; i < idxs.length; i++) vals[idxs[i]] = value + i;
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
    toast('✅ 批量完成：' + ok + '/' + idxs.length + ' 个成功', 3500);
  } catch (e) {
    toast('❌ 批量失败：' + e.message, 4000);
  }
  busy(btn, false);
  setBusy(false);              // 先解锁，load() 里要检查 _busy
  $('overlay').classList.remove('show');
  // 文件模式不重新读内存，只刷新列表
  if (Store.getMode() === 'file') { ALL = Store.validTasks(); render(); }
  else load();   // 重新拉取
}

// ---------- 删除任务 ----------
// 游戏"删除"的做法：把 序号(0x00)、编号(0x04) 写成 0xFFFFFFFF，叹号(0x68) 写成 256
var DEL_MARK = 0xFFFFFFFF;

async function delQuest(idx) {
  var q = ALL.filter(function (x) { return x.index === idx; })[0];
  var label = q ? ('#' + q['编号']) : ('索引 ' + idx);
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
  if (slot === undefined) {
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
  function initVal(f) {
    if (f.name === '序号') {
      var s = q['序号'];
      return (s === undefined || s === 0xFFFFFFFF) ? 1 : s;
    }
    if (f.name === '编号') {
      var n = q['编号'];
      // 编号被删标记占用了 → 给一个未用的编号
      if (n === undefined || n === 0xFFFFFFFF || isNaN(n)) return nextFreeId();
      return n;
    }
    if (f.name === '叹号') {
      var e = q['叹号'];
      return (e === undefined || e === 256) ? 0 : e;
    }
    var v = q[f.name];
    return (v === undefined || v === null) ? 0 : v;
  }

  var rows = FIELDS.map(function (f) {
    var v = initVal(f);
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
    return '<div class="frow"><label>' + f.name + '</label>' +
      '<input type="number" data-afield="' + f.name + '" value="' + v + '" />' + btn + nm + '</div>';
  }).join('');

  var empty = findEmptySlots();
  $('sheet').innerHTML =
    '<h2>➕ 添加任务</h2>' +
    '<div class="frow" style="border-bottom:1px solid var(--line)">' +
      '<label>空槽索引</label>' +
      '<input type="number" id="addSlot" value="' + slot + '" min="0" max="' + (STRUCT.TASK_COUNT - 1) + '" />' +
      '<button class="pick" id="pickSlot">📋</button>' +
      '<span class="hintv" style="min-width:110px">共 ' + empty.length + ' 个空槽</span>' +
    '</div>' +
    '<div class="sub" id="addSlotAddr">地址 ' +
      (BASE + slot * 0x74).toString(16).toUpperCase() + '</div>' +
    '<div class="hint" style="margin:0 0 12px">📥 <b>已读取该空槽遗留数据</b>，请在此基础上修改。<br>' +
    '💡 改「空槽索引」或点 📋 换槽 → 会重新读遗留数据。<br>' +
    '🐉 点怪物 📋 选择 → 自动带等级（怪1用主等级，怪2~5/乱入用副等级）。</div>' +
    '<div class="sec">字段（可改）</div>' + rows +
    '<div style="margin-top:16px">' +
    '<button id="addSave" style="width:100%">💾 写入该空槽</button>' +
    '<button class="ghost" id="cancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  $('overlay').classList.add('show');
  $('cancel').onclick = function () { $('overlay').classList.remove('show'); };
  $('addSave').onclick = function () { saveAdd(parseInt($('addSlot').value, 10)); };

  // 换槽：手动改索引（失焦时生效）
  $('addSlot').addEventListener('change', function () {
    var s = parseInt($('addSlot').value, 10);
    if (isNaN(s) || s < 0 || s >= STRUCT.TASK_COUNT) { toast('索引范围 0~' + (STRUCT.TASK_COUNT - 1)); return; }
    buildAddSheet(s);
  });
  $('pickSlot').onclick = function () { openSlotPicker(parseInt($('addSlot').value, 10)); };

  bindPickerRows($('sheet'), 'afield', 'anm-');
}

/** 所有空槽索引（编号没出现在 ALL 里的） */
function findEmptySlots() {
  var used = {};
  for (var i = 0; i < ALL.length; i++) used[ALL[i].index] = true;
  var out = [];
  for (var s = 0; s < STRUCT.TASK_COUNT; s++) if (!used[s]) out.push(s);
  return out;
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
  if (kw) slots = slots.filter(function (s) { return String(s).indexOf(kw) >= 0; });
  if (!slots.length) { $('pkItems').innerHTML = '<div class="it">没有空槽</div>'; return; }
  $('pkItems').innerHTML = slots.map(function (s) {
    var on = (s === _slotCur) ? ' on' : '';
    return '<div class="it slot-it' + on + '" data-slot="' + s + '">' +
      '<span>索引 ' + s + '</span>' +
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

/** 找一个未被使用的编号（700000 起） */
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
    toast('❌ 索引必须在 0~' + (STRUCT.TASK_COUNT - 1) + ' 之间', 4500);
    return;
  }
  var used = {};
  for (var u = 0; u < ALL.length; u++) used[ALL[u].index] = true;
  if (used[slot]) {
    toast('❌ 索引 ' + slot + ' 已被占用（不是空槽），请换一个', 4500);
    return;
  }

  var inputs = [].slice.call($('sheet').querySelectorAll('input[data-afield]'));
  var changes = [], vmap = {};
  inputs.forEach(function (el) {
    var f = Quest.fieldByName(el.dataset.afield); if (!f) return;
    var val = parseInt(el.value, 10);
    if (isNaN(val)) val = 0;
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
  if (dup) { toast('❌ 编号 ' + num + ' 已存在（索引 ' + dup.index + '）', 4500); return; }

  var btn = $('addSave');
  busy(btn, true, '⏳ 写入中…');
  try {
    if (Store.getMode() === 'file') {
      // 文件模式：本地写（把空槽变成有效任务）
      Store.setSlotFields(slot, changes);
      toast('✅ 已添加到文件（索引 ' + slot + '，编号 ' + num + '）', 3000);
      busy(btn, false);
      $('overlay').classList.remove('show');
      refreshFromStore();
      return;
    }
    if (!BASE) BASE = await Quest.questBase();
    var r = await Quest.setQuestFields(BASE, slot, changes);
    if (r.ok) toast('✅ 已写入空槽 ' + slot + '（编号 ' + num + '）', 3000);
    else toast('⚠️ 写入后校验不一致，请检查', 4000);
  } catch (e) {
    toast('❌ 写入失败：' + e.message, 4000);
  }
  busy(btn, false);
  $('overlay').classList.remove('show');
  load();
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
  if (Store.getMode() === 'file') {
    toast('⚠️ 当前是文件模式，上传需要连上 Switch。请先点「🔄 读取游戏任务」');
    return;
  }
  var slots = Store.getSlots();
  if (!slots.length) { toast('没有数据'); return; }
  if (!confirm('把当前 ' + slots.length + ' 个任务全部上传到游戏吗？\n\n⚠️ 会覆盖游戏里的任务！\n（大块写入，约 1~3 秒）')) return;
  setBusy(true);
  var btn = $('writeBackBtn');
  busy(btn, true, '⏳ 上传中…');
  var pb = $('progressbar'); pb.classList.add('show');
  pb.querySelector('.pbar-txt').textContent = '大块写入中…';
  pb.querySelector('.pbar-fill').style.width = '30%';
  try {
    if (!BASE) BASE = await Quest.questBase();
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
  load();
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
        if (kind === 'mon' && id) {
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
    'value="' + Bridge.getBase() + '" placeholder="http://192.168.1.5:8080" /></div>' +
    '<div class="hint">' +
    '• 手机浏览器直接开中转网页：填 <b>http://127.0.0.1:8080</b>（如果中转和浏览器同环境）<br>' +
    '• 从别的 App / 别的设备访问：填 <b>http://手机局域网IP:8080</b>（如 http://192.168.1.5:8080）<br>' +
    '• 不带端口默认 8080' +
    '</div>' +
    '<div id="cfgTest" class="hint" style="min-height:20px"></div>' +
    '<div style="margin-top:12px">' +
    '<button id="cfgSave" style="width:100%">💾 保存并重连</button>' +
    '<button class="ghost" id="cfgTestBtn" style="margin-top:8px;width:100%">🔍 测试连接</button>' +
    '<button class="ghost" id="cfgCancel" style="margin-top:8px;width:100%">取消</button>' +
    '</div>';
  $('overlay').classList.add('show');
  $('cfgCancel').onclick = function () { $('overlay').classList.remove('show'); };
  $('cfgTestBtn').onclick = testCfg;
  $('cfgSave').onclick = function () {
    var u = ($('cfgUrl').value || '').trim();
    if (!u) { toast('请填写地址'); return; }
    if (!/^https?:\/\//.test(u)) u = 'http://' + u;         // 自动补协议
    if (!/:\d+$/.test(u)) u = u.replace(/\/+$/, '') + ':8080'; // 没端口补 8080
    Bridge.setBase(u);
    $('overlay').classList.remove('show');
    toast('已保存：' + u);
    load();
  };
}
window.cfgAddr = cfgAddr;   // 供内联 onclick 调用

async function testCfg() {
  var u = ($('cfgUrl').value || '').trim();
  if (!u) { toast('请填写地址'); return; }
  if (!/^https?:\/\//.test(u)) u = 'http://' + u;
  if (!/:\d+$/.test(u)) u = u.replace(/\/+$/, '') + ':8080';
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

// ---------- 事件绑定 ----------

document.addEventListener('DOMContentLoaded', function () {
  // JS 跑到了 → 隐藏"JS没执行"警告，并在标题旁打勾
  var jc = $('jsCheck');
  if (jc) jc.style.display = 'none';
  var tag = $('jsTag');
  if (tag) tag.textContent = '✅JS已运行';

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
  bind('addBtn', openAdd);
  bind('batch', openBatch);
  bind('exportBtn', doExport);
  bind('openBtn', openDataFile);
  bind('writeBackBtn', doWriteBack);
  bind('cfgBtn', cfgAddr);

  $('overlay').addEventListener('click', function (e) {
    if (e.target.id === 'overlay') $('overlay').classList.remove('show');
  });
  $('picker').addEventListener('click', function (e) {
    if (e.target.id === 'picker') $('picker').classList.remove('show');
  });

  load();
});