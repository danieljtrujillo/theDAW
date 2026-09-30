import re
from pathlib import Path

from backend.assistant_routes import _is_tool_compat_error, _should_send_tools
from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS, thedaw_mcp_tools


def test_gemini_openai_compat_tools_enabled_by_default(monkeypatch):
    send_tools, reason = _should_send_tools("gemini", "gemini-flash-recent")

    assert send_tools is True
    assert reason is None


def test_openrouter_tools_enabled_before_provider_retry():
    send_tools, reason = _should_send_tools(
        "openrouter-free", "google/gemma-3-1b-it:free"
    )

    assert send_tools is True
    assert reason is None


def test_local_openai_compat_tools_still_disabled_by_default():
    send_tools, reason = _should_send_tools("ollama", "llama3.1")

    assert send_tools is False
    assert reason == "ollama tool support is not guaranteed"


def test_tool_compat_errors_include_openrouter_and_gemini_messages():
    assert _is_tool_compat_error(
        404,
        'No endpoints found that support tool use. Try disabling "getElements".',
    )
    assert _is_tool_compat_error(
        400,
        "Function call is missing a thought_signature in functionCall parts.",
    )


def test_non_tool_errors_are_not_swallowed():
    assert (
        _is_tool_compat_error(404, "No endpoints found that support image input")
        is False
    )
    assert _is_tool_compat_error(500, "tool gateway exploded") is False


# ---------------------------------------------------------------------------
# Catalog completeness (T13)
#
# ``tool_catalog.PROVIDER_TOOLS`` feeds BOTH the OpenAI/Gemini function arrays
# and the ``thedaw`` MCP server, while ``assistantEvents.ts``'s allowlist is
# what the browser will actually execute. A name in one and not the other is a
# tool the model can call and nothing runs, or a capability the browser has and
# no model is ever told about — the exact gap T03 measured. These tests pin the
# two lists to each other by reading the TypeScript source directly, because
# there is no runtime that sees both.
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[1]
ORB_KIT = REPO_ROOT / "frontend" / "src" / "orb-kit"
ASSISTANT_EVENTS_TS = ORB_KIT / "assistantEvents.ts"
TOOL_TIERS_TS = ORB_KIT / "tool-tiers.ts"
ASSISTANT_ROUTES_PY = REPO_ROOT / "backend" / "assistant_routes.py"

#: Names the assistant asked for that have no capability behind them. T12's
#: ``UNSUPPORTED_OPERATIONS`` says why; declaring one would advertise a tool
#: whose only possible answer is "no".
NEVER_DECLARED = {
    "editor_tempo_map",
    "editor_set_metronome",
    "editor_group_tracks",
    "editor_render_arrangement",
    "editor_stretch_audio",
}


def _catalog_names() -> list[str]:
    return [tool["function"]["name"] for tool in PROVIDER_TOOLS]


def _browser_action_types() -> set[str]:
    """The allowlist literal out of ``assistantEvents.ts``."""
    source = ASSISTANT_EVENTS_TS.read_text(encoding="utf-8")
    match = re.search(
        r"theDAW_ACTION_TYPES\s*=\s*new Set\(\[(.*?)\]\)", source, re.DOTALL
    )
    assert match, "could not find the theDAW_ACTION_TYPES allowlist literal"
    return set(re.findall(r"'([A-Za-z0-9_]+)'", match.group(1)))


def _tool_tiers() -> dict[str, str]:
    source = TOOL_TIERS_TS.read_text(encoding="utf-8")
    match = re.search(
        r"TOOL_TIERS:\s*Record<string, ToolTier>\s*=\s*\{(.*?)\n\}", source, re.DOTALL
    )
    assert match, "could not find the TOOL_TIERS map"
    return dict(re.findall(r"^\s*(\w+):\s*'(T[012]_\w+)'", match.group(1), re.M))


def _daw_names(names) -> set[str]:
    return {n for n in names if n.startswith(("editor_", "dj_"))}


def test_every_catalog_editor_and_dj_tool_is_executable_in_the_browser():
    missing = sorted(_daw_names(_catalog_names()) - _browser_action_types())
    assert not missing, (
        "declared to the model but not in assistantEvents.ts's allowlist, so the "
        f"browser refuses to run them: {missing}"
    )


def test_every_browser_editor_and_dj_action_is_declared_in_the_catalog():
    missing = sorted(_daw_names(_browser_action_types()) - set(_catalog_names()))
    assert not missing, (
        f"the browser can run these but no provider is told they exist: {missing}"
    )


def test_catalog_has_no_duplicate_tool_names():
    names = _catalog_names()
    assert len(names) == len(set(names)), "a tool is declared twice"


def test_unsupported_operations_are_not_declared():
    declared = set(_catalog_names())
    assert not (declared & NEVER_DECLARED)


def test_the_essential_overdrive_tools_are_declared():
    declared = set(_catalog_names())
    essential = {
        "editor_quantize_clip",
        "editor_get_notes",
        "editor_set_notes",
        "editor_set_clip_source_bpm",
        "editor_stretch_clip",
        "editor_detect_tempo",
        "editor_play",
        "editor_stop",
        "editor_set_clip",
        "editor_trim_clip",
        "editor_select_clips",
        "editor_analyze_clip",
        "editor_compare_timing",
        "editor_undo",
        "editor_redo",
        "editor_snapshot",
        "editor_restore",
        "dj_get_state",
        "dj_load_set",
        "dj_automix",
        "dj_transition_now",
        "dj_set_next",
    }
    assert essential <= declared, sorted(essential - declared)


def test_every_declaration_carries_a_description_and_an_object_schema():
    for tool in PROVIDER_TOOLS:
        fn = tool["function"]
        assert tool["type"] == "function"
        assert fn["description"].strip(), f"{fn['name']} has no description"
        params = fn["parameters"]
        assert params["type"] == "object", f"{fn['name']} schema is not an object"
        assert isinstance(params.get("properties"), dict)
        for name in params.get("required", []):
            assert name in params["properties"], (
                f"{fn['name']} requires {name!r}, which it does not declare"
            )


def test_enumerated_arguments_are_declared_as_enums():
    schemas = {
        t["function"]["name"]: t["function"]["parameters"] for t in PROVIDER_TOOLS
    }
    assert "off" not in schemas["editor_quantize_clip"]["properties"]["grid"]["enum"], (
        "'off' is not a quantize grid"
    )
    assert "off" in schemas["editor_set_snap"]["properties"]["snap"]["enum"]
    assert schemas["editor_set_tool"]["properties"]["tool"]["enum"] == [
        "move",
        "cut",
        "split",
    ]
    assert schemas["editor_fix_overlaps"]["properties"]["mode"]["enum"] == [
        "legato",
        "trim",
        "dedupe",
    ]


def test_every_declared_tool_has_a_tier():
    tiers = _tool_tiers()
    untiered = sorted(n for n in _daw_names(_catalog_names()) if n not in tiers)
    assert not untiered, f"these would silently fall back to T2_confirm: {untiered}"


def test_destructive_tools_are_gated_at_t2():
    tiers = _tool_tiers()
    for name in (
        "editor_merge_clips",
        "editor_freeze_track",
        "editor_restore",
        "editor_remove_marker",
        "editor_reorder_tracks",
    ):
        assert tiers[name] == "T2_confirm", f"{name} must be confirmed"
    for name in (
        "editor_play",
        "editor_stop",
        "editor_get_notes",
        "editor_analyze_clip",
    ):
        assert tiers[name] == "T0_silent", f"{name} is read-only/transport"


def test_mcp_view_exposes_the_same_names():
    assert [t["name"] for t in thedaw_mcp_tools()] == _catalog_names()


def test_the_dj_action_block_carve_out_is_gone_from_the_prompt():
    prompt = ASSISTANT_ROUTES_PY.read_text(encoding="utf-8")
    assert "TEMPORARY EXCEPTION" not in prompt, (
        "the dj_* tools are in the MCP catalog now; the carve-out telling Claude "
        "to drive them with <action> blocks must go with it"
    )


def test_the_prompt_documents_the_alignment_recipe():
    prompt = ASSISTANT_ROUTES_PY.read_text(encoding="utf-8")
    for step in (
        "editor_detect_tempo",
        "editor_set_clip_source_bpm",
        "editor_compare_timing",
        "editor_nudge_notes",
        "editor_quantize_clip",
    ):
        assert step in prompt, f"{step} is not documented for non-Claude providers"


def _schema(name: str) -> dict:
    return next(t["function"] for t in PROVIDER_TOOLS if t["function"]["name"] == name)


def test_fix_overlaps_does_not_advertise_a_default_for_a_required_mode():
    fn = _schema("editor_fix_overlaps")
    assert fn["parameters"]["required"] == ["clip_id", "mode"]
    mode = fn["parameters"]["properties"]["mode"]["description"]
    assert "default" not in mode.lower(), (
        "mode is required; a documented default invites the model to omit it"
    )


def test_rename_marker_says_which_argument_is_the_new_label():
    fn = _schema("editor_rename_marker")
    assert fn["parameters"]["required"] == ["marker_id", "name"]
    props = fn["parameters"]["properties"]
    assert "Required" in props["marker_id"]["description"]
    assert "current label" in props["marker_id"]["description"]
    assert "Required" in props["name"]["description"]
    assert "NEW label" in props["name"]["description"]
    assert "NEW label" in fn["description"]
