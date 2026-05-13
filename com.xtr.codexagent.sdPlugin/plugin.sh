#!/bin/bash
# Stream Deck 啟動腳本 - 自動搜尋 node 並執行 plugin.js
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 載入常見的環境設定（nvm / homebrew / system）
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin"

# 嘗試載入 nvm（多數使用者安裝方式）
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh" --no-use
fi

# 嘗試載入 fnm
if command -v fnm &>/dev/null; then
    eval "$(fnm env)"
fi

# 找到可用的 node
if command -v node &>/dev/null; then
    NODE="$(command -v node)"
else
    echo "找不到 node，請安裝 Node.js (https://nodejs.org)" >&2
    exit 1
fi

exec "$NODE" "$DIR/plugin.js" "$@"
