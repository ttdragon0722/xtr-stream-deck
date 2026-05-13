@echo off
setlocal

set "DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Cannot find Node.js. Please install Node.js 20 LTS or newer: https://nodejs.org 1>&2
  exit /b 1
)

for /f "delims=" %%N in ('where node 2^>nul') do (
  set "NODE=%%N"
  goto :found_node
)

:found_node
"%NODE%" "%DIR%plugin.js" %*
exit /b %ERRORLEVEL%

