"""Every tempo the assistant's tools take is the app's 20-300 BPM.

The frontend holds tempos to 20-300 BPM (``frontend/src/lib/tempoMap.ts``
``TEMPO_BPM_MIN`` / ``TEMPO_BPM_MAX``), and ``editorTools.setClipSourceBpm``
refuses anything outside that range. Up to afd27bea the tool schema offered
40-240, so a model could not declare a 24 BPM Grave or a 280 BPM Presto the
editor accepts.
"""

from __future__ import annotations

from typing import Any

from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS


def _tool(name: str) -> dict[str, Any]:
    for tool in PROVIDER_TOOLS:
        if tool["function"]["name"] == name:
            return tool["function"]
    raise AssertionError(f"no tool named {name}")


def test_source_bpm_takes_the_app_tempo_range() -> None:
    bpm = _tool("editor_set_clip_source_bpm")["parameters"]["properties"]["bpm"]
    assert (bpm["minimum"], bpm["maximum"]) == (20, 300)


def test_no_tool_schema_caps_a_bpm_at_40_or_240() -> None:
    def walk(node: Any, path: str) -> list[str]:
        found: list[str] = []
        if isinstance(node, dict):
            for key, value in node.items():
                if "bpm" in key.lower() and isinstance(value, dict):
                    if value.get("minimum") == 40 or value.get("maximum") == 240:
                        found.append(f"{path}.{key}")
                found += walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                found += walk(value, f"{path}[{i}]")
        return found

    assert walk(PROVIDER_TOOLS, "tools") == []
