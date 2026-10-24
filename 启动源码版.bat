@echo off
rem Launch AI Studio from source (log: dev-run.log)
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
"%~dp0node_modules\electron\dist\electron.exe" --no-sandbox "%~dp0." >> "%~dp0dev-run.log" 2>&1
