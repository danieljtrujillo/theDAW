"""The roll-part tools in the assistant catalog and prompt.

The assistant writes a score part by part with editor_create_midi_clip,
editor_get_roll_part, editor_set_roll_part, editor_list_roll_parts and
editor_get_meter_map. Each must be declared with the arguments the browser's
tools read (frontend/src/state/editorTools.ts), and the chat prompt must name
each one.
"""


def _schemas():
    from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS

    return {t["function"]["name"]: t["function"] for t in PROVIDER_TOOLS}


def test_the_roll_part_tools_are_declared_with_their_arguments():
    schemas = _schemas()
    create = schemas["editor_create_midi_clip"]["parameters"]
    assert {
        "program",
        "percussion",
        "track_id",
        "track_name",
        "start_bar",
        "start_sec",
        "bars",
        "label",
    } <= set(create["properties"])
    assert create["properties"]["program"]["maximum"] == 127
    assert create["properties"]["bars"]["maximum"] == 4096
    assert "required" not in create, "program defaults to the track's instrument"
    assert schemas["editor_list_roll_parts"]["parameters"]["properties"] == {}
    get = schemas["editor_get_roll_part"]["parameters"]
    assert get["required"] == ["clip_id"]
    assert {"from_bar", "to_bar"} <= set(get["properties"])
    set_part = schemas["editor_set_roll_part"]["parameters"]
    assert set_part["required"] == ["clip_id"]
    assert {
        "notes",
        "lanes",
        "meter_map",
        "pickup_steps",
        "bars",
        "total_steps",
        "program",
    } <= set(set_part["properties"])
    note = set_part["properties"]["notes"]["items"]
    assert note["required"] == ["note", "step", "length", "velocity"]
    assert "lane" in note["properties"]
    lane = set_part["properties"]["lanes"]["items"]
    assert lane["required"] == ["id"]
    assert {"cycle_steps", "span_start", "span_end", "meter_map", "tuplet"} <= set(
        lane["properties"]
    )
    meters = set_part["properties"]["meter_map"]["items"]
    assert meters["required"] == ["bar"]
    assert meters["properties"]["den"]["enum"] == [1, 2, 4, 8, 16, 32]
    read = schemas["editor_get_meter_map"]["parameters"]
    assert set(read["properties"]) == {"from_bar", "to_bar"}
    assert "required" not in read


def test_the_prompt_names_every_roll_part_tool():
    from pathlib import Path

    routes = (
        Path(__file__).resolve().parents[1] / "backend" / "assistant_routes.py"
    ).read_text(encoding="utf-8")
    for name in (
        "editor_create_midi_clip",
        "editor_list_roll_parts",
        "editor_get_roll_part",
        "editor_set_roll_part",
        "editor_get_meter_map",
    ):
        assert f"`{name}`" in routes, f"the assistant prompt never mentions {name}"
