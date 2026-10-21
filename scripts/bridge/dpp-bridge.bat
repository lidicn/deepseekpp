@echo off
REM DPP Bridge native host launcher.
REM 2026-10-21 fix: the previous version pointed at a node.exe inside Doubao's
REM sandbox_runtime, which no longer exists, so the host exited immediately and
REM the extension fell into a reconnect loop
REM (SW console: "native port connected" -> "Native host has exited", repeatedly).
REM Now resolves node in priority order: DPP_BRIDGE_NODE > Program Files > local > x86 > PATH.

if defined DPP_BRIDGE_NODE (
  "%DPP_BRIDGE_NODE%" "%~dp0dpp-bridge.mjs"
  exit /b %errorlevel%
)

set "NODE_EXE="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE for %%P in (node.exe) do if exist %%~$PATH:P set "NODE_EXE=%%~$PATH:P"

if not defined NODE_EXE (
  echo [dpp-bridge] no usable node.exe found; set DPP_BRIDGE_NODE 1>&2
  exit /b 127
)

"%NODE_EXE%" "%~dp0dpp-bridge.mjs"
