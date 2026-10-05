"""
serve.py — a persistent static server for the built game.

Why this exists rather than `npm run dev`: the dev server is a child of whatever
shell started it and dies with it, so a link posted anywhere stops working as soon
as the terminal closes. This serves `dist/` on a FIXED port so a URL stays true,
and it is started detached (see game-web.ps1) so it survives the shell.

    python serve.py                 # 127.0.0.1:5180
    python serve.py --port 5180     # same, explicit
    python serve.py --host 0.0.0.0  # reachable from a phone on the same network

Build first: `npm run build`. Without dist/ this exits with a message, because a
server on an empty directory looks like a broken game rather than a missing build.
"""

import argparse
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
DEFAULT_PORT = 5180


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        """Quiet: the console is for the startup line, not for one line per asset."""

    def end_headers(self):
        # The built assets are hashed, so a stale cache is never a problem, but
        # index.html must not be cached or a rebuild is invisible until a hard
        # refresh. That is exactly the "the fix is not there" false alarm.
        if self.path.endswith(".html") or self.path == "/":
            self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()

    if not (DIST / "index.html").exists():
        sys.exit(f"dist/ is missing or empty at {DIST} — run `npm run build` first")

    handler = lambda *a, **k: Handler(*a, directory=str(DIST), **k)  # noqa: E731
    # allow_reuse_address: a restart right after a stop otherwise fails on a socket
    # still in TIME_WAIT, and the launcher would report "port busy" for a server
    # that is not there.
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((args.host, args.port), handler) as httpd:
        httpd.daemon_threads = True
        print(f"gioco su http://{args.host}:{args.port}/  (Ctrl+C per fermare)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
