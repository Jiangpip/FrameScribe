# AGENTS.md

- 用户要你**安装** FrameScribe：照 [INSTALL_FOR_AI.md](INSTALL_FOR_AI.md) 做。
- 用户要你**改代码**：先读 [docs/开发说明.md](docs/开发说明.md)（代码结构、调试开关、测试方法）。
  - `extension/lib/note.js`、`extension/lib/prompt.js`、`host/core.js` 是桌面软件和插件共用的，改一处两边生效。
  - 测试时用 `BN_PORT=38918` + `BN_DATA=<临时目录>` 另起一个实例，不要碰用户正在用的那个（端口 38917）。
- 提交前运行 `powershell -ExecutionPolicy Bypass -File scripts\check-privacy.ps1`，确保不带本机路径、密钥和个人信息。
