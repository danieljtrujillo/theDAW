"""The assistant's snap and quantize grids are the editor's own divisions.

``tool_catalog._SNAP_DIVISIONS`` mirrors ``SNAP_DIVISIONS`` in
``frontend/src/state/editorStore.ts``; ``editorTools`` refuses any grid outside
that list, so a division the frontend gains (the quintuplet, the septuplet,
1/64, 1/32T) must reach the tool schema too, or the assistant is told the grid
does not exist.
"""

import re
from pathlib import Path

from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS

REPO = Path(__file__).resolve().parents[1]
EDITOR_STORE = REPO / "frontend" / "src" / "state" / "editorStore.ts"


def _frontend_divisions() -> list[str]:
    text = EDITOR_STORE.read_text(encoding="utf-8")
    block = re.search(
        r"export const SNAP_DIVISIONS: SnapDivision\[\] = \[(.*?)\];", text, re.S
    )
    assert block, "SNAP_DIVISIONS not found in editorStore.ts"
    return re.findall(r"'([^']+)'", block.group(1))


def _tool(name: str) -> dict:
    for tool in PROVIDER_TOOLS:
        fn = tool.get("function", tool)
        if fn.get("name") == name:
            return fn
    raise AssertionError(f"{name} is not in the provider tools")


def test_set_snap_enum_is_the_editor_list():
    snap = _tool("editor_set_snap")["parameters"]["properties"]["snap"]["enum"]
    assert snap == _frontend_divisions()


def test_quantize_grid_enum_is_the_editor_list_without_off():
    grid = _tool("editor_quantize_clip")["parameters"]["properties"]["grid"]["enum"]
    assert grid == [d for d in _frontend_divisions() if d != "off"]
    for division in ("1/64", "1/32T", "1/16Q", "1/16S"):
        assert division in grid
