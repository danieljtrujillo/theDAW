"""
Ask mode asks before a call the loaded allow rules match, unless the user
marked that rule "always allow".

The Claude Code CLI approves a call an allow rule matches before it asks the
host, so in theDAW's Ask mode every rule in ~/.claude/settings.json (with "Use
my Claude settings" on) and in this project's .claude/settings*.json ran its
commands without a prompt: Ask only asked about what no rule covered. The child
now gets an ask rule mirroring each loaded allow rule (the CLI checks ask rules
first), except the rules the user marked "always allow" in the assistant panel
(settings ``assistant.always_allow_rules``).

Replays a real conversation: user and project rules on disk, a first turn in
Ask, the user marking one rule "always allow" through PATCH /api/settings, a
rule added to the user's settings file between turns, a switch to Trusted and
back, and the panel's GET /api/assistant/allow-rules. The engine runs against
tests/fixtures/fake_claude_cli.py; only the argv that picks the binary is
monkeypatched.
"""

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import assistant_routes as ar
from backend.modules.assistant import claude_session as cs
from backend.modules.settings import router as settings_router
from backend.modules.settings.store import SettingsStore

FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_claude_cli.py"

USER_RULES = ["Bash(git status:*)", "Bash(npm run test:*)", "Read", "mcp__foo__bar"]
PROJECT_RULES = ["Bash(uv run pytest:*)", "Bash(git status:*)"]


def _write_rules(path: Path, rules: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"permissions": {"allow": rules}}), encoding="utf-8")


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """A user config folder and a checkout, each with allow rules, and a
    settings store of the test's own."""
    config = tmp_path / "claude-config"
    checkout = tmp_path / "checkout"
    _write_rules(config / "settings.json", USER_RULES)
    _write_rules(checkout / ".claude" / "settings.json", PROJECT_RULES)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    monkeypatch.setattr(cs, "REPO_ROOT", checkout)
    store = SettingsStore(tmp_path / "settings.json")
    monkeypatch.setattr(settings_router, "_store", store)
    monkeypatch.setenv("FAKE_CLI_MODE", "basic")
    monkeypatch.delenv("FAKE_CLI_LOG", raising=False)
    arg_sets: list[list[str]] = []

    def fake_argv(base_args):
        arg_sets.append(list(base_args))
        return [sys.executable, "-u", str(FAKE_CLI)]

    monkeypatch.setattr(cs, "build_spawn_argv", fake_argv)
    return {"config": config, "checkout": checkout, "store": store, "args": arg_sets}


def _ask_rules(args: list[str]) -> list[str]:
    path = Path(args[args.index("--settings") + 1])
    return json.loads(path.read_text(encoding="utf-8"))["permissions"]["ask"]


def _self_surface() -> list[str]:
    root = cs._cli_absolute_rule_path(cs.REPO_ROOT)
    return [f"Edit({root}/{glob})" for glob in cs.permissions.SELF_SURFACE_GLOBS]


async def _turn(conversation_id: str, mode: str, use_user_config: bool = True):
    lines = []
    async for line in cs.stream_turn(
        conversation_id,
        prompt_ndjson_line=cs.build_user_ndjson_line("hi"),
        model="claude-test",
        effort="high",
        permission_mode=mode,
        port=0,
        use_user_config=use_user_config,
        always_allow=ar._claude_always_allow_rules(),
    ):
        lines.append(line)
    return lines


def _run(body) -> None:
    async def wrapper():
        try:
            await asyncio.wait_for(body(), 60)
        finally:
            await cs.kill_all()

    asyncio.run(wrapper())


def _local_settings_client() -> TestClient:
    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api/settings")
    return TestClient(app, client=("127.0.0.1", 51000))


def test_ask_mode_asks_for_matched_rules_until_marked_always_allow(machine):
    args = machine["args"]
    settings = _local_settings_client()

    async def body():
        # 1. Ask with the user's setup: every loaded rule is mirrored as an ask
        #    rule, once each, except theDAW's own read-only tools.
        await _turn("conv", "ask")
        assert len(args) == 1
        ask = _ask_rules(args[0])
        assert ask[: len(_self_surface())] == _self_surface()
        mirrored = ask[len(_self_surface()) :]
        assert mirrored == [
            "Bash(git status:*)",
            "Bash(npm run test:*)",
            "mcp__foo__bar",
            "Bash(uv run pytest:*)",
        ]
        assert "Read" not in ask

        # 2. The user marks one rule "always allow" in the panel. The next turn
        #    respawns the child without that ask rule, so the CLI's allow rule
        #    runs it unasked again.
        saved = settings.patch(
            "/api/settings",
            json={"assistant": {"always_allow_rules": ["Bash(git status:*)"]}},
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["assistant"]["always_allow_rules"] == ["Bash(git status:*)"]
        await _turn("conv", "ask")
        assert len(args) == 2, "a changed rule set respawns the child"
        assert "Bash(git status:*)" not in _ask_rules(args[1])
        assert "Bash(npm run test:*)" in _ask_rules(args[1])

        # 3. Nothing changed: the warm child keeps going.
        await _turn("conv", "ask")
        assert len(args) == 2

        # 4. A rule added to the user's settings file between turns is asked
        #    about from the next turn on.
        _write_rules(machine["config"] / "settings.json", [*USER_RULES, "Bash(rm:*)"])
        await _turn("conv", "ask")
        assert len(args) == 3
        assert "Bash(rm:*)" in _ask_rules(args[2])

        # 5. Trusted mirrors nothing (the CLI's own allow rules apply there),
        #    and Ask again mirrors them again.
        await _turn("conv", "trusted")
        assert _ask_rules(args[3]) == _self_surface()
        await _turn("conv", "ask")
        assert "Bash(rm:*)" in _ask_rules(args[4])
        assert "Bash(git status:*)" not in _ask_rules(args[4])

    _run(body)


def test_the_isolated_setup_mirrors_only_the_project_rules(machine):
    args = machine["args"]

    async def body():
        await _turn("conv-iso", "ask", use_user_config=False)
        mirrored = _ask_rules(args[0])[len(_self_surface()) :]
        assert mirrored == ["Bash(uv run pytest:*)", "Bash(git status:*)"]

    _run(body)


def test_the_panel_lists_the_rules_and_a_lan_caller_is_refused(machine):
    machine["store"].patch(
        {"assistant": {"always_allow_rules": ["Bash(git status:*)"]}}
    )
    app = FastAPI()
    app.include_router(ar.router)
    local = TestClient(app, client=("127.0.0.1", 51000))
    body = local.get("/api/assistant/allow-rules").json()
    assert body["use_user_config"] is True
    rules = {r["rule"]: r for r in body["rules"]}
    assert list(rules) == [*USER_RULES, "Bash(uv run pytest:*)"]
    assert rules["Bash(git status:*)"]["always_allow"] is True
    assert rules["Bash(git status:*)"]["source"] == "user"
    assert rules["Bash(uv run pytest:*)"]["source"] == "project"
    assert rules["Bash(npm run test:*)"]["always_allow"] is False

    lan = TestClient(app, client=("10.20.30.40", 51000))
    assert lan.get("/api/assistant/allow-rules").status_code == 403


def test_a_lan_caller_cannot_mark_a_rule_and_junk_is_a_400(machine):
    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api/settings")
    lan = TestClient(app, client=("10.20.30.40", 51000))
    refused = lan.patch(
        "/api/settings", json={"assistant": {"always_allow_rules": ["Bash(rm:*)"]}}
    )
    assert refused.status_code == 403
    assert machine["store"].get_value("assistant", "always_allow_rules") == []

    local = _local_settings_client()
    junk = local.patch(
        "/api/settings", json={"assistant": {"always_allow_rules": "Bash(rm:*)"}}
    )
    assert junk.status_code == 400
    assert machine["store"].get_value("assistant", "always_allow_rules") == []


def _routes_client() -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(ar.router)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 51000)),
        base_url="http://test",
    )


async def _wait_busy(conversation_id: str) -> cs.ClaudeSession:
    for _ in range(400):
        session = cs.sessions.get(conversation_id)
        if session is not None and session.busy:
            return session
        await asyncio.sleep(0.025)
    raise AssertionError("the turn never started")


def test_switching_to_ask_mid_turn_stops_the_turn_and_the_next_one_asks(
    machine, monkeypatch
):
    """A turn runs in Trusted, whose child has no mirrored ask rules, so the
    CLI approves every call a loaded allow rule matches. The user switches to
    Ask because the agent is about to run something. The running turn is
    interrupted, and the next turn's child carries the ask rules."""
    monkeypatch.setenv("FAKE_CLI_MODE", "until_interrupt")
    args = machine["args"]

    async def body():
        turn = asyncio.create_task(_turn("conv-live", "trusted"))
        session = await _wait_busy("conv-live")
        assert _ask_rules(args[0]) == _self_surface()

        async with _routes_client() as http:
            resp = await http.post(
                "/api/assistant/permission-mode",
                json={"conversationId": "conv-live", "mode": "ask"},
            )
        assert resp.status_code == 200, resp.text
        # The running turn is stopped: its child would approve matched calls
        # unasked. The CLI ends the interrupted turn and the child is kept.
        await asyncio.wait_for(turn, 10)
        assert resp.json()["interrupted"] is True
        assert session.permission_mode == "ask"
        assert len(args) == 1

        # The next turn respawns the child with the mirrored ask rules.
        second = asyncio.create_task(_turn("conv-live", "ask"))
        session = await _wait_busy("conv-live")
        assert len(args) == 2
        assert "Bash(npm run test:*)" in _ask_rules(args[1])
        assert "Bash(uv run pytest:*)" in _ask_rules(args[1])

        # Ask -> Trusted needs no rule the child lacks: the turn keeps going.
        async with _routes_client() as http:
            relaxed = await http.post(
                "/api/assistant/permission-mode",
                json={"conversationId": "conv-live", "mode": "trusted"},
            )
        assert relaxed.status_code == 200, relaxed.text
        assert relaxed.json()["interrupted"] is False
        assert session.busy
        assert cs.interrupt("conv-live")
        await asyncio.wait_for(second, 10)

    _run(body)
