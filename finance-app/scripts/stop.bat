@echo off
REM Doble-click para detener todo (mata procesos en :3000 y :8001)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
pause
