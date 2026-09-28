"""The assistant's quantize tool offers the groove pass the frontend runs.

``editorTools.quantizeClip`` quantizes a roll clip through
``rollClip.quantizeRollClip`` and takes ``groove`` and ``groove_strength``
(``frontend/src/state/editorTools.ts``); the tool's schema has to name them,
or a model can never ask for a group swing in 7/8.
"""

from __future__ import annotations

from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS


def test_quantize_takes_a_groove_and_its_strength() -> None:
    tool = next(
        t["function"]
        for t in PROVIDER_TOOLS
        if t["function"]["name"] == "editor_quantize_clip"
    )
    props = tool["parameters"]["properties"]
    assert props["groove"]["type"] == "string"
    assert "group8" in props["groove"]["description"]
    assert (
        props["groove_strength"]["minimum"],
        props["groove_strength"]["maximum"],
    ) == (0, 1)
    assert tool["parameters"]["required"] == ["clip_id", "grid"]
