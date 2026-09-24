# LunaLink

基于 [Genymobile/scrcpy][scrcpy] 的 Web 端 Android 投屏与控制工具：在浏览器里看手机画面、用键鼠控制、跑 shell、传文件。

## 环境要求

- **浏览器**：Chromium 系（Chrome / Edge）——默认播放器依赖 [WebCodecs][webcodecs]，另需 WebSocket / WebWorker / WebAssembly
- **服务端**：Node.js 18 / 20 LTS，`adb` 需在 `PATH` 中
- **设备端**：Android 5.0+（API 21+），已开启 [adb 调试](https://developer.android.com/studio/command-line/adb.html#Enabling)；
  部分设备还需额外开启[此选项](https://github.com/Genymobile/scrcpy/issues/70#issuecomment-373286323)才能用键鼠控制

## 快速开始

```shell
npm install
npm start          # 构建并启动，默认 http://localhost:8888
```

| 命令 | 说明 |
| --- | --- |
| `npm start` | 生产构建 + 启动服务 |
| `npm run dist:dev` | 仅开发构建（热更） |
| `npm run dist:prod` | 仅生产构建 |

构建产物输出至 `dist/`，也可 `cd dist && npm start` 直接启动。
端口默认 `8888`，可在 `config.yaml` 的 `port` 字段修改，或用 `PORT` 环境变量指定（优先级更高）。

## 功能

### Android

- **屏幕投屏**：修改版 scrcpy 推送 H264 流，默认用 **WebCodecs Player** 在 canvas 上解码绘制。
  相比 `<video>` 元素，canvas 渲染不受浏览器自动播放策略与窗口缩放影响，可避免"黑屏需点击才出画面""最大化后黑屏"。
  其它内核（Firefox / Safari）可启用 Mse / Broadway / TinyH264 播放器（见[自定义构建](#自定义构建)）
- **远程控制**：多点触控（按住 <kbd>CTRL</kbd> 以屏幕中心为缩放中心，<kbd>SHIFT</kbd>+<kbd>CTRL</kbd> 以当前点为中心）、
  滚轮与触控板双向滚动、键盘事件、文本注入（仅 ASCII）、剪贴板双向同步、设备旋转
- **远程 Shell**：浏览器内 `adb shell`（基于 [xterm.js][xterm.js] 终端）
- **文件管理**：列出 / 上传 / 下载设备文件；支持拖拽**整个文件夹**递归上传（保留目录结构）、点击图片 / 视频预览
- **文件推送**：拖拽 APK 到页面即推送至 `/data/local/tmp`
- **网页 / WebView 调试**：见 [/docs/Devtools.md](/docs/Devtools.md)

#### 窗口自适应（旋转跟随）

设备旋转时，投屏窗口会**自动跟随变横 / 变竖**，并维持配置好的缩放比例（「窗口缩放 %」）：

- 窗口尺寸按设备方向 contain 进「屏幕 × 缩放%」的框内，竖屏与横屏的大小观感一致（如 4:5 ↔ 5:4）；
- 触摸坐标随画面一同旋转，点击位置与画面严格对应；
- Chromium（Chrome / Edge）**会静默忽略页面脚本的 `window.resizeTo`**，因此窗口尺寸实际由服务端通过
  Win32 API（`EnumWindows` 按窗口标题 `LunaLink-<udid>` 定位 + `MoveWindow`）在 Windows 上直接调整——**不重连、不闪烁**。
  非 Windows 平台自动降级，需手动拖拽窗口边缘调整。

### iOS（实验性）

默认不构建（见[自定义构建](#自定义构建)）。需 `PATH` 中存在 [ws-qvh][ws-qvh]，控制基于
[WebDriverAgent][WebDriverAgent]（仅支持简单触摸、滚动、Home 键）。
也可启用 `USE_WDA_MJPEG_SERVER` 以 MJPEG 方式投屏（无需 ws-qvh，但每帧编码为 jpeg，开销更高）。

## 自定义构建

在 [build.config.override.json](/build.config.override.json) 中覆盖[默认配置](/webpack/default.build.config.json)：

| 开关 | 说明 |
| --- | --- |
| `INCLUDE_GOOG` | Android 设备追踪与控制 |
| `INCLUDE_APPL` | iOS 设备追踪与控制 |
| `INCLUDE_ADB_SHELL` | 远程 Shell（[node-pty][node-pty] 为可选依赖，缺编译工具链时 npm 会跳过，不影响其它功能） |
| `INCLUDE_DEV_TOOLS` | 网页 / WebView 开发者工具 |
| `INCLUDE_FILE_LISTING` | 文件管理 |
| `USE_WEBCODECS` | WebCodecs Player（默认开启） |
| `USE_H264_CONVERTER` | Mse Player |
| `USE_BROADWAY` | Broadway Player |
| `USE_TINY_H264` | TinyH264 Player |
| `USE_WDA_MJPEG_SERVER` | WebDriverAgent MJPEG 服务器 |
| `USE_QVH_SERVER` | ws-qvh 支持 |
| `SCRCPY_LISTENS_ON_ALL_INTERFACES` | scrcpy-server 的 WebSocket 监听所有网卡（浏览器可直连设备，否则需 adb 转发） |

## 运行配置

配置文件路径由环境变量 `LUNALINK_CONFIG` 指定；**未设置时不加载任何配置文件**，全部使用默认值。
`config.yaml` 含本地令牌等私密信息，已被 `.gitignore` 排除，需自行从模板创建：

```shell
cp config.example.yaml config.yaml   # Windows 用 copy
# 编辑后指定路径启动：
# PowerShell:  $env:LUNALINK_CONFIG="./config.yaml"; node dist/index.js
# bash:        LUNALINK_CONFIG=./config.yaml node dist/index.js
```

常用配置（完整字段见 [Configuration.d.ts](/src/types/Configuration.d.ts)，示例见 [config.example.yaml](/config.example.yaml)）：

| 字段 | 说明 |
| --- | --- |
| `server[].port` | HTTP(S) 监听端口，默认 `8888`（`PORT` 环境变量优先级更高） |
| `server[].secure` + `options.certPath` / `keyPath` | 启用 HTTPS |
| `accessToken` | 访问令牌，配置后页面 / API / WebSocket 均需认证（见[安全提示](#安全提示)） |
| `remoteHostList` | 远程设备追踪器列表 |

- `LUNALINK_PATHNAME`：非 `/` 的路径前缀

## 已知问题

- Android 模拟器上的服务监听内部接口，外部无法访问，请从接口列表选择 `proxy over adb`
- Safari 浏览器下文件上传不显示进度
- TinyH264Player 可能启动失败，刷新页面重试（需 `USE_TINY_H264`）
- MsePlayer 质量统计报告丢帧偏多（需 `USE_H264_CONVERTER`）
- WebCodecs Player 需 Chromium 系浏览器；Firefox / Safari 需改用其它播放器（构建开关启用后设备卡片会显示对应按钮）
- **手机→电脑剪贴板自动同步在 Android 12+（尤其 vivo/OriginOS、Android 16）存在平台限制**：
  scrcpy-server 以 `app_process` 后台进程运行，Android 12 起后台进程读剪贴板返回 `null`，
  只能在投屏刚建立的短暂窗口内同步一次，之后失效。这是平台隐私限制而非代码缺陷；
  电脑→手机方向（`SET_CLIPBOARD` 下发）不受影响

## 安全提示

- 可在配置文件中设置 `accessToken` 启用**访问认证**：浏览器访问跳转登录页（令牌正确后种 30 天 HttpOnly cookie），也支持 `?token=xxx` 直通访问；未认证的 API 请求返回 401，WebSocket 握手直接拒绝。**未配置 `accessToken` 时无任何认证，行为同旧版**
- 认证令牌经 HTTP 明文传输，对外暴露请务必配合 HTTPS（`server[].secure`，见[运行配置](#运行配置)）
- 修改版 scrcpy 的 WebSocket 会监听所有网络接口，且最后一个客户端断开后仍继续运行
- 即便启用了认证，也**不建议将服务直接暴露到公网**

## 相关项目

[Genymobile/scrcpy][scrcpy] · [EucalyZ/scrcpy（WebSocket 分支）][fork] · [DeviceFarmer/adbkit][adbkit] ·
[xevokk/h264-converter][xevokk/h264-converter] · [131/h264-live-player][h264-live-player] ·
[mbebenita/Broadway][broadway] · [udevbe/tinyh264][tinyh264] · [xtermjs/xterm.js][xterm.js] ·
[danielpaulus/quicktime_video_hack][qvh] · [ws-qvh][ws-qvh]

## scrcpy WebSocket 分支

内置 server 基于官方 scrcpy v3.1（[EucalyZ/scrcpy][fork] `websocket` 分支）添加 WebSocket 支持，
本仓库另做了本地增强（剪贴板双向同步、关键帧请求兼容、流式文件推送）：

- [预编译包](/vendor/Genymobile/scrcpy/scrcpy-server.jar)（版本 `3.3.4-ws`，需与 `src/common/Constants.ts` 的 `SERVER_VERSION` 一致）
- [本地源码](/vendor/Genymobile/scrcpy-src)（server 模块为 Gradle 工程，构建方式参考[官方构建文档](https://github.com/Genymobile/scrcpy/blob/master/doc/build.md)）

> server 参数为 `key=value`（v3.x 风格），首个参数必须是构建版本号。
> **不要替换为官方 scrcpy 4.x 的 jar**——无 WebSocket 支持，启动参数与控制协议均不兼容。

[fork]: https://github.com/EucalyZ/scrcpy/tree/websocket
[scrcpy]: https://github.com/Genymobile/scrcpy
[xevokk/h264-converter]: https://github.com/xevokk/h264-converter
[h264-live-player]: https://github.com/131/h264-live-player
[broadway]: https://github.com/mbebenita/Broadway
[adbkit]: https://github.com/DeviceFarmer/adbkit
[xterm.js]: https://github.com/xtermjs/xterm.js
[tinyh264]: https://github.com/udevbe/tinyh264
[node-pty]: https://github.com/Tyriar/node-pty
[WebDriverAgent]: https://github.com/appium/WebDriverAgent
[qvh]: https://github.com/danielpaulus/quicktime_video_hack
[ws-qvh]: https://github.com/NetrisTV/ws-qvh
[webcodecs]: https://w3c.github.io/webcodecs/
