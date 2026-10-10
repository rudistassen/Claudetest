@echo off
rem Double-click to update Atlas to the latest version from GitHub.
rem Your data (the data folder) and your Square token are kept; the database is backed up first.
cd /d "%~dp0"
title Update Atlas

netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Atlas is still running. Close the black Atlas window first, then double-click this file again.
  pause
  exit /b
)

if exist data\cafe.db (
  echo Backing up your data to data\cafe-backup.db ...
  copy /y data\cafe.db data\cafe-backup.db >nul
)

echo Downloading the latest version...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $zip = Join-Path $env:TEMP 'cafeops-update.zip'; $dir = Join-Path $env:TEMP 'cafeops-update'; Invoke-WebRequest -UseBasicParsing 'https://github.com/rudistassen/claudetest/archive/refs/heads/claude/gallant-noether-ea6a4y.zip' -OutFile $zip; if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }; Expand-Archive $zip $dir; $src = (Get-ChildItem $dir -Directory | Select-Object -First 1).FullName; robocopy $src (Get-Location).Path /E /XD data node_modules /XF square-token.txt update-windows.bat /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { throw 'Copying the new files failed' }; Remove-Item $zip, $dir -Recurse -Force; exit 0"
if errorlevel 1 goto failed

echo Installing updates...
call npm.cmd install --omit=dev --no-audit --no-fund
if errorlevel 1 goto failed

echo.
echo Atlas is up to date. Double-click start-windows to start it, then refresh your browser.
pause
exit /b

:failed
echo.
echo The update did not finish. Check your internet connection and try again.
echo Your data has not been changed.
pause
exit /b
