/* ============================================================
 * bridge.js —— 与中转服务的通信层（唯一和后端打交道的地方）
 * 中转只提供：GET /status、POST /cmd、POST /config
 * ============================================================ */

var Bridge = (function () {
  // 中转地址（固定默认：http://127.0.0.1:6001）
  //  优先级：localStorage 手动设置 > 默认 127.0.0.1:6001
  //  说明：网页可能由别的服务（如 8093）发出来，未必和中转同址，
  //        所以这里【不做自动探测】，默认就是 127.0.0.1:6001。
  var DEFAULT = 'http://127.0.0.1:6001';
  var base = localStorage.getItem('bridge') || DEFAULT;

  // 默认请求超时（毫秒）—— 连不上中转时不至于永远挂起
  var TIMEOUT = 12000;
  // 全局"取消令牌"：用户点"取消"时 abort 掉进行中的请求
  var _controller = null;

  /** 开始一次可取消的操作（返回 signal） */
  function beginCancelable() {
    cancel();                 // 若上一次还开着，先取消
    _controller = new AbortController();
    return _controller.signal;
  }
  /** 取消当前操作（abort 正在进行的 fetch）
   *  ⚠️ 不置 null：保留"已 abort"的 signal，后续请求会立刻失败 → 循环快速退出 */
  function cancel() {
    if (_controller) {
      try { _controller.abort(); } catch (e) {}
      // 故意不移除 _controller：它现在处于 aborted 状态，
      // 之后任何 command 都会立即抛错（避免"取消后又继续读"）
    }
  }
  /** 操作结束后调用：清掉取消态，恢复正常 */
  function endCancelable() {
    _controller = null;
  }
  /** 生成 signal：优先用传入的，其次用全局可取消的 */
  function signalOf(sig) {
    if (sig) return sig;
    return _controller ? _controller.signal : undefined;
  }

  // 迁移：早期版本可能存过 8080 / localhost 等旧地址 → 自动升级到新默认值
  (function migrate() {
    if (!base) { base = DEFAULT; return; }
    // 只要端口不是 6001，且是"本机/回环"地址，就换成新默认值
    var m = base.match(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?/i);
    if (m && m[2] !== '6001') {
      base = DEFAULT;
      localStorage.setItem('bridge', base);
    }
  })();

  function url(path) {
    return base.replace(/\/+$/, '') + path;
  }

  /** 带超时的 fetch（超时或取消都会抛错） */
  function fetchT(u, opt, timeoutMs, sig) {
    var ms = timeoutMs === undefined ? TIMEOUT : timeoutMs;
    opt = opt || {};
    var signal = signalOf(sig);
    // 组合：外部 signal + 超时
    var ctrl = null, timer = null;
    if (!signal) {
      // 没有外部 signal → 自己造一个（用于超时）
      ctrl = new AbortController();
      signal = ctrl.signal;
    } else if (ms > 0) {
      // 有外部 signal，也要能超时 → 再造一个把两者串起来
      ctrl = new AbortController();
      var ext = signal;
      if (ext.addEventListener) {
        if (ext.aborted) ctrl.abort();
        else ext.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }
      signal = ctrl.signal;
    }
    if (ms > 0) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, ms);
    }
    opt.signal = signal;
    return fetch(u, opt).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && (e.name === 'AbortError')) {
        throw new Error(ctrl && ctrl.signal.reason === 'timeout' ? '请求超时' : '已取消');
      }
      throw e;
    });
  }

  /** 探活：返回 {ok, connected, ip, port} */
  async function status(sig) {
    var r = await fetchT(url('/status'), {}, 6000, sig);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }

  /** 发一条原始 sys-botbase 命令，返回回复文本（已 trim） */
  async function cmd(s, sig, timeoutMs) {
    var r = await fetchT(url('/cmd'), { method: 'POST', body: s }, timeoutMs, sig);
    var t = await r.text();
    if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
    return t.trim();
  }

  /** ⚡ 发命令并"等到 Switch 回 done"（给 clickSeq 用）
   *  返回 { ok: true/false, ms: 耗时毫秒, raw: 原文 }
   */
  async function cmdWait(s, sig, timeoutMs) {
    var ms = timeoutMs === undefined ? 30000 : timeoutMs;   // 等 done 给长超时
    var r = await fetchT(url('/cmdwait'), { method: 'POST', body: s }, ms, sig);
    var t = await r.text();
    if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
    t = t.trim();
    var parts = t.split(/\s+/);
    return { ok: parts[0] === 'done', ms: parseInt(parts[1] || '0', 10) || 0, raw: t };
  }

  /** 修改 Switch 目标 */
  async function setTarget(ip, port) {
    var r = await fetch(url('/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: ip, port: port })
    });
    return await r.json();
  }

  function getBase() { return base; }
  function setBase(v) { base = v; localStorage.setItem('bridge', v); }

  return {
    status: status,
    cmd: cmd,
    cmdWait: cmdWait,
    setTarget: setTarget,
    getBase: getBase,
    setBase: setBase,
    beginCancelable: beginCancelable,
    cancel: cancel,
    endCancelable: endCancelable
  };
})();