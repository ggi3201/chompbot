#!/usr/bin/env python3
"""Signs Apple Shortcuts for Chomp. iOS only imports signed files, and only macOS can sign them,
while Chomp runs on Linux. Takes a plist over HTTP and returns the signed .shortcut file."""

import hmac
import plistlib
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST, PORT, TOKEN_FILE = sys.argv[1], int(sys.argv[2]), sys.argv[3]
EXPECTED = f"Bearer {Path(TOKEN_FILE).read_text().strip()}".encode()
MAX_BYTES = 1_000_000


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body, content_type="text/plain"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/sign":
            return self.respond(404, b"Not found")
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), EXPECTED):
            return self.respond(401, b"Bad token")
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BYTES:
            return self.respond(413, b"Too large")
        try:
            shortcut = plistlib.loads(self.rfile.read(length))
            if not isinstance(shortcut.get("WFWorkflowActions"), list):
                raise ValueError("no WFWorkflowActions")
        except Exception as err:
            return self.respond(400, f"Not a Shortcut plist: {err}".encode())

        with tempfile.TemporaryDirectory() as folder:
            unsigned, signed = Path(folder, "in.shortcut"), Path(folder, "out.shortcut")
            # The sign command refuses XML plists.
            unsigned.write_bytes(plistlib.dumps(shortcut, fmt=plistlib.FMT_BINARY))
            result = subprocess.run(
                ["/usr/bin/shortcuts", "sign", "--mode", "anyone", "--input", unsigned, "--output", signed],
                capture_output=True, timeout=60,
            )
            if result.returncode != 0:
                return self.respond(500, result.stderr or b"shortcuts sign failed")
            self.respond(200, signed.read_bytes(), "application/octet-stream")

    def log_message(self, format, *args):
        print(self.address_string(), format % args, flush=True)


ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
