"""The composer and score tools in the assistant catalog.

composer_* drive the piano roll's COMPOSE backends and notation_* score import
and the music21 corpus. Each must be declared with the enums and limits the
composer router's Pydantic models take (read back here from router.py and
spec.py, so a change there fails this file), be allowed and tiered in the
browser (orb-kit/assistantEvents.ts, orb-kit/tool-tiers.ts), be served by
orb-kit/composerTools.ts, and be named in the chat prompt.
"""

import re
from pathlib import Path

from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS, thedaw_mcp_tools
from backend.modules.composer import router as composer_router
from backend.modules.composer import spec

REPO_ROOT = Path(__file__).resolve().parents[1]
ORB_KIT = REPO_ROOT / "frontend" / "src" / "orb-kit"

COMPOSER_TOOLS = {
    "composer_plan",
    "composer_check",
    "composer_form",
    "composer_species",
    "composer_canon",
    "composer_fugue",
    "composer_styles",
    "composer_profile",
    "notation_import",
    "notation_corpus_search",
    "notation_corpus_open",
}


def _schemas() -> dict:
    return {t["function"]["name"]: t["function"] for t in PROVIDER_TOOLS}


def _props(name: str) -> dict:
    return _schemas()[name]["parameters"]["properties"]


def _names_in(source: str) -> set[str]:
    return set(re.findall(r"'((?:composer|notation)_[a-z_]+)'", source))


def test_every_composer_and_score_tool_is_declared_once():
    names = [t["function"]["name"] for t in PROVIDER_TOOLS]
    declared = {n for n in names if n.startswith(("composer_", "notation_"))}
    assert declared == COMPOSER_TOOLS
    for n in COMPOSER_TOOLS:
        assert names.count(n) == 1, f"{n} is declared twice"
    assert COMPOSER_TOOLS <= {t["name"] for t in thedaw_mcp_tools()}


def test_the_browser_allows_tiers_and_serves_the_same_names():
    events = (ORB_KIT / "assistantEvents.ts").read_text(encoding="utf-8")
    allow = re.search(
        r"theDAW_ACTION_TYPES\s*=\s*new Set\(\[(.*?)\]\)", events, re.DOTALL
    )
    assert allow
    assert _names_in(allow.group(1)) == COMPOSER_TOOLS

    tiers = (ORB_KIT / "tool-tiers.ts").read_text(encoding="utf-8")
    tiered = dict(
        re.findall(r"^\s*((?:composer|notation)_\w+):\s*'(T[012]_\w+)'", tiers, re.M)
    )
    assert set(tiered) == COMPOSER_TOOLS
    assert "T2_confirm" not in tiered.values()
    for read_only in (
        "composer_check",
        "composer_styles",
        "composer_profile",
        "notation_corpus_search",
    ):
        assert tiered[read_only] == "T0_silent"

    served = (ORB_KIT / "composerTools.ts").read_text(encoding="utf-8")
    table = re.search(r"COMPOSER_TOOLS: Record<[^>]+> = \{(.*?)\n\};", served, re.S)
    assert table
    assert (
        set(re.findall(r"^\s*((?:composer|notation)_\w+):", table.group(1), re.M))
        == COMPOSER_TOOLS
    )


def test_the_enums_are_the_composer_router_s():
    plan = _props("composer_plan")
    assert plan["cadence"]["enum"] == list(spec.CADENCES)
    assert plan["include"]["items"]["enum"] == list(spec.FEATURES)
    assert plan["harmonic_rhythm"]["enum"] == list(spec.HARMONIC_RHYTHMS)
    assert plan["mode"]["enum"] == ["major", "minor"]

    form = _props("composer_form")
    assert form["form"]["enum"] == list(spec.FORMS)
    assert form["rondo"]["enum"] == list(spec.RONDO_PATTERNS)

    species = _props("composer_species")
    assert species["species"]["enum"] == list(spec.SPECIES)
    assert species["preset"]["enum"] == list(spec.CANTUS_FIRMI)
    assert species["invertible"]["enum"] == list(spec.INVERTIBLE_AT)
    assert species["mode"]["enum"] == list(spec.MODES)
    assert _props("composer_canon")["mode"]["enum"] == list(spec.MODES)

    fugue = _props("composer_fugue")
    assert fugue["voices"]["enum"] == sorted(spec.FUGUE_VOICES)
    assert fugue["episodes"]["enum"] == [0, 1, 2]


def test_the_limits_are_the_composer_router_s():
    plan = _props("composer_plan")
    assert plan["bars"]["minimum"] == 2
    assert plan["bars"]["maximum"] == composer_router.MAX_BARS

    form = _props("composer_form")
    assert form["bars"]["minimum"] == composer_router.MIN_FORM_BARS
    assert form["bars"]["maximum"] == composer_router.MAX_SYMPHONY_BARS
    assert str(composer_router.MAX_FORM_BARS) in form["bars"]["description"]
    assert form["variations"]["maximum"] == composer_router.MAX_VARIATIONS
    tempo = composer_router.FormRequest.model_fields["tempo"].metadata
    assert (form["tempo"]["minimum"], form["tempo"]["maximum"]) == (
        next(m.ge for m in tempo if hasattr(m, "ge")),
        next(m.le for m in tempo if hasattr(m, "le")),
    )

    canon = _props("composer_canon")
    assert canon["bars"]["maximum"] == composer_router.MAX_CANON_BARS
    assert canon["interval"]["minimum"] == -15
    assert canon["interval"]["maximum"] == 15
    # A lag of 1 to 16 quarters is PPQ to four bars of ticks.
    assert canon["lag_beats"]["minimum"] * spec.PPQ == spec.PPQ
    assert canon["lag_beats"]["maximum"] * spec.PPQ == 4 * composer_router.BAR_TICKS

    profile = _props("composer_profile")
    assert profile["corpus"]["maxItems"] == composer_router.MAX_PROFILE_WORKS
    assert profile["max_bars"]["minimum"] == 4
    assert profile["max_bars"]["maximum"] == 400
    assert profile["name"]["maxLength"] == 80
    id_pattern = composer_router.ProfileRequest.model_fields["id"].metadata
    assert any(
        getattr(m, "pattern", None) == profile["id"]["pattern"] for m in id_pattern
    )


def test_required_arguments_and_the_prompt():
    schemas = _schemas()
    assert schemas["composer_form"]["parameters"]["required"] == ["form"]
    assert schemas["notation_import"]["parameters"]["required"] == [
        "filename",
        "content",
    ]
    assert schemas["notation_corpus_search"]["parameters"]["required"] == ["query"]
    assert schemas["notation_corpus_open"]["parameters"]["required"] == ["id"]
    for name in ("composer_plan", "composer_check", "composer_styles"):
        assert "required" not in schemas[name]["parameters"], name

    prompt = (REPO_ROOT / "backend" / "assistant_routes.py").read_text(encoding="utf-8")
    for name in sorted(COMPOSER_TOOLS):
        assert f"`{name}`" in prompt, f"the assistant prompt never mentions {name}"
