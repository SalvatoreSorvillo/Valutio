#!/usr/bin/env bash
# Serves Valutio locally and opens it in your browser.
# Keep this terminal open while using the app; press Ctrl+C to stop.
set -euo pipefail

PORT="${PORT:-8123}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="http://localhost:${PORT}/"

if [ ! -f "${ROOT}/index.html" ]; then
  echo "Error: cannot find the app at:" >&2
  echo "  ${ROOT}" >&2
  exit 1
fi

# Pick a Python interpreter (used for the no-store static server).
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "Error: python3 is required. Install it with: sudo apt install python3" >&2
  exit 1
fi

echo "Valutio serving on ${URL}  (press Ctrl+C to stop)"

# Open the browser once the server is up.
( sleep 1; xdg-open "${URL}" >/dev/null 2>&1 || true ) &

cd "${ROOT}"
# Serve with Cache-Control: no-store so the PWA/service worker always loads fresh files.
exec "${PY}" - "${PORT}" <<'PYEOF'
import sys, http.server, socketserver

port = int(sys.argv[1])

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the terminal quiet

class Server(socketserver.TCPServer):
    allow_reuse_address = True

with Server(("127.0.0.1", port), Handler) as httpd:
    httpd.serve_forever()
PYEOF
