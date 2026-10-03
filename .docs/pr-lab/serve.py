"""Static preview server for the lab: no caching, so edits show on reload."""
import http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass

os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 5801
http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCache).serve_forever()
