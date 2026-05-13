#!/usr/bin/env bash
# Open the XTR Multiverse workspace in Codex Desktop from a Stream Deck action.

set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

find_workspace() {
    if [ -n "${XTR_CODEX_WORKSPACE:-}" ]; then
        printf "%s\n" "$XTR_CODEX_WORKSPACE"
        return 0
    fi

    if ROOT_DIR="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"; then
        printf "%s\n" "$ROOT_DIR"
        return 0
    fi

    # Repo layout fallback:
    # packages/services/ft/streamdeck/com.xtr.codexagent.sdPlugin/scripts
    local monorepo_root
    monorepo_root="$( cd "$DIR/../../../../../.." && pwd )"
    if [ -f "$monorepo_root/pnpm-workspace.yaml" ]; then
        printf "%s\n" "$monorepo_root"
        return 0
    fi

    # Standalone fallback for archived copies of the Stream Deck package.
    ( cd "$DIR/../.." && pwd )
}

WORKSPACE="$(find_workspace)"

find_codex() {
    if [ -n "${XTR_CODEX_BIN:-}" ] && [ -x "$XTR_CODEX_BIN" ]; then
        printf "%s\n" "$XTR_CODEX_BIN"
        return 0
    fi

    if command -v codex >/dev/null 2>&1; then
        command -v codex
        return 0
    fi

    if [ -x "/Applications/Codex.app/Contents/Resources/codex" ]; then
        printf "%s\n" "/Applications/Codex.app/Contents/Resources/codex"
        return 0
    fi

    return 1
}

if CODEX_BIN="$(find_codex)"; then
    nohup "$CODEX_BIN" app "$WORKSPACE" >/dev/null 2>&1 &
    echo "XTR Project"
    exit 0
fi

if open -Ra "Codex" >/dev/null 2>&1; then
    open -a "Codex"
    echo "Codex App"
    exit 0
fi

echo "Codex not found" >&2
exit 1
