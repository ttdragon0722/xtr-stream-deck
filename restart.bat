@echo off
echo Restarting Stream Deck...

taskkill /F /IM "StreamDeck.exe" >nul 2>&1

timeout /t 2 /nobreak >nul

start "" "C:\Program Files\Elgato\StreamDeck\StreamDeck.exe"

echo Stream Deck restarted.
