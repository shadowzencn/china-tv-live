#!/usr/bin/env python3
"""本地运行「中国电视直播」页面。

在静态文件服务之外提供两个接口：

1. /api/channels
   拉取全部直播源地址里的 m3u 播放列表，按频道名归一化合并：
   同一个频道在多个源里出现时，会合并为一路「多信号源」频道，
   页面打开后自动测速并选择最快的源，主源失效时自动切换。
   结果缓存 10 分钟；?refresh=1 可以强制刷新。

2. /api/stream?url=<播放地址>
   HLS 反向代理。IPTV 流媒体服务器一般不带 CORS 头，浏览器里的
   hls.js 直连会失败，所以播放列表和视频分片都经由本机转发。
   播放列表里的相对地址会被改写成同样经过代理的绝对地址；
   分片则按块流式转发。转发使用按主机缓存的 keep-alive 连接，
   减少换台和拉取分片时的握手延迟。

用法：python serve.py [--host 127.0.0.1] [--port 8000]
"""

import argparse
import colorsys
import hashlib
import http.client
import json
import re
import ssl
import threading
import time
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

ROOT = Path(__file__).resolve().parent

# ---------------- 直播源配置 ----------------

SOURCES = [
    {"id": "fj", "label": "itv.fj.cn", "url": "http://itv.fj.cn:33/all.m3u"},
    {"id": "altv", "label": "altv.cddwsj.com", "url": "http://altv.cddwsj.com:8737/all.m3u"},
    {"id": "top", "label": "52top.com.cn", "url": "http://www.52top.com.cn:8767/all.m3u"},
]

CHANNELS_CACHE_SECONDS = 600
PLAYLIST_CACHE_SECONDS = 2.0
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)

# ---------------- 频道名归一化 ----------------

# EXTINF 标题里常见的后缀描述词；归一化时去掉，让「CCTV-1 综合」和「CCTV-1」并成同一个频道
DESCRIPTORS = [
    "综合", "财经", "综艺", "中文国际", "体育赛事", "体育", "电影", "国防军事",
    "电视剧", "纪录", "科教", "戏曲", "社会与法", "新闻", "少儿", "音乐",
    "奥林匹克", "农业农村", "超高清",
]

# 带中文的频道用拼音作为页面锚点（#/beijing 之类）
ID_OVERRIDES = {
    "CCTV风云剧场": "cctv-fengyun",
    "CCTV第一剧场": "cctv-diyijuchang",
    "CCTV怀旧剧场": "cctv-huaijiu",
    "CETV-1": "cetv-1",
    "国学频道": "guoxue",
    "CGTN法语": "cgtn-fr", "CGTN俄语": "cgtn-ru", "CGTN阿拉伯语": "cgtn-ar",
    "CGTN西班牙语": "cgtn-es", "CGTN纪录": "cgtn-doc",
    "北京卫视": "beijing", "江苏卫视": "jiangsu", "东方卫视": "dongfang", "浙江卫视": "zhejiang",
    "湖南卫视": "hunan", "湖北卫视": "hubei", "广东卫视": "guangdong", "广西卫视": "guangxi",
    "黑龙江卫视": "heilongjiang", "海南卫视": "hainan", "重庆卫视": "chongqing", "深圳卫视": "shenzhen",
    "四川卫视": "sichuan", "河南卫视": "henan", "东南卫视": "dongnan", "贵州卫视": "guizhou",
    "江西卫视": "jiangxi", "辽宁卫视": "liaoning", "安徽卫视": "anhui", "河北卫视": "hebei",
    "山东卫视": "shandong", "天津卫视": "tianjin", "吉林卫视": "jilin", "陕西卫视": "shaanxi",
    "宁夏卫视": "ningxia", "内蒙古卫视": "neimenggu", "云南卫视": "yunnan", "山西卫视": "shanxi",
    "青海卫视": "qinghai", "西藏卫视": "xizang", "新疆卫视": "xinjiang", "甘肃卫视": "gansu",
}

CATEGORIES = [
    {"id": "cctv", "label": "央视频道"},
    {"id": "cgtn", "label": "国际频道"},
    {"id": "digital", "label": "数字频道"},
    {"id": "satellite", "label": "卫视频道"},
    {"id": "misc", "label": "教育文化"},
]
CATEGORY_RANK = {c["id"]: i for i, c in enumerate(CATEGORIES)}

DIGITAL_KEYS = {"CCTV风云剧场", "CCTV第一剧场", "CCTV怀旧剧场"}

NETWORK_MAP = {
    "东方卫视": "上海广播电视台",
    "深圳卫视": "深圳广播电影电视集团",
    "东南卫视": "福建省广播影视集团",
    "海南卫视": "海南广播电视总台",
    "内蒙古卫视": "内蒙古广播电视台",
    "黑龙江卫视": "黑龙江广播电视台",
}

INTROS = {
    "CCTV-1": "中央电视台综合频道，覆盖最广的旗舰频道。《新闻联播》《天气预报》与黄金档电视剧、大型晚会都在这里播出。",
    "CCTV-2": "中央电视台财经频道，专注财经资讯与消费生活，《经济半小时》《对话》等栏目在此播出。",
    "CCTV-3": "中央电视台综艺频道，以综艺、歌舞、戏曲类节目为主，《开门大吉》《越战越勇》等深受欢迎。",
    "CCTV-4": "中央电视台中文国际频道，面向全球华人播出，涵盖新闻、纪实与文化交流类节目。",
    "CCTV-5": "中央电视台体育频道，国内最权威的体育转播平台，足球、篮球、乒乓球等国内外重要赛事大多在此直播。",
    "CCTV-5+": "中央电视台体育赛事频道，专注赛事直播与转播，与 CCTV-5 互为补充，赛事密集时段经常多路并用。",
    "CCTV-6": "中央电视台电影频道，全天播出中外影片与电影资讯栏目。",
    "CCTV-7": "中央电视台国防军事频道，聚焦国防、军事题材内容。",
    "CCTV-8": "中央电视台电视剧频道，全天滚动播出国产精品电视剧。",
    "CCTV-9": "中央电视台纪录频道，汇集国内外优秀纪录片。",
    "CCTV-10": "中央电视台科教频道，以科学、教育、文化类节目为主，《百家讲坛》在此播出。",
    "CCTV-11": "中央电视台戏曲频道，播出京剧与各地方剧种的经典剧目。",
    "CCTV-12": "中央电视台社会与法频道，聚焦法治进程与社会话题。",
    "CCTV-13": "中央电视台新闻频道，24 小时滚动播出新闻，《朝闻天下》《新闻直播间》《新闻1+1》等栏目在此直播。",
    "CCTV-14": "中央电视台少儿频道，面向少年儿童的动画、益智与亲子节目。",
    "CCTV-15": "中央电视台音乐频道，播出音乐会、音乐欣赏与经典 MV。",
    "CCTV-16": "中央电视台奥林匹克频道，以奥林匹克运动和体育赛事为核心内容。",
    "CCTV-164K": "奥林匹克频道的 4K 超高清版本，画质更细腻，需要较好的网络带宽。",
    "CCTV-17": "中央电视台农业农村频道，服务三农、贴近乡村生活。",
    "CCTV-4K": "中央电视台 4K 超高清综合频道，分辨率 3840×2160，播放需要较高的网速。",
    "CCTV-8K": "中央电视台 8K 超高清试验频道，对网络和设备要求很高，普通环境下可能无法流畅播放。",
    "CGTN": "中国环球电视网主频道，英语播出的国际新闻频道，从中国视角报道全球新闻。",
    "CGTN法语": "中国环球电视网法语频道，面向法语地区观众播出新闻与专题节目。",
    "CGTN俄语": "中国环球电视网俄语频道，面向俄语地区观众播出新闻与专题节目。",
    "CGTN阿拉伯语": "中国环球电视网阿拉伯语频道，面向阿拉伯地区观众播出新闻与专题节目。",
    "CGTN西班牙语": "中国环球电视网西班牙语频道，面向西语地区观众播出新闻与专题节目。",
    "CGTN纪录": "中国环球电视网纪录频道，以英语播出人文与自然类纪录片。",
    "CCTV风云剧场": "央视数字付费剧场频道，集中播出热播电视剧。",
    "CCTV第一剧场": "央视数字付费电影频道，轮播中外影片。",
    "CCTV怀旧剧场": "央视数字付费频道，重播历年的经典影视剧。",
    "CETV-1": "中国教育电视台第一频道，全国性的教育综合频道。",
    "国学频道": "以中华传统文化为主题的专业频道，播出国学讲堂、书画、戏曲等内容。",
}

TAGS = {
    "CCTV-1": ["综合", "新闻联播", "晚会"],
    "CCTV-2": ["财经", "经济"],
    "CCTV-3": ["综艺"],
    "CCTV-4": ["国际", "华人"],
    "CCTV-5": ["体育", "足球", "赛事"],
    "CCTV-5+": ["体育", "赛事"],
    "CCTV-6": ["电影"],
    "CCTV-7": ["国防", "军事"],
    "CCTV-8": ["电视剧"],
    "CCTV-9": ["纪录片"],
    "CCTV-10": ["科教", "百家讲坛"],
    "CCTV-11": ["戏曲", "京剧"],
    "CCTV-12": ["法治", "社会"],
    "CCTV-13": ["新闻", "24小时"],
    "CCTV-14": ["少儿", "动画"],
    "CCTV-15": ["音乐"],
    "CCTV-16": ["体育", "奥运"],
    "CCTV-164K": ["体育", "奥运", "4K"],
    "CCTV-17": ["农业", "农村"],
    "CCTV-4K": ["4K", "超高清"],
    "CCTV-8K": ["8K", "超高清"],
    "CGTN": ["英语", "国际新闻"],
    "CGTN纪录": ["英语", "纪录片"],
    "CCTV风云剧场": ["电视剧", "付费"],
    "CCTV第一剧场": ["电影", "付费"],
    "CCTV怀旧剧场": ["经典", "付费"],
    "CETV-1": ["教育"],
    "国学频道": ["国学", "传统文化"],
}


def canon_key(name):
    """把「CCTV-1 综合」「CCTV-1」「CCTV-4K 超高清」等标题归一化为同一个键。

    描述词后缀只对 CCTV 开头的频道剥离，避免把「CGTN 纪录」并进「CGTN」。"""
    s = re.sub(r"\s+", "", name).upper()
    s = re.sub(r"超高清$", "", s)
    for d in DESCRIPTORS:
        if s.endswith(d) and s[: -len(d)].startswith("CCTV"):
            return s[: -len(d)]
    return s


def category_of(key):
    if key in DIGITAL_KEYS:
        return "digital"
    if key.startswith("CGTN"):
        return "cgtn"
    if key.endswith("卫视"):
        return "satellite"
    if key.startswith("CCTV"):
        return "cctv"
    return "misc"


def display_name(candidates):
    """多个源对同一频道的叫法不同时，取信息量最大的那个（如「CCTV-1 综合」）。"""
    return max(candidates, key=lambda n: (len(re.sub(r"\s+", "", n)),))


def logo_text(key, name):
    m = re.fullmatch(r"CCTV-(\d+)", key)
    if m:
        return m.group(1)
    if key == "CCTV-5+":
        return "5+"
    if key in ("CCTV-4K", "CCTV-8K", "CCTV-164K"):
        return "4K" if key != "CCTV-8K" else "8K"
    if key == "CCTV风云剧场":
        return "风云"
    if key == "CCTV第一剧场":
        return "剧场"
    if key == "CCTV怀旧剧场":
        return "怀旧"
    if key.startswith("CGTN"):
        tail = key[4:]
        short = {"法语": "法语", "俄语": "俄语", "阿拉伯语": "阿语", "西班牙语": "西语", "纪录": "纪录"}
        return short.get(tail, "CGTN") if tail else "CGTN"
    if key.endswith("卫视"):
        return key[:-2][:4] or key[:2]
    if key == "CETV-1":
        return "CETV"
    if key == "国学频道":
        return "国学"
    return name[:2]


def logo_colors(key):
    hue = int(hashlib.md5(key.encode("utf-8")).hexdigest()[:8], 16) % 360

    def css(h, light, sat):
        r, g, b = colorsys.hls_to_rgb(h / 360, light, sat)
        return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))

    return css((hue + 45) % 360, 0.60, 0.62), css(hue, 0.34, 0.55)


def build_intro(key, name):
    if key in INTROS:
        return INTROS[key]
    if key.endswith("卫视"):
        province = key[:-2]
        network = NETWORK_MAP.get(key, f"{province}广播电视台")
        return f"{name}是{network}旗下的省级卫星频道，节目信号覆盖全国，以新闻、影视剧和本地特色栏目为主。"
    return f"{name}的直播信号，可在本页观看。"


def build_tags(key):
    if key in TAGS:
        return TAGS[key]
    if key.endswith("卫视"):
        return ["卫视", "省级"]
    if key.startswith("CGTN"):
        return ["外语", "国际"]
    return ["直播"]


def channel_id(key):
    if key in ID_OVERRIDES:
        return ID_OVERRIDES[key]
    # '+' 先改写成 'plus'，避免 CCTV-5 与 CCTV-5+ 撞 id
    slug = re.sub(r"[^a-z0-9-]+", "-", key.lower().replace("+", "plus")).strip("-")
    if slug and not re.search(r"[\u4e00-\u9fff]", key):
        return slug
    return "tv-" + hashlib.md5(key.encode("utf-8")).hexdigest()[:8]  # 理论兜底，正常不会走到


EXTINF_RE = re.compile(r"^#EXTINF:\s*-?\d+(?:\.\d+)?\s*(.*)$")
ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')


def parse_m3u(text):
    items = []
    pending = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.upper().startswith("#EXTINF"):
            rest = line.split(",", 1)[1] if "," in line else line
            attrs = {}
            m = EXTINF_RE.match(line)
            if m:
                for k, v in ATTR_RE.findall(m.group(1)):
                    attrs[k.lower()] = v
            pending = {"title": rest.strip(), "group": attrs.get("group-title", "")}
        elif line.startswith("#"):
            continue
        elif pending:
            pending["url"] = line
            items.append(pending)
            pending = None
    return items


def merge_channels(per_source):
    """把各源的频道按归一化键合并：同一频道聚合多个信号源。"""
    order = []          # 保持首次出现的顺序
    channels = {}
    for src, items in per_source:
        for item in items:
            if not item.get("url"):
                continue
            key = canon_key(item["title"])
            if not key:
                continue
            ch = channels.get(key)
            if ch is None:
                ch = {"key": key, "names": [], "seen": len(order), "sources": []}
                channels[key] = ch
                order.append(ch)
            ch["names"].append(item["title"])
            if item["url"] not in [s["url"] for s in ch["sources"]]:
                ch["sources"].append({"label": src["label"], "url": item["url"]})

    result = []
    for idx, ch in enumerate(sorted(order, key=lambda c: (CATEGORY_RANK[category_of(c["key"])], c["seen"])), start=1):
        key = ch["key"]
        cat = category_of(key)
        name = display_name(ch["names"])
        frm, to = logo_colors(key)
        result.append({
            "id": channel_id(key),
            "key": key,
            "name": name,
            "number": idx,
            "category": cat,
            "network": NETWORK_MAP.get(name, NETWORK_MAP.get(key, "")),
            "tags": build_tags(key),
            "logo": {"text": logo_text(key, name), "from": frm, "to": to},
            "intro": build_intro(key, name),
            "sources": ch["sources"],
        })
    return result


_channels_lock = threading.Lock()
_channels_cache = {"at": 0.0, "payload": None}


def http_get_text(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*", "Connection": "close"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(4_000_000).decode("utf-8", "replace")


def load_channels(force=False):
    now = time.monotonic()
    with _channels_lock:
        if not force and _channels_cache["payload"] and now - _channels_cache["at"] < CHANNELS_CACHE_SECONDS:
            return _channels_cache["payload"]

    # 按配置顺序写入固定下标，保证合并后信号源的排列与 SOURCES 一致
    results = [None] * len(SOURCES)
    statuses = [None] * len(SOURCES)

    def fetch_one(idx, src):
        try:
            results[idx] = (src, parse_m3u(http_get_text(src["url"])))
            statuses[idx] = {"id": src["id"], "label": src["label"], "ok": True, "count": len(results[idx][1]), "error": ""}
        except Exception as err:  # 单个源失败不影响其它源
            statuses[idx] = {"id": src["id"], "label": src["label"], "ok": False, "count": 0, "error": str(err)}

    threads = [threading.Thread(target=fetch_one, args=(i, s), daemon=True) for i, s in enumerate(SOURCES)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    per_source = [r for r in results if r is not None]
    channels = merge_channels(per_source)
    payload = {
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "categories": CATEGORIES,
        "sources": statuses,
        "channels": channels,
    }
    if channels:
        with _channels_lock:
            _channels_cache["at"] = time.monotonic()
            _channels_cache["payload"] = payload
    return payload


# ---------------- HLS 反向代理 ----------------

URI_ATTR_RE = re.compile(r'URI="([^"]+)"')
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE  # IPTV 源常用自签证书，代理场景不做校验

_pool_lock = threading.Lock()
_pool = {}  # (scheme, host, port) -> [HTTPConnection, ...]

_playlist_lock = threading.Lock()
_playlist_cache = {}  # url -> (monotonic, rewritten text)


def _checkout_conn(key):
    with _pool_lock:
        conns = _pool.get(key)
        if conns:
            return conns.pop()
    return None


def _checkin_conn(key, conn):
    with _pool_lock:
        conns = _pool.setdefault(key, [])
        if len(conns) < 6:
            conns.append(conn)
            return
    try:
        conn.close()
    except OSError:
        pass


def _discard_conn(conn):
    try:
        conn.close()
    except OSError:
        pass


def origin_request(url, headers, timeout=15):
    """发起请求，返回 (response, conn, key)。连接出错自动重试一次（换新连接）。"""
    u = urlsplit(url)
    scheme = u.scheme.lower()
    host = u.hostname
    port = u.port or (443 if scheme == "https" else 80)
    if scheme not in ("http", "https") or not host:
        raise ValueError(f"unsupported url: {url}")
    key = (scheme, host, port)
    path = u.path or "/"
    if u.query:
        path += "?" + u.query

    last_err = None
    for _ in range(2):
        conn = _checkout_conn(key)
        fresh = conn is None
        if fresh:
            if scheme == "https":
                conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=_ssl_ctx)
            else:
                conn = http.client.HTTPConnection(host, port, timeout=timeout)
        try:
            conn.request("GET", path, headers=headers)
            resp = conn.getresponse()
            return resp, conn, key, fresh
        except (OSError, http.client.HTTPException) as err:
            _discard_conn(conn)
            last_err = err
    raise last_err


def proxied(url):
    return "/api/stream?" + urlencode({"url": url})


def rewrite_m3u8(text, base_url):
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            if 'URI="' in line:
                line = URI_ATTR_RE.sub(
                    lambda m: 'URI="' + proxied(urljoin(base_url, m.group(1))) + '"', line
                )
            out.append(line)
        else:
            out.append(proxied(urljoin(base_url, line)))
    return "\n".join(out) + "\n"


def is_playlist_url(url):
    return urlsplit(url).path.lower().endswith((".m3u8", ".m3u"))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    }

    def log_message(self, fmt, *args):  # 分片请求太吵，只保留错误
        if args and isinstance(args[0], str) and args[0].startswith(("2", "3")):
            return
        super().log_message(fmt, *args)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/api/channels":
            self.api_channels(parse_qs(url.query).get("refresh", [""])[0] == "1")
            return
        if url.path == "/api/stream":
            target = parse_qs(url.query).get("url", [""])[0]
            self.api_stream(target)
            return
        super().do_GET()

    # ---- /api/channels ----

    def api_channels(self, force):
        try:
            payload = load_channels(force)
            if not payload["channels"]:
                self.send_json(502, {"error": "所有直播源暂时都无法访问，请稍后重试", "sources": payload["sources"]})
            else:
                self.send_json(200, payload)
        except Exception as err:
            self.send_json(500, {"error": f"频道列表生成失败：{err}"})

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- /api/stream ----

    def api_stream(self, target):
        if not target:
            self.send_error(400, "missing url")
            return
        try:
            if is_playlist_url(target):
                self.proxy_playlist(target)
            else:
                self.proxy_segment(target)
        except (OSError, http.client.HTTPException, ValueError) as err:
            try:
                self.send_error(502, f"upstream error: {err}")
            except OSError:
                pass

    def proxy_playlist(self, target):
        now = time.monotonic()
        with _playlist_lock:
            hit = _playlist_cache.get(target)
        if hit and now - hit[0] < PLAYLIST_CACHE_SECONDS:
            self.send_text(hit[1])
            return

        resp, conn, key, _ = origin_request(
            target, {"User-Agent": USER_AGENT, "Accept": "*/*"}, timeout=12
        )
        try:
            body = resp.read(2_000_000)
        finally:
            if resp.will_close:
                _discard_conn(conn)
            else:
                _checkin_conn(key, conn)

        if resp.status != 200:
            self.send_error(resp.status, f"upstream status {resp.status}")
            return
        text = rewrite_m3u8(body.decode("utf-8", "replace"), target)
        with _playlist_lock:
            _playlist_cache[target] = (time.monotonic(), text)
            if len(_playlist_cache) > 800:
                cutoff = time.monotonic() - PLAYLIST_CACHE_SECONDS
                for k in [k for k, v in _playlist_cache.items() if v[0] < cutoff]:
                    _playlist_cache.pop(k, None)
        self.send_text(text)

    def send_text(self, text):
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy_segment(self, target):
        fwd = {"User-Agent": USER_AGENT, "Accept": "*/*"}
        rng = self.headers.get("Range")
        if rng:
            fwd["Range"] = rng

        resp, conn, key, _ = origin_request(target, fwd, timeout=30)
        try:
            self.send_response(resp.status)
            for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                v = resp.getheader(h)
                if v:
                    self.send_header(h, v)
            if not resp.getheader("Content-Length"):
                self.close_connection = True
                self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            will_close = resp.will_close
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            will_close = True  # 客户端中断（换台、暂停），正常现象
        finally:
            if will_close:
                _discard_conn(conn)
            else:
                _checkin_conn(key, conn)


def main():
    parser = argparse.ArgumentParser(description="本地运行中国电视直播页面")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址；想让同一局域网的设备访问时用 0.0.0.0")
    parser.add_argument("--port", type=int, default=8000, help="端口，默认 8000")
    args = parser.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        host = "127.0.0.1" if args.host in ("", "0.0.0.0") else args.host
        print(f"中国电视直播已启动：http://{host}:{args.port}/   按 Ctrl+C 停止", flush=True)
        print("首次打开页面时会把各直播源的 m3u 聚合为多源频道列表，请稍候几秒。", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
