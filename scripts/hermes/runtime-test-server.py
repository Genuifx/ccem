#!/usr/bin/env python3
"""Local development fixture server, never used by production CCEM.

Serves only manifest.json, its signature, and versioned .zip artifacts from a generated build.
Supports ETag/Range and controlled faults for installer behavior tests. Binds literal loopback.
"""
import argparse
import hashlib
import http.server
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=57890)
    parser.add_argument("--fault-file", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *values):
            pass

        def do_GET(self):
            fault = {}
            if args.fault_file and args.fault_file.exists():
                fault = json.loads(args.fault_file.read_text())
            url = urlsplit(self.path)
            relative = url.path.lstrip("/")
            if url.query or not re.fullmatch(r"(?:manifest\.json(?:\.sig)?|[0-9]+(?:\.[0-9]+){1,3}/hermes-macos-aarch64\.zip)", relative):
                self.send_error(404)
                return
            path = root / relative
            if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
                self.send_error(404)
                return
            is_zip = path.suffix == ".zip"
            if fault.get("offline"):
                self.send_error(503)
                return
            size = path.stat().st_size
            etag = '"' + str(size) + '-' + str(path.stat().st_mtime_ns) + str(fault.get("etagSuffix", "")) + '"'
            start = 0
            requested = self.headers.get("Range")
            if is_zip and requested and self.headers.get("If-Range") == etag:
                match = re.fullmatch(r"bytes=(\d+)-", requested)
                if not match or int(match[1]) >= size:
                    self.send_error(416)
                    return
                start = int(match[1])
            self.send_response(206 if start else 200)
            self.send_header("ETag", etag)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size - start))
            if start:
                self.send_header("Content-Range", f"bytes {start}-{size-1}/{size}")
            self.end_headers()
            sent = 0
            try:
                with path.open("rb") as handle:
                    handle.seek(start)
                    while data := handle.read(64 * 1024):
                        if fault.get("badSignature") and relative.endswith(".sig"):
                            lines = data.splitlines(keepends=True)
                            lines[1] = (b"A" if lines[1][:1] != b"A" else b"B") + lines[1][1:]
                            data = b"".join(lines)
                        if fault.get("badArchive") and is_zip and sent == 0:
                            data = bytes([data[0] ^ 1]) + data[1:]
                        if is_zip and fault.get("truncateAfterBytes") and sent >= fault["truncateAfterBytes"]:
                            self.close_connection = True
                            break
                        self.wfile.write(data)
                        self.wfile.flush()
                        sent += len(data)
                        if is_zip and fault.get("chunkDelayMs"):
                            time.sleep(fault["chunkDelayMs"] / 1000)
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                if args.receipt:
                    with args.receipt.open("a") as handle:
                        handle.write(json.dumps({"path": relative, "rangeStart": start, "sentBytes": sent,
                            "fault": fault, "time": time.time()}) + "\n")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_address[1]}", "pid": __import__("os").getpid()}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
