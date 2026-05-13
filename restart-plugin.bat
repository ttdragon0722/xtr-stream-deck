@echo off
:: 快速重啟 XTR plugin（不重啟整個 Stream Deck app，~2 秒）
powershell -ExecutionPolicy Bypass -File "%~dp0restart-streamdeck.ps1" -Mode plugin
