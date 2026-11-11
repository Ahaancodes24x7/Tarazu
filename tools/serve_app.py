"""Serve the offline mobile build (mobile/www) for the phone preview and for testing.

The engine runs inside the page (WebAssembly), so this is only a file server:
no Tarazu API is involved. Builds mobile/www first if it is missing.

Run: python tools/serve_app.py          then open http://127.0.0.1:8000/phone.html
     and pick "On the phone, offline"  (or open http://127.0.0.1:8100 directly)
"""
import functools
import http.server
import os
import socketserver
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WWW = ROOT / "mobile" / "www"
PORT = int(os.environ.get("APP_PORT", "8100"))
HOST = os.environ.get("HOST", "127.0.0.1")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm",
                      ".mjs": "text/javascript", ".js": "text/javascript", ".woff2": "font/woff2"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def main() -> None:
    if not (WWW / "py" / "manifest.json").exists():
        subprocess.run([sys.executable, str(ROOT / "tools" / "build_mobile.py")], check=True)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((HOST, PORT), functools.partial(Handler, directory=str(WWW))) as srv:
        print(f"Offline app build at http://{HOST}:{PORT}  (Ctrl+C to stop)")
        srv.serve_forever()


if __name__ == "__main__":
    main()
