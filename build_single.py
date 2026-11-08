#!/usr/bin/env python3
"""生成「中国电视直播」单文件 HTML 版（dist/china-tv-live-single.html）。

把所有东西打进一个 .html：页面结构、样式、频道数据（实时聚合）、hls.js、播放器逻辑。
产物不依赖任何外部文件与 CDN，双击即可播放（file:// 实测可用），拷到哪都能用。

用法：
    python build_single.py                    # 默认输出 dist/china-tv-live-single.html
    python build_single.py 路径/自定义.html    # 指定输出文件

频道数据在生成时抓取一次（复用 server/serve.py 的聚合逻辑）；直播源增删或
52top 令牌过期后重新生成即可。
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))
import serve  # 复用频道聚合、归一化与简介生成逻辑

SINGLE = ROOT / "single"
HLS_JS = SINGLE / "hls.light.min.js"
DEFAULT_OUT = ROOT / "dist" / "china-tv-live-single.html"
PLACEHOLDERS = ("__STYLE__", "__HLS__", "__PLAYER__", "__DATA__", "__BUILD_TIME__")


def read(path):
    """读文本并确保不会提前闭合 <script> 标签。"""
    text = path.read_text(encoding="utf-8")
    if "</script" in text:
        raise SystemExit(f"错误：{path.name} 里含有 </script，无法安全内联")
    return text


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT

    print("正在拉取直播源并聚合频道（约需几秒）…")
    data = serve.load_channels(force=True)
    channels = data.get("channels") or []
    if not channels:
        print("错误：所有直播源都拉取失败，无法生成。请检查网络后重试。")
        for s in data["sources"]:
            print(f"  - {s['label']}: " + (f"OK，{s['count']} 个频道" if s["ok"] else f"失败：{s['error']}"))
        sys.exit(1)

    payload = {
        "generatedAt": data.get("updatedAt", ""),
        "categories": data.get("categories", []),
        "channels": channels,
    }
    data_js = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if "</script" in data_js:
        raise SystemExit("错误：频道数据里含有 </script，无法安全内联")

    template = (SINGLE / "template.html").read_text(encoding="utf-8")
    style = read(SINGLE / "style.css")
    player = read(SINGLE / "player.js")
    hls_js = read(HLS_JS)
    build_time = time.strftime("%Y-%m-%d %H:%M")

    # hls.js 采用 Apache-2.0 许可，内联时保留版本与许可说明
    hls_header = (
        "/*! hls.js (light build) — Apache-2.0 — https://github.com/video-dev/hls.js\n"
        " *  已内联进本文件；播放器直接调用其全局 Hls 对象。\n"
        " *  版本随 single/hls.light.min.js\n"
        " */\n"
    )

    html = template
    for token, value in (
        ("__STYLE__", style),
        ("__HLS__", hls_header + hls_js),
        ("__PLAYER__", player),
        ("__DATA__", data_js),
        ("__BUILD_TIME__", build_time),
    ):
        if token not in html:
            raise SystemExit(f"错误：模板里缺少占位符 {token}")
        html = html.replace(token, value, 1)

    leftover = [p for p in PLACEHOLDERS if p in html]
    if leftover:
        raise SystemExit(f"错误：占位符未被替换：{', '.join(leftover)}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")

    ok_sources = [s for s in data["sources"] if s["ok"]]
    size_kb = out.stat().st_size / 1024
    print(f"单文件版已生成：{out}（{size_kb:.0f} KB）")
    print(f"频道：{len(channels)} 个，聚合自 {len(ok_sources)}/{len(data['sources'])} 个直播源")
    for s in data["sources"]:
        print(f"  - {s['label']}: " + (f"OK，{s['count']} 个频道" if s["ok"] else f"失败：{s['error']}"))


if __name__ == "__main__":
    main()
