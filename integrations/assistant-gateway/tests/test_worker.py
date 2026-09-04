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

from worker import (  # noqa: E402
    DecisionStore,
    GatewayError,
    JsonClient,
    parse_decision,
    process_decision,
    process_echo,
    verify_message,
)


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


class FakeClient:
    def __init__(self, get_result=None, post_result=None, fail_route_once=None, failure=None):
        self.calls = []
        self.get_result = get_result or {"items": []}
        self.post_result = post_result or {"ok": True}
        self.fail_route_once = fail_route_once
        self.failure = failure or GatewayError("remote_unavailable")

    def get(self, route, headers=None):
        self.calls.append(("GET", route, None, dict(headers or {})))
        return self.get_result

    def post(self, route, payload, headers=None):
        self.calls.append(("POST", route, dict(payload), dict(headers or {})))
        if self.fail_route_once and self.fail_route_once in route:
            self.fail_route_once = None
            raise self.failure
        return self.post_result


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
        self.state_path = Path(self.temp.name) / "decision-state.json"

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

    @staticmethod
    def pending_proposal(**changes):
        proposal = {
            "proposalId": "proposal-1",
            "revision": 2,
            "proposalType": "daily_action_proposal",
            "title": "确认下一步",
            "allowedDecisions": ["approve", "reject", "defer", "expand"],
            "replyBinding": {
                "bindingRef": "binding-1",
                "verifiedSource": "notification_hub_weixin",
                "signatureRef": "signature-1",
                "expiresAt": "2026-09-04T20:00:00+08:00",
            },
        }
        proposal.update(changes)
        return proposal

    def decision_clients(self, proposals=None, decision="approve"):
        hub = FakeClient()
        reader = FakeClient(get_result={"items": proposals if proposals is not None else [self.pending_proposal()]})
        writer = FakeClient(post_result={
            "proposalId": "proposal-1",
            "decision": decision,
            "status": "applied",
            "taskboxMutation": False,
        })
        return hub, reader, writer

    def test_explicit_approve_uses_bound_read_and_idempotent_hq_reply(self):
        hub, reader, writer = self.decision_clients()
        store = DecisionStore(self.state_path)
        process_decision(hub, reader, writer, store, self.message("同意"))

        self.assertEqual(len(reader.calls), 1)
        self.assertIn("X-Assistant-Verified-User-Ref", reader.calls[0][3])
        self.assertEqual(len(writer.calls), 1)
        hq_call = writer.calls[0]
        self.assertEqual(hq_call[1], "/v1/hq/proposals/proposal-1/replies")
        self.assertEqual(hq_call[2]["verification"]["source"], "notification_hub_weixin")
        self.assertEqual(hq_call[2]["inboundMessageId"], "inbound-1")
        self.assertEqual(hq_call[2]["conversationRefHash"], hashlib.sha256(b"weixin:bound-user").hexdigest())
        self.assertEqual(hq_call[2]["expectedProposalRevision"], 2)
        self.assertEqual(hq_call[3]["If-Match"], '"proposal-revision-2"')
        self.assertTrue(hq_call[3]["X-Idempotency-Key"].startswith("assistant-gateway:decision:"))
        self.assertLessEqual(len(hq_call[3]["X-Idempotency-Key"]), 300)
        self.assertEqual([call[1] for call in hub.calls], [
            "/v1/weixin-inbound/inbound-1/reply",
            "/v1/weixin-inbound/inbound-1/ack",
        ])
        self.assertEqual(hub.calls[-1][2]["outcome"], "processed")
        self.assertIsNone(store.get("inbound-1"))

    def test_unknown_or_non_unique_pending_is_retried_without_hq_write(self):
        for text, proposals in [
            ("我觉得可以", [self.pending_proposal()]),
            ("同意", []),
            ("同意", [self.pending_proposal(), self.pending_proposal(proposalId="proposal-2")]),
        ]:
            hub, reader, writer = self.decision_clients(proposals)
            process_decision(hub, reader, writer, DecisionStore(self.state_path), self.message(text))
            self.assertEqual(writer.calls, [])
            self.assertEqual(hub.calls[-1][2]["outcome"], "retry")
            self.state_path.unlink(missing_ok=True)

    def test_defer_requires_a_valid_explicit_date(self):
        self.assertEqual(parse_decision("同意")[0], "approve")
        self.assertEqual(parse_decision("拒绝")[0], "reject")
        self.assertEqual(parse_decision("展开")[0], "expand")
        self.assertEqual(parse_decision("延期到2026-09-30"), ("defer", {"deferUntil": "2026-09-30"}))
        self.assertIsNone(parse_decision("延期"))
        self.assertIsNone(parse_decision("延期到2026-02-31"))

    def test_hq_conflict_dead_letters_without_reply_or_taskbox_fallback(self):
        hub, reader, writer = self.decision_clients()
        writer.fail_route_once = "/replies"
        writer.failure = GatewayError("remote_http_409", 409, {"error": "proposal_revision_conflict"})
        process_decision(hub, reader, writer, DecisionStore(self.state_path), self.message("拒绝"))
        self.assertEqual(hub.calls[-1][2]["outcome"], "dead_letter")
        self.assertFalse(any(call[1].endswith("/reply") for call in hub.calls))
        self.assertIsNone(DecisionStore(self.state_path).get("inbound-1"))

    def test_hub_reply_failure_resumes_without_new_read_or_changed_hq_key(self):
        hub, reader, writer = self.decision_clients()
        hub.fail_route_once = "/reply"
        store = DecisionStore(self.state_path)
        message = self.message("同意")
        process_decision(hub, reader, writer, store, message)
        saved = store.get("inbound-1")
        self.assertTrue(saved["hqApplied"])
        self.assertFalse(saved["replySent"])
        self.assertEqual(hub.calls[-1][2]["outcome"], "retry")

        reader.calls = []
        writer.calls = []
        process_decision(hub, reader, writer, store, {**message, "leaseToken": "lease-2", "attemptCount": 2})
        self.assertEqual(reader.calls, [])
        self.assertEqual(writer.calls, [])
        self.assertEqual(hub.calls[-1][2]["outcome"], "processed")
        self.assertIsNone(store.get("inbound-1"))


if __name__ == "__main__":
    unittest.main()
