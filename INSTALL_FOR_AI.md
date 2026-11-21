# 给 AI 代装用的步骤（Claude Code / Codex 读这个）

用户说“帮我装 FrameScribe”时按这里做。用中文和用户交流；每步做完看结果再走下一步。

## 前提

- Windows 10 / 11。不是 Windows 就告诉用户：目前只支持 Windows（全局快捷键、截屏、窗口识别都是 Windows 专用）。
- 浏览器 Chrome 或 Edge。

## 步骤

1. **拿到代码**：用户给的是仓库地址就 `git clone` 到用户指定的目录（没指定就问；建议不要放在会被清理的临时目录、路径里最好没有空格）。已经下载解压好的就直接进那个目录。

2. **运行安装脚本（不交互模式）**：
   ```
   cmd /c setup.cmd -Yes
   ```
   在安装目录里运行。用 setup.cmd，不要直接调 setup.ps1：它会先清掉从 PowerShell 7 串过来的模块路径。
   - 退出码 0 = 核心部分（Node、依赖、Electron）装好了；看输出最后的「结果」表。
   - 没有 Node.js 时脚本会用 winget 装 Node LTS。winget 不可用就请用户从 https://nodejs.org 装 LTS，装完**重新开一个终端**再跑。
   - npm 或 Electron 下载失败会自动换 npmmirror 镜像；还失败就看报错（多半是网络/代理），把关键报错告诉用户。
   - 「语音模型」失败不影响截图、字幕和大纲，只是不能本机转写；可以重跑一次 setup（会续传）。

3. **检查**：
   ```
   cmd /c setup.cmd -Check -Yes
   ```
   「AI 引擎」两个都没找到时：问用户想用 Claude Code、Codex 还是 API Key。装 CLI 的话装好后提醒用户先登录一次（`claude` / `codex login`）。用 API 的话软件里「⚙ 设置 → 整理引擎 → API」选厂商、填 Key（Key 只存在用户本机）。

4. **加载浏览器插件——这一步必须用户自己手点**，你不能代替。把下面这段原样告诉用户（把路径换成实际的安装目录）：
   > 1. 浏览器地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）
   > 2. 打开右上角「开发者模式」
   > 3. 点「加载已解压的扩展程序」，选 `<安装目录>\extension`

5. **启动**：双击桌面的 FrameScribe 快捷方式，或运行安装目录里的 `FrameScribe.cmd`。第一次会出欢迎页，让用户选笔记存到哪。告诉用户：打开一个 B 站或 YouTube 视频，按 `Alt+S` 试试。

## 不要做的事

- 不要改用户的全局配置（`~/.codex/config.toml`、Claude Code 设置等）。
- 不要把用户的 API Key 写进仓库里的任何文件。
- 不要用管理员权限运行；安装只写当前用户的目录和注册表（HKCU）。

## 排错速查

| 现象 | 处理 |
|---|---|
| `electron.exe` 不存在 | `cd app` 后 `node node_modules\electron\install.js`；国内网络先设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| 软件起来了但「语音模型缺失」 | 重跑 setup；模型在 `app\models\` |
| 插件连不上软件 | 软件要开着；插件要加载；端口 `127.0.0.1:38917` 不能被占用（设置 → 状态 里能看到） |
| 只用插件不开软件，导出失败 | 运行 `host\install-host.ps1` 后完全重启浏览器 |
| 日志 | 软件：`%APPDATA%\FrameScribe\app.log`；整理：安装目录 `host\logs\` |
