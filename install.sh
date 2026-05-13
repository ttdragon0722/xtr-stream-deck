#!/usr/bin/env bash
# XTR Multiverse Stream Deck companion installer.
# Usage: bash install.sh

set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if ! command -v node >/dev/null 2>&1; then
    echo "Cannot find Node.js. Please install Node.js 20 LTS or newer: https://nodejs.org" >&2
    exit 1
fi

exec node "$DIR/install.js"
