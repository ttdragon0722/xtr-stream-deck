@echo off
:: 完整重啟 Stream Deck app（kill + relaunch，~5 秒）
powershell -ExecutionPolicy Bypass -File "%~dp0restart-streamdeck.ps1" -Mode full
