/* ============================================================
 * bridge.js —— 与中转服务的通信层（唯一和后端打交道的地方）
 * 中转只提供：GET /status、POST /cmd、POST /config
 * ============================================================ */

var Bridge = (function () {
  // 中转地址
  //  优先级：localStorage 手动设置 > 当前页面的 host > 默认 127.0.0.1
  //  说明：网页就是中转自己发出来的（GET / 返回 index.html），
  //        所以"哪个地址能打开网页，那个地址就能连中转" —— 直接用 location.host 最稳。
  var DEFAULT = 'http://127.0.0.1:8080';
  var base = localStorage.getItem('bridge') || null;

  (function autoDetect() {
    if (base) return;                 // 用户手动设置过，优先用
    var h = location.hostname;
    // 用当前页面的来源拼中转地址（端口固定 8080）
    if (h && h !== 'localhost') {
      base = 'http://' + h + ':8080';
    } else {
      base = DEFAULT;
    }
  })();

  function url(path) {
    return base.replace(/\/+$/, '') + path;
  }

  /** 探活：返回 {ok, connected, ip, port} */
  async function status() {
    var r = await fetch(url('/status'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }

  /** 发一条原始 sys-botbase 命令，返回回复文本（已 trim） */
  async function cmd(s) {
    var r = await fetch(url('/cmd'), { method: 'POST', body: s });
    var t = await r.text();
    if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
    return t.trim();
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
    setTarget: setTarget,
    getBase: getBase,
    setBase: setBase
  };
})();