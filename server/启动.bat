@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动中国电视直播（代理版）...
echo 浏览器会自动打开 http://127.0.0.1:8021/ ，关闭本窗口即停止服务。
start "" http://127.0.0.1:8021/
python serve.py --port 8021
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Python 3.8+ 并勾选了 "Add Python to PATH"。
  pause
)
