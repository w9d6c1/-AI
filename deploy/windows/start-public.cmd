@echo off
chcp 65001 >nul
echo Starting app + Cloudflare tunnel ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-public.ps1"
pause
