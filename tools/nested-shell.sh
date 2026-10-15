#!/bin/bash
# Runs a nested GNOME Shell (own D-Bus session, --unsafe-mode) with the
# installed extension, waits, saves a screenshot of its stage and exits.
# Usage: tools/nested-shell.sh [wait-seconds] [screenshot.png] [eval.js]
#   eval.js  optional JavaScript run inside the nested shell (org.gnome.Shell.Eval)
# Environment:
#   SPECS      dummy monitor size (default 1400x1000)
#   EVAL_WAIT  seconds between the eval and the screenshot (default 4)
#   RUN        a command started inside the nested session (WAYLAND_DISPLAY and
#              DBUS_SESSION_BUS_ADDRESS set), e.g. the preferences window:
#              RUN="gnome-extensions prefs <uuid>"; RUN_WAIT seconds after it
# Errors of the extension are printed from the shell's log.
set -u
WAIT=${1:-35}; SHOT=$(realpath -m "${2:-/tmp/nested-shell.png}"); EVAL=${3:-}
TMP=$(mktemp -d); LOG="$TMP/shell.log"
# The nested compositor gets a display name of its own; the session bus (and
# so every service it activates, e.g. the preferences dialog) sees that name,
# while gnome-shell itself still draws on the real display.
REAL_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
NESTED_DISPLAY=wayland-nested-$$
MUTTER_DEBUG_DUMMY_MODE_SPECS=${SPECS:-1400x1000} WAYLAND_DISPLAY=$NESTED_DISPLAY dbus-run-session -- sh -c \
    "echo \$DBUS_SESSION_BUS_ADDRESS > '$TMP/addr'; exec env WAYLAND_DISPLAY=$REAL_DISPLAY gnome-shell --nested --wayland --wayland-display=$NESTED_DISPLAY --unsafe-mode" > "$LOG" 2>&1 &
PID=$!
sleep "$WAIT"
export DBUS_SESSION_BUS_ADDRESS=$(cat "$TMP/addr")
eval_js() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1"
}
if [ -n "${RUN:-}" ]; then
    echo "--- running inside the nested session (WAYLAND_DISPLAY=$NESTED_DISPLAY): $RUN"
    WAYLAND_DISPLAY=$NESTED_DISPLAY GDK_BACKEND=wayland sh -c "$RUN" > "$TMP/run.log" 2>&1 &
    sleep "${RUN_WAIT:-8}"
    grep -i "error\|warning\|critical\|sysweather" "$TMP/run.log" | head -8
fi
if [ -n "$EVAL" ]; then
    eval_js "$(cat "$EVAL")"
    sleep "${EVAL_WAIT:-4}"
fi
eval_js "const Shell = imports.gi.Shell; const Gio = imports.gi.Gio; const s = new Shell.Screenshot();
const st = Gio.File.new_for_path('$SHOT').replace(null, false, 0, null);
s.screenshot(false, st, (o, r) => { s.screenshot_finish(r); st.close(null); }); 'ok'" > /dev/null
sleep 3
pkill -P $PID 2>/dev/null; kill $PID 2>/dev/null; sleep 1
echo "--- extension log:"
grep -i "sysweather\|JS ERROR\|JS WARNING\|TypeError\|ReferenceError\|prefs" "$LOG" | grep -v "Activating service" || echo "(no errors)"
echo "--- screenshot: $SHOT"
rm -rf "$TMP"
