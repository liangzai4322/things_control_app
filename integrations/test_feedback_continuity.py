#!/usr/bin/env python3
"""Feedback-only continuity and V2 candidate contract tests."""

import tempfile
import unittest
from pathlib import Path

from integrations.feedback_continuity import build_continuity, build_v2_candidate_bundle


class FeedbackContinuityTests(unittest.TestCase):
    def test_imported_experiment_and_rule_are_both_downgraded(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact = Path(folder) / "review.md"
            artifact.write_text("review", encoding="utf-8")
            payload = build_continuity("week", "2026-W33", artifact, {"feedbackContinuity": {
                "experiments": [{"experimentId": "exp-1", "hypothesis": "h", "status": "active", "approvedBy": "imported"}],
                "rules": [{"ruleId": "rule-1", "statement": "s", "status": "active", "approvedBy": "imported"}],
            }})
        self.assertEqual(payload["experiments"][0]["status"], "proposed")
        self.assertNotIn("approvedBy", payload["experiments"][0])
        self.assertEqual(payload["rules"][0]["status"], "proposed")
        self.assertNotIn("approvedBy", payload["rules"][0])

    def test_v2_bundle_is_read_only_and_preserves_layers(self):
        bundle = build_v2_candidate_bundle(
            "v2", ".",
            [{"claimId": "claim-1", "authority": "ai_summary", "epistemicState": "uncertain", "sourceRef": "/review#L1", "activity": {"dateMapping": "unknown"}}],
            [{"clusterId": "cluster-1", "templateLike": True, "occurrenceCount": 13}],
            [{"patternId": "pattern-1", "status": "active", "temporalInferenceAllowed": True}],
            [{"proposalId": "cal-1", "status": "active", "implementationAuthorized": True}],
        )
        self.assertEqual(bundle["patternCandidates"][0]["status"], "candidate_unvalidated")
        self.assertFalse(bundle["patternCandidates"][0]["temporalInferenceAllowed"])
        self.assertEqual(bundle["calibrationProposals"][0]["status"], "proposed")
        self.assertFalse(bundle["calibrationProposals"][0]["implementationAuthorized"])
        self.assertEqual(bundle["semanticClusters"][0]["clusterId"], "cluster-1")
        self.assertEqual(bundle["observationsClaims"][0]["authority"], "ai_summary")


if __name__ == "__main__":
    unittest.main()
