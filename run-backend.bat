@echo off
setlocal
title Sub Stream AI - Manual Backend

cd /d "%~dp0"

if not exist "backend" (
  echo [ERROR] backend folder not found.
  echo Put this file in the root of the sub-stream repo.
  pause
  exit /b 1
)

if not exist "backend\.venv\Scripts\python.exe" (
  echo [ERROR] Virtual environment not found.
  echo Run setup-edge.bat first.
  pause
  exit /b 1
)

call "backend\.venv\Scripts\activate.bat"
if errorlevel 1 (
  echo [ERROR] Failed to activate virtual environment.
  pause
  exit /b 1
)

cd backend
echo Starting Sub Stream AI backend...
echo Keep this window open while using subtitles.
echo.
python server.py

echo.
echo Backend stopped.
pause
exit /b 0
