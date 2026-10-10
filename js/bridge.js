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