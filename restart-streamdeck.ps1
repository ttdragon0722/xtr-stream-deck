#Requires -Version 5.1
param(
    [ValidateSet("plugin","full")]
    [string]$Mode = "plugin",
    [switch]$Silent
)

$PLUGIN_ID   = "com.xtr.codexagent"
$PLUGIN_PORT = 9999
$SD_PROCESS  = "StreamDeck"

function Write-Step { param($n,$msg) Write-Host "  [$n] $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg)    Write-Host "      OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg)    Write-Host "      !   $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg)    Write-Host "      ERR $msg" -ForegroundColor Red }

function Find-StreamDeckExe {
    $pfx86 = [System.Environment]::GetFolderPath("ProgramFilesX86")
    $candidates = @(
        "C:\Program Files\Elgato\StreamDeck\StreamDeck.exe",
        "$env:ProgramFiles\Elgato\StreamDeck\StreamDeck.exe",
        "$env:LOCALAPPDATA\Programs\Elgato\StreamDeck\StreamDeck.exe",
        "$pfx86\Elgato\StreamDeck\StreamDeck.exe"
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Remove-PortProcess {
    param([int]$Port)
    $found = $false
    netstat -ano 2>$null | Select-String ":$Port\s.*LISTENING" | ForEach-Object {
        $parts = ($_.Line -split '\s+') | Where-Object { $_ -ne "" }
        $pid2 = $parts[-1]
        if ($pid2 -match '^\d+$' -and $pid2 -ne '0') {
            $found = $true
            try {
                Stop-Process -Id ([int]$pid2) -Force -ErrorAction Stop
                Write-Ok "PID $pid2 terminated"
            } catch {
                Write-Warn "Cannot stop PID $pid2"
            }
        }
    }
    return $found
}

Clear-Host
Write-Host ""
Write-Host "  +------------------------------------------+" -ForegroundColor DarkCyan
Write-Host "  |  XTR Stream Deck Restart Tool            |" -ForegroundColor DarkCyan
$modeStr = "  |  Mode : " + $Mode.PadRight(33) + "|"
Write-Host $modeStr -ForegroundColor DarkCyan
Write-Host "  +------------------------------------------+" -ForegroundColor DarkCyan
Write-Host ""

$ok = $false

if ($Mode -eq "plugin") {
    Write-Step 1 "Restarting plugin via streamdeck CLI..."
    $sdCliCmd = Get-Command "streamdeck" -ErrorAction SilentlyContinue
    $sdCli = $null
    if ($sdCliCmd -and $sdCliCmd.Source -and (Test-Path $sdCliCmd.Source)) {
        $sdCli = $sdCliCmd.Source
    } elseif (Test-Path "$env:APPDATA\npm\streamdeck.cmd") {
        $sdCli = "$env:APPDATA\npm\streamdeck.cmd"
    }

    if ($sdCli) {
        try {
            & $sdCli restart $PLUGIN_ID 2>&1 | Out-Null
            Write-Ok "Plugin restarted: $PLUGIN_ID"
            $ok = $true
        } catch {
            Write-Warn "CLI failed, fallback to port kill..."
        }
    } else {
        Write-Warn "streamdeck CLI not found, fallback to port kill..."
    }

    if (-not $ok) {
        Write-Step 2 "Killing port $PLUGIN_PORT process..."
        $killed = Remove-PortProcess -Port $PLUGIN_PORT
        if (-not $killed) { Write-Ok "Port $PLUGIN_PORT is free" }
        $ok = $true
    }
}

if ($Mode -eq "full") {
    Write-Step 1 "Killing port $PLUGIN_PORT process..."
    $killed = Remove-PortProcess -Port $PLUGIN_PORT
    if (-not $killed) { Write-Ok "Port $PLUGIN_PORT is free" }

    Write-Step 2 "Closing Stream Deck..."
    $procs = Get-Process -Name $SD_PROCESS -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force
        Write-Ok "Closed $($procs.Count) process(es)"
    } else {
        Write-Ok "Stream Deck was not running"
    }

    Write-Step 3 "Waiting for process to exit..."
    $w = 0
    while ((Get-Process -Name $SD_PROCESS -ErrorAction SilentlyContinue) -and $w -lt 20) {
        Start-Sleep -Milliseconds 300
        $w++
    }
    Write-Ok "Done"

    Write-Step 4 "Launching Stream Deck..."
    $exePath = Find-StreamDeckExe
    if ($exePath) {
        Start-Process $exePath
        Write-Ok "Started: $exePath"
        $ok = $true
    } else {
        Write-Fail "StreamDeck.exe not found, please start manually"
    }
}

Write-Host ""
if ($ok) {
    Write-Host "  [DONE] Restart complete!" -ForegroundColor Green
    if ($Mode -eq "full") {
        Write-Host "         Wait 5 sec for plugin to load." -ForegroundColor DarkGray
    }
} else {
    Write-Host "  [ERR]  Restart failed. See messages above." -ForegroundColor Red
}
Write-Host ""

if (-not $Silent) {
    Write-Host "  Press any key to close..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}