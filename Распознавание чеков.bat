@echo off
chcp 65001 >nul
title Распознавание чеков
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
python worker\process.py %*
pause
