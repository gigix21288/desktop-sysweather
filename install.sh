#!/bin/bash
# Installs (or updates) the widget for the current user from the .zip package.
# Usage: ./install.sh [path/to/desktop-sysweather@piorio.github.io.shell-extension.zip]
set -euo pipefail

UUID="desktop-sysweather@piorio.github.io"
HERE="$(cd "$(dirname "$0")" && pwd)"

ZIP="${1:-}"
if [ -z "$ZIP" ]; then
    for candidate in "$HERE/$UUID.shell-extension.zip" "$HERE/dist/$UUID.shell-extension.zip"; do
        [ -f "$candidate" ] && ZIP="$candidate" && break
    done
fi
if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
    echo "Package not found. Usage: $0 path/to/$UUID.shell-extension.zip" >&2
    exit 1
fi

if ! command -v gnome-extensions >/dev/null; then
    echo "This widget requires GNOME Shell 45 or newer (gnome-extensions not found)." >&2
    exit 1
fi

gnome-extensions install --force "$ZIP"

# The running shell only notices new extensions after a new login on Wayland,
# so also enable it directly in the settings.
gnome-extensions enable "$UUID" 2>/dev/null || true
python3 - "$UUID" <<'PYTHON'
import ast, subprocess, sys
uuid = sys.argv[1]

def get(key):
    out = subprocess.run(['gsettings', 'get', 'org.gnome.shell', key],
                         capture_output=True, text=True, check=True).stdout.strip()
    return ast.literal_eval(out.removeprefix('@as '))

def put(key, value):
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', key, str(value)], check=True)

enabled = get('enabled-extensions')
if uuid not in enabled:
    put('enabled-extensions', enabled + [uuid])
disabled = get('disabled-extensions')
if uuid in disabled:
    put('disabled-extensions', [u for u in disabled if u != uuid])
PYTHON

echo
if gnome-extensions info "$UUID" 2>/dev/null | grep -qiE 'state: *(active|enabled)'; then
    echo "Installed and running."
else
    echo "Installed. Log out and back in to start the widget."
fi
echo "Settings: gnome-extensions prefs $UUID"
