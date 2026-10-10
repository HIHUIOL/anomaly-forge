/* ============================================================
 * store.js —— 数据源层（在线内存 / 离线文件）
 *
 * 只有两种数据源，二选一：
 *   1) 在线：从 Switch 内存读（Store.loadFromSwitch）
 *   2) 离线：从"打开的文件"载入（Store.loadFile）
 *
 * 上层界面（app.js）只跟 Store 打交道。
 * 数据结构：slots = [{ index, raw(hex, 232字符), fields(对象) }]
 * ============================================================ */

var Store = (function () {

  var slots = [];       // 200 槽：[{index, raw, fields}]
  var mode = 'none';    // 'online' | 'file' | 'none'
  var sourceInfo = '';  // 数据来源描述
  var seqCounter = null; // 序号计数器（游戏获得新怪异任务时取用的序号来源）；null = 未知/文件里没有

  // ---------- 原始 hex ↔ fields ----------
  function rawToFields(rawHex) {
    var bytes = Mem.hexToBytes(rawHex);
    var o = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      o[f.name] = (f.size === 4) ? Mem.u32(bytes, f.off) : bytes[f.off];
    }
    return o;
  }

  function isValid(fields) {
    var n = fields['编号'];
    return n >= STRUCT.TASK_ID_BASE && n <= STRUCT.TASK_ID_BASE + STRUCT.TASK_COUNT;
  }

  /** 本地修改某个槽（离线编辑 / 在线改后同步） */
  function setSlot(index, rawHex) {
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].index === index) {
        slots[i].raw = rawHex;
        slots[i].fields = rawToFields(rawHex);
        return true;
      }
    }
    slots.push({ index: index, raw: rawHex, fields: rawToFields(rawHex) });
    slots.sort(function (a, b) { return a.index - b.index; });
    return true;
  }

  /** 本地按字段改某个槽（离线编辑核心） */
  function setSlotFields(index, changes) {
    var slot = null;
    for (var i = 0; i < slots.length; i++) if (slots[i].index === index) { slot = slots[i]; break; }
    if (!slot) return false;
    var bytes = Mem.hexToBytes(slot.raw);
    for (var j = 0; j < changes.length; j++) {
      var c = changes[j];
      if (c.size === 4) Mem.putU32(bytes, c.off, c.value);
      else bytes[c.off] = c.value & 0xFF;
    }
    slot.raw = Mem.bytesToHex(bytes);
    slot.fields = rawToFields(slot.raw);
    return true;
  }

  function getSlot(index) {
    for (var i = 0; i < slots.length; i++) if (slots[i].index === index) return slots[i];
    return null;
  }

  // ---------- 数据源 1：Switch 内存 ----------
  async function loadFromSwitch(onProgress) {
    var raw = await Quest.getAllRaw(onProgress);
    slots = raw.map(function (s) {
      return { index: s.index, raw: s.raw, fields: rawToFields(s.raw) };
    });
    // 顺便读"序号计数器"
    try {
      seqCounter = await Quest.readSeqCounter();
    } catch (e) {
      seqCounter = null;
    }
    mode = 'online';
    sourceInfo = 'Switch 内存';
    return slots;
  }

  // ---------- 数据源 2：打开的文件 ----------
  function loadFile(d, fname) {
    if (!d || !d.quests || !d.quests.length) return false;
    slots = d.quests.map(function (item) {
      return {
        index: item.index,
        raw: item.raw,
        fields: item.fields || rawToFields(item.raw)
      };
    });
    // 补齐：如果文件里只有部分槽，其余槽补空（全 0）
    var have = {};
    for (var i = 0; i < slots.length; i++) have[slots[i].index] = true;
    for (var s = 0; s < STRUCT.TASK_COUNT; s++) {
      if (!have[s]) slots.push({ index: s, raw: emptyRaw(), fields: rawToFields(emptyRaw()) });
    }
    slots.sort(function (a, b) { return a.index - b.index; });
    // 序号计数器（文件里带了就用）
    seqCounter = (typeof d.seqCounter === 'number') ? d.seqCounter : null;
    mode = 'file';
    sourceInfo = fname ? ('文件：' + fname) : '打开的文件';
    return true;
  }

  /** 一个"空槽"的 116 字节：编号/序号=FFFFFFFF, 叹号=256 */
  function emptyRaw() {
    var b = new Uint8Array(STRUCT.TASK_SIZE);
    Mem.putU32(b, 0x00, 0xFFFFFFFF);
    Mem.putU32(b, 0x04, 0xFFFFFFFF);
    Mem.putU32(b, 0x68, 256);
    return Mem.bytesToHex(b);
  }

  /** 导出成 JSON 对象 */
  function toExport() {
    return {
      app: '怪异任务编辑器',
      version: 1,
      game: 'MONSTER HUNTER RISE 16.0.2',
      taskSize: STRUCT.TASK_SIZE,
      taskCount: STRUCT.TASK_COUNT,
      seqCounter: seqCounter,     // 序号计数器（新任务序号来源）
      exportedAt: new Date().toISOString(),
      quests: slots.map(function (s) {
        return {
          index: s.index,
          raw: s.raw,
          fields: s.fields,
          empty: !isValid(s.fields)
        };
      })
    };
  }

  /** 取"有效任务"列表（给界面用，等价于旧的 ALL） */
  function validTasks() {
    var out = [];
    for (var i = 0; i < slots.length; i++) {
      if (isValid(slots[i].fields)) {
        var t = {};
        for (var k in slots[i].fields) t[k] = slots[i].fields[k];
        t.index = slots[i].index;
        t.addr = (slots[i].index * STRUCT.TASK_SIZE).toString(16).toUpperCase();
        out.push(t);
      }
    }
    return out;
  }

  /** 全部空槽索引 */
  function emptySlots() {
    var out = [];
    for (var i = 0; i < slots.length; i++) {
      if (!isValid(slots[i].fields)) out.push(slots[i].index);
    }
    return out;
  }

  function getSlots() { return slots; }
  function getMode() { return mode; }
  function getSource() { return sourceInfo; }
  function getSeqCounter() { return seqCounter; }
  function setSeqCounter(v) { seqCounter = (v === null || v === undefined) ? null : (v >>> 0); }
  function clear() { slots = []; mode = 'none'; sourceInfo = ''; seqCounter = null; }

  return {
    rawToFields: rawToFields,
    isValid: isValid,
    setSlot: setSlot,
    setSlotFields: setSlotFields,
    getSlot: getSlot,
    loadFromSwitch: loadFromSwitch,
    loadFile: loadFile,
    emptyRaw: emptyRaw,
    toExport: toExport,
    validTasks: validTasks,
    emptySlots: emptySlots,
    getSlots: getSlots,
    getMode: getMode,
    getSource: getSource,
    getSeqCounter: getSeqCounter,
    setSeqCounter: setSeqCounter,
    clear: clear
  };
})();