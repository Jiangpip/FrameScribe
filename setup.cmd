@echo off
rem FrameScribe setup: double-click to install / repair. Options: -Yes (no questions), -Check (only check).
rem Clear PSModulePath so Windows PowerShell 5.1 does not pick up PowerShell 7 modules when started from pwsh.
setlocal
set PSModulePath=
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
exit /b %ERRORLEVEL%
