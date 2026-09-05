import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from conversation_runner import SessionStore, run_codex, run_once  # noqa: E402
from crypto_payload import open_text, read_key, seal_text  # noqa: E402


class FakeApi:
    def __init__(self, claims):
        self.claims = list(claims)
        self.calls = []

    def post(self, route, body):
        self.calls.append((route, dict(body)))
        if route.endswith("/claim"):
            return {"item": self.claims.pop(0) if self.claims else None}
        return {"ok": True}


class ConversationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key = b"k" * 32

    def tearDown(self):
        self.temp.cleanup()

    def test_payload_round_trip_and_tamper_detection(self):
        payload = seal_text("你好，私密内容", self.key)
        self.assertNotIn("私密内容", payload)
        self.assertEqual(open_text(payload, self.key), "你好，私密内容")
        changed = payload[:-1] + ("A" if payload[-1] != "A" else "B")
        with self.assertRaisesRegex(ValueError, "conversation_payload_auth_failed"):
            open_text(changed, self.key)

    def test_key_file_requires_32_bytes(self):
        path = self.root / "key"
        path.write_bytes(b"short")
        with self.assertRaisesRegex(ValueError, "conversation_payload_key_too_short"):
            read_key(path)

    def test_first_turn_uses_fixed_exec_and_saves_structured_session(self):
        output = self.root / "reply.txt"

        def fake_run(command, **kwargs):
            self.assertEqual(command, [
                "/fixed/codex", "exec", "--skip-git-repo-check", "--json", "-o", str(output), "-",
            ])
            self.assertNotIn("shell", kwargs)
            self.assertEqual(kwargs["input"], "hello")
            output.write_text("semantic reply", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, '{"type":"thread.started","thread_id":"session-1"}\n', "")

        with patch("conversation_runner.subprocess.run", side_effect=fake_run):
            session, reply = run_codex("hello", None, output, "/fixed/codex")
        self.assertEqual((session, reply), ("session-1", "semantic reply"))

    def test_second_turn_resumes_same_session(self):
        output = self.root / "reply.txt"

        def fake_run(command, **kwargs):
            self.assertEqual(command, [
                "/fixed/codex", "exec", "resume", "--skip-git-repo-check", "-o", str(output), "session-1", "-",
            ])
            self.assertNotIn("shell", kwargs)
            output.write_text("continued reply", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch("conversation_runner.subprocess.run", side_effect=fake_run):
            session, reply = run_codex("continue", "session-1", output, "/fixed/codex")
        self.assertEqual((session, reply), ("session-1", "continued reply"))

    def test_run_once_commits_ciphertext_and_session_without_plaintext(self):
        prompt = "only-in-memory-secret"
        api = FakeApi([{
            "turnId": "turn-1", "leaseToken": "lease-1", "conversationKeyHash": "c" * 64,
            "promptPayload": seal_text(prompt, self.key),
        }])
        store_path = self.root / "sessions.json"
        sessions = SessionStore(store_path)
        with patch("conversation_runner.run_codex", return_value=("session-1", "natural answer")) as invoked:
            self.assertTrue(run_once(api, sessions, self.key))
        self.assertIn(prompt, invoked.call_args.args[0])
        result_call = next(call for call in api.calls if call[0].endswith("/result"))
        self.assertEqual(open_text(result_call[1]["resultPayload"], self.key), "natural answer")
        self.assertNotIn("natural answer", json.dumps(result_call[1]))
        saved = store_path.read_text(encoding="utf-8")
        self.assertNotIn(prompt, saved)
        self.assertNotIn("natural answer", saved)
        self.assertEqual(json.loads(saved)["sessions"]["c" * 64], "session-1")

    def test_execution_failure_is_reported_without_result(self):
        api = FakeApi([{
            "turnId": "turn-1", "leaseToken": "lease-1", "conversationKeyHash": "c" * 64,
            "promptPayload": seal_text("hello", self.key),
        }])
        with patch("conversation_runner.run_codex", side_effect=RuntimeError("sensitive failure details")):
            self.assertTrue(run_once(api, SessionStore(self.root / "sessions.json"), self.key))
        self.assertFalse(any(route.endswith("/result") for route, _ in api.calls))
        failure = next(body for route, body in api.calls if route.endswith("/fail"))
        self.assertNotIn("hello", failure["errorCode"])


if __name__ == "__main__":
    unittest.main()
