"""The assistant's MIDI stage 4 tools in the catalog: each is declared with the
arguments the browser handler takes (frontend/src/orb-kit/actionHandlers.ts
EDITOR_TOOLS), allowed and tiered in the browser, and named in the chat
prompt for the providers that read it.
"""

import re
from pathlib import Path

from backend.modules.assistant.tool_catalog import PROVIDER_TOOLS, thedaw_mcp_tools

REPO_ROOT = Path(__file__).resolve().parents[1]
ORB_KIT = REPO_ROOT / "frontend" / "src" / "orb-kit"
PROMPT = REPO_ROOT / "backend" / "assistant_routes.py"

#: name -> (tier, the payload keys the browser handler passes on)
STAGE4_TOOLS = {
    "editor_add_symphony_template": ("T1_inform", {"seating"}),
}


def _schema(name: str) -> dict:
    return next(t["function"] for t in PROVIDER_TOOLS if t["function"]["name"] == name)


def _handler_keys(name: str) -> set[str]:
    source = (ORB_KIT / "actionHandlers.ts").read_text(encoding="utf-8")
    m = re.search(
        rf"^\s*{name}: \(p\) =>\s*facade\.\w+\(pick\(p, \[(.*?)\]\)\)",
        source,
        re.M | re.S,
    )
    assert m, f"{name} has no handler in EDITOR_TOOLS"
    keys = set(re.findall(r"'(\w+)'", m.group(1)))
    if "...TRACK" in m.group(1):
        keys |= {"track_id", "track"}
    return keys


def test_each_tool_is_declared_once_with_the_handler_keys():
    names = [t["function"]["name"] for t in PROVIDER_TOOLS]
    for name, (_tier, keys) in STAGE4_TOOLS.items():
        assert names.count(name) == 1, f"{name} is declared {names.count(name)} times"
        props = set(_schema(name)["parameters"]["properties"])
        assert props <= _handler_keys(name), (
            f"{name} declares {props - _handler_keys(name)} the handler drops"
        )
        assert keys <= props, f"{name} does not declare {keys - props}"
    assert set(STAGE4_TOOLS) <= {t["name"] for t in thedaw_mcp_tools()}


def test_each_tool_is_allowed_and_tiered_in_the_browser():
    events = (ORB_KIT / "assistantEvents.ts").read_text(encoding="utf-8")
    allow = re.search(r"theDAW_ACTION_TYPES\s*=\s*new Set\(\[(.*?)\]\)", events, re.S)
    assert allow
    tiers = (ORB_KIT / "tool-tiers.ts").read_text(encoding="utf-8")
    for name, (tier, _keys) in STAGE4_TOOLS.items():
        assert f"'{name}'" in allow.group(1), f"{name} is not on the allowlist"
        assert re.search(rf"^\s*{name}:\s*'{tier}'", tiers, re.M), (
            f"{name} is not tiered {tier}"
        )
        assert f"case '{name}':" in tiers, f"{name} has no receipt text"


def test_each_tool_is_named_in_the_prompt():
    prompt = PROMPT.read_text(encoding="utf-8")
    for name in STAGE4_TOOLS:
        assert f"`{name}`" in prompt, f"{name} is not in the chat prompt"


def test_the_symphony_seating_is_the_templates_two():
    seating = _schema("editor_add_symphony_template")["parameters"]["properties"][
        "seating"
    ]
    assert seating["enum"] == ["american", "european"]
    template = (
        REPO_ROOT / "frontend" / "src" / "lib" / "symphonyTemplate.ts"
    ).read_text(encoding="utf-8")
    assert "export type Seating = 'american' | 'european';" in template
