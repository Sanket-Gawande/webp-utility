@echo off
setlocal EnableExtensions
title WebP Utility - Windows installer build
cd /d "%~dp0"

echo ===================================================
echo   WebP Utility - Windows installer build
echo ===================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install it from https://nodejs.org/ and run this again.
    goto :fail
)
for /f "delims=" %%V in ('node -v') do echo [1/4] Using Node.js %%V

echo [2/4] Installing dependencies...
call npm install
if errorlevel 1 goto :fail

echo [3/4] Building the installer...
call npm run build:win
if errorlevel 1 goto :fail

set "INSTALLER="
for /f "delims=" %%F in ('dir /b /o:d "dist\*Setup*.exe" 2^>nul') do set "INSTALLER=%%F"
if not defined INSTALLER (
    echo [ERROR] The build finished but no installer was found in the dist folder.
    goto :fail
)

echo [4/4] Copying %INSTALLER% to your Desktop...
set "DESKTOP="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"

copy /y "dist\%INSTALLER%" "%DESKTOP%\%INSTALLER%" >nul
if errorlevel 1 (
    echo [WARNING] Could not copy the installer to the Desktop. It is available at:
    echo           %CD%\dist\%INSTALLER%
) else (
    echo [SUCCESS] Installer copied to %DESKTOP%\%INSTALLER%
)

echo.
echo Done. Run the installer to install WebP Utility with Start Menu and Desktop shortcuts.
echo.
pause
exit /b 0

:fail
echo.
echo Build failed. Scroll up for details.
echo.
pause
exit /b 1
