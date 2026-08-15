#!/bin/sh
# Serve the solver locally. Data files live one level above web/, so the
# server root is the project root. Caching is disabled so that editing
# config.js and refreshing actually shows the change.
cd "$(dirname "$0")"
exec python3 scripts/serve.py "${1:-8777}"
