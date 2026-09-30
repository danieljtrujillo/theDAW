"""Tests for render lineage record validation and normalisation.

Pure-logic module: no database, no FastAPI, no filesystem. Every case here
constructs a plain dict payload (as if freshly decoded from a POST body) and
checks what :func:`normalize_record` accepts or rejects.
"""

from __future__ import annotations

import math

import pytest

from backend.modules.lineage.records import (
    MAX_CONTRIBUTIONS,
    MAX_NAME_CHARS,
    LineageError,
    normalize_record,
)


def _valid_payload() -> dict:
    return {
        "render_id": "render-1",
        "project_id": "project-1",
        "project_name": "My Project",
        "created_at": "2026-01-01T00:00:00+00:00",
        "output": {
            "library_entry_id": "entry-1",
            "path": "render.wav",
            "kind": "full",
            "start_sec": 0.0,
            "end_sec": 10.0,
        },
        "contributions": [
            {
                "library_entry_id": "entry-2",
                "clip_id": "clip-1",
                "track_id": "track-1",
                "start_sec": 0.0,
                "end_sec": 4.0,
                "source_offset_sec": 0.0,
                "role": "audio",
            }
        ],
    }


def _contribution(index: int) -> dict:
    return {
        "library_entry_id": f"entry-{index}",
        "clip_id": f"clip-{index}",
        "track_id": f"track-{index}",
        "start_sec": 0.0,
        "end_sec": 1.0,
        "source_offset_sec": 0.0,
        "role": "audio",
    }


def test_normalize_record_returns_canonical_keys():
    result = normalize_record(_valid_payload())

    assert set(result) == {
        "render_id",
        "project_id",
        "project_name",
        "created_at",
        "output",
        "contributions",
    }
    assert set(result["output"]) == {
        "library_entry_id",
        "path",
        "kind",
        "start_sec",
        "end_sec",
    }
    assert set(result["contributions"][0]) == {
        "library_entry_id",
        "clip_id",
        "track_id",
        "start_sec",
        "end_sec",
        "source_offset_sec",
        "role",
    }


@pytest.mark.parametrize("separator", ["/", "\\"])
def test_render_id_with_path_separator_is_rejected(separator):
    payload = _valid_payload()
    payload["render_id"] = f"bad{separator}id"

    with pytest.raises(LineageError, match="render_id"):
        normalize_record(payload)


def test_render_id_dotdot_is_rejected():
    payload = _valid_payload()
    payload["render_id"] = ".."

    with pytest.raises(LineageError, match="render_id"):
        normalize_record(payload)


def test_created_at_z_suffix_normalises_to_utc_offset():
    payload = _valid_payload()
    payload["created_at"] = "2026-01-01T12:30:00Z"

    result = normalize_record(payload)

    assert result["created_at"] == "2026-01-01T12:30:00+00:00"


def test_naive_created_at_is_treated_as_utc():
    payload = _valid_payload()
    payload["created_at"] = "2026-01-01T12:30:00"

    result = normalize_record(payload)

    assert result["created_at"] == "2026-01-01T12:30:00+00:00"


@pytest.mark.parametrize("bad_value", [math.inf, math.nan])
def test_non_finite_times_are_rejected(bad_value):
    payload = _valid_payload()
    payload["contributions"][0]["start_sec"] = bad_value

    with pytest.raises(LineageError, match="finite"):
        normalize_record(payload)


def test_end_before_start_is_rejected_for_contribution_and_output():
    output_payload = _valid_payload()
    output_payload["output"]["start_sec"] = 10.0
    output_payload["output"]["end_sec"] = 1.0
    with pytest.raises(LineageError, match="output.end_sec"):
        normalize_record(output_payload)

    contribution_payload = _valid_payload()
    contribution_payload["contributions"][0]["start_sec"] = 10.0
    contribution_payload["contributions"][0]["end_sec"] = 1.0
    with pytest.raises(LineageError, match="end_sec must be >= start_sec"):
        normalize_record(contribution_payload)


def test_unknown_kind_and_unknown_role_are_rejected():
    kind_payload = _valid_payload()
    kind_payload["output"]["kind"] = "bogus"
    with pytest.raises(LineageError, match="output.kind"):
        normalize_record(kind_payload)

    role_payload = _valid_payload()
    role_payload["contributions"][0]["role"] = "bogus"
    with pytest.raises(LineageError, match="role"):
        normalize_record(role_payload)


def test_contribution_cap_is_enforced_at_20000_plus_one():
    payload = _valid_payload()
    payload["contributions"] = [_contribution(i) for i in range(MAX_CONTRIBUTIONS)]

    normalize_record(payload)  # exactly at the cap is fine

    payload["contributions"].append(_contribution(MAX_CONTRIBUTIONS))
    with pytest.raises(LineageError, match="at most 20000 contributions"):
        normalize_record(payload)


def test_oversize_project_name_is_rejected():
    payload = _valid_payload()
    payload["project_name"] = "x" * (MAX_NAME_CHARS + 1)

    with pytest.raises(LineageError, match="project_name"):
        normalize_record(payload)


def test_output_entry_id_may_be_null():
    payload = _valid_payload()
    payload["output"]["library_entry_id"] = None

    result = normalize_record(payload)

    assert result["output"]["library_entry_id"] is None
