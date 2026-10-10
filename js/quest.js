/* ============================================================
 * quest.js —— 怪异任务业务逻辑（指针链定位 + 任务解析 + 读写）
 * 依赖：data.js（FIELDS / MONSTERS / MAPS / STRUCT）、memory.js（Mem）
 * ============================================================ */

var Quest = (function () {

  // ---------- 指针链（ASLR 安全）----------
  // p1 = *(main + 0x12A58748)
  // p2 = *(p1 + 0x100)
  // p3 = *(p2 + 0x28)
  // base = p3 + 0x20
  async function questBase() {
    var p1 = Mem.u64(await Mem.peekMain(STRUCT.MAIN_PTR_OFFSET, 8));
    var p2 = Mem.u64(await Mem.readAbs(p1 + 0x100, 8));
    var p3 = Mem.u64(await Mem.readAbs(p2 + 0x28, 8));
    return p3 + 0x20;
  }

  /** 解析 116 字节 -> 对象 */
  function parseQuest(raw, index, addr) {
    var t = { index: index, addr: addr.toString(16).toUpperCase().padStart(16, '0') };
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      t[f.name] = (f.size === 4) ? Mem.u32(raw, f.off) : raw[f.off];
    }
    return t;
  }

  /** 读单个任务 */
  async function getQuest(base, index) {
    var addr = base + index * STRUCT.TASK_SIZE;
    var raw = await Mem.readAbs(addr, STRUCT.TASK_SIZE);
    if (!raw || raw.length < STRUCT.TASK_SIZE) return null;
    return parseQuest(raw, index, addr);
  }

  /** 读全部任务（一次大块读，本地切片解析） */
  async function getAllQuests(onProgress) {
    var base = await questBase();
    if (!base) throw new Error('定位任务数组失败（游戏没开？）');
    var total = STRUCT.TASK_COUNT * STRUCT.TASK_SIZE;
    var buf = await Mem.readRange(base, total);   // ⚡ 一次读完 200 槽
    var out = [];
    for (var i = 0; i < STRUCT.TASK_COUNT; i++) {
      var off = i * STRUCT.TASK_SIZE;
      var raw = buf.subarray(off, off + STRUCT.TASK_SIZE);
      var t = parseQuest(raw, i, base + off);
      if (t['编号'] >= STRUCT.TASK_ID_BASE &&
          t['编号'] <= STRUCT.TASK_ID_BASE + STRUCT.TASK_COUNT) {
        out.push(t);
      }
    }
    if (onProgress) onProgress(STRUCT.TASK_COUNT, STRUCT.TASK_COUNT);
    return out;
  }

  /**
   * 写单个任务的多个字段（一次读→改→写→回读）
   * changes = [{off, size, value}, ...]
   * 返回 {ok, got}
   */
  async function setQuestFields(base, index, changes) {
    var addr = base + index * STRUCT.TASK_SIZE;
    var raw = await Mem.readAbs(addr, STRUCT.TASK_SIZE);
    if (!raw || raw.length < STRUCT.TASK_SIZE) return { ok: false, got: null };

    var buf = new Uint8Array(raw);  // 复制
    var want = [];
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i];
      if (c.size === 4) Mem.putU32(buf, c.off, c.value);
      else buf[c.off] = c.value & 0xFF;
      want.push(c);
    }
    await Mem.writeAbs(addr, buf);

    // 回读校验
    var chk = await Mem.readAbs(addr, STRUCT.TASK_SIZE);
    if (!chk || chk.length < STRUCT.TASK_SIZE) return { ok: false, got: null };
    var allok = true;
    for (var j = 0; j < want.length; j++) {
      var c2 = want[j];
      var g = (c2.size === 4) ? Mem.u32(chk, c2.off) : chk[c2.off];
      if (g !== c2.value) allok = false;
    }
    return { ok: allok, got: true };
  }

  /** 批量：对若干索引统一写一个字段（一次大块读 + 本地改 + 大块写回） */
  async function setManyQuests(base, idxs, off, size, value, onProgress) {
    if (!idxs.length) return 0;
    var minI = Math.min.apply(null, idxs);
    var maxI = Math.max.apply(null, idxs);
    var startAddr = base + minI * STRUCT.TASK_SIZE;
    var span = (maxI - minI + 1) * STRUCT.TASK_SIZE;
    var buf = await Mem.readRange(startAddr, span);   // ⚡ 一次读
    var hit = {};
    for (var k = 0; k < idxs.length; k++) hit[idxs[k]] = true;
    for (var i = 0; i < idxs.length; i++) {
      var local = (idxs[i] - minI) * STRUCT.TASK_SIZE;   // 在 buf 里的偏移
      if (size === 4) Mem.putU32(buf, local + off, value);
      else buf[local + off] = value & 0xFF;
    }
    await Mem.writeRange(startAddr, buf);   // ⚡ 大块写回
    if (onProgress) onProgress(idxs.length, idxs.length);
    return idxs.length;
  }

  /** 批量：每个索引写不同的值（累加用）——一次大块读 + 本地改 + 大块写回
   *  vals = { index: value }
   */
  async function setManyQuestsDiff(base, indexList, off, size, values, onProgress) {
    if (!indexList.length) return 0;
    var minI = Math.min.apply(null, indexList);
    var maxI = Math.max.apply(null, indexList);
    var startAddr = base + minI * STRUCT.TASK_SIZE;
    var span = (maxI - minI + 1) * STRUCT.TASK_SIZE;
    var buf = await Mem.readRange(startAddr, span);   // ⚡ 一次读
    for (var i = 0; i < indexList.length; i++) {
      var ix = indexList[i];
      var local = (ix - minI) * STRUCT.TASK_SIZE;
      var v = values[ix];
      if (size === 4) Mem.putU32(buf, local + off, v);
      else buf[local + off] = v & 0xFF;
    }
    await Mem.writeRange(startAddr, buf);   // ⚡ 大块写回
    if (onProgress) onProgress(indexList.length, indexList.length);
    return indexList.length;
  }

  /** 批量"清空"：把多个任务都打成删除标记
   *  删除标记 = 序号(0x00)=FFFFFFFF、编号(0x04)=FFFFFFFF、叹号(0x68)=256
   *  ⚡ 一次大块读 → 本地打标记 → 一次大块写回（比逐个快几十倍）
   */
  async function clearManyQuests(base, indexList, onProgress) {
    if (!indexList.length) return 0;
    var minI = Math.min.apply(null, indexList);
    var maxI = Math.max.apply(null, indexList);
    var startAddr = base + minI * STRUCT.TASK_SIZE;
    var span = (maxI - minI + 1) * STRUCT.TASK_SIZE;
    var buf = await Mem.readRange(startAddr, span);   // ⚡ 一次读
    for (var i = 0; i < indexList.length; i++) {
      var local = (indexList[i] - minI) * STRUCT.TASK_SIZE;
      Mem.putU32(buf, local + 0x00, 0xFFFFFFFF);
      Mem.putU32(buf, local + 0x04, 0xFFFFFFFF);
      Mem.putU32(buf, local + 0x68, 256);
    }
    await Mem.writeRange(startAddr, buf);   // ⚡ 大块写回
    if (onProgress) onProgress(indexList.length, indexList.length);
    return indexList.length;
  }

  /** 批量"恢复"：把多个已删除的槽变回有效任务
   *  items = { index: {seq, num} }   —— 每个槽要写入的 序号 / 编号
   *  写入：序号(0x00)=seq、编号(0x04)=num、叹号(0x68)=1
   *  ⚡ 一次大块读 → 本地改 → 一次大块写回
   */
  async function restoreManyQuests(base, items, onProgress) {
    var ks = Object.keys(items).map(Number);
    if (!ks.length) return 0;
    var minI = Math.min.apply(null, ks);
    var maxI = Math.max.apply(null, ks);
    var startAddr = base + minI * STRUCT.TASK_SIZE;
    var span = (maxI - minI + 1) * STRUCT.TASK_SIZE;
    var buf = await Mem.readRange(startAddr, span);   // ⚡ 一次读
    for (var i = 0; i < ks.length; i++) {
      var ix = ks[i];
      var local = (ix - minI) * STRUCT.TASK_SIZE;
      Mem.putU32(buf, local + 0x00, items[ix].seq >>> 0);
      Mem.putU32(buf, local + 0x04, items[ix].num >>> 0);
      Mem.putU32(buf, local + 0x68, 1);   // 叹号 = 1（显示"新任务"）
    }
    await Mem.writeRange(startAddr, buf);   // ⚡ 大块写回
    if (onProgress) onProgress(ks.length, ks.length);
    return ks.length;
  }

  /** 读全部 200 个槽的"原始 116 字节"（含空槽，用于导出）
   *  返回 [{index, addr, raw(hex), ok}]  —— 一次大块读
   */
  async function getAllRaw(onProgress) {
    var base = await questBase();
    if (!base) throw new Error('定位任务数组失败（游戏没开？）');
    var total = STRUCT.TASK_COUNT * STRUCT.TASK_SIZE;
    var buf = await Mem.readRange(base, total);   // ⚡ 一次读完 200 槽
    var out = [];
    for (var i = 0; i < STRUCT.TASK_COUNT; i++) {
      var off = i * STRUCT.TASK_SIZE;
      var raw = buf.subarray(off, off + STRUCT.TASK_SIZE);
      out.push({
        index: i,
        addr: (base + off).toString(16).toUpperCase(),
        raw: Mem.bytesToHex(raw),
        ok: raw && raw.length === STRUCT.TASK_SIZE
      });
    }
    if (onProgress) onProgress(STRUCT.TASK_COUNT, STRUCT.TASK_COUNT);
    return out;
  }

  /** 写回整块 116 字节（十六进制字符串） */
  async function writeRaw(base, index, hex) {
    var addr = base + index * STRUCT.TASK_SIZE;
    await Mem.writeAbs(addr, Mem.hexToBytes(hex));
    return true;
  }

  /** 整批写回：把 200 个槽的数据一次大块写（用于"上传到游戏"提速）
   *  slots = [{index, raw(hex)}]（需覆盖 [0..TASK_COUNT)，缺失的槽跳过）
   */
  async function writeAllRaw(slots, onProgress) {
    var base = await questBase();
    if (!base) throw new Error('定位任务数组失败（游戏没开？）');
    // 拼成连续 buffer：按 index 填入，缺失的槽保留"空槽标准长相"
    var total = STRUCT.TASK_COUNT * STRUCT.TASK_SIZE;
    var buf = new Uint8Array(total);
    var have = {};   // index -> true
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s.index < 0 || s.index >= STRUCT.TASK_COUNT) continue;
      var bytes = Mem.hexToBytes(s.raw);
      var off = s.index * STRUCT.TASK_SIZE;
      buf.set(bytes.subarray(0, STRUCT.TASK_SIZE), off);
      have[s.index] = true;
    }
    // 没填的槽 → 空槽标准长相（序号/编号=FFFFFFFF，叹号=256），避免误写成 0
    for (var k = 0; k < STRUCT.TASK_COUNT; k++) {
      if (have[k]) continue;
      var off2 = k * STRUCT.TASK_SIZE;
      Mem.putU32(buf, off2 + 0x00, 0xFFFFFFFF);
      Mem.putU32(buf, off2 + 0x04, 0xFFFFFFFF);
      Mem.putU32(buf, off2 + 0x68, 256);
    }
    await Mem.writeRange(base, buf);   // ⚡ 大块写
    if (onProgress) onProgress(STRUCT.TASK_COUNT, STRUCT.TASK_COUNT);
    return STRUCT.TASK_COUNT;
  }

  // ---------- 序号计数器（游戏获得新怪异任务时取用的"序号"来源）----------
  // 金手指：640F0000 11A2E990 00000409
  //   前 3 行指针链：
  //     reg0 = u64(peekMain(0x12A58748))
  //     reg1 = u64(reg0 + 0x100)
  //     reg0 = reg1 + 0x34          <-- 序号计数器地址!
  //   末行把 8 字节 [00000409][90E9A211] 写到 reg0：
  //     +0x00 = 00000409 (1033)  ← 序号计数器的值
  //     +0x04 = 11A2E990 (其余字节，游戏会改动)
  // 实测（重启游戏后）：reg1+0x34 读出 = 1033 ✅
  /** 定位"序号计数器"地址（ASLR 安全） */
  async function seqCounterAddr() {
    var reg0 = Mem.u64(await Mem.peekMain(STRUCT.MAIN_PTR_OFFSET, 8));
    if (!reg0) return null;
    var reg1 = Mem.u64(await Mem.readAbs(reg0 + 0x100, 8));
    if (!reg1) return null;
    return reg1 + STRUCT.SEQ_COUNTER_DELTA;   // + 0x34
  }

  /** 读"序号计数器"（游戏获得新怪异任务时取用的序号来源） */
  async function readSeqCounter() {
    var addr = await seqCounterAddr();
    if (!addr) return null;
    var bytes = await Mem.readAbs(addr, 4);
    if (!bytes || bytes.length < 4) return null;
    return Mem.u32(bytes, 0);
  }

  /** 写"序号计数器" */
  async function writeSeqCounter(value) {
    var addr = await seqCounterAddr();
    if (!addr) return false;
    var b = new Uint8Array(4);
    Mem.putU32(b, 0, value >>> 0);
    await Mem.writeAbs(addr, b);
    // 回读校验
    var chk = await Mem.readAbs(addr, 4);
    if (!chk || chk.length < 4) return false;
    return Mem.u32(chk, 0) === (value >>> 0);
  }

  function monName(id) {
    if (!id) return '无';
    return MONSTERS[id] || ('未知(0x' + Number(id).toString(16).toUpperCase() + ')');
  }
  function mapName(id) {
    if (!id) return '—';
    return MAPS[id] || ('地图' + id);
  }
  function enumName(enumKey, v) {
    var en = ENUMS[enumKey] || {};
    return en[String(v)] || '';
  }
  function fieldByName(name) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].name === name) return FIELDS[i];
    return null;
  }

  /** 构造任务的"怪物列表"（用于列表显示） */
  function monsterList(t) {
    var arr = [];
    var keys = ['怪1ID', '怪2ID', '怪3ID', '怪4ID', '怪5ID'];
    for (var i = 0; i < keys.length; i++) {
      var mid = t[keys[i]];
      if (mid) arr.push({ id: mid, name: monName(mid), lv: t['怪' + (i + 1) + '级'], inv: false });
    }
    if (t['乱入ID']) arr.push({ id: t['乱入ID'], name: '乱入:' + monName(t['乱入ID']), lv: t['乱入级'], inv: true });
    return arr;
  }

  return {
    questBase: questBase,
    getQuest: getQuest,
    getAllQuests: getAllQuests,
    setQuestFields: setQuestFields,
    setManyQuests: setManyQuests,
    setManyQuestsDiff: setManyQuestsDiff,
    clearManyQuests: clearManyQuests,
    restoreManyQuests: restoreManyQuests,
    getAllRaw: getAllRaw,
    writeRaw: writeRaw,
    writeAllRaw: writeAllRaw,
    parseQuest: parseQuest,
    readSeqCounter: readSeqCounter,
    writeSeqCounter: writeSeqCounter,
    monName: monName,
    mapName: mapName,
    enumName: enumName,
    fieldByName: fieldByName,
    monsterList: monsterList
  };
})();