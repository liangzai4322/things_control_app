import hashlib
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from worker import GatewayError, JsonClient, process_echo, verify_message  # noqa: E402


class ApiHandler(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, _format, *_args):
        return

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        self.__class__.calls.append((self.path, body, self.headers.get("authorization")))
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


class WorkerTests(unittest.TestCase):
    def setUp(self):
        ApiHandler.calls = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ApiHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory()
        self.token = Path(self.temp.name) / "token"
        self.token.write_text("secret\n", encoding="utf-8")
        self.client = JsonClient(f"http://127.0.0.1:{self.server.server_port}", self.token)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    @staticmethod
    def message(text="测试", **changes):
        message = {
            "inboundMessageId": "inbound-1",
            "senderIdentity": "bound-user",
            "conversationRef": "weixin:bound-user",
            "receivedAt": "2026-09-03T20:00:00+08:00",
            "bridgeRequestId": "bridge-1",
            "text": text,
            "originalMessageHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "authVerification": {"transport": "ilink_bearer_poll", "senderBound": True},
            "attemptCount": 1,
            "leaseToken": "lease-1",
        }
        message.update(changes)
        return message

    def test_echo_is_sent_before_processed_ack(self):
        process_echo(self.client, self.message())
        self.assertEqual([call[0] for call in ApiHandler.calls], [
            "/v1/weixin-inbound/inbound-1/reply",
            "/v1/weixin-inbound/inbound-1/ack",
        ])
        self.assertEqual(ApiHandler.calls[0][1]["replyKey"], "echo:inbound-1")
        self.assertEqual(ApiHandler.calls[0][1]["text"], "已收到，微信助手通路正常")
        self.assertEqual(ApiHandler.calls[1][1]["outcome"], "processed")
        self.assertEqual(ApiHandler.calls[0][2], "Bearer secret")

    def test_non_test_text_is_deferred_without_reply(self):
        process_echo(self.client, self.message("批准"))
        self.assertEqual(len(ApiHandler.calls), 1)
        self.assertEqual(ApiHandler.calls[0][1]["outcome"], "retry")
        self.assertEqual(ApiHandler.calls[0][1]["retryAfterSeconds"], 3600)

    def test_timestamped_test_prefix_is_echoed(self):
        process_echo(self.client, self.message("测试-20260903-2330"))
        self.assertEqual(ApiHandler.calls[0][0], "/v1/weixin-inbound/inbound-1/reply")

    def test_unverified_or_changed_text_dead_letters(self):
        process_echo(self.client, self.message(authVerification={"transport": "ilink_bearer_poll", "senderBound": False}))
        self.assertEqual(ApiHandler.calls[-1][1]["outcome"], "dead_letter")
        ApiHandler.calls = []
        process_echo(self.client, self.message(originalMessageHash="0" * 64))
        self.assertEqual(ApiHandler.calls[-1][1]["outcome"], "dead_letter")

    def test_verify_requires_complete_bound_message(self):
        with self.assertRaises(GatewayError):
            verify_message(self.message(conversationRef=""))


if __name__ == "__main__":
    unittest.main()
