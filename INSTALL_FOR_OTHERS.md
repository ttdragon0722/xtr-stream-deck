# XTR Stream Deck 分享包安裝說明

這個資料夾已包含：

- `com.xtr.codexagent.sdPlugin/`：Stream Deck 外掛本體
- `chrome-extension/`：Chrome bridge 外掛
- `install.sh`：macOS 安裝/連結腳本
- `install.ps1`：Windows PowerShell 安裝/連結腳本
- `install.js`：跨平台安裝器
- `package.json`：Node 依賴設定，安裝時會自動抓 `ws`

## 安裝需求

- macOS 或 Windows 10/11
- Node.js 20 或更新版
- Elgato Stream Deck app
- Chrome
- Codex app 或 Codex CLI（只有「開啟 XTR 專案」按鍵需要）

## 安裝 Stream Deck 外掛

macOS：

```bash
bash install.sh
```

Windows PowerShell：

```powershell
.\install.ps1
```

如果 PowerShell 擋下腳本，可在這個資料夾改跑：

```powershell
node .\install.js
```

安裝完成後，重新啟動 Stream Deck app。

## 安裝 Chrome 外掛

1. 打開 `chrome://extensions`
2. 開啟「開發人員模式」
3. 點「載入未封裝項目」
4. 選這個資料夾裡的 `chrome-extension/`
5. 重新整理要控制的網頁分頁

## 使用注意

- Chrome extension 需要保持啟用，Stream Deck 才能控制瀏覽器頁面。
- 麥克風聲波按鍵第一次使用時會開啟權限頁，允許後再按一次即可。
- Bridge 預設使用 `ws://localhost:9999`；如果按鍵顯示 Chrome 未連線，請重新整理 Chrome extension 並重啟 Stream Deck app。
- 「開啟 XTR 專案」會優先使用 `XTR_CODEX_WORKSPACE`；沒有設定時會打開這份分享包所在資料夾。

