@echo off
setlocal EnableExtensions
title Install VTE Log Manager

set "VTE_SOURCE_DIR=%~dp0"
set "VTE_INSTALL_DIR=%LocalAppData%\VTE Log Manager"
set "VTE_DATA_DIR=%UserProfile%\Documents\VTE Log Data"

if not exist "%VTE_SOURCE_DIR%app\VTE_Log_Manager.html" (
  echo [ERROR] The installation files are incomplete.
  echo Extract the complete ZIP file and try again.
  pause
  exit /b 1
)

echo Installing VTE Log Manager...
if not exist "%VTE_INSTALL_DIR%" mkdir "%VTE_INSTALL_DIR%"
xcopy "%VTE_SOURCE_DIR%app" "%VTE_INSTALL_DIR%\app" /E /I /Y /Q >nul
copy /Y "%VTE_SOURCE_DIR%START_VTE_WINDOWS.cmd" "%VTE_INSTALL_DIR%\START_VTE_WINDOWS.cmd" >nul
copy /Y "%VTE_SOURCE_DIR%README_FIRST.txt" "%VTE_INSTALL_DIR%\README_FIRST.txt" >nul

if not exist "%VTE_DATA_DIR%\Process_General" mkdir "%VTE_DATA_DIR%\Process_General"
if not exist "%VTE_DATA_DIR%\Process_Tooling" mkdir "%VTE_DATA_DIR%\Process_Tooling"
if not exist "%VTE_DATA_DIR%\Calibration" mkdir "%VTE_DATA_DIR%\Calibration"
if not exist "%VTE_DATA_DIR%\Structures" mkdir "%VTE_DATA_DIR%\Structures"
if not exist "%VTE_DATA_DIR%\Presets" mkdir "%VTE_DATA_DIR%\Presets"

powershell.exe -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'VTE Log Manager.lnk')); $s.TargetPath=[IO.Path]::Combine($env:VTE_INSTALL_DIR,'START_VTE_WINDOWS.cmd'); $s.WorkingDirectory=$env:VTE_INSTALL_DIR; $s.Description='VTE Log Manager'; $s.Save()"
if errorlevel 1 (
  echo [WARNING] The app was installed, but the desktop shortcut could not be created.
  echo Run this file directly: %VTE_INSTALL_DIR%\START_VTE_WINDOWS.cmd
)

echo.
echo Installation complete.
echo App:  %VTE_INSTALL_DIR%
echo Data: %VTE_DATA_DIR%
echo.
echo When the app opens, click the folder button and select:
echo %VTE_DATA_DIR%
echo.
start "" "%VTE_INSTALL_DIR%\START_VTE_WINDOWS.cmd"
explorer.exe "%VTE_DATA_DIR%"
pause
