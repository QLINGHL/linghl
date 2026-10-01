@echo off
chcp 65001 >nul
title Codex Replica Launcher
cd /d "%~dp0"

rem Use the same guarded launcher as npm start:
rem - kills only stale Codex processes when explicitly needed by the launcher
rem - removes inherited Electron host variables before spawning
rem - adds the required Chromium sandbox switch
call node tools\start-forge.cjs
exit /b %errorlevel%
