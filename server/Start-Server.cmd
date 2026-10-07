@echo off
chcp 65001 >nul
cd /d "%~dp0"
where java >nul 2>nul
if errorlevel 1 (
    echo 未找到 Java。请先安装 Java 17 或更新版本。
    pause
    exit /b 1
)
java -jar "multiplayer-server.jar" %*
if errorlevel 1 (
    echo 服务端未能启动，请查看上方错误信息。
    pause
)
