#!/usr/bin/env python3
"""Static server for the solver, with caching turned off.

`python3 -m http.server` lets the browser hold on to config.js / style.css, so
you edit a weight, refresh, and see the old behaviour -- which is a miserable
way to tune anything. This sends `Cache-Control: no-store` on everything.
"""

import functools
import http.server
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Only surface failures; the image flood isn't useful.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    handler = functools.partial(NoCacheHandler, directory=HERE)
    with http.server.ThreadingHTTPServer(("", PORT), handler) as httpd:
        print(f"→ http://localhost:{PORT}/web/   (no-cache; ctrl-c to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
