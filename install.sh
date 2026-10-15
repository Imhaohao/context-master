#!/bin/sh
# Installs the latest Context Master release into /Applications (or ~/Applications)
# and opens it. Usage:
#   curl -fsSL https://github.com/Imhaohao/context-master/releases/latest/download/install.sh | sh
set -eu

APP_NAME="Context Master"
ZIP_URL="${CONTEXT_MASTER_ZIP_URL:-https://github.com/Imhaohao/context-master/releases/latest/download/Context-Master-arm64.zip}"

fail() { printf 'Context Master: %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS."
[ "$(uname -m)" = "arm64" ] || fail "the current build runs on Apple silicon Macs only."

if [ -n "${CONTEXT_MASTER_INSTALL_DIR:-}" ]; then target_dir=$CONTEXT_MASTER_INSTALL_DIR
elif [ -w /Applications ]; then target_dir=/Applications
else target_dir="$HOME/Applications"; fi
mkdir -p "$target_dir"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

printf 'Downloading %s...\n' "$APP_NAME"
curl -fL --progress-bar "$ZIP_URL" -o "$work_dir/app.zip" || fail "download failed from $ZIP_URL"
ditto -x -k "$work_dir/app.zip" "$work_dir/unpacked" || fail "could not unpack the download."
[ -d "$work_dir/unpacked/$APP_NAME.app" ] || fail "the download did not contain $APP_NAME.app."

if pgrep -xq "$APP_NAME"; then osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true; sleep 1; fi
rm -rf "$target_dir/$APP_NAME.app"
mv "$work_dir/unpacked/$APP_NAME.app" "$target_dir/"
xattr -dr com.apple.quarantine "$target_dir/$APP_NAME.app" 2>/dev/null || true

printf 'Installed %s in %s\n' "$APP_NAME" "$target_dir"
printf 'Next: choose Import sessions, then open Connections for the one-line command that lets Claude Code or Codex ask your specialists.\n'
open "$target_dir/$APP_NAME.app"
