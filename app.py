"""Loopback-only local PDF editor; no files, analytics or external requests."""
import argparse
import json
import secrets
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote

import engine
import pymupdf as pdf

ROOT = Path(__file__).parent
TOKEN = secrets.token_urlsafe(32)
SESSIONS = {}
LOCK = threading.RLock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Avoid logging private filenames / document IDs.

    def reply(self, data, content='application/json', status=200):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def handle_request(self, post=False):
        expected = f'127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host') != expected:
            return self.reply({'error': 'Host rejected'}, status=403)
        url = urlparse(self.path)
        if not post and url.path in ('/', '/app.js', '/style.css'):
            name = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}[url.path]
            data = (ROOT / 'static' / name).read_bytes().replace(b'__TOKEN__', TOKEN.encode())
            mime = {'/': 'text/html; charset=utf-8', '/app.js': 'text/javascript', '/style.css': 'text/css'}[url.path]
            return self.reply(data, mime)
        if self.headers.get('X-Local-Token') != TOKEN:
            return self.reply({'error': 'Refresh the local page and try again'}, status=403)
        if self.headers.get('Origin') not in (None, 'http://' + expected):
            return self.reply({'error': 'Origin rejected'}, status=403)
        try:
            with LOCK:
                now = time.monotonic()
                for sid in list(SESSIONS):
                    if now - SESSIONS[sid]['time'] > 7200:
                        del SESSIONS[sid]
                if post:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= engine.MAX_FILE:
                        raise ValueError('Request is empty or exceeds 50 MB')
                    body = self.rfile.read(length)
                    if url.path == '/api/open':
                        with engine.open_pdf(body) as doc:
                            info = engine.metadata(doc)
                            data = doc.tobytes(garbage=4, deflate=True)
                        if len(SESSIONS) >= 8:
                            del SESSIONS[min(SESSIONS, key=lambda x: SESSIONS[x]['time'])]
                        sid = secrets.token_urlsafe(24)
                        SESSIONS[sid] = {'data': data, 'time': now}
                        return self.reply(dict(info, id=sid))
                    payload = json.loads(body)
                    sid = payload.get('id')
                else:
                    sid = parse_qs(url.query).get('id', [''])[0]
                if sid not in SESSIONS:
                    return self.reply({'error': 'Document session expired. Open the file again.'}, status=404)
                session = SESSIONS[sid]
                session['time'] = now
                if post and url.path == '/api/close':
                    del SESSIONS[sid]
                    return self.reply({'ok': True})
                if post and url.path in ('/api/preview', '/api/export'):
                    with engine.apply_edits(session['data'], payload.get('edits', [])) as doc:
                        if url.path == '/api/export':
                            return self.reply(doc.tobytes(garbage=4, deflate=True), 'application/pdf')
                        n = payload.get('page', 0)
                        if type(n) is not int or not 0 <= n < len(doc):
                            raise ValueError('Invalid page number')
                        return self.reply(engine.png(doc[n]), 'image/png')
                if not post and url.path == '/api/page':
                    n = int(parse_qs(url.query).get('page', ['0'])[0])
                    with pdf.open(stream=session['data'], filetype='pdf') as doc:
                        if not 0 <= n < len(doc):
                            raise ValueError('Invalid page number')
                        return self.reply(engine.png(doc[n]), 'image/png')
                self.reply({'error': 'Endpoint not found'}, status=404)
        except (ValueError, TypeError, KeyError, RuntimeError, pdf.FileDataError) as exc:
            self.reply({'error': str(exc) or 'Cannot read PDF'}, status=400)
        except Exception:
            self.reply({'error': 'Processing failed. Check the PDF or restart the app.'}, status=500)

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request(True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'PDF Studio is running at {url}\nFiles are processed in local memory only. Close this terminal or press Ctrl+C to stop.', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        SESSIONS.clear()


if __name__ == '__main__':
    main()
