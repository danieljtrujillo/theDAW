"""theDAW reachable from another device, in a secure context.

A browser hands out ``AudioContext.audioWorklet``, the microphone, Web MIDI,
the clipboard and ``crypto.subtle`` only over ``https://`` or ``localhost``, so
a second computer on ``http://<lan-ip>:5173`` opened an EDIT tab with no audio
engine at all ("Cannot read properties of undefined (reading 'addModule')").
The fix is a second Vite listener, the same app over TLS, started by whichever
launcher the user runs.

These cover the parts that decide and wire that up:

* :mod:`backend.lib.lan_https` -- the one decision both launchers make, pure,
  so the table of cases and the exact wording of each refusal are testable
  without a certificate, a network interface or a subprocess.
* ``backend/_devstack.py`` -- the web launcher's spawn: its command, its
  working directory, and the environment the child is handed.
* ``electron-ui/main/index.ts`` -- the desktop shell's wiring, read out of the
  source the same way ``tests/test_launch_token_child_env.py`` reads it (the
  main process needs a real Electron to run).
* ``backend/modules/network/router.py`` -- ``GET /api/network/lan``, whose
  ``https_url`` must be a live fact rather than an intention.

Nothing here starts a server, a browser or a listener, and no test touches the
real LAN port.
"""

from __future__ import annotations

import io
import re
import subprocess
import threading
from pathlib import Path
from typing import Any

import pytest

from backend import ports
from backend.lib import lan_https, launch_token
from backend.lib.lan_cert import CertPaths

REPO_ROOT = Path(__file__).resolve().parents[1]
SECRET = "launch-secret-for-lan-tests"
CERT = CertPaths(
    cert=Path("C:/theDAW/data/lan-cert/lan-cert.pem"),
    key=Path("C:/theDAW/data/lan-cert/lan-key.pem"),
)
LAN = ["192.168.1.34"]
#: The listener binary a resolved plan carries (backend/lib/lan_https.py
#: resolves it once, for both launchers). Not this machine's, so no test
#: depends on whether ``npm install`` has been run here.
VITE = "C:/theDAW/frontend/node_modules/.bin/vite.cmd"


# ---------------------------------------------------------------------------
# plan_lan_https: the one decision
# ---------------------------------------------------------------------------


def test_everything_present_serves_the_lan_over_tls() -> None:
    plan = lan_https.plan_lan_https({}, {}, LAN, CERT)
    assert plan.enabled is True
    assert plan.port == ports.LAN_HTTPS_PORT
    assert plan.url == f"https://192.168.1.34:{ports.LAN_HTTPS_PORT}"
    assert plan.cert_paths is CERT
    assert plan.reason is None
    assert (
        plan.log_line() == f"LAN (https): https://192.168.1.34:{ports.LAN_HTTPS_PORT}"
    )


def test_it_is_on_by_default_with_no_settings_file_at_all() -> None:
    """The whole point is that a second device works with nothing configured,
    so an absent setting -- an empty dict, or a settings file that could not be
    read -- means ON."""
    assert lan_https.plan_lan_https({}, {}, LAN, CERT).enabled is True
    assert lan_https.plan_lan_https({"lan": {}}, {}, LAN, CERT).enabled is True
    assert lan_https.plan_lan_https({"lan": None}, {}, LAN, CERT).enabled is True
    assert lan_https.plan_lan_https({"app": {}}, {}, LAN, CERT).enabled is True
    assert lan_https.plan_lan_https({"app": None}, {}, LAN, CERT).enabled is True


#: Where the switch is stored: ``lan.https``, and the schema-10 ``app.lan_https``
#: a launcher still reads until the backend's store has moved it.
SETTING_PLACES = [("lan", "https"), ("app", "lan_https")]


@pytest.mark.parametrize(("section", "key"), SETTING_PLACES)
@pytest.mark.parametrize("stored", [False, "false", "0", "no", "off", "OFF"])
def test_the_setting_turns_it_off_and_says_so(
    stored: Any, section: str, key: str
) -> None:
    plan = lan_https.plan_lan_https({section: {key: stored}}, {}, LAN, CERT)
    assert plan.enabled is False
    assert plan.url is None
    assert plan.reason is not None
    assert f"{section}.{key}" in plan.reason
    assert plan.log_line().startswith("LAN (https): off - ")
    # It names the levers that exist. It used to say "in Settings", and there
    # is no Settings control for this -- the file and the environment variable
    # are the only two ways to change it, so the line has to name them.
    assert "settings.json" in plan.reason
    assert f"{lan_https.ENV_ENABLED}=1" in plan.reason


@pytest.mark.parametrize(("section", "key"), SETTING_PLACES)
@pytest.mark.parametrize("stored", [True, "true", "1", "on", "yes", "anything else"])
def test_any_other_setting_value_leaves_it_on(
    stored: Any, section: str, key: str
) -> None:
    """Only ``false`` is off. A value nobody recognises must not silently take
    the feature away."""
    assert lan_https.plan_lan_https({section: {key: stored}}, {}, LAN, CERT).enabled


def test_an_off_in_either_place_wins_and_names_its_key() -> None:
    """A schema-10 build writes ``app.lan_https: true`` from its defaults and
    keeps ``lan`` whole, so the two places can disagree. The one thing this
    setting must never do is come back on after the user switched it off."""
    old_off = {"lan": {"https": True}, "app": {"lan_https": False}}
    new_off = {"lan": {"https": False}, "app": {"lan_https": True}}
    for settings, named in ((old_off, "app.lan_https"), (new_off, "lan.https")):
        plan = lan_https.plan_lan_https(settings, {}, LAN, CERT)
        assert plan.enabled is False
        assert plan.reason is not None and named in plan.reason
        assert lan_https.stored_off_key(settings) == named
    assert lan_https.stored_off_key({"lan": {"https": True}}) is None


def test_the_environment_can_turn_it_off_for_one_launch() -> None:
    plan = lan_https.plan_lan_https({}, {lan_https.ENV_ENABLED: "0"}, LAN, CERT)
    assert plan.enabled is False
    assert plan.reason is not None
    assert lan_https.ENV_ENABLED in plan.reason


@pytest.mark.parametrize(("section", "key"), SETTING_PLACES)
def test_the_environment_can_turn_it_back_on_over_the_setting(
    section: str, key: str
) -> None:
    settings = {section: {key: False}}
    env = {lan_https.ENV_ENABLED: "1"}
    assert lan_https.plan_lan_https(settings, env, LAN, CERT).enabled is True


def test_no_lan_address_says_to_connect_to_a_network() -> None:
    for addresses in ([], [""], [None]):  # type: ignore[list-item]
        plan = lan_https.plan_lan_https({}, {}, addresses, CERT)
        assert plan.enabled is False
        assert plan.reason is not None
        assert "no LAN address" in plan.reason
        # Still reports the port, so a log line can name it.
        assert plan.port == ports.LAN_HTTPS_PORT


def test_no_certificate_names_the_fix_rather_than_the_symptom() -> None:
    plan = lan_https.plan_lan_https({}, {}, LAN, None)
    assert plan.enabled is False
    assert plan.reason is not None
    assert "openssl" in plan.reason


def test_the_first_real_address_is_the_one_devices_are_told_to_use() -> None:
    plan = lan_https.plan_lan_https({}, {}, ["", "10.0.0.5", "192.168.1.34"], CERT)
    assert plan.url == f"https://10.0.0.5:{ports.LAN_HTTPS_PORT}"


def test_being_switched_off_is_checked_before_the_address_and_the_cert() -> None:
    """resolve_plan short-circuits on the cheap answer so a switched-off launch
    never shells out to openssl; blocking_reason is what it asks."""
    off = {"lan": {"https": False}}
    assert lan_https.blocking_reason(off, {}, []) is not None
    assert "lan.https" in str(lan_https.blocking_reason(off, {}, []))
    assert lan_https.blocking_reason({}, {}, LAN) is None


# ---------------------------------------------------------------------------
# listener_port / listener_env
# ---------------------------------------------------------------------------


def test_the_port_comes_from_the_table_unless_the_environment_says_otherwise() -> None:
    assert lan_https.listener_port({}) == ports.LAN_HTTPS_PORT
    assert lan_https.listener_port({lan_https.ENV_PORT: "6443"}) == 6443
    assert lan_https.listener_port({lan_https.ENV_PORT: " 6443 "}) == 6443


@pytest.mark.parametrize("bad", ["", "  ", "no", "0", "-1", "65536", "5443.5"])
def test_an_unusable_port_falls_back_exactly_as_the_listener_does(bad: str) -> None:
    """``vite.lan.config.ts`` ignores a bad ``theDAW_HTTPS_PORT`` and uses the
    default. If this obeyed it instead, the launcher would print an address
    nothing is listening on."""
    assert lan_https.listener_port({lan_https.ENV_PORT: bad}) == ports.LAN_HTTPS_PORT


def test_the_child_environment_carries_only_what_the_listener_reads() -> None:
    plan = lan_https.plan_lan_https({}, {lan_https.ENV_PORT: "6443"}, LAN, CERT)
    base = {"PATH": "/usr/bin", "THEDAW_ALREADY_HERE": "kept"}
    env = lan_https.listener_env(plan, base)

    assert env["PATH"] == "/usr/bin"
    assert env["THEDAW_ALREADY_HERE"] == "kept"
    assert env[lan_https.ENV_CERT] == str(CERT.cert)
    assert env[lan_https.ENV_KEY] == str(CERT.key)
    assert env[lan_https.ENV_PORT] == "6443"
    assert set(env) - set(base) == {
        lan_https.ENV_CERT,
        lan_https.ENV_KEY,
        lan_https.ENV_PORT,
    }
    # The caller's mapping is untouched.
    assert set(base) == {"PATH", "THEDAW_ALREADY_HERE"}


def test_live_reload_comes_from_the_base_environment_not_from_here() -> None:
    """``ENABLE_HMR`` used to be forced on for this child, which starts a
    watcher over the whole repository. The web launcher sets it for its own
    http dev server; the desktop shell does not want a second watcher, and
    neither launcher should have that decision made for it here."""
    plan = lan_https.plan_lan_https({}, {}, LAN, CERT)
    assert "ENABLE_HMR" not in lan_https.listener_env(plan, {})
    passed_through = lan_https.listener_env(plan, {"ENABLE_HMR": "true"})
    assert passed_through["ENABLE_HMR"] == "true"


def test_the_child_environment_refuses_a_plan_with_nothing_to_serve() -> None:
    off = lan_https.plan_lan_https({}, {}, LAN, None)
    with pytest.raises(ValueError):
        lan_https.listener_env(off, {})


def test_the_listener_command_runs_the_frontends_own_vite_binary() -> None:
    """Not ``npx``: on Windows cmd searches the current directory before PATH,
    and a non-interactive npx with no node_modules present fetches a copy of
    vite from the registry in the middle of a launch."""
    assert (REPO_ROOT / "frontend" / "vite.lan.config.ts").is_file()
    plan = lan_https.plan_lan_https({}, {}, LAN, CERT, vite=VITE)
    assert lan_https.listener_command(plan) == [
        VITE,
        "--config",
        "vite.lan.config.ts",
    ]
    assert "npx" not in " ".join(lan_https.listener_command(plan))
    assert not hasattr(lan_https, "LISTENER_COMMAND"), (
        "the npx command string must be gone, not left beside the new one for "
        "a caller to pick up"
    )


def test_the_listener_command_refuses_a_plan_with_no_binary() -> None:
    with pytest.raises(ValueError):
        lan_https.listener_command(lan_https.plan_lan_https({}, {}, LAN, CERT))
    with pytest.raises(ValueError):
        lan_https.listener_command(lan_https.plan_lan_https({}, {}, [], None))


def test_the_binary_is_the_one_the_frontend_installed_for_itself() -> None:
    """Resolved here, once, for both launchers: the desktop shell reads the
    path out of the plan rather than searching for it again in TypeScript."""
    found = lan_https.listener_binary()
    if found is not None:
        assert found.is_file()
        assert found.parent == REPO_ROOT / "frontend" / "node_modules" / ".bin"
        assert found.name in {"vite", "vite.cmd"}


def test_no_frontend_dependencies_is_one_line_rather_than_a_crash_loop(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A clone that has never run ``npm install`` has no vite to start. Vite is
    not spawned at all then, and the reason says which lever fixes it."""
    monkeypatch.setattr(lan_https.paths, "PROJECT_ROOT", tmp_path)
    assert lan_https.listener_binary() is None

    monkeypatch.setattr(lan_https, "read_settings", lambda: {})
    monkeypatch.setattr(lan_https, "detect_lan_ips", lambda: LAN)
    import backend.lib.lan_cert as lan_cert

    monkeypatch.setattr(
        lan_cert,
        "ensure_lan_cert",
        lambda ips, **kw: pytest.fail("shelled out to openssl with no vite"),
    )
    plan = lan_https.resolve_plan({})
    assert plan.enabled is False
    assert plan.vite is None
    assert plan.reason is not None
    assert "frontend dependencies not installed" in plan.reason
    assert "npm install" in plan.reason


def test_the_plan_is_json_the_desktop_shell_can_read() -> None:
    payload = lan_https.plan_lan_https({}, {}, LAN, CERT, vite=VITE).as_json()
    assert payload == {
        "enabled": True,
        "port": ports.LAN_HTTPS_PORT,
        "url": f"https://192.168.1.34:{ports.LAN_HTTPS_PORT}",
        "cert": str(CERT.cert),
        "key": str(CERT.key),
        "vite": VITE,
        "reason": None,
    }
    off = lan_https.plan_lan_https({}, {}, [], None).as_json()
    assert off["enabled"] is False and off["cert"] is None and off["reason"]


def test_the_cli_always_prints_one_plan_and_exits_zero(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The desktop shell parses this. A traceback on stdout, or a non-zero
    exit, would turn "no LAN listener" into a visible failure."""
    import json

    def boom(env: Any = None) -> Any:
        raise RuntimeError("openssl exploded")

    monkeypatch.setattr(lan_https, "resolve_plan", boom)
    assert lan_https._main(["--json"]) == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["enabled"] is False
    assert "openssl exploded" in payload["reason"]
    assert payload["port"] == ports.LAN_HTTPS_PORT


@pytest.mark.parametrize(
    ("settings", "addresses"),
    [
        ({"lan": {"https": False}}, LAN),  # switched off
        ({"app": {"lan_https": False}}, LAN),  # switched off, schema 10
        ({}, []),  # no network
    ],
)
def test_resolve_plan_mints_no_certificate_when_there_is_nothing_to_serve(
    monkeypatch: pytest.MonkeyPatch, settings: dict, addresses: list[str]
) -> None:
    """Minting shells out to openssl (RSA keygen, two subprocess round trips).
    A launch with the feature off, or with no network to serve, must not pay
    for that -- and must not leave a certificate behind either."""
    import backend.lib.lan_cert as lan_cert

    monkeypatch.setattr(lan_https, "read_settings", lambda: settings)
    monkeypatch.setattr(lan_https, "detect_lan_ips", lambda: addresses)
    monkeypatch.setattr(
        lan_cert,
        "ensure_lan_cert",
        lambda ips, **kw: pytest.fail("shelled out to openssl anyway"),
    )
    plan = lan_https.resolve_plan({})
    assert plan.enabled is False
    assert plan.reason is not None


def test_resolve_plan_survives_a_certificate_that_cannot_be_made(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(lan_https, "read_settings", lambda: {})
    monkeypatch.setattr(lan_https, "detect_lan_ips", lambda: LAN)
    # The binary is stubbed so THIS test is about the certificate step. CI has
    # no frontend/node_modules, where the real listener_binary() answers None
    # and resolve_plan (correctly) refuses with NO_FRONTEND_REASON before it
    # ever reaches openssl -- and the assertion below then read a reason about
    # npm install instead of the one it is pinning.
    monkeypatch.setattr(
        lan_https, "listener_binary", lambda *a, **k: Path("/fake/.bin/vite")
    )
    import backend.lib.lan_cert as lan_cert

    def refuse(ips: list[str], **kwargs: Any) -> None:
        raise OSError("no openssl here")

    monkeypatch.setattr(lan_cert, "ensure_lan_cert", refuse)
    plan = lan_https.resolve_plan({})
    assert plan.enabled is False
    assert plan.reason is not None and "openssl" in plan.reason


def test_read_settings_returns_the_defaults_for_an_unreadable_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    broken = tmp_path / "settings.json"
    broken.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("theDAW_SETTINGS_PATH", str(broken))
    assert lan_https.read_settings() == {}

    # A readable file comes back with the switch settled into lan.https
    # (lan_https.reconcile); with no record beside it, the old key's off wins.
    broken.write_text('{"app": {"lan_https": false}}', encoding="utf-8")
    assert lan_https.read_settings() == {
        "app": {"lan_https": False},
        "lan": {"https": False},
    }


# ---------------------------------------------------------------------------
# backend/_devstack.py — the web launcher's spawn
# ---------------------------------------------------------------------------


class _FakeProc:
    """A child whose output is already at EOF, so _pump returns at once."""

    pid = 7777

    def __init__(self) -> None:
        self.stdout = io.StringIO("")

    def poll(self) -> int | None:
        return None

    def wait(self) -> int:
        return 0


@pytest.fixture
def devstack(monkeypatch: pytest.MonkeyPatch):
    """backend._devstack with its spawn, port probe and log recorded.

    ``describe_occupant`` is stubbed in every case: the real one binds the
    port to find out who holds it, and the user's own LAN listener is on that
    port right now.
    """
    from backend import _devstack

    spawns: list[tuple[Any, str | None, dict[str, str] | None]] = []
    lines: list[str] = []

    def record(cmd: Any, cwd: Any = None, env: Any = None) -> _FakeProc:
        spawns.append((cmd, cwd, env))
        return _FakeProc()

    monkeypatch.setenv(launch_token.ENV_VAR, SECRET)
    monkeypatch.setattr(_devstack, "_spawn", record)
    monkeypatch.setattr(
        _devstack, "_emit", lambda tag, line: lines.append(f"[{tag}] {line}")
    )
    monkeypatch.setattr(_devstack.ports, "describe_occupant", lambda port: None)
    return _devstack, spawns, lines


def test_the_web_launcher_starts_the_listener_beside_the_http_one(
    devstack: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    module, spawns, lines = devstack
    plan = lan_https.plan_lan_https({}, {}, LAN, CERT, vite=VITE)
    monkeypatch.setattr(module.lan_https, "resolve_plan", lambda: plan)

    children: list[Any] = []
    assert module._start_lan_listener(children, "C:/theDAW/frontend") is True

    [(cmd, cwd, env)] = spawns
    # argv, not a shell string, and the frontend's own binary rather than npx.
    assert cmd == [VITE, "--config", "vite.lan.config.ts"]
    assert cwd == "C:/theDAW/frontend"
    assert len(children) == 1
    assert any(plan.url in line for line in lines), lines

    assert env is not None
    assert env[lan_https.ENV_CERT] == str(CERT.cert)
    assert env[lan_https.ENV_KEY] == str(CERT.key)
    assert env[lan_https.ENV_PORT] == str(ports.LAN_HTTPS_PORT)


def test_the_listener_child_never_holds_the_desktop_launch_token(
    devstack: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """vite runs the frontend's own devDependencies. Third-party code that
    held THEDAW_LAUNCH_TOKEN could send X-TheDAW-Launch-Token and pass as the
    desktop shell (backend/lib/launch_token.py)."""
    module, spawns, _lines = devstack
    monkeypatch.setattr(
        module.lan_https,
        "resolve_plan",
        lambda: lan_https.plan_lan_https({}, {}, LAN, CERT, vite=VITE),
    )

    module._start_lan_listener([], "C:/theDAW/frontend")
    [(_cmd, _cwd, env)] = spawns
    assert env is not None, "the child inherited this process's environment"
    assert launch_token.ENV_VAR not in {k.upper() for k in env}
    assert SECRET not in env.values()
    # The rest of the environment is still there.
    assert "PATH" in {k.upper() for k in env}


def test_a_disabled_plan_logs_the_reason_and_spawns_nothing(
    devstack: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    module, spawns, lines = devstack
    off = lan_https.plan_lan_https({}, {}, [], None)
    monkeypatch.setattr(module.lan_https, "resolve_plan", lambda: off)

    assert module._start_lan_listener([], "C:/theDAW/frontend") is False
    assert spawns == []
    assert any("no LAN address" in line for line in lines), lines


def test_an_occupied_port_is_reported_rather_than_crashing_the_stack(
    devstack: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """vite.lan.config.ts sets strictPort, so a taken port kills the child.
    The launcher says who has it, in backend.ports' own words, and carries on."""
    module, spawns, lines = devstack
    monkeypatch.setattr(
        module.lan_https,
        "resolve_plan",
        lambda: lan_https.plan_lan_https({}, {}, LAN, CERT, vite=VITE),
    )
    monkeypatch.setattr(
        module.ports,
        "describe_occupant",
        lambda port: f"Port {port} is held by another program.",
    )

    assert module._start_lan_listener([], "C:/theDAW/frontend") is False
    assert spawns == []
    assert any("is taken" in line and "another program" in line for line in lines), (
        lines
    )


def test_a_failed_spawn_is_one_line_and_the_stack_still_runs(
    devstack: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    module, _spawns, lines = devstack
    monkeypatch.setattr(
        module.lan_https,
        "resolve_plan",
        lambda: lan_https.plan_lan_https({}, {}, LAN, CERT, vite=VITE),
    )

    def refuse(*_a: Any, **_k: Any) -> None:
        raise OSError("npx is not on PATH")

    monkeypatch.setattr(module, "_spawn", refuse)
    children: list[Any] = []
    assert module._start_lan_listener(children, "C:/theDAW/frontend") is False
    assert children == []
    assert any("could not start" in line for line in lines), lines


def test_the_web_launcher_starts_the_listener_on_a_thread_of_its_own() -> None:
    """main() has to start it, next to the http frontend it mirrors -- and on a
    daemon thread, never inline. resolve_plan() shells out to openssl to mint an
    RSA key (a 120 s timeout) and describe_occupant enumerates every listener on
    the machine; inline, all of that sat in front of the backend supervisor and
    the browser, so a first launch waited on a certificate and a hung openssl
    held the whole app for two minutes."""
    source = (REPO_ROOT / "backend" / "_devstack.py").read_text(encoding="utf-8")
    body = source[source.index("def main(") :]
    assert re.search(
        r"threading\.Thread\(\s*target=_start_lan_listener,\s*"
        r"args=\(children, frontend_dir\),\s*daemon=True,?\s*\)\.start\(\)",
        body,
    ), body
    assert "_start_lan_listener(children" not in body, "nothing calls it inline"
    # After the http dev server, so the two lines read in the order they happen.
    assert body.index("_spawn(_frontend_command(") < body.index("_start_lan_listener")


def test_a_listener_that_arrives_during_shutdown_is_killed_by_its_own_thread(
    devstack, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Off the main thread, the listener can be registered after main()'s final
    kill loop has already run -- leaving a vite holding the TLS port against the
    next launch. So the registry is CLOSED before that loop, and a child that
    arrives too late is refused, which makes the thread that started it kill the
    process itself."""
    module, _spawns, lines = devstack
    # The plan is stubbed, like every other devstack test here: the real
    # resolve_plan() needs frontend/node_modules (absent on CI) and shells out
    # to openssl to mint a certificate into the real data directory.
    plan = lan_https.plan_lan_https({}, {}, LAN, CERT, vite=VITE)
    monkeypatch.setattr(module.lan_https, "resolve_plan", lambda: plan)
    monkeypatch.setattr(module, "_children_closed", False)
    children: list = []
    assert module._register_child(children, "early") is True

    assert module._close_children(children) == ["early"], (
        "the kill loop still gets everything registered in time"
    )
    assert module._register_child(children, "late") is False
    assert children == ["early"], "a late child is never silently added"

    killed: list = []
    monkeypatch.setattr(module, "_kill_tree", killed.append)
    assert module._start_lan_listener(children, "C:/theDAW/frontend") is False
    assert len(killed) == 1, "the refused listener is killed, not leaked"
    assert children == ["early"]
    assert any("stopping" in line for line in lines), lines


def test_a_backend_that_arrives_during_shutdown_is_killed_by_its_own_thread(
    devstack, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The backend supervisor is off the main thread as well, and its respawn
    loop can pass its own ``_shutdown`` check, spawn ``backend.run``, and
    register after main()'s kill loop has taken its snapshot -- a backend that
    nothing will ever kill, holding :8600 against the next launch. So it goes
    through the same closed-registry gate as the LAN listener, and kills its
    own child when the gate refuses it."""
    module, spawns, lines = devstack
    monkeypatch.setattr(module, "_children_closed", True)
    monkeypatch.setattr(module, "_shutdown", threading.Event())
    monkeypatch.setattr(module, "_pump", lambda tag, proc: None)
    killed: list = []
    monkeypatch.setattr(module, "_kill_tree", killed.append)

    children: list = []
    module._run_backend(children)

    assert len(spawns) == 1, "the supervisor spawned one backend and stopped"
    assert children == [], "a backend registered too late is never in the list"
    assert len(killed) == 1, "the refused backend is killed, not leaked"
    assert any("stopping" in line for line in lines), lines


# ---------------------------------------------------------------------------
# electron-ui/main/index.ts — the desktop shell's wiring
#
# Read out of the source, like tests/test_launch_token_child_env.py: importing
# main/index.ts needs a real Electron.
# ---------------------------------------------------------------------------

ELECTRON_MAIN = REPO_ROOT / "electron-ui" / "main" / "index.ts"


def _bracketed(source: str, start: int, opening: str, closing: str) -> str:
    depth = 0
    for i in range(start, len(source)):
        if source[i] == opening:
            depth += 1
        elif source[i] == closing:
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
    raise AssertionError(f"index.ts: no {closing!r} closes offset {start}")


def _ts_function(source: str, name: str) -> tuple[int, int]:
    """The offsets of the body of ``function name`` in ``source``.

    The body brace is the LAST ``{`` on the declaration line, not the first:
    ``function f(): { command: string } {`` opens an object TYPE first, and
    taking that one would return the return type instead of the body.
    """
    match = re.search(rf"\b(?:async )?function {name}\(", source)
    assert match, f"index.ts has no function {name}"
    line_end = source.index("\n", match.end())
    start = source.rindex("{", match.end(), line_end)
    return start, start + len(_bracketed(source, start, "{", "}"))


@pytest.fixture(scope="module")
def electron_main() -> str:
    return ELECTRON_MAIN.read_text(encoding="utf-8")


def test_the_desktop_shell_starts_the_listener_from_the_frontend(
    electron_main: str,
) -> None:
    body = electron_main[slice(*_ts_function(electron_main, "startLanHttps"))]
    assert "lanListenerCommand(process.platform, plan)" in body
    assert "spawn(command, args" in body
    assert "env: lanListenerEnv(buildBaseEnv(), plan)" in body
    assert "cwd: frontendDir" in body
    assert "path.join(repoRoot, 'frontend')" in body


def test_the_desktop_shell_reads_the_shared_plan_rather_than_deciding_again(
    electron_main: str,
) -> None:
    """The decision lives in backend/lib/lan_https.py. Two copies of it would
    let the two launchers disagree about the same machine."""
    plan_cmd = electron_main[slice(*_ts_function(electron_main, "lanHttpsPlanCommand"))]
    assert "'backend.lib.lan_https'" in plan_cmd
    assert "'--json'" in plan_cmd
    reader = electron_main[slice(*_ts_function(electron_main, "readLanHttpsPlan"))]
    assert "env: buildBaseEnv()" in reader, "the plan child gets no launch token"
    assert "parseLanHttpsPlan(stdout)" in reader


def test_the_plan_is_parsed_once_its_stdout_has_actually_drained(
    electron_main: str,
) -> None:
    """'close', not 'exit'. 'exit' fires when the process ends, while its stdio
    pipes can still carry buffered data, so the parse could see a truncated
    final line -- and the plan IS the last line -- turning a good plan into "no
    plan" and the launch into a silent no-listener. 'close' fires after every
    stream is drained and closed."""
    reader = electron_main[slice(*_ts_function(electron_main, "readLanHttpsPlan"))]
    assert "proc.on('close'" in reader
    assert "proc.on('exit'" not in reader, "'exit' can fire with stdout unflushed"
    closed = reader[reader.index("proc.on('close'") :]
    body = _bracketed(closed, closed.index("{"), "{", "}")
    assert "done(parseLanHttpsPlan(stdout))" in body
    # The timeout and the process handle are released there too, not left in a
    # handler that no longer runs.
    assert "clearTimeout(deadline)" in body
    assert "release()" in body


def test_the_packaged_app_starts_no_listener(electron_main: str) -> None:
    """A packaged build serves its UI over app:// -- there is no dev server to
    mirror, and spawning npx from an installed app would only fail."""
    body = electron_main[slice(*_ts_function(electron_main, "startLanHttps"))]
    guard = re.search(r"if \(app\.isPackaged[^)]*\) return", body)
    assert guard, body[:400]
    assert "isQuitting" in guard.group(0)


def test_the_window_never_waits_for_the_listener(electron_main: str) -> None:
    assert "void startLanHttps()" in electron_main
    assert "await startLanHttps()" not in electron_main


def test_the_listener_dies_with_the_app(electron_main: str) -> None:
    kill_backend = _ts_function(electron_main, "killBackend")
    body = electron_main[slice(*kill_backend)]
    # Before killBackend's early return, which fires when this process did not
    # spawn the backend -- the listener is still ours in that case.
    assert body.index("killLanHttps()") < body.index("if (!backendProcess")

    will_quit = electron_main.index("app.on('will-quit'")
    assert "killLanHttps()" in electron_main[will_quit : will_quit + 800]


def test_the_listener_is_killed_as_a_tree_on_windows(electron_main: str) -> None:
    """It is started through ``cmd /c``, so killing the shell alone leaves a
    vite process holding the port against the next launch."""
    body = electron_main[slice(*_ts_function(electron_main, "killLanHttps"))]
    assert "killLanChild(listener" in body
    tree = electron_main[slice(*_ts_function(electron_main, "killLanChild"))]
    assert "'/F', '/T', '/PID'" in tree
    assert "env: buildBaseEnv()" in tree


def test_the_electron_helper_runs_under_plain_node(electron_main: str) -> None:
    """main/lanHttps.ts is the pure half and must stay importable without
    Electron, the way main/downloadNaming.ts is -- that is what lets
    main/lanHttps.test.ts run at all."""
    helper = (REPO_ROOT / "electron-ui" / "main" / "lanHttps.ts").read_text(
        encoding="utf-8"
    )
    assert "from 'electron'" not in helper
    assert "require('electron')" not in helper
    assert "THEDAW_LAUNCH_TOKEN" in helper, "the helper strips the token itself"


def test_the_electron_helper_has_its_own_test_and_ci_runs_it() -> None:
    """``frontend/package.json``'s ``test:electron`` is the ONLY thing that runs
    a ``*.test.ts`` under electron-ui/main (``npm test`` discovers frontend/src
    only). A suite missing from that script is a suite nothing runs -- which is
    what this one was: it existed, it passed, and no gate would have noticed it
    breaking."""
    import json

    assert (REPO_ROOT / "electron-ui" / "main" / "lanHttps.test.ts").is_file()
    scripts = json.loads(
        (REPO_ROOT / "frontend" / "package.json").read_text(encoding="utf-8")
    )["scripts"]
    assert "lanHttps.test.ts" in scripts["test:electron"]


def test_the_plan_child_is_tracked_so_quitting_takes_it_with_it(
    electron_main: str,
) -> None:
    """A cold ``uv run`` can take tens of seconds. Quitting in that window used
    to leave the plan child (and, through the shell it runs under, its tree)
    behind, and its own timeout killed only the process the shell held."""
    assert "let lanPlanProcess: ChildProcess | null = null" in electron_main
    reader = electron_main[slice(*_ts_function(electron_main, "readLanHttpsPlan"))]
    assert "lanPlanProcess = proc" in reader
    assert "killLanChild(proc" in reader, (
        "the timeout kills the tree, not just the shell"
    )

    kill = electron_main[slice(*_ts_function(electron_main, "killLanHttps"))]
    assert "lanPlanProcess" in kill, "the plan child dies with the app too"
    # One Windows path for both children, the one killLanHttps always used.
    tree = electron_main[slice(*_ts_function(electron_main, "killLanChild"))]
    assert "'/F', '/T', '/PID'" in tree
    assert "env: buildBaseEnv()" in tree


def test_a_child_already_taken_down_by_a_signal_is_not_killed_again(
    electron_main: str,
) -> None:
    """node reports an exit code OR a signal, never both: a listener taskkill
    has already stopped has exitCode === null and signalCode set. Testing only
    exitCode logged a second "Stopping..." and, on Windows, ran another taskkill
    against a pid the OS is free to have reused by then."""
    tree = electron_main[slice(*_ts_function(electron_main, "killLanChild"))]
    assert "proc.exitCode !== null" in tree
    assert "proc.signalCode !== null" in tree


def test_a_port_someone_else_holds_is_said_out_loud_rather_than_guessed_at(
    electron_main: str,
) -> None:
    """vite's strictPort exits 1 and the log said only "the listener exited
    (code=1)". A 300 ms connect first turns that into the actual reason, and
    there is no retry loop fighting whatever owns the port."""
    body = electron_main[slice(*_ts_function(electron_main, "startLanHttps"))]
    assert "await portIsHeld(plan.port)" in body
    assert "already in use" in body
    probe = electron_main[slice(*_ts_function(electron_main, "portIsHeld"))]
    assert "'127.0.0.1'" in probe
    assert "setTimeout(300" in probe
    # Node's own net, not Electron's `net` (which this file already imports).
    assert re.search(r"import \{ connect as netConnect \} from 'net'", electron_main)


# ---------------------------------------------------------------------------
# GET /api/network/lan
# ---------------------------------------------------------------------------


@pytest.fixture
def network_router(monkeypatch: pytest.MonkeyPatch):
    """The network router with its probe cache emptied and its probe stubbed
    off, so no test opens a socket to the real LAN port."""
    from backend.modules.network import router as network

    monkeypatch.setattr(network, "_probe_cache", {})
    monkeypatch.setattr(
        network, "_probe_once", lambda port: pytest.fail("unstubbed probe")
    )
    monkeypatch.setattr(network.lan_https, "detect_lan_ips", lambda: LAN)
    return network


def test_the_route_is_mounted_where_the_ui_looks_for_it() -> None:
    import json

    from backend.modules.network import router as network

    manifest = json.loads(
        (REPO_ROOT / "backend" / "modules" / "network" / "module.json").read_text(
            encoding="utf-8"
        )
    )
    assert manifest["api_prefix"] == "/api/network"
    assert manifest["enabled"] is True
    assert [r.path for r in network.router.routes] == ["/lan"]


def test_the_https_address_is_offered_only_while_something_is_listening(
    network_router: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A link to a port nothing answers on is worse than no link: the person
    walks to the other device, scans the code, and gets a connection error."""
    monkeypatch.setattr(network_router, "_probe_once", lambda port: True)
    answer = network_router.get_lan()
    assert answer == {
        "lan_ip": "192.168.1.34",
        "http_port": ports.FRONTEND_PORT,
        "https_port": ports.LAN_HTTPS_PORT,
        "https_url": f"https://192.168.1.34:{ports.LAN_HTTPS_PORT}",
    }

    monkeypatch.setattr(network_router, "_probe_cache", {})
    monkeypatch.setattr(network_router, "_probe_once", lambda port: False)
    dead = network_router.get_lan()
    assert dead["https_url"] is None
    assert dead["lan_ip"] == "192.168.1.34"
    assert dead["https_port"] == ports.LAN_HTTPS_PORT


def test_the_http_port_is_the_one_the_web_ui_really_took(
    network_router: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Whoever started the web UI tells this process the port it serves on
    (theDAW_FRONTEND_PORT). The address handed to a second device is that
    port, never one assumed from the table."""
    monkeypatch.setattr(network_router, "_probe_once", lambda port: False)
    monkeypatch.setenv("theDAW_FRONTEND_PORT", "5178")
    assert network_router.get_lan()["http_port"] == 5178

    monkeypatch.delenv("theDAW_FRONTEND_PORT")
    monkeypatch.setattr(network_router, "_probe_cache", {})
    assert network_router.get_lan()["http_port"] == ports.FRONTEND_PORT


def test_an_offline_machine_answers_with_nulls_not_an_error(
    network_router: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(network_router.lan_https, "detect_lan_ips", lambda: [])
    monkeypatch.setattr(network_router, "_probe_once", lambda port: True)
    answer = network_router.get_lan()
    assert answer["lan_ip"] is None
    assert answer["https_url"] is None


def test_the_route_follows_the_port_override(
    network_router: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(lan_https.ENV_PORT, "6443")
    monkeypatch.setattr(network_router, "_probe_once", lambda port: port == 6443)
    answer = network_router.get_lan()
    assert answer["https_port"] == 6443
    assert answer["https_url"] == "https://192.168.1.34:6443"


def test_the_probe_runs_at_most_once_every_five_seconds(
    network_router: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the cache a UI that polls this route opens a socket per poll;
    with a longer one the address stays stale after the listener comes up."""
    probes: list[int] = []
    monkeypatch.setattr(
        network_router, "_probe_once", lambda port: (probes.append(port), True)[1]
    )

    assert network_router.https_listening(5443, now=100.0) is True
    assert network_router.https_listening(5443, now=101.0) is True
    assert network_router.https_listening(5443, now=104.9) is True
    assert probes == [5443], "the answer inside the window came from the cache"

    assert network_router.https_listening(5443, now=105.1) is True
    assert probes == [5443, 5443], "the cache expired after five seconds"

    # A different port is a different question.
    assert network_router.https_listening(6443, now=105.2) is True
    assert probes == [5443, 5443, 6443]


def test_a_cached_answer_of_false_is_cached_too(
    network_router: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The expensive case: nothing is listening, so every probe pays the
    connect timeout. Caching only the hit would leave that per request."""
    probes: list[int] = []
    monkeypatch.setattr(
        network_router, "_probe_once", lambda port: (probes.append(port), False)[1]
    )
    assert network_router.https_listening(5443, now=10.0) is False
    assert network_router.https_listening(5443, now=12.0) is False
    assert probes == [5443]


def test_the_probe_never_leaves_a_socket_open_on_a_dead_port() -> None:
    """_probe_once against a port nothing holds returns False rather than
    raising. Uses an ephemeral port this process just released -- never the
    real LAN port."""
    import socket
    from contextlib import closing

    from backend.modules.network import router as network

    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as probe:
        probe.bind(("127.0.0.1", 0))
        free = probe.getsockname()[1]
    assert network._probe_once(free) is False


# ---------------------------------------------------------------------------
# the launchers' own sanity
# ---------------------------------------------------------------------------


def test_the_devstack_still_compiles_after_the_edit() -> None:
    """_devstack is started as ``python -m backend._devstack`` by theDAW.bat,
    where a syntax error is a launch that dies with no window."""
    done = subprocess.run(
        [
            "python",
            "-c",
            "import ast,pathlib;ast.parse(pathlib.Path('backend/_devstack.py').read_bytes())",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert done.returncode == 0, done.stderr


def test_the_switch_record_is_ignored_by_git() -> None:
    """The record :func:`lan_https.record_path` puts beside data/settings.json
    is per machine, like settings.json itself: a checkout that ran the app
    listed data/lan_https.json as an untracked file in git status, one
    `git add .` away from being committed."""
    record = lan_https.record_path(REPO_ROOT / "data" / "settings.json")
    done = subprocess.run(
        ["git", "check-ignore", "-q", record.relative_to(REPO_ROOT).as_posix()],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if done.returncode == 128:
        pytest.skip(f"not a git checkout: {done.stderr.strip()}")
    assert done.returncode == 0, f"{record.name} is not git-ignored"
