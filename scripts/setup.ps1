# FrameScribe 一键安装 / 检查。由根目录的 setup.cmd 调用，可以重复运行（装好的步骤会跳过）。
#   setup.cmd          安装并检查（会问几个是/否）
#   setup.cmd -Yes     全部默认“是”，不停下来问（给 AI 代装用）
#   setup.cmd -Check   只检查，不安装任何东西
param([switch]$Check, [switch]$Yes)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$app = Join-Path $root 'app'
$electronExe = Join-Path $app 'node_modules\electron\dist\electron.exe'
$results = [ordered]@{}

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($n, $text) { Write-Host ''; Write-Host "[$n] $text" -ForegroundColor Cyan }
# 不用 Get-FileHash：从 PowerShell 7 里启动 5.1 时模块路径会串，那个命令加载不了
function Sha256($file) {
  $s = [IO.File]::OpenRead($file)
  try { return (([Security.Cryptography.SHA256]::Create().ComputeHash($s)) | ForEach-Object { $_.ToString('x2') }) -join '' } finally { $s.Dispose() }
}
function Ok($text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Ask($q) {
  if ($Yes) { return $true }
  $a = Read-Host "    $q [Y/n]"
  return ($a -eq '' -or $a -match '^[yY]')
}
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function NodeVersion {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return $null }
  $v = (& node -v) -replace '^v', ''
  return [version]($v -replace '[^\d.].*$', '')
}

Say ''
Say '  FrameScribe 安装程序' 'White'
Say "  位置：$root"
if ($Check) { Say '  （只检查，不安装）' }

# —— 1. Node.js ——
Step 1 'Node.js（22.12 或更新）'
$nv = NodeVersion
if (-not $nv -or $nv -lt [version]'22.12') {
  if ($nv) { Warn "现在的 Node 是 $nv，太旧" } else { Warn '没装 Node.js' }
  if (-not $Check -and (Get-Command winget -ErrorAction SilentlyContinue) -and (Ask '用 winget 安装 Node.js LTS？')) {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    RefreshPath
    $nv = NodeVersion
  }
}
if ($nv -and $nv -ge [version]'22.12') { Ok "Node $nv"; $results['Node.js'] = $true }
else {
  $results['Node.js'] = $false
  Warn '请先装 Node.js LTS：https://nodejs.org （装完重新双击 setup.cmd）'
  if (-not $Check) { if (-not $Yes) { Read-Host '按回车退出' }; exit 1 }
}

# —— 2. 软件依赖 + Electron 运行时 ——
Step 2 '软件依赖（npm install，约 400 MB，第一次要几分钟）'
$depsOk = (Test-Path (Join-Path $app 'node_modules\sherpa-onnx-node')) -and (Test-Path (Join-Path $app 'node_modules\koffi')) -and (Test-Path (Join-Path $app 'node_modules\ws'))
if (-not $depsOk -and -not $Check) {
  Push-Location $app
  try {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      Warn 'npm 官方源装失败，换国内镜像 npmmirror 再试'
      & npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
    }
  } finally { Pop-Location }
  $depsOk = (Test-Path (Join-Path $app 'node_modules\sherpa-onnx-node')) -and (Test-Path (Join-Path $app 'node_modules\koffi'))
}
if ($depsOk) { Ok '依赖已装' } else { Warn '依赖没装上（看上面 npm 的报错）' }
$results['软件依赖'] = $depsOk

if ($depsOk -and -not (Test-Path $electronExe) -and -not $Check) {
  Say '    下载 Electron 运行时…'
  Push-Location $app
  try {
    & node node_modules\electron\install.js
    if (-not (Test-Path $electronExe)) {
      Warn 'GitHub 下载失败，换国内镜像再试'
      $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
      & node node_modules\electron\install.js
    }
  } finally { Pop-Location }
}
if (Test-Path $electronExe) { Ok 'Electron 运行时' } else { Warn '缺 Electron 运行时' }
$results['Electron'] = (Test-Path $electronExe)

# —— 3. 语音模型（本机转写用，约 240 MB）——
Step 3 '语音模型（SenseVoice + Silero VAD，约 240 MB，只下一次）'
$hf = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
$models = @(
  @{ File = 'sense-voice\model.int8.onnx'; Size = 239233841; Sha = 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'
     Urls = @("https://huggingface.co/$hf/model.int8.onnx", "https://hf-mirror.com/$hf/model.int8.onnx") },
  @{ File = 'sense-voice\tokens.txt'; Size = 315894; Sha = 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'
     Urls = @("https://huggingface.co/$hf/tokens.txt", "https://hf-mirror.com/$hf/tokens.txt") },
  @{ File = 'silero_vad.onnx'; Size = 643854; Sha = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
     Urls = @('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx') }
)
$modelsOk = $true
foreach ($m in $models) {
  $dest = Join-Path $app ('models\' + $m.File)
  if ((Test-Path $dest) -and (Get-Item $dest).Length -eq $m.Size) { Ok $m.File; continue }
  if ($Check) { Warn "缺 $($m.File)"; $modelsOk = $false; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  $tmp = "$dest.part"
  $got = $false
  foreach ($u in $m.Urls) {
    Say "    下载 $($m.File) ← $u"
    & curl.exe -L --fail --retry 3 --connect-timeout 20 -C - -o $tmp $u
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp) -and (Sha256 $tmp) -eq $m.Sha) { $got = $true; break }
    Warn '这个地址没下好，换下一个'
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
  if ($got) { Move-Item -Force $tmp $dest; Ok $m.File } else { Warn "$($m.File) 下载失败（不影响截图和字幕，只是不能本机转写）"; $modelsOk = $false }
}
$results['语音模型'] = $modelsOk

# —— 4. 本地桥接（插件单独用时需要）——
Step 4 '注册浏览器插件的本地桥接'
$bridge = Join-Path $root 'host\com.framescribe.host.json'
$regKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.framescribe.host'
$registered = (Test-Path $bridge) -and (Test-Path $regKey) -and ((Get-Item $regKey).GetValue('') -eq $bridge)
if (-not $registered -and -not $Check) {
  & (Join-Path $root 'host\install-host.ps1') | ForEach-Object { Say "    $_" }
  $registered = (Test-Path $bridge)
}
if ($registered) { Ok '已注册（Chrome / Edge / Chromium）' } else { Warn '没注册' }
$results['桥接'] = $registered

# —— 5. AI 整理引擎 ——
Step 5 'AI 整理引擎（用你已有的订阅）'
$eng = $null
try { $eng = & node -e "const e=require(process.argv[1]).engines();console.log(JSON.stringify({claude:!!e.claude,codex:!!e.codex}))" (Join-Path $root 'host\core.js') | ConvertFrom-Json } catch {}
if ($eng -and $eng.claude) { Ok 'Claude Code：找到了' } else { Say '    --  Claude Code：没找到（可选）' }
if ($eng -and $eng.codex) { Ok 'Codex：找到了' } else { Say '    --  Codex：没找到（可选）' }
if (-not ($eng -and ($eng.claude -or $eng.codex))) {
  Say '    两个都没有也能用：在软件「设置 → 整理引擎」里选 API，填 DeepSeek / 通义 / Kimi 等的 Key。' 'Yellow'
}
$results['AI 引擎'] = [bool]($eng -and ($eng.claude -or $eng.codex))

# —— 6. 桌面快捷方式 ——
if (-not $Check -and (Test-Path $electronExe)) {
  Step 6 '桌面快捷方式'
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FrameScribe.lnk'
  if (-not (Test-Path $lnk)) {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $electronExe
    $s.Arguments = '"' + $app + '"'
    $s.WorkingDirectory = $app
    $s.IconLocation = (Join-Path $app 'icon.ico')
    $s.Description = 'FrameScribe'
    $s.Save()
  }
  Ok $lnk
}

# —— 汇总 ——
Write-Host ''
Write-Host '========== 结果 ==========' -ForegroundColor White
foreach ($k in $results.Keys) {
  if ($results[$k]) { Write-Host ("  [OK] " + $k) -ForegroundColor Green } else { Write-Host ("  [--] " + $k) -ForegroundColor Yellow }
}
$ready = $results['Node.js'] -and $results['软件依赖'] -and $results['Electron']

if ($ready -and -not $Check) {
  $ext = Join-Path $root 'extension'
  Write-Host ''
  Write-Host '最后一步（只能手点，30 秒）：在浏览器里加载插件' -ForegroundColor Cyan
  Say '  1. 打开 chrome://extensions（Edge 是 edge://extensions）'
  Say '  2. 打开右上角「开发者模式」'
  Say '  3. 点「加载已解压的扩展程序」，选这个文件夹：'
  Say "     $ext" 'White'
  try { Set-Clipboard -Value $ext; Say '     （路径已复制到剪贴板，选文件夹时直接粘贴）' } catch {}
  if (-not $Yes) {
    if (Ask '现在打开插件文件夹并启动 FrameScribe？') {
      Start-Process explorer.exe $ext
      Start-Process $electronExe -ArgumentList ('"' + $app + '"') -WorkingDirectory $app
    }
  }
}
if (-not $Yes) { Write-Host ''; Read-Host '按回车关闭' | Out-Null }
if ($ready) { exit 0 } else { exit 1 }
