# magpie 与 neko 对比

- 日期:2026-08-08
- 关联:[`magpie-remote-browser-design.md`](./specs/2026-08-08-magpie-remote-browser-design.md)、根目录 `CLAUDE.md`
- 对比对象:neko —— [m1k1o/neko](https://github.com/m1k1o/neko)

> **已核对**:本文对 neko 的描述已于 2026-08-08 联网核对上游 `m1k1o/neko` 仓库 master 分支;核对来源见文末「已核对来源」。

## TL;DR

两者都是「用 WebRTC 把远程浏览器/桌面推给网页客户端」,但:

- **magpie** 是「**无桌面的单页远程浏览器**」——headless Chromium,只能流一个网页,单用户。
- **neko** 是「**带桌面的多用户虚拟机 / VDI**」——Xorg 虚拟显示 + 窗口管理器(或完整桌面),能流任意 X11 应用。

根本分野是**显示模型**——它决定了能力上限。

## 关键维度对比

| 维度 | magpie | neko (m1k1o/neko) |
|---|---|---|
| 定位 | 单实例单用户的远程**网页**实例 | 多用户远程**虚拟桌面**(里面跑浏览器) |
| 显示模型 | **headless** Chromium,无桌面 | **Xorg 虚拟显示** + 窗口管理器(openbox;另有 XFCE/KDE 完整桌面镜像)+ 真 GUI 浏览器 |
| 像素采集 | CDP `Page.startScreencast`,**只能抓单页** | GStreamer `ximagesrc` 抓整个 X 屏幕,**任意 X11 应用** |
| 视频编码/发送 | Chromium 页内**原生 libwebrtc**(JPEG→canvas→`captureStream`) | GStreamer `x264enc`(软编,tune=zerolatency)/ VAAPI·NVENC(硬编) |
| **谁是 WebRTC 对端** | 一个 streamer 页;**Node 不是 peer** | **Go 服务端本身就是 peer**(pion/webrtc) |
| 服务端栈 | Node.js,仅 `playwright`+`ws`,无原生媒体栈 | Go(pion/webrtc v4)+ GStreamer(cgo)+ 自研 Xorg 输入驱动 + Xorg + PulseAudio |
| 音频 | 无(v1) | 有(PulseAudio → opus) |
| 多用户 | 严格单用户 | 房间 + 多观众 + 角色(可夺取控制) |
| 鉴权/房间/剪贴板/文件 | 全无 | 有(rooms、密码、admin、剪贴板同步、文件传输) |
| 分辨率 | 固定 1280×800,无运行时 resize | 可调屏幕分辨率 |
| 流质量 | JPEG q80、~10–15fps、有压缩痕 | H.264、高码率、可高帧率 |
| 输入 | CDP `Input.dispatch*`,坐标映射,受 CDP 能力限制 | 经自研 Xorg 输入驱动 `xf86-input-neko` 注入,完整键鼠、系统级快捷键 |
| 容器重量 | 轻(只有 headless Chromium + Node) | 重(整套桌面 + 媒体栈) |
| 能流什么 | 仅 1 个网页 | VLC / Tor / XFCE·KDE 桌面 / Chrome / Firefox / Brave / … 任意 X11 应用 |

## 架构上的三个根本差异

### 1. 显示模型决定了能力上限

neko 起一个真的 Xorg 虚拟显示(`runtime/xorg.conf`),在里面跑窗口管理器和真实 GUI 浏览器,再用 GStreamer `ximagesrc` 抓屏——所以它能流任意应用、有音频、有剪贴板,本质是一台 VDI。

magpie 是 headless 的,**没有任何桌面**。任意外网站的像素只能靠 CDP `Page.startScreencast` 抓(见设计 spec「关键约束:为什么 capture 必须用 CDP」),所以它天然只能服务于「一个网页」,且无音频、无剪贴板。这不是取舍,是 headless 的物理限制。

### 2. 谁是 WebRTC 对端 —— magpie 设计里最反常规的一点

neko 里 **Go 服务端自己就是 WebRTC 发送方**:GStreamer(`x264enc`/VAAPI/NVENC)编出 H.264,经 pion/webrtc v4 推给客户端。

magpie 里 **Node 根本不是 WebRTC 对端**——它把客户端的 offer SDP 中继给一个「streamer 页」(共享 browser 里另开的 context),让 **Chromium 自己的 libwebrtc** 编码发送。代价是多一个页面 + `/internal` 帧中继 + 信令中继;收益是**不用在 Node 里塞编码器**(规避了 werift↔libwebrtc 互通风险),也省掉了原生媒体依赖。

### 3. 轻量 vs 完整,是后果不是目标

magpie 用 headless+CDP 换来了「2 个 npm 依赖、无 GStreamer/Xorg/FFmpeg」,但代价就是丢掉了音频、剪贴板、整桌面、多用户。neko 反过来——重量大,但能力完整、像真机器。

## 各自适合什么

- **选 magpie**:给**单个**用户远程看/操作**一个网页**;要极轻量、可嵌入;需要一边流给人看、一边还能用 **Playwright/CDP 脚本化驱动**(自动化、可视化爬取、远程调试)。它本质是「可被程序驱动 + 可被人观看」的远程浏览器。
- **选 neko**:多人一起看(看剧/共览)、共享桌面、协作浏览,或需要音频/整桌面/多用户/剪贴板/文件传输。它本质是面向人的远程桌面。

一个容易混淆的点:都能「在网页里看 + 控制」一个远程浏览器,但 **magpie 流的是一个网页,neko 流的是一整块屏幕**——所以 magpie 永远做不到「流 VLC / 流整个桌面」,而 neko 不擅长被脚本化驱动。

## 共同点(为什么会被拿来比较)

- 都基于 WebRTC 把远端画面推给浏览器客户端;
- 都容器化部署;
- 都有一条信令通道负责 SDP/控制消息;
- 都能让远程用户观看 + 控制一个浏览器。

## 已核对来源(neko,`m1k1o/neko` master,2026-08-08)

- `server/go.mod` → `github.com/pion/webrtc/v4 v4.2.11`(Go 服务端 + pion WebRTC;另含 `pion/datachannel`)。
- `server/pkg/gst/`(`gst.go`/`.c`/`.h`)→ GStreamer 的 cgo 绑定,**编码在 Go 进程内完成**。
- `server/internal/capture/manager.go` → 视频管线字符串 `ximagesrc ... ! x264enc tune=zerolatency key-int-max=15 ...`(软编);H.264 经 `rtph264depay` 打 RTP。
- `server/internal/desktop/xorg.go` + `utils/xorg-deps/xf86-input-neko` → Xorg 控制 + **自研 Xorg 输入驱动**(键鼠在 X server 层注入)。
- `.github/workflows/ghcr_intel.yml`、`ghcr_nvidia.yml` + `apps/*/Dockerfile.nvidia` → Intel(VAAPI)/ NVIDIA(NVENC)硬件编码镜像。
- `README.md` → Docker 镜像清单(firefox / tor-browser / waterfox / chromium / google-chrome / ungoogled-chromium / microsoft-edge / brave / vivaldi / opera + xfce / kde / remmina / vlc)、内置音频、多用户控制、可跑 VLC / 桌面等任意 Linux 程序。
