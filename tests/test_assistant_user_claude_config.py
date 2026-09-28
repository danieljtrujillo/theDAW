"""
"Use my Claude settings and MCP servers": the app setting that decides whether
the in-app Claude Code session loads the user's own Claude setup.

The persistent-session engine spawned the CLI with ``--setting-sources
project,local`` and ``--strict-mcp-config`` on every turn, so the in-app Claude
lost the user's own MCP servers, ~/.claude/settings.json, CLAUDE.md, skills and
agents, with an environment variable as the only way back. The Claude path it
replaced passed neither flag. The setting (``assistant.use_user_claude_config``,
default ON) restores that, and OFF keeps the isolated setup.

Each test replays a sequence a real install goes through: a settings file
written by an older build, opened by this one, then by the older build again;
a user switching the setting in the middle of a conversation; a phone on the LAN
trying to flip it. The engine runs against ``tests/fixtures/fake_claude_cli.py``
(a real subprocess speaking the stream-json protocol); only the argv that picks
the binary is monkeypatched.
"""

import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path, PurePosixPath, PureWindowsPath

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import assistant_routes as ar
from backend.modules.assistant import claude_session as cs
from backend.modules.settings import router as settings_router
from backend.modules.settings.store import SCHEMA_VERSION, SettingsStore

FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_claude_cli.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def use_fake_cli(monkeypatch, log_path: Path | None = None) -> list[list[str]]:
    """Point the engine at the fake CLI; return the list every spawn's argv
    (the real CLI args, before the binary is swapped) is appended to."""
    monkeypatch.setenv("FAKE_CLI_MODE", "basic")
    if log_path is not None:
        monkeypatch.setenv("FAKE_CLI_LOG", str(log_path))
    else:
        monkeypatch.delenv("FAKE_CLI_LOG", raising=False)
    arg_sets: list[list[str]] = []

    def fake_argv(base_args):
        arg_sets.append(list(base_args))
        return [sys.executable, "-u", str(FAKE_CLI)]

    monkeypatch.setattr(cs, "build_spawn_argv", fake_argv)
    return arg_sets


def run(body) -> None:
    async def wrapper():
        try:
            await asyncio.wait_for(body(), 60)
        finally:
            await cs.kill_all()

    asyncio.run(wrapper())


def sources(args: list[str]) -> str:
    return args[args.index("--setting-sources") + 1]


def frame_types(lines: list[str]) -> list[str]:
    return [
        json.loads(line[len("data: ") :])["type"]
        for line in lines
        if line.startswith("data: ")
    ]


async def engine_turn(
    conversation_id: str, text: str, use_user_config: bool, permission_mode="ask"
):
    lines = []
    async for line in cs.stream_turn(
        conversation_id,
        prompt_ndjson_line=cs.build_user_ndjson_line(text),
        model="claude-test",
        effort="high",
        permission_mode=permission_mode,
        port=0,
        use_user_config=use_user_config,
    ):
        lines.append(line)
    return lines


def stdin_user_turns(log_path: Path) -> list[str]:
    entries = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return [e["message"]["content"] for e in entries if e.get("type") == "user"]


# ---------------------------------------------------------------------------
# The switch in data/settings.json across builds
# ---------------------------------------------------------------------------
FIXTURES = Path(__file__).parent / "fixtures"


def _older_store_module(build: str):
    """An older build's settings store, loaded from its verbatim copy in
    tests/fixtures/<build>/settings_store.py."""
    spec = importlib.util.spec_from_file_location(
        f"settings_store_{build}", FIXTURES / build / "settings_store.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _older_build_reopens(path: Path, build: str, schema_version: int) -> None:
    """Open the file with an older build's OWN store code (main, schema 8; PR
    #207 head, schema 10), and save one of that build's own toggles through it
    the way its settings page would."""
    store = _older_store_module(build).SettingsStore(path)
    store.patch({"stems": {"auto_on_import": True}})
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    # That build's code really ran: it stamped its own schema back on disk.
    assert on_disk["schema_version"] == schema_version


def test_a_file_from_main_gains_the_switch_on_and_keeps_the_users_choice(tmp_path):
    path = tmp_path / "settings.json"
    # Written by main (schema 8): no assistant section at all.
    path.write_text(
        json.dumps(
            {
                "schema_version": 8,
                "app": {"launch_mode": "desktop"},
                "io": {"audio_output": {"id": "abc", "label": "Scarlett 2i2"}},
            }
        ),
        encoding="utf-8",
    )

    # Opened by this build: ON, the in-app Claude keeps what it had on main,
    # and the upgraded shape is on disk.
    store = SettingsStore(path)
    assert store.get_value("assistant", "use_user_claude_config") is True
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert on_disk["assistant"] == {
        "use_user_claude_config": True,
        "always_allow_rules": [],
    }
    assert on_disk["app"]["launch_mode"] == "desktop"

    # The user turns it off.
    store.patch({"assistant": {"use_user_claude_config": False}})

    # main opens and saves the file, then this build again: the choice survives.
    _older_build_reopens(path, "main_851f6a0", 8)
    assert SettingsStore(path).get_value("assistant", "use_user_claude_config") is False
    # The same through the PR #207 head.
    _older_build_reopens(path, "pr207_8039b45", 10)
    reopened = SettingsStore(path)
    assert reopened.get_value("assistant", "use_user_claude_config") is False
    assert reopened.get_value("stems", "auto_on_import") is True
    assert (
        json.loads(path.read_text(encoding="utf-8"))["schema_version"] == SCHEMA_VERSION
    )


@pytest.mark.parametrize("junk", ["no", 0, None, [], {"on": False}])
def test_a_hand_edited_non_boolean_reads_as_the_default(tmp_path, junk):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {"schema_version": 11, "assistant": {"use_user_claude_config": junk}}
        ),
        encoding="utf-8",
    )
    assert SettingsStore(path).get_value("assistant", "use_user_claude_config") is True


def test_a_non_object_assistant_section_reads_as_the_default(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps({"schema_version": 11, "assistant": "off"}), encoding="utf-8"
    )
    store = SettingsStore(path)
    assert store.get_section("assistant") == {
        "use_user_claude_config": True,
        "always_allow_rules": [],
    }


def test_store_patch_ignores_a_non_boolean(tmp_path):
    store = SettingsStore(tmp_path / "settings.json")
    store.patch({"assistant": {"use_user_claude_config": False}})
    store.patch({"assistant": {"use_user_claude_config": "yes"}})
    assert store.get_value("assistant", "use_user_claude_config") is False


# ---------------------------------------------------------------------------
# Who may flip it
# ---------------------------------------------------------------------------
def _settings_client(tmp_path, monkeypatch, peer) -> tuple[TestClient, SettingsStore]:
    store = SettingsStore(tmp_path / "settings.json")
    monkeypatch.setattr(settings_router, "_store", store)
    app = FastAPI()
    app.include_router(settings_router.router, prefix="/api/settings")
    return TestClient(app, client=peer), store


def test_a_lan_caller_cannot_flip_the_switch(tmp_path, monkeypatch):
    lan, store = _settings_client(tmp_path, monkeypatch, ("10.20.30.40", 51000))

    refused = lan.patch(
        "/api/settings", json={"assistant": {"use_user_claude_config": False}}
    )
    assert refused.status_code == 403
    assert store.get_value("assistant", "use_user_claude_config") is True
    # Reading it is harmless, so the phone still sees it.
    assert lan.get("/api/settings").json()["assistant"] == {
        "use_user_claude_config": True,
        "always_allow_rules": [],
    }
    # And the phone's own toggles still save.
    assert (
        lan.patch("/api/settings", json={"stems": {"auto_on_import": True}}).status_code
        == 200
    )


def test_this_machine_flips_the_switch_and_junk_is_a_400(tmp_path, monkeypatch):
    local, store = _settings_client(tmp_path, monkeypatch, ("127.0.0.1", 51000))

    off = local.patch(
        "/api/settings", json={"assistant": {"use_user_claude_config": False}}
    )
    assert off.status_code == 200, off.text
    assert off.json()["assistant"] == {
        "use_user_claude_config": False,
        "always_allow_rules": [],
    }
    assert store.get_value("assistant", "use_user_claude_config") is False

    junk = local.patch(
        "/api/settings", json={"assistant": {"use_user_claude_config": "on"}}
    )
    assert junk.status_code == 400
    assert store.get_value("assistant", "use_user_claude_config") is False


# ---------------------------------------------------------------------------
# What the CLI is spawned with
# ---------------------------------------------------------------------------
def test_user_config_loads_the_user_source_and_drops_strict(tmp_path):
    args = cs.build_base_args("m", "high", "ask", use_user_config=True)
    assert sources(args) == "user,project,local"
    # Everything else is the same contract as the isolated set.
    isolated = cs.build_base_args("m", "high", "ask")
    assert sources(isolated) == "project,local"
    assert [a for a in args if a != "user,project,local"] == [
        a for a in isolated if a != "project,local"
    ]

    path = tmp_path / "mcp.json"
    mcp_args, written = cs._mcp_config_args(
        "relay-u", str(path), port=1, extra_servers={}, use_user_config=True
    )
    assert written is True
    assert mcp_args == ["--mcp-config", str(path)]
    # The relay is still in the config the CLI adds to the user's own servers.
    assert "thedaw" in json.loads(path.read_text(encoding="utf-8"))["mcpServers"]


def test_a_failed_config_write_keeps_the_users_servers_and_warns(monkeypatch):
    arg_sets = use_fake_cli(monkeypatch)
    monkeypatch.setattr(cs, "write_mcp_config", lambda *a, **k: False)

    async def body():
        lines = await engine_turn("conv-user-nomcp", "hi", use_user_config=True)
        assert "--strict-mcp-config" not in arg_sets[0]
        assert "--mcp-config" not in arg_sets[0]
        errors = [
            json.loads(line[len("data: ") :])
            for line in lines
            if line.startswith("data: ") and '"error"' in line
        ]
        assert [e["message"] for e in errors] == [cs.MCP_UNAVAILABLE_MESSAGE]
        assert frame_types(lines).count("done") == 1

    run(body)


def test_switching_mid_conversation_respawns_with_the_other_setup(monkeypatch):
    arg_sets = use_fake_cli(monkeypatch)

    async def body():
        await engine_turn("conv-switch", "one", use_user_config=True)
        session = cs.sessions["conv-switch"]
        first_proc = session.proc
        assert session.use_user_config is True
        assert sources(arg_sets[0]) == "user,project,local"
        assert "--strict-mcp-config" not in arg_sets[0]
        assert "--mcp-config" in arg_sets[0]

        # A second turn with the same setting reuses the warm child.
        await engine_turn("conv-switch", "two", use_user_config=True)
        assert len(arg_sets) == 1
        assert session.proc is first_proc

        # The user switches it off: the next turn respawns, isolated.
        await engine_turn("conv-switch", "three", use_user_config=False)
        assert cs.sessions["conv-switch"] is session
        assert session.proc is not first_proc
        assert session.use_user_config is False
        assert sources(arg_sets[1]) == "project,local"
        assert "--strict-mcp-config" in arg_sets[1]

        # And back on.
        await engine_turn("conv-switch", "four", use_user_config=True)
        assert session.use_user_config is True
        assert sources(arg_sets[2]) == "user,project,local"
        assert "--strict-mcp-config" not in arg_sets[2]
        assert len(arg_sets) == 3

    run(body)


# ---------------------------------------------------------------------------
# Through the /chat route: the setting reaches the spawn and the seed
# ---------------------------------------------------------------------------
def _app_client() -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(ar.router)
    app.include_router(ar.mcp_relay_router)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


def _chat(conversation_id: str, text: str) -> dict:
    return {
        "provider": "claude",
        "model": "claude-test",
        "effort": "high",
        "conversationId": conversation_id,
        "messages": [{"role": "user", "content": text}],
    }


@pytest.fixture
def _no_rag(monkeypatch):
    stub = types.ModuleType("backend.rag")
    stub.retrieve = lambda text, k=5: []
    stub.format_context = lambda chunks: ""
    monkeypatch.setitem(sys.modules, "backend.rag", stub)


def test_the_app_setting_drives_the_session_turn_by_turn(
    monkeypatch, tmp_path, _no_rag
):
    store = SettingsStore(tmp_path / "settings.json")
    monkeypatch.setattr(settings_router, "_store", store)
    log_path = tmp_path / "stdin.log"
    arg_sets = use_fake_cli(monkeypatch, log_path)

    async def body():
        async with _app_client() as http:
            # Fresh install: the default is ON.
            first = await http.post("/api/assistant/chat", json=_chat("conv-app", "a"))
            assert first.status_code == 200, first.text
            assert sources(arg_sets[0]) == "user,project,local"
            assert "--strict-mcp-config" not in arg_sets[0]

            # The model is told the truth about what it has loaded.
            seed = stdin_user_turns(log_path)[0]
            assert ar.CLAUDE_MCP_SURFACE_USER_CONFIG in seed
            assert ar.CLAUDE_MCP_SURFACE_ISOLATED not in seed

            # The user switches it off in the panel; the next message respawns
            # the child with the isolated setup.
            store.patch({"assistant": {"use_user_claude_config": False}})
            second = await http.post("/api/assistant/chat", json=_chat("conv-app", "b"))
            assert second.status_code == 200, second.text
            assert len(arg_sets) == 2
            assert sources(arg_sets[1]) == "project,local"
            assert "--strict-mcp-config" in arg_sets[1]
            assert cs.sessions["conv-app"].use_user_config is False

            # The respawned child RESUMES the conversation, so it is not seeded
            # again: the message itself must carry the setup now in force, or
            # the model keeps believing the user's servers are loaded.
            assert "--resume" in arg_sets[1]
            switched = stdin_user_turns(log_path)[1]
            assert "Provider Mode" not in switched
            assert ar.CLAUDE_MCP_SURFACE_ISOLATED.removeprefix("- ") in switched
            assert ar.CLAUDE_MCP_SURFACE_USER_CONFIG.removeprefix("- ") not in switched

            # A new conversation while it is off is seeded with the narrow line.
            third = await http.post("/api/assistant/chat", json=_chat("conv-app2", "c"))
            assert third.status_code == 200, third.text
            seeds = [t for t in stdin_user_turns(log_path) if "Provider Mode" in t]
            assert ar.CLAUDE_MCP_SURFACE_ISOLATED in seeds[-1]
            assert ar.CLAUDE_MCP_SURFACE_USER_CONFIG not in seeds[-1]

    run(body)


# ---------------------------------------------------------------------------
# The loaded allow rules cannot outvote theDAW's permission mode
# ---------------------------------------------------------------------------
def _settings_file(args: list[str]) -> Path:
    return Path(args[args.index("--settings") + 1])


def _settings_rules(args: list[str]) -> list[str]:
    """The ask rules in the ``--settings`` file a spawn was given."""
    payload = json.loads(_settings_file(args).read_text(encoding="utf-8"))
    return payload["permissions"]["ask"]


def _self_surface_rules() -> list[str]:
    root = cs._cli_absolute_rule_path(cs.REPO_ROOT)
    return [f"Edit({root}/{glob})" for glob in ar.permissions.SELF_SURFACE_GLOBS]


def test_rule_paths_use_the_clis_absolute_form():
    windows = PureWindowsPath("G:/Users/dtruj/Dev/theDAW")
    assert cs._cli_absolute_rule_path(windows) == "//g/Users/dtruj/Dev/theDAW"
    posix = PurePosixPath("/home/me/theDAW")
    assert cs._cli_absolute_rule_path(posix) == "//home/me/theDAW"


@pytest.mark.parametrize("use_user_config", [True, False])
def test_read_only_then_ask_then_teardown(monkeypatch, tmp_path, use_user_config):
    """Read-only with allow rules loaded, then the user picks Ask, then the
    conversation ends.

    Every loaded setting source can carry allow rules (the user's
    ~/.claude/settings.json with the switch on, this project's
    .claude/settings*.json either way), and the CLI approves what they match
    without asking theDAW, so decide() never saw a matched `git commit` or an
    Edit of the assistant's own code in Read-only mode. The child now gets ask
    rules, which the CLI checks before any allow rule.

    No settings file carries an allow rule here (an empty CLAUDE_CONFIG_DIR
    and a checkout without .claude/), so Ask mode mirrors none; the mirroring
    itself is test_assistant_ask_allow_rules.py."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    (tmp_path / "checkout").mkdir()
    monkeypatch.setattr(cs, "REPO_ROOT", tmp_path / "checkout")
    arg_sets = use_fake_cli(monkeypatch)

    async def body():
        await engine_turn("conv-ro", "one", use_user_config, permission_mode="readonly")
        readonly = _settings_rules(arg_sets[0])
        for tool in ("Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "Agent"):
            assert tool in readonly, tool
        assert "mcp__*" in readonly
        for rule in _self_surface_rules():
            assert rule in readonly
        readonly_file = _settings_file(arg_sets[0])

        # The user switches to Ask: the respawned child keeps the self-surface
        # rules and loses the read-only ones.
        await engine_turn("conv-ro", "two", use_user_config, permission_mode="ask")
        assert len(arg_sets) == 2
        assert _settings_rules(arg_sets[1]) == _self_surface_rules()
        ask_file = _settings_file(arg_sets[1])
        assert ask_file != readonly_file

        # Teardown removes every rules file the conversation's children got.
        relay_id = cs.sessions["conv-ro"].relay_id
        assert relay_id in readonly_file.name
        await cs.teardown("conv-ro", kill=True)
        assert not readonly_file.exists()
        assert not ask_file.exists()

    run(body)


def test_no_rules_file_means_no_child(monkeypatch):
    """Fail closed: a child without the rules would let allow rules approve
    edits in Read-only mode, so an unwritable rules file fails the turn."""
    arg_sets = use_fake_cli(monkeypatch)

    def refuse(relay_id, permission_mode, **_):
        raise OSError("disk full")

    async def body():
        await engine_turn("conv-rules", "one", True, permission_mode="ask")
        session = cs.sessions["conv-rules"]
        first_proc = session.proc

        monkeypatch.setattr(cs, "_permission_settings_args", refuse)
        # A mode switch cannot respawn without its rules: the turn errors and
        # the session stays whole on its old child, still in Ask.
        lines = await engine_turn("conv-rules", "two", True, permission_mode="readonly")
        assert "error" in frame_types(lines)
        assert len(arg_sets) == 1
        assert session.proc is first_proc
        assert session.permission_mode == "ask"

        # A brand-new conversation gets no child at all.
        lines = await engine_turn("conv-rules-2", "one", True)
        assert "error" in frame_types(lines)
        assert len(arg_sets) == 1
        assert "conv-rules-2" not in cs.sessions

    run(body)
