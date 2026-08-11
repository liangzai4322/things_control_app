#!/usr/bin/env python3
"""Shared P1 contract for day/week/month feedback continuity payloads."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


def clean(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def stable_id(kind: str, anchor: str) -> str:
    digest = hashlib.sha256(clean(anchor).casefold().encode("utf-8")).hexdigest()[:20]
    return f"{kind}-{digest}"


def evidence_ref(ref_type: str, source_id: str, label: str = "", uri: str = "") -> dict | None:
    source_id = clean(source_id)
    if not source_id:
        return None
    return {
        "refId": f"{clean(ref_type) or 'reference'}:{source_id}",
        "type": clean(ref_type) or "reference",
        "sourceId": source_id,
        "label": clean(label) or source_id,
        "uri": clean(uri),
    }


def artifact_refs(markdown_path: Path | str, cycle_type: str, cycle_key: str, extra: list[dict] | None = None) -> list[dict]:
    refs = [
        evidence_ref(f"{cycle_type}_review", cycle_key, f"{cycle_type} review {cycle_key}"),
        evidence_ref("markdown", str(Path(markdown_path).resolve()), Path(markdown_path).name, str(Path(markdown_path).resolve())),
    ]
    refs.extend(extra or [])
    return list({item["refId"]: item for item in refs if item}.values())


def normalize_items(items, kind: str, cycle_type: str, cycle_key: str, refs: list[dict]) -> list[dict]:
    normalized = []
    id_field = {"deviation": "deviationId", "experiment": "experimentId", "rule": "ruleId"}[kind]
    for index, raw in enumerate(items or []):
        item = dict(raw or {})
        anchor = item.get(id_field) or item.get("continuityKey") or item.get("subjectRef") or item.get("hypothesis") or item.get("statement") or f"{cycle_key}:{index}"
        item[id_field] = clean(item.get(id_field)) or stable_id(kind, anchor)
        item["sourceCycle"] = clean(item.get("sourceCycle")) or cycle_type
        item["sourceRef"] = clean(item.get("sourceRef")) or cycle_key
        combined = [*(item.get("evidenceRefs") or []), *refs]
        item["evidenceRefs"] = list({ref.get("refId"): ref for ref in combined if isinstance(ref, dict) and ref.get("refId")}.values())
        if kind in {"experiment", "rule"}:
            item["status"] = "proposed"
            item.pop("approvedBy", None)
            item.pop("approvedAt", None)
        normalized.append(item)
    return normalized


def build_continuity(cycle_type: str, cycle_key: str, markdown_path: Path | str, source: dict | None = None, extra_refs: list[dict] | None = None) -> dict:
    source = source or {}
    explicit = source.get("feedbackContinuity") or {}
    refs = artifact_refs(markdown_path, cycle_type, cycle_key, extra_refs)
    return {
        "schemaVersion": 1,
        "continuityId": clean(explicit.get("continuityId")) or f"feedback:{cycle_type}:{cycle_key}",
        "cycleType": cycle_type,
        "cycleKey": cycle_key,
        "evidenceRefs": refs,
        "deviations": normalize_items(explicit.get("deviations"), "deviation", cycle_type, cycle_key, refs),
        "experiments": normalize_items(explicit.get("experiments"), "experiment", cycle_type, cycle_key, refs),
        "rules": normalize_items(explicit.get("rules"), "rule", cycle_type, cycle_key, refs),
    }


def read_jsonl(path: Path | str) -> list[dict]:
    """Read a V2 JSONL layer without changing the source dataset."""
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def build_v2_candidate_bundle(
    dataset_version: str,
    source_ref: Path | str,
    observations_claims: list[dict],
    semantic_clusters: list[dict],
    pattern_candidates: list[dict],
    calibration_proposals: list[dict],
) -> dict:
    """Build the read-only, independently removable V2 feedback namespace payload."""
    source_ref = str(Path(source_ref).resolve())
    import_id = f"feedback-v2:{clean(dataset_version) or 'v2'}:{stable_id('dataset', source_ref)}"
    safe_patterns = []
    for raw in pattern_candidates or []:
        item = dict(raw or {})
        item["status"] = "candidate_unvalidated"
        item["temporalInferenceAllowed"] = bool(item.get("temporalInferenceAllowed")) and bool(item.get("sequenceEligible"))
        safe_patterns.append(item)
    safe_calibrations = []
    for raw in calibration_proposals or []:
        item = dict(raw or {})
        item["status"] = "proposed"
        item["implementationAuthorized"] = False
        safe_calibrations.append(item)
    return {
        "schemaVersion": 1,
        "importId": import_id,
        "datasetVersion": clean(dataset_version) or "v2",
        "sourceRef": source_ref,
        "observationsClaims": list(observations_claims or []),
        "semanticClusters": list(semantic_clusters or []),
        "patternCandidates": safe_patterns,
        "calibrationProposals": safe_calibrations,
    }
