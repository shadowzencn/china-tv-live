# 中国电视直播 · 静态直连版

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
