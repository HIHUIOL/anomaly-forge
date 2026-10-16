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

  // ============================================================
  //  🎮 金手指（code patch）—— 通用逻辑
  //  数据在 js/cheats.js 里（CHEATS 数组），这里只负责读写内存。
  //  地址是【相对 main NSO 的偏移】，用 peekMain / pokeMain 读写。
  // ============================================================

  /** 取某条金手指的定义（by id） */
  function cheatDef(id) { return CHEATS_BY_ID[id] || null; }

  /** 列出全部金手指定义（供界面显示） */
  function cheatDefs() { return CHEATS; }

  /** 读某条金手指"当前内存里的值" */
  async function cheatReadOne(item) {
    var b = await Mem.peekMain(item.off, 4);
    if (!b || b.length < 4) return null;
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  /** 写某条金手指的指令值 */
  async function cheatWriteOne(item, value) {
    var v = value >>> 0;
    await Mem.pokeMain(item.off, new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]));
  }

  /** 读某条金手指的整体状态
   *  type='toggle' → { type, state: 'on'|'off'|'unknown', values: [...] }
   *  type='modes'  → { type, modeKey: '正常模式key'|'unknown', values: [...] }
   */
  async function cheatStatus(id) {
    var c = cheatDef(id);
    if (!c) return null;
    var vals = [];
    for (var i = 0; i < c.items.length; i++) {
      vals.push(await cheatReadOne(c.items[i]));
    }
    if (c.type === 'toggle') {
      var allOrig = vals.every(function (v, i) { return v === c.items[i].orig; });
      var allPatch = vals.every(function (v, i) { return v === c.items[i].patched; });
      return { type: 'toggle', state: allOrig ? 'off' : (allPatch ? 'on' : 'unknown'), values: vals };
    }
    if (c.type === 'modes') {
      var v0 = vals[0];
      // 先看是否等于"原始值"（通常是 normal 模式）
      if (v0 === c.items[0].orig) {
        // 找到 label 为正常的那个 mode（或者 key='normal'）
        var nk = 'normal';
        for (var k = 0; k < c.modes.length; k++) {
          if (c.modes[k].value === c.items[0].orig) { nk = c.modes[k].key; break; }
        }
        return { type: 'modes', modeKey: nk, values: vals };
      }
      for (var m = 0; m < c.modes.length; m++) {
        if (v0 === c.modes[m].value) return { type: 'modes', modeKey: c.modes[m].key, values: vals };
      }
      return { type: 'modes', modeKey: 'unknown', values: vals };
    }
    return { type: c.type, values: vals };
  }

  /** 应用金手指
   *  toggle → cheatApply(id, 'on' | 'off')
   *  modes  → cheatApply(id, modeKey)
   */
  async function cheatApply(id, mode) {
    var c = cheatDef(id);
    if (!c) throw new Error('未知金手指 ' + id);

    if (c.type === 'toggle') {
      var on = (mode !== 'off');
      for (var i = 0; i < c.items.length; i++) {
        var it = c.items[i];
        await cheatWriteOne(it, on ? it.patched : it.orig);
      }
      return true;
    }

    if (c.type === 'modes') {
      var target = null;
      for (var m = 0; m < c.modes.length; m++) {
        if (c.modes[m].key === mode) { target = c.modes[m]; break; }
      }
      if (!target) throw new Error('未知模式 ' + mode);
      // modes 类型：把所有 item 都写成同一个 value（通常只有 1 个 item）
      for (var j = 0; j < c.items.length; j++) {
        await cheatWriteOne(c.items[j], target.value);
      }
      return true;
    }

    throw new Error('未知金手指类型 ' + c.type);
  }

  /** 按 route 解析出"最终地址"
   *  route 例：['main:0x12B157C0', 0x58]，final: 0x18
   *  → p = [mainBase + 0x12B157C0]
   *  → p = [p + 0x58]
   *  → addr = p + 0x18
   */
  async function watchResolveAddr(route, finalOff) {
    var hb = await Mem.getHeapBase();
    var mb = await Mem.getMainBase();
    var p = 0;
    for (var i = 0; i < route.length; i++) {
      var step = route[i];
      if (typeof step === 'string') {
        // 'main:0xXXXX' → 读 [mainBase + off]
        var m = step.match(/^main[:@](0x[0-9a-fA-F]+)$/);
        if (!m) throw new Error('route 格式错误：' + step);
        var off = parseInt(m[1], 16);
        var b = await Mem.peekMain(off, 8);
        if (!b || b.length < 8) throw new Error('读 main 指针失败');
        p = Mem.u64(b);
      } else {
        // 数字 → 读 [p + off]（8 字节）
        var addr = p + step;
        var bb;
        if (addr >= hb && addr < hb + 0x40000000) {
          bb = await Mem.peekHeap(addr - hb, 8);
        } else {
          bb = await Mem.peekMain(addr - mb, 8);
        }
        if (!bb || bb.length < 8) throw new Error('读指针失败 @0x' + addr.toString(16));
        p = Mem.u64(bb);
      }
    }
    return p + (finalOff || 0);
  }

  /** 把数值转成"内存字节顺序"的 hex（小端）*/
  function numToHexLE(value, size) {
    var s = '';
    for (var i = 0; i < size; i++) {
      s += ('0' + ((value >>> (i * 8)) & 0xFF).toString(16)).slice(-2);
    }
    return s.toUpperCase();
  }

  /** 读 watch 的"当前值" */
  async function watchRead(id) {
    var c = cheatDef(id);
    if (!c || c.type !== 'watch') return null;
    var addr = await watchResolveAddr(c.route, c.final);
    var hb = await Mem.getHeapBase();
    var b;
    if (addr >= hb && addr < hb + 0x40000000) {
      b = await Mem.peekHeap(addr - hb, c.size);
    } else {
      var mb = await Mem.getMainBase();
      b = await Mem.peekMain(addr - mb, c.size);
    }
    if (!b || b.length < c.size) return null;
    // 小端解析
    var v = 0;
    for (var i = 0; i < c.size; i++) v += (b[i] * Math.pow(256, i));
    return { addr: addr, value: v };
  }

  /** 锁定（freeze）：反复写 c.value */
  async function watchFreeze(id) {
    var c = cheatDef(id);
    if (!c || c.type !== 'watch') throw new Error('不是 watch 类型');
    var addr = await watchResolveAddr(c.route, c.final);
    var hb = await Mem.getHeapBase();
    if (addr < hb || addr >= hb + 0x40000000) {
      throw new Error('地址不在 heap 范围，无法 freeze（0x' + addr.toString(16) + '）');
    }
    var off = addr - hb;
    var hex = numToHexLE(c.value, c.size);
    // ⚠️ 必须带 0x 前缀！否则 sys-botbase 会按十进制解析 → 变 0
    await Bridge.cmd('freeze 0x' + off.toString(16).toUpperCase() + ' 0x' + hex);
    return { addr: addr, off: off, hex: hex };
  }

  /** 解除锁定（unFreeze）*/
  async function watchUnfreeze(id) {
    var c = cheatDef(id);
    if (!c || c.type !== 'watch') throw new Error('不是 watch 类型');
    var addr = await watchResolveAddr(c.route, c.final);
    var hb = await Mem.getHeapBase();
    var off = addr - hb;
    await Bridge.cmd('unFreeze 0x' + off.toString(16).toUpperCase());
    return { addr: addr, off: off };
  }

  /** 查某个地址当前是否在"冻结列表"里
   *  ⚠️ sys-botbase 只提供"总数"，没有"列出全部地址"的命令
   *     → 我们用"值是否恒等于 c.value"来粗略判断（不准）
   *     → 更可靠：用一个内存标记（存在 localStorage）
   *  这里返回 { frozen: bool }，靠 localStorage 记录
   */
  function watchFrozenList() {
    try {
      return JSON.parse(localStorage.getItem('af.frozen') || '[]');
    } catch (e) { return []; }
  }
  function watchSetFrozen(id, on) {
    var arr = watchFrozenList();
    var i = arr.indexOf(id);
    if (on && i < 0) arr.push(id);
    if (!on && i >= 0) arr.splice(i, 1);
    localStorage.setItem('af.frozen', JSON.stringify(arr));
  }
  function watchIsFrozen(id) { return watchFrozenList().indexOf(id) >= 0; }

  /** 清空所有 freeze（sys-botbase 的 freezeClear） */
  async function watchClearAll() {
    await Bridge.cmd('freezeClear');
    localStorage.setItem('af.frozen', '[]');
  }

  /** 读 freezeCount（sys-botbase 返回 hex） */
  async function watchCount() {
    var t = await Bridge.cmd('freezeCount');
    if (!t) return null;
    return parseInt(t, 16);   // 源码是 printf("%02X")，hex 格式
  }

  // ============================================================
  // 🎮 按键 / 摇杆（sys-botbase）
  // ============================================================

  /** 按一下某个键（click）—— Switch 不回数据，中转短等待 */
  async function pressKey(key) {
    return await Bridge.cmd('click ' + key);
  }

  /** 播放一段按键序列（clickSeq）
   *  seq 例：'DUP,W200,DUP,W200,DDOWN'
   *  ⚠️ 命令立即返回，序列在 Switch 端异步执行
   */
  async function pressSeq(seq) {
    return await Bridge.cmd('clickSeq ' + seq);
  }

  /** ⚡ 播放一段按键序列，并"等它真的播完"（Switch 播完回 done）
   *  返回 { ok, ms }（ms = 实际耗时毫秒）
   */
  async function pressSeqWait(seq, timeoutMs) {
    return await Bridge.cmdWait('clickSeq ' + seq, null, timeoutMs);
  }

  /** 中断正在播放的序列 */
  async function pressCancel() {
    return await Bridge.cmd('clickCancel');
  }

  /** 摇杆：side = 'left' | 'right'，范围 -32767 ~ 32767 */
  async function setStick(side, x, y) {
    var s = (side === 'right') ? 'right' : 'left';
    return await Bridge.cmd('setStick ' + s + ' ' + (x | 0) + ' ' + (y | 0));
  }

  /** 调整 click 时按键的按住时长（毫秒）—— 帧率低时调大点更好识别 */
  async function setClickHold(ms) {
    return await Bridge.cmd('configure buttonClickSleepTime ' + (ms | 0));
  }

  /** 截取当前 Switch 屏幕 —— 返回 JPEG 的 Uint8Array
   *  sys-botbase 的 pixelPeek 会返回一整张 JPEG 的 hex（约 70 万字符 / 350KB）
   */
  async function captureScreen() {
    var hex = await Bridge.cmd('pixelPeek');
    if (!hex) throw new Error('没收到截图数据（游戏没开？）');
    var t = hex.replace(/\s/g, '');
    if (!/^[0-9A-Fa-f]+$/.test(t) || t.length < 100) {
      throw new Error('截图返回异常：' + t.slice(0, 60));
    }
    var bytes = Mem.hexToBytes(t);
    // 校验 JPEG 头尾
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
      throw new Error('不是有效 JPEG（截图失败，可能需要 patch debug flag）');
    }
    return bytes;
  }

  /** 交换两个槽的整块 116 字节
   *  ⚡ 一次大块读（覆盖两槽）+ 本地对调 + 一次大块写回
   *  autoNum = true（默认）：对调后，若【该槽是有效任务】→ 自动重算编号 = 700000 + 槽位
   *                         若【该槽是空槽】→ 保持空槽原样（序号=FFFFFFFF、编号=FFFFFFFF）
   *  autoNum = false       ：保留"对调过来"的原编号（不重算）
   */
  async function swapQuests(base, ia, ib, autoNum) {
    if (ia === ib) return true;
    var lo = Math.min(ia, ib), hi = Math.max(ia, ib);
    var startAddr = base + lo * STRUCT.TASK_SIZE;
    var span = (hi - lo + 1) * STRUCT.TASK_SIZE;
    var buf = await Mem.readRange(startAddr, span);   // ⚡ 一次读
    var oa = (ia - lo) * STRUCT.TASK_SIZE;
    var ob = (ib - lo) * STRUCT.TASK_SIZE;
    var tmp = buf.slice(oa, oa + STRUCT.TASK_SIZE);   // 复制 A 的 116 字节
    buf.copyWithin(oa, ob, ob + STRUCT.TASK_SIZE);    // A ← B
    buf.set(tmp, ob);                                 // B ← A
    if (autoNum !== false) {
      // ✅ 只对【有效任务】重算编号；空槽不动（保持 序号=FFFFFFFF、编号=FFFFFFFF）
      var seqA = Mem.u32(buf, oa + 0x00);
      var seqB = Mem.u32(buf, ob + 0x00);
      if (seqA !== 0xFFFFFFFF) Mem.putU32(buf, oa + 0x04, (STRUCT.TASK_ID_BASE + ia) >>> 0);
      if (seqB !== 0xFFFFFFFF) Mem.putU32(buf, ob + 0x04, (STRUCT.TASK_ID_BASE + ib) >>> 0);
    }
    await Mem.writeRange(startAddr, buf);             // ⚡ 大块写回
    return true;
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
    captureScreen: captureScreen,
    // 🎮 按键 / 摇杆
    pressKey: pressKey,
    pressSeq: pressSeq,
    pressSeqWait: pressSeqWait,
    pressCancel: pressCancel,
    setStick: setStick,
    setClickHold: setClickHold,
    cheatDefs: cheatDefs,
    cheatDef: cheatDef,
    cheatStatus: cheatStatus,
    cheatApply: cheatApply,
    watchResolveAddr: watchResolveAddr,
    watchRead: watchRead,
    watchFreeze: watchFreeze,
    watchUnfreeze: watchUnfreeze,
    watchIsFrozen: watchIsFrozen,
    watchSetFrozen: watchSetFrozen,
    watchClearAll: watchClearAll,
    watchCount: watchCount,
    getAllRaw: getAllRaw,
    writeRaw: writeRaw,
    writeAllRaw: writeAllRaw,
    swapQuests: swapQuests,
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