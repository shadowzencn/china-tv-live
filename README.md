# 中国电视直播 · China TV Live

在网页上观看中国电视频道直播：CCTV 全系列、CGTN 各语种频道、全国各省级卫视（约 64 个频道，绝大多数 3 路信号源）。
三个公开 IPTV 播放列表自动聚合为「一台多源」，打开页面自动测速选最快信号，播放失败自动切换备用源；支持数字选台、`[` `]` 快速换台。

## 目录结构

```
├── server/              代理版（推荐）：serve.py 提供聚合接口 + HLS 流代理
├── site/                静态版：纯静态文件，GitHub Pages 部署根（build_static.py 生成）
├── single/              单文件版生成源：模板 + 播放器 + hls.js
├── dist/                生成产物：china-tv-live-single.html（双击即看）
├── build_static.py      生成 site/（复用 server/serve.py 的聚合逻辑）
├── build_single.py      生成 dist/ 单文件版
└── .github/workflows/   Pages 部署 + 定时刷新频道数据
```

## 三种形态

| 形态 | 入口 | 怎么跑 | 适用场景 |
| --- | --- | --- | --- |
| **代理版** | `server/` | `python serve.py`，或双击 `server/启动.bat` | 最稳，推荐日常使用；反代到 HTTPS 域名下也没有混合内容问题 |
| **静态版** | `site/` | 任意 **http** 静态服务器 | 不想跑 Python 服务；**GitHub Pages 部署见下文限制** |
| **单文件版** | `dist/china-tv-live-single.html` | **直接双击** | 一个文件拷来拷去，手机/电视/U 盘都能用（`file://` 实测可用） |

## 直播源

内置三个公开 IPTV 播放列表（配置在 `server/serve.py` 的 `SOURCES`，可增删）：

| 源 | 地址 |
| --- | --- |
| itv.fj.cn | `http://itv.fj.cn:33/all.m3u` |
| altv.cddwsj.com | `http://altv.cddwsj.com:8737/all.m3u` |
| 52top.com.cn | `http://www.52top.com.cn:8767/all.m3u`（带令牌，会过期） |

聚合后 64 个频道：央视 21、CGTN 6、数字付费 3、省级卫视 32、教育文化 2。

## GitHub Pages 部署（静态版）

仓库已带 `.github/workflows/deploy-pages.yml`：推送到 `main` 后，GitHub Actions 会把 `site/` 发布到 Pages。
启用步骤：

1. 把本目录推到 GitHub 仓库；
2. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**；
3. 之后每次 push 自动部署，地址是 `https://<用户名>.github.io/<仓库名>/`。

### ⚠ 必须知道的限制

**Pages 是 HTTPS 页面，而直播源全是 HTTP。** 浏览器把这类跨协议请求按「混合内容」拦截，
所以在 Pages 上：页面和频道列表能加载，**播放大概率不可用**（页面会自动显示警告条，这是预期行为）。

Pages 部署的实际价值：

- 项目展示与文档；
- 提供单文件版下载：访问 `https://<用户名>.github.io/<仓库名>/` 旁的仓库 Releases 或直接下载 `dist/china-tv-live-single.html`，**下载后双击即可正常观看**（`file://` 下没有混合内容问题）；
- 若将来源站提供 https 端点，或替换为支持 https 的源，Pages 播放即可用。

想在线看，两个可行方案：

- **代理版反代**：把 `server/` 部署到自己的 VPS/NAS（可套 HTTPS 反代——流经同源 `/api/stream` 转发，没有混合内容问题）；
- **http 环境**：`site/` 放到局域网 NAS、内网服务器的 http 地址上。

### 定时刷新频道数据

`.github/workflows/refresh-channels.yml` 每天（北京时间 5:00）重新抓源、重建 `site/channels.json` 和单文件版并自动提交，
解决静态快照变旧、52top 令牌过期的问题。注意 Actions 服务器在境外，若源站限制境外访问，任务会失败并保留上次快照（不影响站点）。

## 功能

- 一台多源：同一频道聚合多路信号，页面上显示每路源的实测延迟，自动选最快源
- 自动换源：播放失败或加载超时自动切下一路；挂掉的源定期后台重测，恢复自动变绿
- 快速换台：`[` `]`（PageUp/PageDown）顺序换台 + OSD；`0-9` 数字选台，退格可改
- 分类/搜索/收藏/分享链接直达频道/剧场模式/画中画/全屏/画质切换/统计信息
- 手机端播放器吸顶，浏览列表时继续观看

快捷键：`空格` 播放/暂停 · `M` 静音 · `F` 全屏 · `I` 画中画 · `[` `]` 换台 · `0-9` 数字选台 · `T` 剧场模式 · `/` 搜索

## 重新生成

修改 `server/serve.py` 的 `SOURCES` 或归一化规则后，在仓库根目录运行：

```bash
python build_static.py    # 重建 site/（含 channels.json）
python build_single.py    # 重建 dist/china-tv-live-single.html
```

## 版权与许可

本项目不存储、不转码、不转发任何音视频内容，仅提供本地播放工具；所有直播信号来自公开的第三方播放列表，节目版权归各电视台及版权方所有，请勿用于商业用途。
播放器使用 [Video.js](https://videojs.org/)（Apache-2.0，内含 [hls.js](https://github.com/video-dev/hls.js)，同为 Apache-2.0）。
