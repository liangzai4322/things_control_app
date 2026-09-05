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
    GatewayStatus,
    GatewayError,
    JsonClient,
    STATUS_FIELDS,
    parse_decision,
    process_automation_queue,
    process_decision,
    process_echo,
    claim,
    verify_message,
)
from crypto_payload import open_text, seal_text  # noqa: E402


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
        return self.post_result(route, payload) if callable(self.post_result) else self.post_result


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
        self.status_path = Path(self.temp.name) / "status.json"

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

    def test_claim_uses_bounded_nonblocking_poll(self):
        with self.assertRaises(GatewayError):
            claim(self.client)
        self.assertEqual(ApiHandler.calls[0][1]["waitSeconds"], 0)

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

    def test_status_aggregation_is_atomic_and_sanitized(self):
        self.status_path.write_text(json.dumps({"messageText": "secret", "retryCount": "bad"}), encoding="utf-8")
        status = GatewayStatus(self.status_path)
        store = DecisionStore(self.state_path)
        store.put("pending", {"promotionPending": True, "taskId": "private-task"})
        status.record_claim(1)
        status.record_automation_count(2)
        status.record_reply()
        status.record_outcome("retry")
        status.record_outcome("dead_letter")
        status.sync_promotion_pending(store)

        saved = json.loads(self.status_path.read_text(encoding="utf-8"))
        self.assertEqual(tuple(saved), STATUS_FIELDS)
        self.assertEqual(saved["pendingCount"], 1)
        self.assertEqual(saved["automationCount"], 2)
        self.assertEqual(saved["promotionPendingCount"], 1)
        self.assertEqual(saved["retryCount"], 1)
        self.assertEqual(saved["deadLetterCount"], 1)
        self.assertRegex(saved["lastClaimAt"], r"Z$")
        self.assertRegex(saved["lastReplyAt"], r"Z$")
        self.assertNotIn("messageText", saved)

    def test_echo_updates_status_without_persisting_message_content(self):
        status = GatewayStatus(self.status_path)
        process_echo(self.client, self.message("测试-私密原文"), status)
        saved_text = self.status_path.read_text(encoding="utf-8")
        self.assertNotIn("私密原文", saved_text)
        self.assertIsNotNone(json.loads(saved_text)["lastReplyAt"])

    @staticmethod
    def pending_proposal(**changes):
        proposal = {
            "proposalId": "proposal-1",
            "revision": 2,
            "proposalType": "daily_action_proposal",
            "evidenceStatus": "confirmed",
            "disposition": "confirmation_required",
            "promotionEligible": True,
            "taskSpec": {
                "boxId": "box-1", "content": "完成明确行动", "clearAction": "完成明确行动",
                "boxReason": "直接推动目标", "deviceContext": "universal", "executionMode": "self",
            },
            "title": "确认下一步",
            "allowedDecisions": ["approve", "reject", "defer", "expand"],
            "replyBinding": {
                "bindingRef": "binding-1",
                "verifiedSource": "notification_hub_weixin",
                "signatureRef": "signature-1",
                "sessionRef": "session-1",
                "expiresAt": "2026-09-04T20:00:00+08:00",
            },
        }
        proposal.update(changes)
        return proposal

    def decision_clients(self, proposals=None, decision="approve"):
        hub = FakeClient()
        reader = FakeClient(get_result={"items": proposals if proposals is not None else [self.pending_proposal()]})
        def writer_result(route, _payload):
            if route.endswith("/promote"):
                return {"proposalId": "proposal-1", "status": "promoted", "taskId": "task-1", "taskboxMutation": True}
            return {
                "replyId": "reply-1", "proposalId": "proposal-1", "decision": decision,
                "status": "applied", "taskboxMutation": False,
                "proposal": {"decisionId": "proposal-1", "status": "approved" if decision == "approve" else decision},
            }
        writer = FakeClient(post_result=writer_result)
        return hub, reader, writer

    def test_explicit_approve_uses_bound_read_and_idempotent_hq_reply(self):
        hub, reader, writer = self.decision_clients()
        store = DecisionStore(self.state_path)
        process_decision(hub, reader, writer, store, self.message("同意"))

        self.assertEqual(len(reader.calls), 1)
        self.assertIn("X-Assistant-Verified-User-Ref", reader.calls[0][3])
        self.assertEqual(len(writer.calls), 2)
        hq_call = writer.calls[0]
        self.assertEqual(hq_call[1], "/v1/hq/proposals/proposal-1/replies")
        self.assertEqual(hq_call[2]["verification"]["source"], "notification_hub_weixin")
        self.assertEqual(hq_call[2]["inboundMessageId"], "inbound-1")
        self.assertEqual(hq_call[2]["conversationRefHash"], hashlib.sha256(b"weixin:bound-user").hexdigest())
        self.assertEqual(hq_call[2]["expectedProposalRevision"], 2)
        self.assertEqual(hq_call[3]["If-Match"], '"proposal-revision-2"')
        self.assertTrue(hq_call[3]["X-Idempotency-Key"].startswith("assistant-gateway:decision:"))
        self.assertLessEqual(len(hq_call[3]["X-Idempotency-Key"]), 300)
        promote_call = writer.calls[1]
        self.assertEqual(promote_call[1], "/v1/hq/proposals/proposal-1/promote")
        self.assertEqual(promote_call[2]["approvalReplyId"], "reply-1")
        self.assertEqual(promote_call[2]["sessionRef"], "session-1")
        self.assertTrue(promote_call[3]["X-Idempotency-Key"].startswith("assistant-gateway:promotion:"))
        self.assertEqual([call[1] for call in hub.calls], [
            "/v1/weixin-inbound/inbound-1/reply",
            "/v1/weixin-inbound/inbound-1/ack",
        ])
        self.assertEqual(hub.calls[-1][2]["outcome"], "processed")
        self.assertIsNone(store.get("inbound-1"))

    def test_auto_eligible_queue_approves_then_promotes_with_recovery(self):
        proposal = {
            **self.pending_proposal(),
            "disposition": "auto_eligible",
            "sourceAuthority": "ai_derived",
            "standingRuleId": "execution.daily_action_proposal.auto_approve",
            "standingRuleVersion": 2,
        }
        reader = FakeClient(get_result={"items": [proposal]})
        writer = FakeClient(post_result=lambda route, _payload: (
            {"decisionId": "proposal-1", "status": "approved"} if route.endswith("/approve")
            else {"proposalId": "proposal-1", "status": "promoted", "taskId": "task-1", "taskboxMutation": True}
        ))
        store = DecisionStore(self.state_path)
        process_automation_queue(reader, writer, store)
        self.assertEqual([call[1].rsplit('/', 1)[-1] for call in writer.calls], ["approve", "promote"])
        self.assertEqual(writer.calls[0][2]["standingRuleId"], "execution.daily_action_proposal.auto_approve")
        self.assertEqual(writer.calls[1][2]["authorizationSource"], "standing_rule")
        self.assertIsNone(store.get("automation:proposal-1:2"))

    def test_manual_promotion_pending_resumes_without_second_approval(self):
        hub, reader, writer = self.decision_clients()
        writer.fail_route_once = "/promote"
        store = DecisionStore(self.state_path)
        message = self.message("同意")
        process_decision(hub, reader, writer, store, message)
        saved = store.get("inbound-1")
        self.assertTrue(saved["hqApplied"])
        self.assertTrue(saved["promotionPending"])
        self.assertFalse(saved["promotionApplied"])

        reader.calls = []
        writer.calls = []
        process_decision(hub, reader, writer, store, {**message, "leaseToken": "lease-2", "attemptCount": 2})
        self.assertEqual(reader.calls, [])
        self.assertEqual(len(writer.calls), 1)
        self.assertTrue(writer.calls[0][1].endswith("/promote"))
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

    def test_ordinary_chat_uses_conversation_path_without_hq_or_taskbox_write(self):
        key = b"k" * 32
        hub = FakeClient()
        reader = FakeClient()
        writer = FakeClient()

        def conversation_result(route, payload):
            if route.endswith("/turns"):
                self.assertEqual(open_text(payload["promptPayload"], key), "你好，今天有什么重要事项？")
                return {
                    "turnId": "turn-1", "status": "result_ready",
                    "resultPayload": seal_text("今天先处理唯一主行动。", key),
                }
            return {"turnId": "turn-1", "status": "replied"}

        conversation = FakeClient(post_result=conversation_result)
        process_decision(
            hub, reader, writer, DecisionStore(self.state_path),
            self.message("你好，今天有什么重要事项？"),
            conversation=conversation, payload_key=key,
        )
        self.assertEqual(reader.calls, [])
        self.assertEqual(writer.calls, [])
        self.assertEqual([call[1] for call in hub.calls], [
            "/v1/weixin-inbound/inbound-1/reply",
            "/v1/weixin-inbound/inbound-1/ack",
        ])
        self.assertEqual(hub.calls[0][2]["text"], "今天先处理唯一主行动。")
        self.assertTrue(hub.calls[0][2]["replyKey"].startswith("conversation:"))
        self.assertEqual(hub.calls[1][2]["outcome"], "processed")
        self.assertTrue(any(call[1].endswith("/replied") for call in conversation.calls))
        self.assertTrue(any(call[1].endswith("/completed") for call in conversation.calls))

    def test_replied_chat_recovery_only_acknowledges_and_completes(self):
        key = b"k" * 32
        hub = FakeClient()

        def conversation_result(route, _payload):
            if route.endswith("/turns"):
                return {
                    "turnId": "turn-1", "status": "replied",
                    "resultPayload": seal_text("already sent", key),
                }
            return {"turnId": "turn-1", "status": "completed"}

        conversation = FakeClient(post_result=conversation_result)
        process_decision(
            hub, FakeClient(), FakeClient(), DecisionStore(self.state_path), self.message("继续"),
            conversation=conversation, payload_key=key,
        )
        self.assertEqual([call[1] for call in hub.calls], ["/v1/weixin-inbound/inbound-1/ack"])
        self.assertEqual(hub.calls[0][2]["outcome"], "processed")
        self.assertTrue(any(call[1].endswith("/completed") for call in conversation.calls))

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
