/* ============================================================
 * memory.js —— 内存底层操作（把 sys-botbase 命令封装成好用的函数）
 *
 * ⚠️ 三个必须处理的坑：
 *   1) sys-botbase 返回的 hex 是"高字节在前"，要用时需两两一组反转
 *   2) peek 的参数是"相对 heap 的偏移"，不能直接给绝对地址
 *   3) poke 的数据必须带 0x 前缀，否则会被当十进制解析（写坏数据！）
 * ============================================================ */

var Mem = (function () {
  var heapBase = null;
  var mainBase = null;

  // ---------- 基础工具 ----------

  /** hex 字符串 -> Uint8Array（按 sys-botbase 输出顺序，即高字节在前） */
  function hexToBytes(hex) {
    hex = (hex || '').replace(/\s/g, '');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  /** Uint8Array -> hex 字符串（大写） */
  function bytesToHex(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i++) {
      s += (arr[i] < 16 ? '0' : '') + arr[i].toString(16).toUpperCase();
    }
    return s;
  }

  /**
   * 把 sys-botbase 返回的字节数组按"小端 64 位"解析成整数。
   * sys-botbase 返回的顺序是反的，例如 70F6C2D227000000 -> 0x27D2C2F670
   */
  function u64(bytes) {
    // bytes 高字节在前 => 反转成低字节在前（little endian）
    var v = 0n;
    for (var i = 0; i < 8; i++) {
      v |= BigInt(bytes[i]) << BigInt(8 * i);
    }
    return Number(v & 0xFFFFFFFFFFFFFn); // 48 位足够（Switch 地址）
  }

  /** 取 Uint8Array 里第 off 起的 little-endian uint32 */
  function u32(b, off) {
    return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
  }

  /** 把 uint32 写进 Uint8Array 的 off 处（little-endian） */
  function putU32(b, off, val) {
    b[off] = val & 0xFF;
    b[off + 1] = (val >>> 8) & 0xFF;
    b[off + 2] = (val >>> 16) & 0xFF;
    b[off + 3] = (val >>> 24) & 0xFF;
  }

  // ---------- 基址 ----------

  async function getHeapBase() {
    if (heapBase === null) {
      heapBase = parseInt(await Bridge.cmd('getHeapBase'), 16);
    }
    return heapBase;
  }
  async function getMainBase() {
    if (mainBase === null) {
      mainBase = parseInt(await Bridge.cmd('getMainNsoBase'), 16);
    }
    return mainBase;
  }
  function resetCache() { heapBase = null; mainBase = null; }

  // ---------- 读写 ----------

  /** 相对 heap 读 n 字节 -> Uint8Array */
  async function peekHeap(off, n) {
    var r = await Bridge.cmd('peek 0x' + off.toString(16).toUpperCase() + ' ' + n);
    return hexToBytes(r);
  }

  /** 相对 NSO 读 n 字节 -> Uint8Array */
  async function peekMain(off, n) {
    var r = await Bridge.cmd('peekMain 0x' + off.toString(16).toUpperCase() + ' ' + n);
    return hexToBytes(r);
  }

  /** 按绝对地址读（自动判断 heap / NSO） */
  async function readAbs(addr, n) {
    var hb = await getHeapBase();
    if (hb && addr >= hb && addr < hb + 0x40000000) {
      return await peekHeap(addr - hb, n);
    }
    return await peekMain(addr, n);
  }

  /** 按绝对地址写（data 是 Uint8Array）——自动补 0x 前缀！ */
  async function writeAbs(addr, data) {
    var hb = await getHeapBase();
    var hexs = '0x' + bytesToHex(data);  // ⚠️ 必须带 0x！
    if (hb && addr >= hb && addr < hb + 0x40000000) {
      await Bridge.cmd('poke 0x' + (addr - hb).toString(16).toUpperCase() + ' ' + hexs);
    } else {
      await Bridge.cmd('pokeMain 0x' + addr.toString(16).toUpperCase() + ' ' + hexs);
    }
  }

  // ---------- 大块读 / 写（提速核心）----------
  // sys-botbase 的 peek/poke 支持一次读/写很长（上限由 MAX_LINE_LENGTH=22016 决定）：
  //   · 读：一次最多输出 MAX_LINE_LENGTH 字节（hex 是 2 倍，但输出不受行限制）
  //   · 写：命令是 "poke <off> <hex>"，hex 占 2 字符/字节，所以单次数据 ≤ ~11000 字节
  // 自动按安全分块大小切分，把 200 次请求降到 1~3 次。
  var READ_CHUNK = 20000;    // 单次读字节数（< 22016 留余量）
  var WRITE_CHUNK = 8000;    // 单次写字节数（hex 16000 字符 < 22016 留余量）

  /** 大块读：从绝对地址 addr 读 n 字节（自动按 READ_CHUNK 分块），返回 Uint8Array */
  async function readRange(addr, n) {
    var hb = await getHeapBase();
    var out = new Uint8Array(n);
    var got = 0;
    while (got < n) {
      var thisLen = Math.min(READ_CHUNK, n - got);
      var a = addr + got;
      var piece;
      if (hb && a >= hb && a < hb + 0x40000000) {
        piece = await peekHeap(a - hb, thisLen);
      } else {
        piece = await peekMain(a, thisLen);
      }
      if (!piece || piece.length === 0) break;
      out.set(piece.subarray(0, Math.min(piece.length, n - got)), got);
      if (piece.length < thisLen) break;   // 读不满，结束
      got += thisLen;
    }
    return out;
  }

  /** 大块写：把 data 写到绝对地址 addr（自动按 WRITE_CHUNK 分块） */
  async function writeRange(addr, data) {
    var hb = await getHeapBase();
    var total = data.length;
    var done = 0;
    while (done < total) {
      var thisLen = Math.min(WRITE_CHUNK, total - done);
      var a = addr + done;
      var part = data.subarray(done, done + thisLen);
      var hexs = '0x' + bytesToHex(part);
      if (hb && a >= hb && a < hb + 0x40000000) {
        await Bridge.cmd('poke 0x' + (a - hb).toString(16).toUpperCase() + ' ' + hexs);
      } else {
        await Bridge.cmd('pokeMain 0x' + a.toString(16).toUpperCase() + ' ' + hexs);
      }
      done += thisLen;
    }
    return true;
  }

  return {
    hexToBytes: hexToBytes,
    bytesToHex: bytesToHex,
    u64: u64,
    u32: u32,
    putU32: putU32,
    getHeapBase: getHeapBase,
    getMainBase: getMainBase,
    resetCache: resetCache,
    peekHeap: peekHeap,
    peekMain: peekMain,
    readAbs: readAbs,
    writeAbs: writeAbs,
    readRange: readRange,
    writeRange: writeRange
  };
})();