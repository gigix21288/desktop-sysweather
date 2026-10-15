#!/bin/sh
# Runs the unit tests of the pure modules with gjs (no GNOME Shell needed).
cd "$(dirname "$0")/.." || exit 1
status=0
for t in tests/*.test.js; do
    gjs -m "$t" || status=1
done
exit $status
