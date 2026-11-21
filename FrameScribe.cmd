@echo off
rem Start FrameScribe (tray icon + notebook window). You can close this console; the app keeps running in the tray.
if not exist "%~dp0app\node_modules\electron\dist\electron.exe" (
  echo FrameScribe is not installed yet. Double-click setup.cmd first.
  pause
  exit /b 1
)
start "" "%~dp0app\node_modules\electron\dist\electron.exe" "%~dp0app"
