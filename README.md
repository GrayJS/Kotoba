# Kotoba · 本地双语字幕

Windows 11 桌面程序：选择一个正在播放声音的应用，通过本地 Whisper 识别语音，
交给 Ollama 或用户配置的兼容 API 翻译，在置顶透明窗口中显示双语字幕。
默认组合为 **Whisper large-v3-turbo + 本机 Ollama Index-Translate-2B**，默认日语→简体中文。

从 [GitHub Releases](https://github.com/GrayJS/Kotoba/releases) 下载 Windows x64 安装包。

## 日常使用

1. 启动 Kotoba。默认本机模式会检测 Ollama 和 Index：缺少时，在默认展开的“模型服务设置”中点击“一键安装 Ollama + Index 并自动配置”。
   已安装 Ollama 时只需启动服务或准备缺少的 Index 模型；已有有效组件直接复用。
2. 启动 Kotoba，点击左侧“一键下载识别模型”。Whisper 下载无需命令行或填写路径。
   在“模型服务设置”中可修改 Ollama 地址、模型、超时和驻留时间，也可改用兼容 API。
3. 点击“重新检查连接”。首次预热需要加载两个模型；通过 GPU/CPU 真实推理自检后才能开始。
4. 在目标应用播放声音，刷新列表，选中应用并点击“开始监听”。
5. **直接按住桌面字幕框拖动**，位置自动保存，无需先进入编辑模式；字幕框外的透明区域可穿透。
   “预览桌面位置”可在没有声音时显示占位字幕，“重置位置”可将字幕移回屏幕底部。
6. 在主界面选择源语音语言和译文语言；切换会暂停当前监听并清空旧会话结果，再次开始即可使用。
   主题提供“跟随系统 / 浅色 / 深色”，默认跟随系统并响应系统变化。字幕颜色和透明度独立保留。

源语音语言默认手动日语，也支持自动检测及英、中、韩、西、法、德、俄、葡、意、阿拉伯、印地语。
译文可选择简体/繁体中文、日、英、韩等界面列出的语言。实际翻译质量和语言覆盖取决于所选翻译模型。
同一份 Whisper 多语言模型无需按语言重新下载。自动检测仅在语音片段足够且置信度较高时显示检测标签，
同一句后续滚动识别复用检测结果；新句和新会话重新判断。短片段或静音不会显示为可靠的检测结论。
手动模式跳过语言检测；自动/手动的速度差异尚未量化。

0.2.0 默认开启“边听边显示”：GPU 模式每约 640 毫秒取一次增长中的语音片段做滚动识别，
日文先出现，中文暂译随后更新；同一句的文字可能修正，约 320 毫秒停顿后定稿。
这使用现有 Whisper 做滚动识别，不是更换为原生流式模型。CPU 模式会降低预览频率。
若更重视稳定整句，可暂停监听后关闭“边听边显示”。

关闭控制台会留在系统托盘。使用托盘菜单退出程序。
`Ctrl+Alt+S` 开始/暂停监听，`Ctrl+Alt+H` 显示/隐藏字幕；快捷键被占用时会提示。

## 一键准备本机翻译环境

默认日语→简体中文配置无需手动填写路径或模型名。程序启动后检测本机 Ollama 服务、已安装的运行组件及默认
`hf.co/IndexTeam/Index-Translate-2B-GGUF:Q4_K_M` 模型，缺少时显示提示，由用户点击后安装。
新电脑按需从 Ollama 官方 GitHub 下载固定的 `v0.40.15/OllamaSetup.exe`（约 1.69 GB），
通过固定 SHA-256 校验后，以当前用户权限调用官方安装程序；启动服务仅监听 `127.0.0.1:11434`。
已存在的服务或运行组件会复用，不为其重新安装另一份 Ollama。安装包缓存位于 `%APPDATA%\Kotoba\downloads`。

**进度在 Kotoba 应用内显示**：Ollama 安装包下载显示已下载字节、总大小与百分比，校验/安装/服务启动显示明确阶段；
Index 下载通过 Ollama 的流式 API 显示当前模型文件的字节进度与百分比，后续还有校验和保存状态。
无法计算比例时显示不确定进度条，不制造整体百分比。下载阶段可取消、失败可重试；安装包支持服务端允许时断点续传，
模型下载复用 Ollama 缓存。官方安装程序正在写入文件时不提供强制取消。

成功后自动保存本机地址与 Index 模型名，验证模型已出现在服务列表中；若 Whisper 已准备则继续连接和 GPU/CPU 自检，
否则提示在左侧准备 Whisper。不会自动切换 CPU。自定义地址、模型或兼容 API 不会被默认环境安装覆盖，
检测会显示保留现有配置；若用户在准备期间手动改动配置文件，完成时也不会强行覆盖。
本功能仅支持 Windows x64；首次需要能访问 GitHub、Hugging Face / 模型源以及足够的磁盘空间。

## 检查更新

左侧版本区点击“检查更新”，主动查询本项目 [GitHub Releases](https://github.com/GrayJS/Kotoba/releases)，
显示检查中、已是最新、发现新版本或网络失败；失败后可重试。列表同时包含正式版与 Beta，
排除草稿，按语义版本比较（例如 `beta.10` 高于 `beta.2`，同版本正式版高于 Beta），不依赖只返回正式版的 `latest` 接口。
发现更新后可打开发布页或 Windows x64 安装包下载入口，下载后运行安装包升级；保留已有模型与用户配置。
程序不后台检查、自动下载、静默安装或强制更新。只打开本仓库可信的 HTTPS GitHub 发布地址。
查询在主进程执行，使用公开 API、10 秒总超时，不携带 Ollama/API 密钥、音频或字幕；GitHub 网络不通或限流时会提示重试。

## 配置文件

开发版使用项目根目录的 `config.json`。安装版默认使用 `%APPDATA%\Kotoba\config.json`，
首次启动会创建默认配置。程序左下角显示当前配置的完整位置。
也可使用 `--config="D:\path\config.json"` 或 `KOTOBA_CONFIG` 指定配置文件。
界面即可保存服务和语言，无需编辑 JSON；修改文件后点击“重新检查连接”生效。
程序启动时只检测，不自动下载；Ollama/Index 一键安装与 Whisper 下载均由用户在应用内点击触发。
升级保留已有自定义模型和地址，旧配置缺失的新字段自动使用兼容默认值。

```json
{
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "hf.co/IndexTeam/Index-Translate-2B-GGUF:Q4_K_M",
    "timeoutMs": 15000,
    "keepAlive": "5m"
  },
  "asr": {
    "modelPath": "D:\\models\\whisper-large-v3-turbo",
    "device": "cuda",
    "gpuLibraryPath": ""
  },
  "languages": { "source": "ja", "target": "zh-CN" },
  "translation": {
    "provider": "ollama",
    "compatible": {
      "baseUrl": "https://your-service.example/v1",
      "model": "",
      "timeoutMs": 15000
    }
  }
}
```

- `baseUrl`：Ollama 服务根地址。默认本机；配置远程服务时，识别出的文字会发往该地址。
- `model`：与 `ollama list` 中的模型名称一致。默认关闭思考输出以降低字幕延迟。
- `timeoutMs`：每句翻译超时，范围 1000–120000 毫秒。首次预热单独允许 120 秒。
- `keepAlive`：模型驻留时间，支持 `5m`、`1h`、`0`、`-1` 等 Ollama 时间格式。
- `modelPath`：**CTranslate2 格式** Whisper 模型目录，不是 Ollama 模型，也不是 GGUF 文件。
  至少包含 `config.json`、`model.bin`、`tokenizer.json` 和该模型的 vocabulary 文件。
  相对路径以配置文件所在目录为基准。Windows 绝对路径中的反斜杠需要写成 `\\`，也可写 `/`。
- `device`：`cuda`（默认 `int8_float16`）或 `cpu`（`int8`）。界面切换设备也会更新配置。
- `gpuLibraryPath`：默认留空，使用安装包附带的 cuBLAS/cuDNN。自行部署时可填写包含 DLL 的目录。
- `languages.source`：`ja` 等语言代码或 `auto` 自动判断源语音；`languages.target` 为目标文字语言（默认 `zh-CN`）。
- `translation.provider`：`ollama` 或 `compatible`。兼容 API 采用 Chat Completions 协议，
  地址填写 API 前缀（如 `https://your-service.example/v1`），程序追加 `/chat/completions`。
  需要该服务支持 `messages`、`stream:false`、`temperature`、`max_tokens`，返回 `choices[0].message.content`。
  程序不承诺任意厂商兼容，不创建账号或密钥。远程 API 必须使用 HTTPS，本机测试可用 HTTP。
  连接检查会向已保存的服务发出一次短翻译请求；在线服务可能按其规则计费。

密钥只在界面填写，经 Electron safeStorage / Windows DPAPI 加密保存到
`%APPDATA%\Kotoba\credentials.bin`，绑定到准确服务地址，不写入配置 JSON、渲染状态或日志。
留空保留原密钥，勾选清除可移除；更换服务地址不会自动把旧密钥发送到新地址。
加密不可用时拒绝保存密钥。识别音频始终留在本机；远端翻译会接收当前原文和最近两句上下文，
界面根据已保存的实际地址显示“本机处理”或“文字发送至远端”。

字体、透明度、宽度和字幕位置单独保存到 `%APPDATA%\Kotoba\settings.json`。
录音和字幕默认只驻留内存。状态日志保存在 `%APPDATA%\Kotoba\logs\status.log`，
只记录状态、错误类别和耗时，超过 1 MiB 自动轮换，不写入音频、日文、译文或窗口标题。

## 准备语音识别模型

默认使用 `dropbox-dash/faster-whisper-large-v3-turbo`，固定模型版本
`0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`。点击下载后显示下载源连接、当前文件/阶段百分比，
失败可重试并复用缓存；下载、模型检查和监听不能同时进行。模型约 1.6 GB，首次需要网络和足够磁盘空间。
自动下载到 `%APPDATA%\Kotoba\models\whisper-large-v3-turbo` 用户可写目录，成功后自动保存路径。
已配置且文件完整的模型会保留并跳过下载。下载后自动衔接服务检查与真实 GPU/CPU 推理自检；
Whisper 下载成功状态与 Ollama/API 检查失败分开显示。GPU 检查失败会给出原因，由用户决定是否手动切换 CPU，
不会自动切换设备。网络受限时可手动下载到 `modelPath`。
开发环境也提供显式下载命令（不会随启动自动执行）：

```powershell
.venv\Scripts\python.exe python\worker.py --model-dir "D:\models\whisper-large-v3-turbo" --download-model
```

安装版可用 `resources\worker\kotoba-worker.exe --model-dir "D:\models\whisper-large-v3-turbo" --download-model`。
下载命令支持重新运行并利用已下载的缓存。模型准备完成后，日常运行无需联网。

## 开发与构建

需要 Windows 11 x64、Node.js 24、uv、Visual Studio 2022 Build Tools（C++ 桌面工具与 Windows SDK）。

```powershell
npm install
npm run setup:electron
npm run setup:python
npm run build:native
node scripts/fetch-gpu.mjs
npm run dev
```

`fetch-gpu.mjs` 从 NVIDIA 官方下载固定版本的 cuBLAS/cuDNN，验证 SHA-256 后收集 DLL 和许可证。
Electron 45 的 npm 包需要显式下载运行时，因此开发前要执行一次 `setup:electron`。
开发阶段使用 GPU 需要执行这一步；仅 CPU 开发可跳过，但完整安装包需要附带 GPU 资源。
Python 的完整依赖版本在 `python/requirements-lock.txt`。

```powershell
npm run typecheck
npm test
npm run test:python
npm run build
npm run smoke
npm run build:worker
npm run dist
```

`release/` 包含 x64 安装包和可直接启动的 `win-unpacked/` 目录。
运行安装版无需系统 Python 或 Node.js；Python、推理依赖、音频采集组件及 GPU DLL 随安装包附带。
本机翻译需 Ollama 和相应翻译模型，缺少时可在应用内一键准备；Whisper 也在应用内下载。模型准备后本机模式可离线使用。
模型不打入安装包，因此可替换模型而不重新打包程序。

## 验证工具

- `scripts/test-capture.py`：两个独立低音量音频进程同时播放，验证进程隔离及目标退出处理。
- `scripts/smoke.mjs`：启动真实 Electron，验证受限 IPC、双语开关、悬浮窗和模型自检。
- `scripts/e2e.mjs`：公开日语音频从独立应用播放，经实际进程采集生成桌面双语字幕。
- `scripts/fault-smoke.mjs`：连接错误、模型缺失、进程崩溃恢复及 CPU 切换。
- `scripts/setup-smoke.mjs`：真实 Electron 内下载失败/重试/缓存完成、自动配置路径、服务错误隔离、
  多语言保存、兼容 API 本地 mock、Windows 密钥加密、GPU 检查、无编辑模式的原生拖动、浅/深色布局和重启持久化。
  下载完成分支使用真实模型文件的硬链接缓存，不会重复下载 1.6 GB 权重。
- `scripts/updates-smoke.mjs`：更新界面、主进程受限 IPC、Beta mock、可信链接、网络失败重试、浅/深色及真实 GitHub 查询。
- `scripts/local-setup-smoke.mjs`：默认环境检测提示、流式模型进度、失败重试、自动配置、已有模型复用、自定义服务保留及安装进度 UI。
  缺少运行环境的协调流程与下载续传/校验使用本地 mock 测试；不卸载本机 Ollama 来模拟干净系统。
- `scripts/local-reuse-smoke.mjs`：使用真实已有 Ollama、Index 与 Whisper，验证跳过下载、自动配置和实际推理自检。
- `scripts/host-exit-smoke.mjs`：主程序异常退出后，识别进程自动清理。
- `scripts/dev-smoke.mjs`：验证 Vite 开发模式及开发用 CSP nonce。
- `scripts/prepare-fixtures.py`：显式下载 3 条公开 JSUT 日语测试音频，仅保存到忽略的构建目录。
- `scripts/soak.py --seconds 1800`：30 分钟真实识别与翻译循环，无声播放，记录处理耗时及内存。
  此工具测量模型处理时间，不等同于包含音频分句等待的桌面字幕端到端延迟。

## 边界

- 按 Windows 应用**进程树**隔离。浏览器同一进程树中的其他标签页可能被同时采集；可使用独立浏览器实例。
- 目标应用必须建立音频会话才会出现在列表中。普通窗口与无边框全屏可用，独占全屏不保证覆盖。
- DRM 保护或高权限应用可能无法采集；程序不会自动退回系统全局采集。
- 实时模式约 320 毫秒静音结束一句，整句模式约 500 毫秒；连续讲话最长约 4 秒切段，保留约 192 毫秒重叠。
  识别与翻译各只保留同一句最新的待处理版本，最多等待 3 句；只有完整语句因过载被跳过时才增加计数。
- 实时模式优先提前显示暂译，速度由“原文首字／译文首字”统计反映；整句模式以短句约 2–4 秒为目标。
  长句、背景音乐、多人重叠讲话、GPU 被游戏占用或 CPU 模式会影响速度与准确率。
- “原文首字”从该句首次检测到语音到首次识别结果计时；“译文首字”从同一起点到首次暂译到达计时。
  “句末 P95”从最后检测到语音到定稿译文完成计时，统计当前会话最近 1000 条定稿字幕，不能替代首字等待时间。
- 当前版本提供手动检查更新，没有自动安装更新、云服务账号、字幕导出或说话人分离。

第三方许可见 `THIRD_PARTY_NOTICES.md`。
