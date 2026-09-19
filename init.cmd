@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0node.exe" (
  echo Missing bundled node.exe.
  exit /b 1
)
"%~dp0node.exe" "%~dp0src\init.mjs" %*
exit /b %errorlevel%
