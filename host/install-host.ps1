# 注册本地桥接程序（只写当前用户的注册表 HKCU，不需要管理员）。重复运行无害。
# 插件单独用（不开桌面软件）时靠它写文件、调 Claude Code / Codex。setup.cmd 会自动跑这一步。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$id = (Get-Content -LiteralPath (Join-Path $here 'EXTENSION_ID.txt') -Raw).Trim()
$node = (Get-Command node -ErrorAction Stop).Source
$name = 'com.framescribe.host'

$cmd = Join-Path $here 'framescribe-host.cmd'
[IO.File]::WriteAllText($cmd, "@echo off`r`n`"$node`" `"%~dp0host.js`"`r`n", [Text.Encoding]::ASCII)

$manifestPath = Join-Path $here "$name.json"
$manifest = [ordered]@{
  name            = $name
  description     = 'FrameScribe local bridge'
  path            = $cmd
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$id/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))

$roots = @('HKCU:\Software\Google\Chrome', 'HKCU:\Software\Microsoft\Edge', 'HKCU:\Software\Chromium')
foreach ($r in $roots) {
  $k = "$r\NativeMessagingHosts\$name"
  New-Item -Path $k -Force | Out-Null
  Set-Item -Path $k -Value $manifestPath
  # 旧名字（改名前）的注册项，留着没用，删掉
  Remove-Item -Path "$r\NativeMessagingHosts\com.bilinotes.host" -Recurse -ErrorAction SilentlyContinue
}
foreach ($old in @('com.bilinotes.host.json', 'bilinotes-host.cmd')) {
  Remove-Item -LiteralPath (Join-Path $here $old) -ErrorAction SilentlyContinue
}
"已注册：$manifestPath"
"扩展 ID：$id"
"Node：$node"
