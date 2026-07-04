import argparse
import functools
import mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Serve TaskBox with correct ES module MIME types.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--dir", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()

    mimetypes.add_type("application/javascript; charset=utf-8", ".js")
    mimetypes.add_type("text/css; charset=utf-8", ".css")
    mimetypes.add_type("application/manifest+json; charset=utf-8", ".webmanifest")
    mimetypes.add_type("application/json; charset=utf-8", ".json")

    handler = functools.partial(SimpleHTTPRequestHandler, directory=args.dir)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {args.dir} at http://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
