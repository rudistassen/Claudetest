@echo off
rem Double-click to start BrewView on Windows. Sets it up the first time, asks for your Square token once,
rem then opens the app in your browser. Close this window to stop BrewView.
cd /d "%~dp0"
title BrewView

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules goto token
echo Setting up BrewView for the first time. This takes a minute or two...
echo.
call npm.cmd install --omit=dev --no-audit --no-fund
if errorlevel 1 goto failed

:token
if exist square-token.txt goto run
echo.
echo ============================================================
echo  Paste your Square Production access token, then press Enter.
echo  (Right-click in this window to paste.)
echo  Or just press Enter to start without Square for now.
echo ============================================================
set "TOKEN="
set /p "TOKEN=Token: "
if not defined TOKEN goto run
>square-token.txt echo %TOKEN%
echo Saved. To change it later, delete square-token.txt in this folder.

:run
set "SQUARE_ACCESS_TOKEN="
if exist square-token.txt set /p SQUARE_ACCESS_TOKEN=<square-token.txt
echo.
echo Starting BrewView. Your browser will open at http://localhost:3000
echo Keep this window open while you use BrewView. Close it to stop.
echo.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm.cmd start
echo.
echo BrewView has stopped.
pause
exit /b

:nonode
echo Node.js is not installed. Opening nodejs.org - download and install the LTS version,
echo then double-click this file again.
start https://nodejs.org
pause
exit /b

:failed
echo.
echo Setup failed. Check your internet connection and try again.
pause
exit /b
