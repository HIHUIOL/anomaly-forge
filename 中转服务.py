#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
 中转服务.py —— 怪异任务编辑器（PWA）本地 HTTP 中转 + 静态托管
============================================================================

 作用：
   浏览器里的网页不能直接开 TCP socket 去连 Switch，
   所以需要这个中转服务，把 HTTP 请求翻译成 sys-botbase 的 TCP 命令。

 它做两件事：
   1. 静态托管 —— 把本目录下的 index.html / js/ / 图标 发给浏览器
   2. TCP 中转 —— 把 /cmd 收到的文本，原样转发给 Switch 的 sys-botbase

 依赖：只用 Python 3 标准库，不需要 pip install 任何东西。

 用法：
     python3 中转服务.py
     python3 中转服务.py --port 6001 --ip 192.168.1.5 --swport 6000
     python3 中转服务.py --no-browser      # 不自动开浏览器

============================================================================
 对外接口（前端 js/bridge.js 约定，不要随意改）
============================================================================

  GET  /status
       返回 {"ok":true,"connected":bool,"ip":str,"port":int}

  POST /cmd          body = 原始命令文本（如 "getHeapBase"）
       返回 text/plain —— Switch 的回复原文（已 strip）
       读命令：等 Switch 有回包才返回
       写命令：不等回包（NS 不回数据），立即返回 "ok"

  POST /cmdwait      body = 原始命令文本
       用途：clickSeq 这类命令，NS 播完会回 "done <耗时ms>"
       返回 text/plain —— 形如 "done 1234"

  POST /config       body = {"ip":"192.168.1.5","port":6000}
       返回 {"ok":true,"ip":...,"port":...}

  POST 之外的所有请求 → 静态文件

  CORS：全部放行（网页可能是从别的端口发出来的）

============================================================================
 协议要点（依据 leolovenet/sys-agent 的 sysagent.py 与 main.c 实现）
============================================================================
 1) 每条命令都以 \r\n 结尾，回包是【一行 ASCII，以 \n 结束】。
    所以必须按行读，不能用"空闲多久没数据就算完"来判断 —— 那样又慢又不准。

 2) 有两类命令：
      新版系统命令 → 回 `OK key=value` / `ERR code=...`
      旧版裸命令   → 成功回数据行（十六进制/文本），失败回 `ERR ...`

 3) "静默命令"（poke/freeze/click…）成功时【什么都不打印】，
    但失败时【会打印 ERR 诊断】。所以不能简单地"发完就不管"：
    要发完抢读 20ms，读到 ERR 就报错，读不到才算真成功。
    （早期版本直接不等回包，会吞掉错误信息 → 用户看到"提示成功其实失败"）

 4) 静默命令之后要标记 dirty，下次操作前重连，
    否则上一条的残留诊断会被误读成本条命令的回包。

 5) freeze / poke 的地址都是【相对 heap】，源码是 heap_base + address。
    commands.md 里写"absolute address"是文档错误，以源码为准。

============================================================================
"""

import argparse
import atexit
import json
import os
import signal
import socket
import sys
import threading
import time
import webbrowser

# ---------------------------------------------------------------------------
# 配置默认值
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_HTTP_PORT = 6001          # 中转服务自己的端口
DEFAULT_NS_IP = "192.168.1.5"     # Switch 的 IP（可在网页设置里改）
DEFAULT_NS_PORT = 6000            # sys-botbase 端口

# 连 Switch 的超时（秒）—— 局域网内 5 秒足够
NS_CONNECT_TIMEOUT = 5.0

# 读命令等回包的超时（秒）
READ_TIMEOUT = 3.0

# 静默命令"抢读诊断"的超时（秒）—— 官方客户端用的就是 0.02
SILENT_PEEK_TIMEOUT = 0.02

# 单行回包上限。
# pixelPeek 会把整张 JPEG 作为一行十六进制返回，官方给的是 4 MiB，
# 因为 sys-agent 截图缓冲 0x7D000 字节，最坏情况十六进制正好 1 MiB。
RESPONSE_LIMIT = 4 * 1024 * 1024

# /cmdwait 等 done 的默认超时（秒）
CMDWAIT_TIMEOUT = 30.0

# ---------------------------------------------------------------------------
# 静默命令清单（成功时不打印任何内容）
# ---------------------------------------------------------------------------
# 重要概念更正：
#   这批命令【不是"完全不回包"】，而是"成功时静默"。
#   失败时它们会打印 `ERR code=...` 诊断 —— 这个信息必须让用户看到，
#   否则又变成"提示成功其实失败"。
#
#   所以处理方式是：发完用 20ms 抢读一行（见 SILENT_PEEK_TIMEOUT），
#   读到 ERR 就报错，读到别的当诊断信息返回，读不到就是正常成功。
#
#   这比"直接不等回包"准确得多，和官方 sysagent.py 的 _bare_command_once 一致。
# ---------------------------------------------------------------------------
IS_SILENT_CMD = {
    # --- 内存写入 ---
    "poke",
    "pokeMain",
    "pokeAbsolute",
    "pointerPoke",

    # --- 数值冻结（成功静默；失败会打印 ERR）---
    "freeze",
    "unFreeze",
    "freezeClear",
    "freezePause",
    "freezeUnpause",

    # --- 按键 / 摇杆 / 触屏 ---
    "click",
    "clickSeq",
    "clickCancel",
    "key",
    "keyMod",
    "keyMulti",
    "release",
    "setStick",
    "touchHold",
    "touchCancel",

    # --- 配置类（会打印 buttonClickSleepTime=N 之类的回显，也要抢读）---
    "configure",
}

# 补充：部分版本用这些名字开关外设
IS_SILENT_CMD_EXTRA = {
    "detachController",
    "attachController",
    "screenOn",
    "screenOff",
}


def is_silent_cmd(cmd_text):
    """判断这条命令是否"成功时静默"（需要 20ms 抢读诊断）。"""
    if not cmd_text:
        return False
    verb = cmd_text.strip().split(" ", 1)[0]
    return verb in IS_SILENT_CMD or verb in IS_SILENT_CMD_EXTRA


# ---------------------------------------------------------------------------
# Switch 连接管理
# ---------------------------------------------------------------------------
class SwitchLink:
    """持有一条到 sys-botbase 的长连接。断线自动重连。"""

    def __init__(self, ip, port):
        self.ip = ip
        self.port = port
        self.sock = None
        self.lock = threading.Lock()   # 同一时刻只允许一条命令在飞

    # -- 内部 --------------------------------------------------------------
    def _close(self):
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
        self.sock = None
        self.buf = bytearray()
        self.dirty = False

    def _connect(self):
        """建立连接，失败返回 False（不抛异常）。"""
        self._close()
        try:
            s = socket.create_connection(
                (self.ip, self.port), timeout=NS_CONNECT_TIMEOUT
            )
            s.settimeout(READ_TIMEOUT)
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.sock = s
            self.buf = bytearray()
            self.dirty = False
            return True
        except Exception:
            self.sock = None
            return False

    def _readline(self, max_bytes=RESPONSE_LIMIT):
        """读到换行为止，返回这一行（不含 \\r\\n）。

        这是 sys-agent / sys-botbase 协议的标准读法：
        每条命令的回包都是【一行 ASCII，以 \\n 结束】。
        pixelPeek 会回几十万字符，仍是一行，只是很长 —— 所以上限给到 4 MiB。
        """
        if self.sock is None:
            raise ConnectionError("没连接")
        while True:
            i = self.buf.find(b"\n")
            if i >= 0:
                line = bytes(self.buf[:i])
                del self.buf[:i + 1]
                return line.rstrip(b"\r")
            try:
                data = self.sock.recv(4096)
            except socket.timeout:
                raise ConnectionError("等 Switch 回包超时")
            if not data:
                raise ConnectionError("Switch 断开了连接")
            self.buf.extend(data)
            if len(self.buf) > max_bytes:
                self._close()
                raise ConnectionError("回包超过 %d 字节上限" % max_bytes)

    # -- 对外 --------------------------------------------------------------
    def send(self, cmd_text, wait_reply=None, timeout=None):
        """发一条命令。

        sys-agent 里所有命令【都会回一行】，但分两类：

        ① 新版系统命令 → 回 `OK key=value` / `ERR code=...`
        ② 旧版裸命令   → 成功时回数据行；静默命令（poke/freeze/click…）
                         成功时【什么都不打印】，但失败时会打印 `ERR ...` 诊断

        所以正确处理方式是：
          静默命令 → 发出去，用【极短超时（20ms）】试着读一行：
                     读到了 → 是诊断信息，原样返回给前端
                     读不到 → 正常（说明成功了）
                     然后标记 dirty，下次操作前重连，避免残留串到下一命令

          这与官方客户端 sysagent.py 的 _bare_command_once 完全一致。
        """
        silent = is_silent_cmd(cmd_text) if wait_reply is None else (not wait_reply)

        with self.lock:
            # 上一条静默命令可能有残留输出 → 换新连接，保证流是干净的
            if self.sock is not None and self.dirty:
                self._close()

            if self.sock is None:
                if not self._connect():
                    raise ConnectionError(
                        "连不上 Switch %s:%s（sys-botbase 在跑吗？IP 对吗？）"
                        % (self.ip, self.port)
                    )

            payload = (cmd_text.rstrip("\r\n") + "\r\n").encode("ascii", "ignore")

            try:
                self.sock.settimeout(NS_CONNECT_TIMEOUT)
                self.sock.sendall(payload)

                if silent:
                    # 静默命令：抢读 20ms，有诊断就带回去，没有就算成功
                    self.dirty = True
                    self.sock.settimeout(SILENT_PEEK_TIMEOUT)
                    try:
                        line = self._readline()
                    except (ConnectionError, OSError):
                        return "ok"
                    finally:
                        try:
                            if self.sock:
                                self.sock.settimeout(READ_TIMEOUT)
                        except Exception:
                            pass
                    txt = line.decode("ascii", "ignore").strip()
                    if txt.startswith("ERR"):
                        # 真出错了，要让前端看到
                        raise ConnectionError(txt)
                    return txt or "ok"

                # 普通命令：等一行完整回包
                self.sock.settimeout(timeout or READ_TIMEOUT)
                line = self._readline()
                txt = line.decode("ascii", "ignore").strip()
                if not txt:
                    # 空行 = 对面没按协议回话（端口通了但对面不是 sys-agent）
                    self._close()
                    raise ConnectionError("Switch 回了空行（对面可能不是 sys-botbase）")
                return txt

            except ConnectionError:
                self._close()
                raise
            except socket.timeout:
                self._close()
                raise ConnectionError("等 Switch 回包超时")
            except Exception as e:
                self._close()
                raise ConnectionError(str(e))

    def send_multiline(self, cmd_text, stop_prefixes, timeout=None):
        """发一条命令，然后【连续读多行】直到某行命中 stop_prefixes。

        为什么需要这个：
          sys-agent 的 clickSeq 会先回 "OK tokens=N estMs=M"，播完再回 "done"。
          如果只读一行就拿去判断，会把 "OK ..." 当成结果 → 前端以为失败。

        返回 (最终行, 之前的所有中间行列表)
        """
        stops = tuple(p.lower() for p in stop_prefixes)

        with self.lock:
            if self.sock is not None and self.dirty:
                self._close()
            if self.sock is None:
                if not self._connect():
                    raise ConnectionError(
                        "连不上 Switch %s:%s（sys-botbase 在跑吗？IP 对吗？）"
                        % (self.ip, self.port))

            payload = (cmd_text.rstrip("\r\n") + "\r\n").encode("ascii", "ignore")
            extra = []
            try:
                self.sock.settimeout(NS_CONNECT_TIMEOUT)
                self.sock.sendall(payload)

                deadline = time.time() + (timeout or CMDWAIT_TIMEOUT)
                while True:
                    remain = deadline - time.time()
                    if remain <= 0:
                        self._close()
                        raise ConnectionError(
                            "等回包超时（%.0fs）" % (timeout or CMDWAIT_TIMEOUT))
                    self.sock.settimeout(remain)
                    line = self._readline().decode("ascii", "ignore").strip()
                    if not line:
                        continue
                    if line.lower().startswith(stops):
                        return line, extra
                    extra.append(line)
                    # ERR 也立刻停，不再傻等
                    if line.lower().startswith("err"):
                        return line, extra
                    # 中间行太多说明对面行为异常，别无限读
                    if len(extra) > 64:
                        self._close()
                        raise ConnectionError("回包行数异常（>64 行）")

            except ConnectionError:
                self._close()
                raise
            except socket.timeout:
                self._close()
                raise ConnectionError("等 Switch 回包超时")
            except Exception as e:
                self._close()
                raise ConnectionError(str(e))

    def set_target(self, ip, port):
        """改目标 IP/端口，并主动重连。"""
        with self.lock:
            self.ip = ip
            self.port = int(port)
            self._close()
        return self._connect()

    def ping(self):
        """探活：必须真的收到一行有效回包才算连着。

        ⚠️ 只判断 connect() 成功是不够的：
           某些网络环境 TCP 能连上但对面不回数据 → 会被误判成"已连接"。
           所以这里用 getVersion（sys-agent 有，sys-botbase 回错误行也算通），
           只要收到【非空的一行】就认为对面在说话。
        """
        try:
            r = self.send("getVersion", timeout=2.0)
            return bool(r and r.strip())
        except Exception:
            return False


# ---------------------------------------------------------------------------
# 极简 HTTP 服务器（标准库实现，不依赖 Flask）
# ---------------------------------------------------------------------------
import http.server
import socketserver
import urllib.parse

LINK = None          # SwitchLink 实例，main 里初始化
HTTP_PORT = DEFAULT_HTTP_PORT


MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}


class Handler(http.server.BaseHTTPRequestHandler):
    # --- 工具 ------------------------------------------------------------
    def log_message(self, fmt, *args):
        # 默认日志太吵，改成简洁版
        msg = fmt % args
        if "/status" in msg:
            return          # status 探活不打印，否则刷屏
        print("  %s %s" % (self.command, msg.split(" ")[1] if " " in msg else msg))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _text(self, s, code=200):
        body = s.encode("utf-8", "ignore")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return ""
        return self.rfile.read(n).decode("utf-8", "ignore")

    # --- 路由 ------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/status":
            connected = LINK.ping()
            self._json({
                "ok": True,
                "connected": connected,
                "ip": LINK.ip,
                "port": LINK.port,
            })
            return

        self._serve_static(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        body = self._read_body()

        try:
            # ---- /cmd ：普通命令 --------------------------------------
            if path == "/cmd":
                # send() 自己会判断静默命令并做 20ms 抢读，
                # 这里只负责给"大回包"命令放宽超时。
                low = body.strip().lower()
                if low.startswith("pixelpeek") or low.startswith("screencapture"):
                    out = LINK.send(body, timeout=15.0)
                else:
                    out = LINK.send(body, timeout=READ_TIMEOUT)
                self._text(out)
                return

            # ---- /cmdwait ：等 Switch 回 done -------------------------
            if path == "/cmdwait":
                t0 = time.time()

                # ⚠️ sys-agent 与 sys-botbase 的 clickSeq 回包行数不同：
                #
                #   sys-botbase  ：静默，播完回一行 "done"
                #   sys-agent    ：【先】回 "OK tokens=N estMs=M"
                #                   【再】回 "done"（或被 clickCancel 后回 "cancelled"）
                #
                # 所以必须一直读，直到读到 done / cancelled / ERR。
                # 只读第一行会把 "OK tokens=..." 当结果 → 前端误判成失败。
                final, extras = LINK.send_multiline(
                    body,
                    stop_prefixes=("done", "cancelled", "err"),
                    timeout=CMDWAIT_TIMEOUT,
                )
                low = final.lower()

                if low.startswith("done"):
                    parts = final.split()
                    if len(parts) < 2:
                        # sys-agent 回 "done" 不带耗时，自己算一个
                        final = "done %d" % int((time.time() - t0) * 1000)
                    self._text(final)
                elif low.startswith("err"):
                    self._text(final, 502)
                else:
                    # cancelled
                    self._text(final)
                return

            # ---- /config ：改 Switch 目标 -----------------------------
            if path == "/config":
                try:
                    j = json.loads(body or "{}")
                except Exception:
                    self._text("JSON 格式错误", 400)
                    return
                ip = (j.get("ip") or LINK.ip).strip()
                port = int(j.get("port") or LINK.port)
                ok = LINK.set_target(ip, port)
                self._json({
                    "ok": True,
                    "connected": ok,
                    "ip": LINK.ip,
                    "port": LINK.port,
                })
                return

            self._text("未知接口: " + path, 404)

        except ConnectionError as e:
            # 连不上 / 超时 → 502，前端会显示错误文本
            print("  ⚠️  %s  →  %s" % (body.strip()[:60], e))
            self._text(str(e), 502)
        except Exception as e:
            print("  ❌  %s  →  %r" % (body.strip()[:60], e))
            self._text("中转内部错误: %r" % (e,), 500)

    # --- 静态托管 --------------------------------------------------------
    def _serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"

        # 防止 ../ 穿越
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(HERE, rel))
        if not full.startswith(HERE):
            self._text("403", 403)
            return

        if os.path.isdir(full):
            full = os.path.join(full, "index.html")

        if not os.path.isfile(full):
            self._text("404 Not Found: " + path, 404)
            return

        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")

        try:
            with open(full, "rb") as f:
                data = f.read()
        except Exception as e:
            self._text("读取失败: %r" % (e,), 500)
            return

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # index.html / sw.js 不缓存，避免改了没生效
        if ext in (".html", ".htm") or rel == "sw.js":
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(data)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """允许并发请求（多个 tab 同时开）。"""
    daemon_threads = True
    allow_reuse_address = True


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def local_ip():
    """取本机局域网 IP（不实际发包）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 自动探测 Switch IP
# ---------------------------------------------------------------------------
def _probe_botbase(ip, port, timeout=0.35):
    """连一下 + 发 getTitleID，能收到十六进制回包才算真的是 sys-botbase。

    只 connect 成功是不够的（有的设备端口碰巧开着，或中间设备劫持 TCP），
    必须见到真实回包才认。
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        if s.connect_ex((ip, port)) != 0:
            s.close()
            return False
        s.sendall(b"getTitleID\r\n")
        buf = b""
        try:
            while len(buf) < 64:
                d = s.recv(64)
                if not d:
                    break
                buf += d
                if b"\n" in d:
                    break
        except socket.timeout:
            pass
        s.close()
        txt = buf.decode("ascii", "ignore").strip()
        # 正常回包是 16 位十六进制，如 0100000000010000
        if not txt:
            return False
        return all(c in "0123456789abcdefABCDEF" for c in txt)
    except Exception:
        return False


def _subnet_hosts(my_ip):
    """根据本机 IP 猜 /24 网段，返回除自己外的所有主机地址。

    不做真正的子网掩码探测（Termux 上不可靠），
    直接按最常见的家用 /24 处理，够用且简单。
    """
    try:
        parts = my_ip.split(".")
        if len(parts) != 4:
            return []
        head = ".".join(parts[:3])
        me = parts[3]
        return ["%s.%d" % (head, i) for i in range(1, 255) if str(i) != me]
    except Exception:
        return []


def discover_switch(port=DEFAULT_NS_PORT, my_ip=None, known=None, workers=64,
                    timeout=0.35, log=print):
    """在局域网里扫 sys-botbase。

    策略（快 → 慢）：
      1. 先试上次成功过的 IP（记住的），命中就直接返回 —— 几乎瞬间
      2. 全 /24 并发扫，找到第一个就返回
    返回 IP 字符串，找不到返回 None。
    """
    # 1) 上次成功的
    if known and _probe_botbase(known, port, timeout=timeout):
        log("  ✔ 上次用过的 Switch 还在：%s" % known)
        return known

    if not my_ip or my_ip.startswith("127."):
        return None

    hosts = _subnet_hosts(my_ip)
    if not hosts:
        return None

    log("  🔍 扫描网段 %s.0/24（%d 个地址）..." % (my_ip.rsplit(".", 1)[0], len(hosts)))

    found = []
    lock = threading.Lock()
    queue = list(hosts)
    qlock = threading.Lock()

    def worker():
        while True:
            with qlock:
                if not queue or found:
                    return
                ip = queue.pop()
            if _probe_botbase(ip, port, timeout=timeout):
                with lock:
                    if not found:
                        found.append(ip)
                return

    threads = [threading.Thread(target=worker, daemon=True)
               for _ in range(min(workers, len(hosts)))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    return found[0] if found else None


# ---------------------------------------------------------------------------
# 单实例 / 开关控制
# ---------------------------------------------------------------------------
PIDFILE = os.path.join(HERE, ".relay.pid")


def pid_alive(pid):
    """判断进程是否还活着（跨平台，不杀进程）。"""
    try:
        pid = int(pid)
    except Exception:
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True          # 存在但没权限 → 还是活的
    except Exception:
        return False


def _proc_start_time(pid):
    """读 /proc/<pid>/stat 的第 22 项（进程启动时刻，单位 clock tick）。

    用来识别【PID 被系统复用】：
    我们记录的 PID 可能是很久前退出的那个中转，
    而现在这个 PID 恰好被别的进程继承了 → 光看"PID 存在"会误判成在运行，
    于是第二次执行时会去"关闭"一个根本不是我们的进程（还会 PermissionError）。
    """
    try:
        with open("/proc/%d/stat" % int(pid), "rb") as f:
            data = f.read().decode("utf-8", "ignore")
        # comm 字段可能含空格和括号，从左括号后第一个右括号之后开始切
        rest = data[data.rindex(")") + 2:].split()
        # rest[0] 对应 stat 的第 3 项(state)，所以第 22 项 = rest[19]
        return rest[19]
    except Exception:
        return None


def read_pidfile():
    """读 .relay.pid，返回 (pid, start_time)。"""
    try:
        with open(PIDFILE, "r") as f:
            raw = f.read().strip()
        if not raw:
            return 0, None
        if " " in raw:
            p, st = raw.split(None, 1)
            return int(p), st.strip()
        return int(raw), None
    except Exception:
        return 0, None


def write_pidfile(pid):
    """写入 PID 和启动时间，用于防 PID 复用误判。"""
    try:
        st = _proc_start_time(pid)
        with open(PIDFILE, "w") as f:
            f.write("%d %s" % (pid, st or "0"))
    except Exception:
        pass


def remove_pidfile():
    try:
        os.remove(PIDFILE)
    except Exception:
        pass


def port_in_use(port):
    """端口是否已被监听（用于兜底判断"已经在跑"）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def main():
    global LINK, HTTP_PORT

    ap = argparse.ArgumentParser(
        description="怪异任务编辑器 · 本地中转服务（再次执行 = 关闭）")
    ap.add_argument("--port", type=int, default=DEFAULT_HTTP_PORT,
                    help="中转服务监听端口（默认 6001）")
    ap.add_argument("--ip", default=None,
                    help="Switch IP（不给就自动探测）")
    ap.add_argument("--swport", type=int, default=DEFAULT_NS_PORT,
                    help="sys-botbase 端口（默认 6000）")
    ap.add_argument("--no-browser", action="store_true",
                    help="启动后不自动打开浏览器")
    ap.add_argument("--status", action="store_true",
                    help="只查看运行状态，不启停")
    args = ap.parse_args()

    HTTP_PORT = args.port

    # =====================================================================
    #  开关逻辑：已经在跑 → 关闭；没在跑 → 启动
    # =====================================================================
    old_pid, old_st = read_pidfile()

    # 判断"我们自己的中转"是否真的在跑。
    # 光看 PID 存在不够 —— PID 会被系统复用，必须比对启动时间。
    running = False
    if old_pid and pid_alive(old_pid):
        now_st = _proc_start_time(old_pid)
        if old_st and now_st and old_st != "0":
            running = (now_st == old_st)
        else:
            # 老格式（只有 PID，没有启动时间）→ 无法校验，
            # 保守一点：用端口 + 我们能连上它来确认
            running = port_in_use(HTTP_PORT)
        if not running:
            # PID 活着但不是我们的 → 记录已失效，清掉
            remove_pidfile()

    # 兜底：PID 文件丢了但端口占着，八成也是我们的旧进程
    if not running and port_in_use(HTTP_PORT) and not args.status:
        # 端口被别的程序占着 —— 不去乱杀，提示用户
        print()
        print("⚠️  端口 %d 已被占用，但不是本脚本记录的进程。" % HTTP_PORT)
        print("    可能是有旧的中转在跑，或别的程序占了这个端口。")
        print("    换个端口：python3 中转服务.py --port 6002")
        print()
        return

    if args.status:
        print()
        if running:
            print("🟢 中转正在运行（PID %d）" % old_pid)
            print("   http://127.0.0.1:%d/" % HTTP_PORT)
        else:
            print("⚪ 中转未运行")
        print()
        return

    if running:
        # ---------------- 第二次执行 → 关闭 ----------------
        print()
        print("🔴 正在关闭中转（PID %d）..." % old_pid)
        try:
            os.kill(old_pid, 15)          # SIGTERM，让它自己收尾
        except Exception as e:
            print("   ⚠️  发送关闭信号失败：%r" % (e,))

        # 等它真的退出（最多 5 秒）
        for _ in range(50):
            if not pid_alive(old_pid):
                break
            time.sleep(0.1)

        if pid_alive(old_pid):
            print("   进程没退干净，强制结束")
            try:
                os.kill(old_pid, 9)
            except Exception:
                pass
            time.sleep(0.3)

        remove_pidfile()

        if port_in_use(HTTP_PORT):
            print("   ⚠️  端口 %d 仍被占用" % HTTP_PORT)
        else:
            print("   ✅ 已关闭")
        print()
        return

    # ---------------- 第一次执行 → 启动 ----------------
    print()
    print("=" * 58)
    print("  怪异任务编辑器 · 中转服务")
    print("=" * 58)

    lan = local_ip()

    # ---- 找 Switch ----
    ns_ip = args.ip
    if ns_ip:
        print("  Switch IP : %s（手动指定）" % ns_ip)
    else:
        print("  Switch IP : 自动探测中 ...")
        known_file = os.path.join(HERE, ".relay.nsip")
        known = None
        try:
            with open(known_file) as f:
                known = f.read().strip() or None
        except Exception:
            pass

        ns_ip = discover_switch(args.swport, lan, known)
        if ns_ip:
            print("  Switch IP : %s ✅" % ns_ip)
            try:
                with open(known_file, "w") as f:
                    f.write(ns_ip)
            except Exception:
                pass
        else:
            ns_ip = DEFAULT_NS_IP
            print("  Switch IP : 没扫到，先用默认 %s" % ns_ip)
            print("              （游戏没开 / sys-botbase 没跑 / 不在同一 WiFi）")

    LINK = SwitchLink(ns_ip, args.swport)

    print("-" * 58)
    print("  本地      : http://127.0.0.1:%d/" % HTTP_PORT)
    print("  局域网    : http://%s:%d/" % (lan, HTTP_PORT))
    print("  NS        : %s:%d" % (ns_ip, args.swport))
    print("-" * 58)

    # 探一下 Switch
    print("  正在连接 Switch ...", end=" ", flush=True)
    if LINK.ping():
        print("✅ 已连接")
    else:
        print("⚠️  未连接")
        print("     → 确认游戏已开、sys-botbase 在跑")
        print("     → 或网页里点 ⚙️ 设置手动改地址")

    print("-" * 58)
    print("  💡 再执行一次本脚本 = 关闭中转")
    print("  💡 按 Ctrl+C 也可以停止")
    print("=" * 58)
    print()

    # ---- 写 PID 文件（先写，保证重复执行能关掉）----
    write_pidfile(os.getpid())

    # ---- 退出时清理 ----
    def cleanup():
        remove_pidfile()

    # 关键：收到 SIGTERM（第二次执行时发的）要能优雅退出。
    # 否则进程被直接杀掉 → PID 文件残留 → 下次判断混乱。
    def on_term(signum, frame):
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGTERM, on_term)
    except Exception:
        pass

    # 兜底：无论怎么退出都清 PID 文件
    atexit.register(cleanup)

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(
            "http://127.0.0.1:%d/" % HTTP_PORT)).start()

    srv = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  正在停止 ...")
        srv.shutdown()
        print("  已停止 👋")
    except Exception as e:
        raise


if __name__ == "__main__":
    main()
