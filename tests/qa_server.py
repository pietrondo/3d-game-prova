"""
qa_server.py — the static server both headless passes share.

Extracted from qa.py because qa-level.py needs the same three non-obvious
properties, and getting any of them wrong wedges a run rather than failing it:

  - ThreadingTCPServer. A single-threaded server wedges the whole pass on the
    second request, because the game holds the GPU context open and the page
    keeps a connection alive.
  - Port 0. A hardcoded port collides with a previous run's socket in TIME_WAIT.
  - Quiet logging. SimpleHTTPRequestHandler writes one line per request, which
    buries the checks in noise.
"""

import functools
import http.server
import socketserver
import threading
from pathlib import Path


def serve(directory: Path):
    """Start a quiet static server on an OS-chosen port. Returns the server."""
    directory = Path(directory)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    handler = functools.partial(Quiet, directory=str(directory))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd
