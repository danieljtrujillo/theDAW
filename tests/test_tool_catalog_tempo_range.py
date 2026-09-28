"""Every tempo the assistant's tools take is the app's 20-300 BPM.

The frontend holds tempos to 20-300 BPM (``frontend/src/lib/tempoMap.ts``
``TEMPO_BPM_MIN`` / ``TEMPO_BPM_MAX``): ``editorTools.setClipSourceBpm``
refuses anything outside that range and ``editorStore.setBpm`` clamps to it.
Up to afd27bea the source-BPM and stretch schemas offered 40-240, so a model
could not declare a 24 BPM Grave or a 280 BPM Presto the editor accepts, and
``editor_set_bpm`` advertised 20-400 while a 350 was set as 300.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

from backend.assistant_routes import theDAW_SYSTEM_PROMPT
from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS


def _tool(name: str) -> dict[str, Any]:
    for tool in PROVIDER_TOOLS:
        if tool["function"]["name"] == name:
            return tool["function"]
    raise AssertionError(f"no tool named {name}")


def _bpm_parameters(node: Any, path: str) -> Iterator[tuple[str, dict[str, Any]]]:
    """Every schema property whose name holds "bpm", with its path."""
    if isinstance(node, dict):
        for key, value in node.items():
            if "bpm" in key.lower() and isinstance(value, dict) and "type" in value:
                yield f"{path}.{key}", value
            yield from _bpm_parameters(value, f"{path}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from _bpm_parameters(value, f"{path}[{i}]")


def test_source_bpm_takes_the_app_tempo_range() -> None:
    bpm = _tool("editor_set_clip_source_bpm")["parameters"]["properties"]["bpm"]
    assert (bpm["minimum"], bpm["maximum"]) == (20, 300)


def test_set_bpm_takes_the_app_tempo_range() -> None:
    bpm = _tool("editor_set_bpm")["parameters"]["properties"]["bpm"]
    assert (bpm["minimum"], bpm["maximum"]) == (20, 300)
    assert "20-300" in bpm["description"]


def test_every_bpm_parameter_takes_20_to_300_and_says_so() -> None:
    found = list(_bpm_parameters(PROVIDER_TOOLS, "tools"))
    names = {path.rsplit(".", 1)[-1] for path, _ in found}
    assert {"bpm", "target_bpm"} <= names, found
    for path, prop in found:
        assert (prop.get("minimum"), prop.get("maximum")) == (20, 300), path
        for lo, hi in re.findall(
            r"(\d+)\s*-\s*(\d+)", str(prop.get("description", ""))
        ):
            assert (int(lo), int(hi)) == (20, 300), f"{path} names {lo}-{hi}"


def test_the_prompt_names_the_same_tempo_range() -> None:
    lines = theDAW_SYSTEM_PROMPT.splitlines()
    line = next(ln for ln in lines if ln.startswith("- `editor_set_bpm`"))
    assert "20-300" in line, line
    for stale in ("20-400", "40-240", "40-220"):
        assert stale not in theDAW_SYSTEM_PROMPT, stale


def test_the_prompt_names_the_quantize_groove() -> None:
    lines = theDAW_SYSTEM_PROMPT.splitlines()
    line = next(ln for ln in lines if ln.startswith("- `editor_quantize_clip`"))
    props = _tool("editor_quantize_clip")["parameters"]["properties"]
    for arg in ("groove", "groove_strength"):
        assert arg in props, arg
        assert f'"{arg}?"' in line, arg
