@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "runtime\python.exe" (
    echo 未找到项目自带的 Python。请完整解压项目后再启动。
    pause
    exit /b 1
)
"runtime\python.exe" "serve_local.py" --open
if errorlevel 1 (
    echo.
    echo 服务器启动失败，请查看上方错误信息。
    pause
)
