@echo off
cd /d "%~dp0"
java -jar multiplayer-world-experimental.jar --host 0.0.0.0 --port 47486 --max-clients 8 %*
pause
