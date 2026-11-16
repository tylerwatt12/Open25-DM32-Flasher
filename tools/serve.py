#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Loopback-only preview; serves only this web app, never the repository backups."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parents[1]

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Permissions-Policy', 'serial=(self)')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)

    def do_GET(self):
        from urllib.parse import unquote, urlsplit
        parts = Path(unquote(urlsplit(self.path).path)).parts
        if any(p.startswith('.') for p in parts if p not in ('/', '.')) or any(p == '..' for p in parts):
            self.send_error(404)
            return
        super().do_GET()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8325)
    args = ap.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(APP)))
    print(f'Local: http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
