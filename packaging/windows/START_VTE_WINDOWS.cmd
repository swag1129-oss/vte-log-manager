@echo off
setlocal EnableExtensions
title VTE Log Manager

set "VTE_APP_FILE=%~dp0app\VTE_Log_Manager.html"
if not exist "%VTE_APP_FILE%" (
  echo [ERROR] app\VTE_Log_Manager.html was not found.
  echo Extract the complete ZIP file and try again.
  pause
  exit /b 1
)

set "VTE_APP_URL=file:///%VTE_APP_FILE:\=/%"

call :try_browser "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not errorlevel 1 exit /b 0
call :try_browser "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not errorlevel 1 exit /b 0
call :try_browser "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not errorlevel 1 exit /b 0
call :try_browser "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not errorlevel 1 exit /b 0
call :try_browser "%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not errorlevel 1 exit /b 0

where msedge.exe >nul 2>nul
if not errorlevel 1 (
  start "" msedge.exe --app="%VTE_APP_URL%"
  exit /b 0
)
where chrome.exe >nul 2>nul
if not errorlevel 1 (
  start "" chrome.exe --app="%VTE_APP_URL%"
  exit /b 0
)

echo [ERROR] Microsoft Edge or Google Chrome was not found.
echo Install or update one of those browsers, then try again.
pause
exit /b 1

:try_browser
if not exist "%~1" exit /b 1
start "" "%~1" --app="%VTE_APP_URL%"
exit /b 0
