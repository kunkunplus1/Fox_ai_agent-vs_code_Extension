#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stealth Fetch —— 伪装抓取 MCP 服务器（零依赖手写 MCP 协议）
=====================================================

目标：用 curl_cffi 模拟 Chrome/Edge 的 TLS 指纹（impersonate）+ 支持 Cookie，
绕过常见反爬（B 站、小红书等），把网页/JSON 端点抓取成 LLM 友好的文本。

设计优化（对应「渐进式披露 / 内存 / 逻辑 / 栈堆」要求）：
- 渐进式披露：fetch_url 只返回「行窗口」(start_line, line_count)，Agent 可分批续取，
  不在一次调用里把整页塞给模型。
- 内存优化：curl_cffi 异步流式读取（resp.aiter_content()），按 chunk 解码、按行切分，
  到达「窗口上界 + 余量」立即提前终止读取——长页面也不会整页驻留内存。
- 栈堆优化：全程迭代、无递归；行缓冲有界（单行超长截断），未完结行缓冲设硬上限，
  防止异常长行撑爆堆。
- 逻辑优化：Cookie / 请求头解析独立为纯函数，错误一律以文本返回（不崩服务）。
- 安全护栏（对行为风控友好）：整页缓存——同一 (URL+指纹+Cookie) 在缓存期内只发一次
  真实 GET，Agent 分页续取直接切窗口、零网络，消除「一个长页 = 十几二十个重复 GET」
  的突发画像；同域最小请求间隔（默认 1.5s，可配）进一步压平流量。
- 零依赖：仅依赖 curl_cffi，不引入 mcp SDK 重依赖，安装快、失败面小。

MCP 协议：标准 JSON-RPC 2.0 over stdio（行分隔 JSON）。只实现智能体实际用到的
initialize / tools/list / tools/call（及 ping / notifications/initialized）。
"""

import sys
import os
import json
import re
import time
import asyncio
import hashlib
from urllib.parse import urlparse, urljoin

# —— 常量（有界保护）——
MAX_LINE = 8000          # 单行最大长度，超出截断（防单行撑爆内存）
CUR_HARD_CAP = 2_000_000  # 未完结行缓冲硬上限（字节），超出只保留尾部
WINDOW_MARGIN = 64       # 窗口之外多读几行，用于判定 has_more

# —— 安全 / 效率配置（环境变量可调，行为风控友好）——
# 同域两次「实际网络请求」之间的最小间隔（秒）。0 关闭。
MIN_INTERVAL = float(os.environ.get("STEALTH_FETCH_MIN_INTERVAL", "1.5"))
# 整页缓存存活秒数：命中缓存的续取不再重复下载。0 关闭缓存。
CACHE_TTL = int(os.environ.get("STEALTH_FETCH_CACHE_TTL", "120"))
# 单页缓存行数上限（内存护栏）：超出只存前 N 行，避免超大页撑爆内存。
CACHE_MAX_LINES = int(os.environ.get("STEALTH_FETCH_CACHE_MAX_LINES", "5000"))
# 全局代理（可选）：用于抓取国外站（如 news.ycombinator.com）等直连不通的目标。
# 也可在每次调用时用 fetch_url 的 proxy 参数覆盖。格式：http://127.0.0.1:7890
PROXY = os.environ.get("STEALTH_FETCH_PROXY", "") or None

# —— SSRF 护栏 ——
# fetch_url 的抓取目标由模型每次调用时传入，可能被提示注入诱导去访问内网 / 回环 /
# 云元数据（169.254.169.254 等）。默认拒绝一切私网/回环/链路本地地址；
# 只有显式设置 STEALTH_FETCH_ALLOW_PRIVATE=1 才放行（不推荐）。
ALLOW_PRIVATE = os.environ.get("STEALTH_FETCH_ALLOW_PRIVATE", "") == "1"


def _is_private_host(host: str) -> bool:
    """判断主机名是否为私网/回环/链路本地地址（含 IPv4-mapped IPv6）。

    域名默认放行（宿主侧另有 MCP 连接级校验）；这里覆盖字面 IP 的全部主流写法。
    """
    h = str(host or "").strip().rstrip(".").lower()
    if not h:
        return True
    if h == "localhost" or h.endswith(".localhost") or h == "0.0.0.0":
        return True
    if h.startswith("::ffff:"):  # IPv4-mapped IPv6（::ffff:127.0.0.1 等）→ 拆出 IPv4 继续判
        h = h[len("::ffff:"):]
    if ":" in h:  # IPv6
        if h == "::1":
            return True
        if h.startswith("fe80:") or h.startswith("fc") or h.startswith("fd"):
            return True
        return False
    m = re.match(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$", h)
    if not m:
        return False
    a, b = int(m.group(1)), int(m.group(2))
    if a in (0, 10, 127):
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    if a == 169 and b == 254:  # 链路本地 / 云元数据
        return True
    return False


def _validate_target(url: str):
    """SSRF 护栏：scheme 仅允许 http/https；私网/回环一律拒绝（除非显式放行）。

    返回 None 表示放行，否则返回错误描述字符串。
    """
    if not url or not isinstance(url, str):
        return "URL 为空"
    try:
        p = urlparse(url)
    except Exception:
        return "URL 解析失败"
    if p.scheme not in ("http", "https"):
        return "仅允许 http/https 协议，拒绝：" + (p.scheme or "(空)")
    host = (p.hostname or "").lower()
    if not host:
        return "URL 缺少主机名"
    if ALLOW_PRIVATE:
        return None
    if _is_private_host(host):
        return ("拒绝访问内网/回环地址「" + host + "」（SSRF 防护，"
                "如确需访问本机服务可设置 STEALTH_FETCH_ALLOW_PRIVATE=1）")
    return None

# —— 跨调用持久状态（同进程全局；tools/call 在 main 里顺序执行，天然无并发）——
_CACHE = {}          # key -> {"ts": float, "lines": list, "total": int, "status": int}
_HOST_LAST = {}      # host -> 上次「实际发起网络请求」的时刻（time.monotonic）

TOOL_SCHEMA = {
    "name": "fetch_url",
    "description": (
        "抓取网页并提取文本（渐进式：仅返回指定行窗口）。"
        "用 curl_cffi 模拟 Chrome/Edge TLS 指纹 + 支持 Cookie，可绕过常见反爬（B站等）。"
        "内置安全护栏：整页缓存（同一 URL 在缓存期内只下载一次，续取零网络）、"
        "同域最小请求间隔（默认 1.5s，防突发流量触发行为风控）、单页行数上限（内存护栏）。"
        "可用环境变量调参：STEALTH_FETCH_MIN_INTERVAL / STEALTH_FETCH_CACHE_TTL / "
        "STEALTH_FETCH_CACHE_MAX_LINES；以及代理 STEALTH_FETCH_PROXY（用于抓取国外站）。"
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "目标 URL"},
            "start_line": {"type": "integer", "description": "起始行（0 基），用于分批读取长页面", "default": 0},
            "line_count": {"type": "integer", "description": "本次返回的最大行数", "default": 80},
            "max_len": {"type": "integer", "description": "单行最大长度（超出截断）", "default": 8000},
            "impersonate": {"type": "string", "description": "TLS 指纹伪装目标，如 chrome / chrome131 / edge", "default": "chrome"},
            "cookie": {"type": "string", "description": "Cookie 字符串（k=v; k2=v2），用于需登录的站点", "default": ""},
            "cookie_file": {"type": "string", "description": "Cookie 文件路径（JSON dict 或 Netscape 格式）", "default": ""},
            "headers_json": {"type": "string", "description": "额外请求头（JSON 对象字符串）", "default": ""},
            "proxy": {"type": "string", "description": "代理地址（如 http://127.0.0.1:7890），用于抓直连不通的国外站；也可用环境变量 STEALTH_FETCH_PROXY 全局设置", "default": ""},
            "timeout": {"type": "integer", "description": "超时秒数", "default": 25},
        },
        "required": ["url"],
    },
}


def _parse_cookies(cookie: str | None, cookie_file: str | None) -> dict:
    """把 Cookie 字符串 / 文件解析成 dict（纯函数，失败静默忽略）。"""
    cookies: dict = {}
    if cookie:
        for part in cookie.split(";"):
            part = part.strip()
            if not part or "=" not in part:
                continue
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    if cookie_file and os.path.isfile(cookie_file):
        try:
            with open(cookie_file, "r", encoding="utf-8") as fh:
                txt = fh.read().strip()
            if txt.startswith("{"):
                data = json.loads(txt)
                if isinstance(data, dict):
                    cookies.update({k: str(v) for k, v in data.items()})
            else:
                # Netscape cookie 格式：每行以 \t 分隔，第 6/7 列为 name/value
                for line in txt.splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    cols = line.split("\t")
                    if len(cols) >= 7 and cols[5]:
                        cookies[cols[5]] = cols[6]
        except Exception:
            pass
    return cookies


def _parse_headers(headers_json: str | None) -> dict:
    """把 JSON 字符串解析成请求头 dict（纯函数）。"""
    if not headers_json:
        return {}
    try:
        data = json.loads(headers_json)
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        pass
    return {}


def _finalize(out_lines: list, seen: int, start_line: int, line_count: int,
              status: int, has_more: bool, capped: bool = False) -> str:
    """组装返回文本：头部元信息 + 行窗口 + 续取提示。"""
    end = start_line + len(out_lines)
    head = (f"[stealth-fetch] HTTP {status} | 行窗口 {start_line + 1}-{end} "
            f"/ 已读 {seen} 行 | has_more={has_more}\n")
    body = "\n".join(out_lines)
    if has_more:
        nxt = start_line + line_count
        body += (f"\n…(更多内容请用 start_line={nxt} 续取，"
                 f"渐进式披露避免一次性载入整页)")
    elif capped:
        body += (f"\n…(注：本页超长，已按内存护栏仅缓存前 {CACHE_MAX_LINES} 行，"
                 f"其余内容未载入)")
    return head + body


def _cache_key(url: str, cookies: dict, impersonate: str, headers_json: str) -> str:
    """缓存键：URL + 指纹 + Cookie + 自定义头 一起决定页面身份。
    同 URL 不同登录态/指纹视为不同页，避免串味。"""
    sig = (url + "|" + impersonate + "|" +
           json.dumps(cookies, sort_keys=True, ensure_ascii=False) + "|" +
           (headers_json or ""))
    return hashlib.sha1(sig.encode("utf-8")).hexdigest()


class _Blocked(Exception):
    """抓取目标被 SSRF 护栏拦截。"""


async def _download(url: str, impersonate: str, cookies: dict, headers: dict,
                    timeout: int, proxy: str | None = None):
    """真正发起一次网络请求，流式解析出「完整行列表」（供缓存复用）。
    返回 (lines, total, status)；HTTP>=400 时返回 (None, 0, status)。
    内存护栏：行列表最多存 CACHE_MAX_LINES 行，但 total 仍计真实总行数。
    proxy: 可选代理地址（http://127.0.0.1:7890），用于直连不通的国外站。

    安全：重定向改为手动逐跳跟随（最多 5 跳），每一跳的目标都重新过 SSRF 护栏
    —— 防止「公网 302 → 内网/元数据」的跳板绕过。"""
    from curl_cffi.requests import AsyncSession

    connect_timeout = min(10, timeout)
    lines: list = []
    total = 0
    status = 0
    cur_url = url
    async with AsyncSession(impersonate=impersonate,
                            timeout=(connect_timeout, timeout),
                            cookies=cookies) as client:
        for _hop in range(6):  # 原始请求 + 最多 5 次重定向
            blocked = _validate_target(cur_url)
            if blocked:
                raise _Blocked(blocked + "（" + cur_url + "）")
            async with client.stream("GET", cur_url, headers=headers,
                                     allow_redirects=False,
                                     proxy=proxy) as resp:
                status = resp.status_code
                if status in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("location")
                    if not loc:
                        return (None, 0, status)
                    cur_url = urljoin(cur_url, str(loc).strip())
                    continue  # 下一跳继续校验
                if status >= 400:
                    return (None, 0, status)
                cur = ""
                async for chunk in resp.aiter_content():
                    if not chunk:
                        continue
                    text = chunk.decode("utf-8", "replace") if isinstance(
                        chunk, (bytes, bytearray)) else str(chunk)
                    cur += text
                    if len(cur) > CUR_HARD_CAP:
                        cur = cur[-MAX_LINE * 4:]  # 异常超长未换行行：只保留尾部
                    while "\n" in cur:
                        line, cur = cur.split("\n", 1)
                        total += 1
                        if len(lines) < CACHE_MAX_LINES:
                            lines.append(line)
                if cur:
                    total += 1
                    if len(lines) < CACHE_MAX_LINES:
                        lines.append(cur)
                return (lines, total, status)
    return (None, 0, status)


async def _fetch(url: str, start_line: int = 0, line_count: int = 80,
                max_len: int = 8000, impersonate: str = "chrome",
                cookie: str = "", cookie_file: str = "",
                headers_json: str = "", proxy: str = "", timeout: int = 25) -> str:
    """核心抓取：先查整页缓存（命中则零网络、直接切窗口）；
    未命中才真正下载并缓存。用 asyncio.wait_for 做硬超时兜底。

    安全护栏：
    - 同域最小间隔 MIN_INTERVAL（默认 1.5s），避免突发重复 GET 触发行为风控；
    - 整页只下载一次（CACHE_TTL 内续取来自缓存），既省流量又消除重复请求。
    - proxy：直连不通的国外站可走代理（参数或环境变量 STEALTH_FETCH_PROXY）。
    """
    # SSRF 护栏：入口先拦（重定向跳板在 _download 内逐跳再拦）
    url = str(url or "").strip()
    blocked = _validate_target(url)
    if blocked:
        return "[stealth-fetch] 已拒绝：" + blocked

    start_line = max(0, int(start_line))
    line_count = max(1, min(int(line_count), 500))
    max_len = max(200, min(int(max_len), 32000))
    timeout = max(5, min(int(timeout), 60))  # 合法范围 5~60 秒
    proxy = (proxy or PROXY or "") or None    # 参数优先，否则用环境变量；空=直连

    cookies = _parse_cookies(cookie, cookie_file)
    headers = _parse_headers(headers_json)
    # 仅补充 Accept-Language；UA 由 impersonate 自动设置，勿手动覆盖
    headers.setdefault("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")

    key = _cache_key(url, cookies, impersonate, headers_json)
    now = time.monotonic()

    # 1) 缓存命中：零网络，直接切窗口
    cached = None
    if CACHE_TTL > 0 and key in _CACHE:
        entry = _CACHE[key]
        if now - entry["ts"] < CACHE_TTL:
            cached = entry
    if cached is not None:
        sys.stderr.write("[stealth-fetch] cache HIT: " + url + "\n")
        lines, total, status = cached["lines"], cached["total"], cached["status"]
    else:
        # 2) 缓存未命中：同域限速 + 真正下载
        host = urlparse(url).netloc or url
        if MIN_INTERVAL > 0:
            last = _HOST_LAST.get(host)
            if last is not None:
                wait = MIN_INTERVAL - (time.monotonic() - last)
                if wait > 0:
                    sys.stderr.write(
                        f"[stealth-fetch] 同域限速 {host}：等待 {wait:.1f}s\n")
                    await asyncio.sleep(wait)
            _HOST_LAST[host] = time.monotonic()

        try:
            # 比工具 timeout 多留 3 秒余量，确保服务器侧先返回友好错误，
            # 而不是让 MCP 宿主因等不到响应而报 -32001。
            lines, total, status = await asyncio.wait_for(
                _download(url, impersonate, cookies, headers, timeout, proxy),
                timeout=timeout + 3)
        except asyncio.TimeoutError:
            return (f"[stealth-fetch] 抓取超时（{timeout} 秒未收完数据）：{url}\n"
                    f"提示：可缩短 line_count 减少传输量，或检查网络/代理/DNS "
                    f"到该域名的连通性。")
        except Exception as exc:  # 任何其他错误都返回文本，绝不崩服务
            return f"[stealth-fetch] 抓取失败：{type(exc).__name__}: {exc}"

        if lines is None:
            return f"[stealth-fetch] HTTP 错误 {status}：{url}"

        if CACHE_TTL > 0:
            _CACHE[key] = {"ts": time.monotonic(), "lines": lines,
                           "total": total, "status": status}
            sys.stderr.write("[stealth-fetch] cache MISS (fetched): " + url + "\n")

    # 3) 切窗口 + 单行截断（渐进式披露 / 内存优化）
    end_idx = start_line + line_count
    window = lines[start_line:end_idx]
    out_lines = [ln[:max_len] for ln in window]
    capped = len(lines) >= CACHE_MAX_LINES and total > len(lines)
    has_more = end_idx < len(lines)
    return _finalize(out_lines, total, start_line, line_count,
                     status, has_more, capped=capped)


# ===================== MCP stdio(JSON-RPC 2.0) =====================

def _send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle(msg):
    method = msg.get("method")
    mid = msg.get("id")

    if method == "initialize":
        pv = (msg.get("params") or {}).get("protocolVersion") or "2024-11-05"
        _send({
            "jsonrpc": "2.0", "id": mid,
            "result": {
                "protocolVersion": pv,  # 回显客户端版本，保证协商通过
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "stealth-fetch", "version": "1.0.0"},
            },
        })
    elif method == "notifications/initialized":
        pass  # 通知类，无需回复
    elif method == "ping":
        _send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "tools/list":
        _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [TOOL_SCHEMA]}})
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            if name == "fetch_url":
                text = asyncio.run(_fetch(**args))
                is_error = False
            else:
                text = f"[stealth-fetch] 未知工具：{name}"
                is_error = True
        except Exception as exc:  # 防御：任何异常都包成文本返回
            text = f"[stealth-fetch] 调用异常：{type(exc).__name__}: {exc}"
            is_error = True
        _send({
            "jsonrpc": "2.0", "id": mid,
            "result": {"content": [{"type": "text", "text": text}], "isError": is_error},
        })
    else:
        # 未知方法：若带 id 则回空 result，避免客户端挂起
        if mid is not None:
            _send({"jsonrpc": "2.0", "id": mid, "result": {}})


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        try:
            _handle(msg)
        except Exception as exc:
            sys.stderr.write(f"[stealth-fetch] handle error: {exc}\n")


if __name__ == "__main__":
    main()
