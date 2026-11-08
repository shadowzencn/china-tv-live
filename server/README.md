# 中国电视直播 · 代理版

本地服务器 + 完整前端。`serve.py` 在静态文件之外提供两个接口：

1. **`/api/channels`** — 拉取全部直播源的 m3u，按频道名归一化合并成「一台多源」列表，缓存 10 分钟；
2. **`/api/stream?url=`** — HLS 反向代理：IPTV 源一般不开放 CORS（或被浏览器混合内容策略拦截），
   播放列表与分片经本机转发（keep-alive 连接池 + 播放列表微缓存，稳定性最好）。

## 运行

```bash
python serve.py            # Windows 可双击 启动.bat
```

打开 http://127.0.0.1:8000/ 。

- `--port 9000` 换端口；`--host 0.0.0.0` 让局域网设备访问
- 套 HTTPS 反代（Nginx/Caddy）后流经同源 `/api/stream` 转发，**没有混合内容问题**，适合部署到自己的 VPS/NAS
- 必须通过 serve.py 访问，不能直接双击 index.html

## 功能

- 一台多源 + 自动测速选源 + 失败自动换源（挂掉的源每 3 分钟后台重测）
- 数字选台（`0-9`，退格修改）、`[` `]` 快速换台 + 频道 OSD
- 分类/搜索/收藏/分享直达（`#/hunan`）/剧场模式/画中画/统计信息
- 手机端播放器吸顶

## 配置直播源

编辑本目录 `serve.py` 顶部的 `SOURCES`：

```python
SOURCES = [
    {"id": "fj",   "label": "itv.fj.cn",       "url": "http://itv.fj.cn:33/all.m3u"},
    {"id": "altv", "label": "altv.cddwsj.com", "url": "http://altv.cddwsj.com:8737/all.m3u"},
    {"id": "top",  "label": "52top.com.cn",    "url": "http://www.52top.com.cn:8767/all.m3u"},
]
```

重启生效。频道名归一化（去空格、去「综合/财经」等后缀描述词）与频道简介也在此文件。
改完源后记得在仓库根目录运行 `python build_static.py` / `python build_single.py` 同步静态产物。

## 已知限制

- 4K / 8K 频道码率高，卡顿取决于网络
- 源由第三方维护，某个源失效时页面会显示「暂不可用」，还有一个源可用就能看

## 版权

不存储、不转码、不转发任何音视频内容；直播信号来自公开的第三方播放列表，版权归各电视台及版权方所有，请勿商用。
