/* ============================================================
 * 怪异任务编辑器 · Service Worker
 * 策略：网络优先（network-first），失败时用缓存兜底。
 *   - 本工具会频繁更新 index.html，所以优先拿最新版；
 *   - 离线/断网时仍能打开上次缓存的页面（至少能看到界面）。
 * 注意：SW 只在 HTTPS 或 localhost 下才会被浏览器注册。
 *       http://192.168.x.x 打开时浏览器会拒绝注册（代码里已做容错）。
 *
 * ⚠️ CACHE 里的版本号需要手动保持与 js/data.js 的 APP_VERSION 一致。
 *    发新版时两处一起改，activate 时会自动清掉上一版的缓存。
 *    （早期由 _inline.py 自动写入，该脚本已在 v1.38.0 随外链改造一并移除）
 * ============================================================ */

const CACHE = 'anomaly-forge-v1.38.1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  // js/ 已改为外链，必须全部预缓存，否则离线打不开
  './js/data.js',
  './js/items.js',
  './js/cheats.js',
  './js/bridge.js',
  './js/memory.js',
  './js/quest.js',
  './js/store.js',
  './js/app.js'
];

// 安装：预缓存核心资源
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => {
      // 单个失败不影响整体安装
      return Promise.all(
        ASSETS.map((u) => cache.add(u).catch(() => null))
      );
    })
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 请求：网络优先，失败回退缓存
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源 GET；跨域（如 Switch 中转 8080 的 /cmd 请求）直接放行
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // 中转命令接口不缓存
  if (url.pathname === '/cmd' || url.pathname.endsWith('/cmd')) return;

  // 手动"检查更新"时带的 _t 参数 → 直接走网络，不落缓存
  const bypass = url.searchParams.has('_t');

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (!bypass) {
          // 成功后顺手更新缓存
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match('./index.html'))
      )
  );
});

// 消息：来自页面的"更新"操作 → 清掉旧缓存（配合 skipWaiting）
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skip-waiting-clear') {
    const reply = (ok) => {
      // 回执给页面，让它知道可以安全刷新了
      try {
        if (event.source && event.source.postMessage) {
          event.source.postMessage({ type: 'cleared', ok: ok });
        }
      } catch (e) {}
    };
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.skipWaiting())
        .then(() => reply(true))
        .catch(() => reply(false))
    );
  }
});