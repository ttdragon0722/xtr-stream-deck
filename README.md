# XTR Stream Deck

Stream Deck companion for XTR Multiverse host operation. This package was imported from the former `xtr_btn` repo and now lives under `packages/services/ft/streamdeck` because it is a physical-control frontend for `ft/app` in host mode.

The Stream Deck plugin UUID is still `com.xtr.codexagent` for compatibility with existing Stream Deck profiles. The monorepo package name is `@xtr/ft-streamdeck`, and the visible plugin/category name is **XTR Stream Deck / XTR Multiverse**.

## Layout

```text
packages/services/ft/streamdeck/
├── package.json                         # pnpm workspace package
├── install.js                           # cross-platform install/link script
├── install.sh                           # macOS/Linux wrapper
├── install.ps1                          # Windows PowerShell wrapper
├── README.md
│
├── com.xtr.codexagent.sdPlugin/
│   ├── manifest.json                    # Stream Deck action manifest
│   ├── plugin.sh                        # macOS Stream Deck entrypoint
│   ├── plugin.bat                       # Windows Stream Deck entrypoint
│   ├── plugin.js                        # plugin runtime + Chrome bridge ws server
│   ├── scripts/
│   │   └── codex-agent.sh               # opens the XTR repo in Codex
│   └── imgs/                            # action icons
│
├── chrome-extension/
│   ├── manifest.json
│   ├── background.js                    # keeps ws://localhost:9999 connected
│   ├── content.js                       # performs DOM actions in active tab
│   ├── offscreen.html/js                # samples microphone level
│   └── mic-permission.html/js           # first-run mic permission page
│
└── preview/
    └── mic-wave-preview.html
```

## Actions

| Stream Deck action | Default behavior |
|---|---|
| 開啟 XTR 專案 | Opens the XTR repo or standalone package folder with `codex app <workspace>` |
| 系統資訊 | Shows CPU / memory usage on macOS and Windows |
| 開啟 Codex | Opens Codex on macOS or Windows |
| Codex 網頁送出 | Uses the Chrome bridge to click send/submit on Codex / ChatGPT / OpenAI pages |
| 自訂網頁點擊 | Uses `settings.selector` to click any CSS selector in the active Chrome tab |
| YouBike XTR | Replaces the active host ft input on `host.xtr-multiverse.xyz` or local host mode (`localhost:3502`) with `請把以下任務指派給 ubike xtr：\n` |
| 麥克風聲波 | Uses Chrome `getUserMedia()` and draws a live waveform on Stream Deck keys |

## Architecture

```text
Stream Deck key
  -> Stream Deck software --ws--> plugin.js
                              |
                              |-- opens Codex / XTR workspace
                              |-- setImage live waveform SVG
                              |
                              `-- ws://localhost:9999
                                      |
                                      v
                                Chrome extension background.js
                                      |-- chrome.tabs.sendMessage -> content.js
                                      `-- offscreen.html -> Web Audio mic level
```

Chrome is still required for browser-page control and microphone sampling. HTTPS pages cannot directly connect from a content script to `ws://localhost`, so `background.js` owns the local bridge connection and forwards commands to `content.js`.

## Install

From the monorepo root on macOS or Windows:

```bash
pnpm install
pnpm streamdeck:install
```

For a standalone shared folder:

```bash
# macOS
bash install.sh

# Windows PowerShell
.\install.ps1
```

Then install the Chrome extension:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select `packages/services/ft/streamdeck/chrome-extension/`.
5. Restart Stream Deck.

The first time you use 麥克風聲波, Chrome opens the XTR mic permission page. Grant access, then press the key again.

## Development

```bash
# Syntax-check plugin and extension JavaScript
pnpm --filter @xtr/ft-streamdeck check:js

# Restart the local Stream Deck plugin after changing plugin.js / manifest.json
pnpm streamdeck:restart

# Validate the Stream Deck manifest
pnpm streamdeck:validate

# Stream Deck logs on macOS
tail -f ~/Library/Logs/ElgatoStreamDeck/StreamDeck.log
```

On Windows, Stream Deck logs live under `%APPDATA%\Elgato\StreamDeck\logs\`.

After changing the Chrome extension, refresh it in `chrome://extensions` and reload the target tab so the new content script is injected.

## Host FT Presets

`chrome-extension/content.js` currently includes these presets:

| preset | Behavior |
|---|---|
| `codex-send` | Clicks send/submit on Codex / ChatGPT / OpenAI pages |
| `codex-continue` | Clicks Continue / Resume / Run / Approve / Allow style buttons |
| `host-ubike-xtr` | Replaces the active host ft input on `host.xtr-multiverse.xyz` or local host mode (`localhost:3502`) with the YouBike delegation prompt |
| `youtube-like` | Legacy example retained from the prototype |
| `youtube-subscribe` | Legacy example retained from the prototype |
| `click` | Generic click using the `selector` field |

The current 5x3 menu UI in `plugin.js` contains placeholders for `toshl`, `gmail`, `line_oa`, `tuya`, `user`, `youbike`, and `computer`. Only YouBike currently performs a host ft input action; the rest are intentionally staged for the next integration pass.

For custom host ft domains, set the action setting `allowedHosts` or `hosts` to a comma-separated host list.

## Bridge Protocol

`plugin.js -> background.js`:

```json
{ "id": "1736000000000", "action": "codex-send" }
```

Custom click:

```json
{ "id": "1736000000000", "action": "click", "selector": "button[data-testid='send-button']" }
```

Mic control:

```json
{ "id": "1736000000000", "type": "mic-control", "command": "start" }
```

`background.js -> plugin.js`:

```json
{ "id": "1736000000000", "result": "OK" }
```

Mic level:

```json
{ "type": "mic-level", "level": 0.42, "peak": 0.7, "ts": 1736000000000 }
```

Common results include `OK`, `NOT_FOUND`, `WRONG_PAGE`, `NO_SELECTOR`, `INVALID_SELECTOR`, `NO_ACTIVE_TAB`, `CONTENT_SCRIPT_ERROR`, `TEXT_REPLACED`, `NO_TEXTBOX`, `HOST_WRONG_PAGE`, `HOST_LOGIN_REQUIRED`, `MIC_STARTED`, `MIC_PERMISSION`, `MIC_ERROR`, and `MIC_UNSUPPORTED`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Key shows alert | `plugin.js` crashed | Check Stream Deck logs: `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log` on macOS, `%APPDATA%\Elgato\StreamDeck\logs\` on Windows |
| Shows `Chrome 未連線` | Chrome extension is not connected | Refresh extension in `chrome://extensions` |
| Shows `允許 Mic` | Extension does not have mic permission | Use the automatically opened permission page |
| Host action says `不是 XTR` | Active tab is not `host.xtr-multiverse.xyz` or local host ft (`localhost:3502`) | Switch to host ft and try again |
| Host action says `請先登入` | Cloudflare Access page is active | Finish login first |
| Port 9999 is occupied | Old plugin process is still alive | `lsof -nP -i :9999` then stop the stale process |
