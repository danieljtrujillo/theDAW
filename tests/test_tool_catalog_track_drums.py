"""The assistant can say what kind of instrument a track's program is.

``editor_set_track`` took ``instrument_program`` alone, so a General MIDI
program sent to a drum track was read as a drum kit number and the track
stayed on the drum channel (EDIT's own select flips the drum flag with the
choice: ``editorStore.setTrackVoice``). The tool now takes ``drums`` with the
program, the frontend handler passes it to ``setTrackVoice``, and the
assistant's ``editorState`` shows each track's ``drums`` flag
(``frontend/src/state/trackVoice.test.tsx`` replays the calls).
"""

from __future__ import annotations

from typing import Any

from backend.assistant_routes import theDAW_SYSTEM_PROMPT
from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS


def _tool(name: str) -> dict[str, Any]:
    for tool in PROVIDER_TOOLS:
        if tool["function"]["name"] == name:
            return tool["function"]
    raise AssertionError(f"no tool named {name}")


def test_set_track_takes_the_kind_of_its_program() -> None:
    props = _tool("editor_set_track")["parameters"]["properties"]
    assert props["drums"]["type"] == "boolean"
    assert "drum kit" in props["instrument_program"]["description"]
    assert "drums" in props["instrument_program"]["description"]


def test_the_prompt_names_drums_on_set_track_and_in_editor_state() -> None:
    lines = theDAW_SYSTEM_PROMPT.splitlines()
    line = next(ln for ln in lines if ln.startswith("- `editor_set_track`"))
    assert '"drums?": bool' in line, line
    assert "`drums` (true: a drum track" in theDAW_SYSTEM_PROMPT
