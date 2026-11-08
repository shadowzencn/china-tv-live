#!/usr/bin/env python3
"""生成「中国电视直播」纯静态版（site/ 目录）。

复用 server/serve.py 里的直播源拉取与频道聚合逻辑，把合并结果固化为
site/channels.json，连同页面一起输出到 site/。site/ 就是 GitHub Pages
的部署根（见 .github/workflows/），也可以放到任意静态服务器上。

用法（在仓库根目录运行）：python build_static.py
"""

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))
import serve  # 复用频道聚合、归一化与简介生成逻辑

OUT = ROOT / "site"

README = """# 中国电视直播 · 静态直连版

由仓库根目录的 `build_static.py` 生成，页面与代理版相同，但没有本地服务：
频道列表来自打包时的 `channels.json`，直播地址由浏览器直连（生成时实测各源均开放跨域）。

## 运行

把整个目录交给任意 **http** 静态服务器，例如：

```bash
python -m http.server 8033
```

然后打开 http://127.0.0.1:8033/ 。`file://` 双击打开无法加载频道数据（fetch 受限），
请用静态服务器；单文件版（dist/china-tv-live-single.html）才支持双击。

## ⚠ HTTPS 托管的限制（GitHub Pages 等）

直播源全是 `http://`。放在 HTTPS 页面（GitHub Pages、Vercel 等）下，浏览器会把
hls.js 的跨协议请求按混合内容拦截——页面能看、频道列表能加载，但**播放大概率不可用**。
部署到 GitHub Pages 适合做展示页和提供单文件版下载；想真正在线看，请用：

- 本地/局域网/NAS 的 http 静态服务器；
- 或代理版（`server/serve.py`），它同时支持 HTTPS 反代（流经同源代理转发，无混合内容）。

## 与代理版（server/serve.py）的差异

- 频道列表是生成时刻的快照：源站增删频道后需重新运行 `python build_static.py`，
  或依赖仓库里的定时刷新 workflow。
- 52top 源的地址带令牌（内嵌时间戳），过期后该源会全部失效，同样重新生成即可；
  itv.fj.cn 与 altv.cddwsj.com 是固定路径，不受影响。
- 靠源站继续开放跨域；若对方将来加防盗链或关闭 CORS，请改用代理版。
- 个别源偶发返回不一致的播放列表时，页面会自动切换到该频道的下一路信号源。

重新生成：修改 `server/serve.py` 里的 `SOURCES` 后，在仓库根目录运行
`python build_static.py`，本目录会被整体覆盖更新（channels.json 一并刷新）。
"""


def main():
    print("正在拉取直播源并聚合频道（约需几秒）…")
    data = serve.load_channels(force=True)
    channels = data.get("channels") or []
    if not channels:
        print("错误：所有直播源都拉取失败，无法生成静态版。请检查网络后重试。")
        for s in data["sources"]:
            print(f"  - {s['label']}: " + (f"OK，{s['count']} 个频道" if s["ok"] else f"失败：{s['error']}"))
        sys.exit(1)

    OUT.mkdir(exist_ok=True)
    for item in ("index.html", "assets", "vendor"):
        src = SERVER / item
        dst = OUT / item
        if dst.is_dir():
            shutil.rmtree(dst)
        elif dst.exists():
            dst.unlink()
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    (OUT / "channels.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (OUT / "README.md").write_text(README, encoding="utf-8")

    # 把单文件版一起放进 site/：Pages 上可直接下载（先跑 build_single.py 保证是新的）
    single = ROOT / "dist" / "china-tv-live-single.html"
    if single.exists():
        shutil.copy2(single, OUT / "china-tv-live-single.html")

    # 在页脚加一个单文件版下载入口
    idx_path = OUT / "index.html"
    idx = idx_path.read_text(encoding="utf-8")
    marker = '<p class="shortcuts">'
    if marker in idx and "china-tv-live-single.html" not in idx:
        idx = idx.replace(
            marker,
            marker + '<a href="china-tv-live-single.html" download="china-tv-live-single.html">⬇ 下载单文件版</a> · ',
            1,
        )
        idx_path.write_text(idx, encoding="utf-8")

    ok_sources = [s for s in data["sources"] if s["ok"]]
    print(f"静态版已生成：{OUT}")
    print(f"频道：{len(channels)} 个，聚合自 {len(ok_sources)}/{len(data['sources'])} 个直播源")
    for s in data["sources"]:
        print(f"  - {s['label']}: " + (f"OK，{s['count']} 个频道" if s["ok"] else f"失败：{s['error']}"))


if __name__ == "__main__":
    main()
