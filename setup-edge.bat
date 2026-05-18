@echo off
setlocal ENABLEDELAYEDEXPANSION
title Kami Subs - Edge Setup

cd /d "%~dp0"

echo ==================================================
echo            Kami Subs - Edge First-Time Setup
echo ==================================================
echo.

if not exist "backend" (
  echo [ERROR] backend folder not found.
  echo Put this file in the root of the kami-subs repo.
  pause
  exit /b 1
)

if not exist "extension" (
  echo [ERROR] extension folder not found.
  echo Put this file in the root of the kami-subs repo.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python 3.10+ is not installed or not added to PATH.
  echo Install Python, then run this file again.
  echo https://www.python.org/downloads/
  pause
  exit /b 1
)

echo [OK] Python detected:
python --version
echo.

echo [1/6] Creating virtual environment...
if not exist "backend\.venv\Scripts\python.exe" (
  pushd backend
  python -m venv .venv
  if errorlevel 1 (
    popd
    echo [ERROR] Failed to create virtual environment.
    pause
    exit /b 1
  )
  popd
  echo [OK] Virtual environment created.
) else (
  echo [OK] Virtual environment already exists.
)
echo.

echo [2/6] Activating virtual environment...
call "backend\.venv\Scripts\activate.bat"
if errorlevel 1 (
  echo [ERROR] Failed to activate virtual environment.
  pause
  exit /b 1
)
echo [OK] Virtual environment activated.
echo.

echo [3/6] Upgrading pip...
python -m pip install --upgrade pip
if errorlevel 1 (
  echo [ERROR] Failed to upgrade pip.
  pause
  exit /b 1
)
echo [OK] pip upgraded.
echo.

echo [4/6] Installing backend dependencies...
pip install -r "backend\requirements.txt"
if errorlevel 1 (
  echo [ERROR] Failed to install Python dependencies.
  echo Try closing this window and running setup-edge.bat again.
  pause
  exit /b 1
)
echo [OK] Backend dependencies installed.
echo.

echo [5/6] Registering Native Messaging host for Edge/Chrome...
powershell -ExecutionPolicy Bypass -File "extension\native\install.ps1"
if errorlevel 1 (
  echo [WARNING] Native Messaging host setup may have failed.
  echo You can still use run-backend.bat as a manual fallback.
) else (
  echo [OK] Native Messaging host installed.
)
echo.

echo [6/6] Opening Microsoft Edge extensions page...
start microsoft-edge:edge://extensions/
timeout /t 2 >nul

echo ==================================================
echo                    NEXT STEPS
echo ==================================================
echo 1. In Edge, turn ON Developer mode
echo 2. Click Load unpacked
echo 3. Select this folder:
echo    %cd%\extension
echo 4. Pin the Kami Subs extension
echo 5. Open a video tab
echo 6. Click the extension
echo 7. Choose:
echo      - Source language: Japanese
echo      - Target language: English
echo      - Model: tiny or small
echo      - Device: cpu
echo 8. Click Start
echo.
echo If auto-start does not work:
echo - Run run-backend.bat
echo - Then click Start in the extension again
echo.
echo DRM sites like Netflix/Disney+ may not work.
echo YouTube and many normal browser videos should work.
echo.
pause
exit /b 0
