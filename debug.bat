@echo off
setlocal
title XTR Stream Deck Debug

echo ========================================
echo   XTR Stream Deck - Debug / Restart
echo ========================================
echo.

:: --- 1. 結束佔用 port 9999 的 node 進程 ---
echo [1] 清除佔用 port 9999 的進程...
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":9999 " ^| findstr "LISTENING"') do (
  if not "%%P"=="0" (
    echo     終止 PID %%P
    taskkill /F /PID %%P >nul 2>&1
  )
)
echo     完成

:: --- 2. 重啟 Stream Deck app ---
echo [2] 重啟 Stream Deck...
taskkill /F /IM StreamDeck.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "C:\Program Files\Elgato\StreamDeck\StreamDeck.exe"
echo     完成
echo.
echo Stream Deck 已重新啟動，等待 plugin 載入...
echo 若需查看 plugin log：
echo   %APPDATA%\Elgato\StreamDeck\logs\StreamDeck.log
echo.
pause
