@echo off
title Kami Subs - Edge Guide
cd /d "%~dp0"

echo ==================================================
echo                 Kami Subs - Edge Guide
echo ==================================================
echo.
echo Follow these steps in Edge:
echo.
echo 1. Turn ON Developer mode
echo 2. Click Load unpacked
echo 3. Select this folder:
echo    %cd%\extension
echo 4. Pin the Kami Subs extension
echo 5. Open a video tab
echo 6. Click the extension
echo 7. Set:
echo      Source language = Japanese
echo      Target language = English
echo      Model = tiny or small
echo      Device = cpu
echo 8. Click Start
echo.
echo If nothing happens:
echo - Run run-backend.bat
echo - Go back to Edge
echo - Click Start again
echo.
start microsoft-edge:edge://extensions/
pause
exit /b 0
