"""No process the backend starts holds the desktop shell's launch token.

The token lets a request pass as the desktop shell (backend.lib.launch_token).
Sidecars, installers and plugin hosts run third-party code, so every spawn takes
its environment from ``child_env``. Each module test puts the token in this
process's environment, starts that module's child with the spawn replaced by a
recorder, and reads the environment the child was handed.
"""

from __future__ import annotations

import ast
import asyncio
import io
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from backend.lib import launch_token

REPO_ROOT = Path(__file__).resolve().parents[1]
SECRET = "launch-secret-for-tests"
PROBE = "THEDAW_CHILD_ENV_PROBE"
# These start the backend itself, which needs the token.
LAUNCHERS = {"backend/_supervisor.py", "backend/_devstack.py"}
SPAWN_ATTRS = {"Popen", "run", "call", "check_output", "check_call"}


@pytest.fixture(autouse=True)
def token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, SECRET)
    monkeypatch.setenv(PROBE, "kept")


class _FakeProc:
    """A child that has already exited."""

    pid = 4242
    returncode = 0

    def __init__(self) -> None:
        self.stdout = io.StringIO("")

    def poll(self) -> int:
        return 0

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass


class _Spawns:
    """Stands in for subprocess.Popen, run and call, and keeps what each call
    was handed as (function, command, env)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any, dict[str, str] | None]] = []

    def _keep(self, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        cmd = args[0] if args else kwargs.get("args")
        self.calls.append((name, cmd, kwargs.get("env")))
        return cmd

    def popen(self, *args: Any, **kwargs: Any) -> _FakeProc:
        self._keep("Popen", args, kwargs)
        return _FakeProc()

    def run(self, *args: Any, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
        cmd = self._keep("run", args, kwargs)
        empty: Any = "" if kwargs.get("text") else b""
        return subprocess.CompletedProcess(cmd, 0, empty, empty)

    def call(self, *args: Any, **kwargs: Any) -> int:
        self._keep("call", args, kwargs)
        return 0

    def install(self, monkeypatch: pytest.MonkeyPatch, module: Any) -> _Spawns:
        monkeypatch.setattr(module.subprocess, "Popen", self.popen)
        monkeypatch.setattr(module.subprocess, "run", self.run)
        monkeypatch.setattr(module.subprocess, "call", self.call)
        return self

    def of(self, name: str) -> list[dict[str, str] | None]:
        return [env for fn, _cmd, env in self.calls if fn == name]


def _assert_clean(envs: list[dict[str, str] | None]) -> None:
    assert envs, "the child was never started"
    for env in envs:
        assert env is not None, "the child inherited this process's environment"
        assert launch_token.ENV_VAR not in {k.upper() for k in env}
        assert SECRET not in env.values()
        assert env.get(PROBE) == "kept"


def _not_listening(*_args: Any, **_kwargs: Any) -> bool:
    return False


# ---------------------------------------------------------------------------
# child_env
# ---------------------------------------------------------------------------


def test_child_env_leaves_out_the_token_and_keeps_the_rest() -> None:
    env = launch_token.child_env()
    assert launch_token.ENV_VAR not in env
    assert env[PROBE] == "kept"
    env["THEDAW_ADDED_IN_TEST"] = "1"
    assert "THEDAW_ADDED_IN_TEST" not in os.environ
    assert os.environ[launch_token.ENV_VAR] == SECRET


def test_child_env_of_a_mapping_matches_the_name_without_case() -> None:
    base = {"thedaw_launch_token": "a", "Thedaw_Launch_Token": "b", "PATH": "p"}
    assert launch_token.child_env(base) == {"PATH": "p"}
    assert len(base) == 3


def _spawn_calls(tree: ast.AST) -> list[ast.Call]:
    found = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        owner = node.func.value
        if not isinstance(owner, ast.Name):
            continue
        if (owner.id == "subprocess" and node.func.attr in SPAWN_ATTRS) or (
            owner.id == "asyncio" and node.func.attr == "create_subprocess_exec"
        ):
            found.append(node)
    return found


def _is_os_environ(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "environ"
        and isinstance(node.value, ast.Name)
        and node.value.id == "os"
    )


def _copies_os_environ(node: ast.AST) -> bool:
    if isinstance(node, ast.Call):
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "copy"
            and _is_os_environ(func.value)
        ):
            return True
        if (
            isinstance(func, ast.Name)
            and func.id == "dict"
            and node.args
            and _is_os_environ(node.args[0])
        ):
            return True
    if isinstance(node, ast.Dict):
        return any(
            k is None and _is_os_environ(v) for k, v in zip(node.keys, node.values)
        )
    return False


def _tracked_backend_sources() -> list[str]:
    """Every tracked .py file under backend/, relative to the repo root."""
    tracked = subprocess.run(
        ["git", "ls-files", "backend"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    # backend/deprecated/ is an archive of retired code that nothing imports; it
    # is kept as it was, not maintained.
    return [
        rel
        for rel in tracked
        if rel.endswith(".py") and not rel.startswith("backend/deprecated/")
    ]


def test_every_backend_spawn_names_its_environment() -> None:
    """A spawn with no ``env`` inherits the token. A copy of ``os.environ``
    carries it too, so the backend builds child environments only through
    child_env."""
    missing: list[str] = []
    copies: list[str] = []
    for rel in _tracked_backend_sources():
        if rel in LAUNCHERS:
            continue
        tree = ast.parse((REPO_ROOT / rel).read_bytes())
        for call in _spawn_calls(tree):
            if not any(k.arg == "env" for k in call.keywords):
                missing.append(f"{rel}:{call.lineno}")
        for node in ast.walk(tree):
            if _copies_os_environ(node):
                copies.append(f"{rel}:{node.lineno}")
    assert missing == []
    assert copies == []


def _os_startfile_uses(tree: ast.AST) -> list[int]:
    """The lines that name ``os.startfile``, as an attribute or an import."""
    lines: list[int] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and node.attr == "startfile"
            and isinstance(node.value, ast.Name)
            and node.value.id in {"os", "nt"}
        ):
            lines.append(node.lineno)
        elif (
            isinstance(node, ast.ImportFrom)
            and node.module in {"os", "nt"}
            and any(alias.name == "startfile" for alias in node.names)
        ):
            lines.append(node.lineno)
    return sorted(lines)


def test_no_backend_code_opens_a_path_with_os_startfile() -> None:
    """os.startfile takes no environment, so whatever it launches inherits the
    token. A route that opens a path starts Explorer, or backend.lib.reveal,
    with child_env. The launchers are checked too."""
    sample = "import os\nfrom os import startfile\nos.startfile('x')\n"
    assert _os_startfile_uses(ast.parse(sample)) == [2, 3]

    found = [
        f"{rel}:{line}"
        for rel in _tracked_backend_sources()
        for line in _os_startfile_uses(ast.parse((REPO_ROOT / rel).read_bytes()))
    ]
    assert found == []


# ---------------------------------------------------------------------------
# /api/storage/open
# ---------------------------------------------------------------------------


def _storage_open_under(
    monkeypatch: pytest.MonkeyPatch, models: Path
) -> tuple[Any, _Spawns]:
    """The storage router with ``models`` as its only open root, on Windows, and
    its spawns recorded."""
    from backend.modules.storage import router as storage_router

    models.mkdir()
    root = os.path.normpath(str(models)).lower()
    monkeypatch.setattr(storage_router, "_allowed_open_roots", lambda: [root])
    monkeypatch.setattr(storage_router.sys, "platform", "win32")
    return storage_router, _Spawns().install(monkeypatch, storage_router)


def test_opening_a_model_location_starts_explorer_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    models = tmp_path / "models"
    storage_router, spawns = _storage_open_under(monkeypatch, models)

    body = storage_router.OpenBody(path=str(models))
    assert storage_router.storage_open(body) == {"opened": str(models)}
    assert [(fn, cmd) for fn, cmd, _env in spawns.calls] == [
        ("Popen", ["explorer", str(models)])
    ]
    _assert_clean(spawns.of("Popen"))


def test_a_missing_or_escaping_location_starts_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fastapi import HTTPException

    models = tmp_path / "models"
    storage_router, spawns = _storage_open_under(monkeypatch, models)
    (tmp_path / "outside").mkdir()

    answers = {
        str(models / "gone"): 404,
        # Under the root as typed, outside it once '..' is resolved.
        os.path.join(str(models), "..", "outside"): 403,
    }
    for path, status in answers.items():
        with pytest.raises(HTTPException) as refused:
            storage_router.storage_open(storage_router.OpenBody(path=path))
        assert refused.value.status_code == status, path
    assert spawns.calls == []


# ---------------------------------------------------------------------------
# The desktop shell (electron-ui/main/index.ts)
# ---------------------------------------------------------------------------

ELECTRON_MAIN = REPO_ROOT / "electron-ui" / "main" / "index.ts"
_TS_SPAWN = re.compile(
    r"(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\("
)


def _bracketed(source: str, start: int, opening: str, closing: str) -> str:
    """The text from the ``opening`` bracket at ``start`` to its match."""
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
    """The offsets of the body of ``function name`` in ``source``."""
    match = re.search(rf"\bfunction {name}\(", source)
    assert match, f"index.ts has no function {name}"
    start = source.index("{", match.end())
    return start, start + len(_bracketed(source, start, "{", "}"))


#: The one spawn that cannot pass ``buildBaseEnv()`` straight through: the LAN
#: HTTPS listener needs three more names (main/lanHttps.ts). It is still built
#: FROM buildBaseEnv(), and lanListenerEnv drops the token a second time --
#: asserted separately below, and behaviourally in main/lanHttps.test.ts.
LAN_LISTENER_ENV = "env: lanListenerEnv(buildBaseEnv(), plan)"


def test_the_desktop_shell_hands_the_token_only_to_the_backend() -> None:
    """The main process starts uv sync, an import probe, taskkill and the LAN
    HTTPS listener as well as the backend. uv sync runs package build scripts,
    so only spawnBackend uses buildBackendEnv, and every other spawn gets
    buildBaseEnv, which drops an inherited THEDAW_LAUNCH_TOKEN whatever its
    case."""
    source = ELECTRON_MAIN.read_text(encoding="utf-8")
    backend = _ts_function(source, "spawnBackend")
    with_token = _ts_function(source, "buildBackendEnv")
    base = _ts_function(source, "buildBaseEnv")

    def within(span: tuple[int, int], offsets: list[int]) -> bool:
        return bool(offsets) and all(span[0] <= at < span[1] for at in offsets)

    token_set = [
        m.start()
        for m in re.finditer(r"THEDAW_LAUNCH_TOKEN\s*[:=]\s*LAUNCH_TOKEN\b", source)
    ]
    assert within(with_token, token_set)
    backend_env_calls = [
        m.start() for m in re.finditer(r"\bbuildBackendEnv\(\)(?!\s*:)", source)
    ]
    assert within(backend, backend_env_calls)
    assert "const env = buildBackendEnv()" in source[slice(*backend)]

    base_body = source[slice(*base)]
    assert re.search(r"\.toUpperCase\(\)\s*===\s*'THEDAW_LAUNCH_TOKEN'", base_body)
    assert "delete env[" in base_body
    assert "env: buildBaseEnv()" in source[slice(*_ts_function(source, "runUvSync"))]

    spawns = list(_TS_SPAWN.finditer(source))
    assert spawns
    for m in spawns:
        args = _bracketed(source, m.end() - 1, "(", ")")
        where = f"index.ts:{source.count(chr(10), 0, m.start()) + 1}"
        if backend[0] <= m.start() < backend[1]:
            assert re.search(r"\benv\b", args), where
        else:
            assert "env: buildBaseEnv()" in args or LAN_LISTENER_ENV in args, where


def test_the_lan_listeners_environment_drops_the_token_a_second_time() -> None:
    """main/lanHttps.ts adds three names to buildBaseEnv()'s result, so it is
    the one place a future caller could hand the listener a base that still
    carried the token. It removes it itself, under every spelling, exactly as
    buildBaseEnv does -- vite runs the frontend's own devDependencies, and
    none of that may send X-TheDAW-Launch-Token."""
    helper = (REPO_ROOT / "electron-ui" / "main" / "lanHttps.ts").read_text(
        encoding="utf-8"
    )
    assert re.search(r"\.toUpperCase\(\)\s*===\s*LAUNCH_TOKEN_ENV", helper)
    assert "const LAUNCH_TOKEN_ENV = 'THEDAW_LAUNCH_TOKEN'" in helper
    assert "delete env[" in helper
    # And it never writes one back in.
    assert not re.search(r"env\[\s*LAUNCH_TOKEN_ENV\s*\]\s*=", helper)
    assert "THEDAW_LAUNCH_TOKEN" not in helper.replace(
        "const LAUNCH_TOKEN_ENV = 'THEDAW_LAUNCH_TOKEN'", ""
    ), "the name belongs only where it is declared, to be removed"


def test_the_lan_https_listener_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The web launcher's second Vite listener (backend/_devstack.py). The
    launchers are exempt from the static scan above because they start the
    backend, which DOES need the token -- so this child is checked by running
    the start and reading what it was handed."""
    from backend import _devstack
    from backend.lib import lan_cert, lan_https

    cert = lan_cert.CertPaths(
        cert=tmp_path / "lan-cert.pem", key=tmp_path / "lan-key.pem"
    )
    plan = lan_https.plan_lan_https(
        {},
        {},
        ["192.168.1.34"],
        cert,
        vite="C:/theDAW/frontend/node_modules/.bin/vite.cmd",
    )
    monkeypatch.setattr(_devstack.lan_https, "resolve_plan", lambda: plan)
    # Pass-through, so a launch that happens to have it set is not what makes
    # the assertion below pass.
    monkeypatch.delenv("ENABLE_HMR", raising=False)
    # The real describe_occupant binds the port to find out who holds it.
    monkeypatch.setattr(_devstack.ports, "describe_occupant", lambda port: None)
    monkeypatch.setattr(_devstack, "_emit", lambda tag, line: None)
    spawns = _Spawns().install(monkeypatch, _devstack)

    assert _devstack._start_lan_listener([], str(tmp_path)) is True
    [env] = spawns.of("Popen")
    _assert_clean([env])
    assert env is not None
    assert env[lan_https.ENV_CERT] == str(cert.cert)
    assert env[lan_https.ENV_KEY] == str(cert.key)
    # ENABLE_HMR is passed through from the base rather than forced on here,
    # so the listener starts no watcher the launcher did not ask for.
    assert "ENABLE_HMR" not in env


# ---------------------------------------------------------------------------
# One test per sidecar module
# ---------------------------------------------------------------------------


def test_the_foundry_server_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.foundry import sidecar

    monkeypatch.setenv("THEDAW_FOUNDRY_PROJECT", str(tmp_path))
    monkeypatch.delenv("THEDAW_FOUNDRY_DEV", raising=False)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_is_foundry_server", _not_listening)
    monkeypatch.setattr(sidecar, "_port_is_listening", _not_listening)
    monkeypatch.setattr(
        sidecar, "_production_server", lambda cfg: tmp_path / "dist" / "server.cjs"
    )
    monkeypatch.setattr(sidecar, "_resolve_node", lambda: "node")
    monkeypatch.setattr(sidecar, "_LOG_PATH", tmp_path / "logs" / "foundry.log")
    spawns = _Spawns().install(monkeypatch, sidecar)

    sidecar.ensure_running(wait_for_ready=False)
    [env] = spawns.of("Popen")
    _assert_clean([env])
    assert env is not None and env["NODE_ENV"] == "production"


@pytest.mark.skipif(
    sys.platform not in ("win32", "linux"), reason="the Kinect sidecar runs there"
)
def test_the_kinect_capture_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.akvj import sidecar

    script = tmp_path / "kinect_sidecar.py"
    script.write_text("", encoding="utf-8")
    monkeypatch.setattr(sidecar, "SCRIPT", script)
    spawns = _Spawns().install(monkeypatch, sidecar)
    capture = sidecar.AkvjSidecar()
    monkeypatch.setattr(capture, "_ensure_deps", lambda: None)
    monkeypatch.setattr(capture, "_native_runtime_ok", lambda: (True, ""))

    capture.start()
    [env] = spawns.of("Popen")
    _assert_clean([env])
    assert env is not None and env["AKVJ_WS_URL"]
    # status() probes the capture deps with a Python of its own.
    _assert_clean(spawns.of("run"))


def test_the_quest_cast_relay_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.modules.questcast import sidecar

    monkeypatch.setattr(sidecar, "_node_path", lambda: "node")
    monkeypatch.setattr(sidecar, "_adb_path", lambda: "adb")
    spawns = _Spawns().install(monkeypatch, sidecar)
    relay = sidecar.QuestCastSidecar()
    monkeypatch.setattr(relay, "_ensure_bootstrap", lambda: None)

    relay.start("QUEST123")
    [env] = spawns.of("Popen")
    _assert_clean([env])
    assert env is not None and env["QUESTCAST_DEVICE_SERIAL"] == "QUEST123"
    # The adb server it starts first.
    _assert_clean(spawns.of("run"))


def test_the_underfit_dashboard_and_its_setup_start_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.underfit import sidecar

    monkeypatch.setenv("theDAW_UNDERFIT_PROJECT", str(tmp_path))
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "_setup", dict(sidecar._setup))
    monkeypatch.setattr(sidecar, "_port_is_listening", _not_listening)
    monkeypatch.setattr(sidecar, "probe", lambda: {"issues": []})
    monkeypatch.setattr(sidecar, "LOG_PATH", tmp_path / "underfit.log")
    spawns = _Spawns().install(monkeypatch, sidecar)

    sidecar.ensure_running(wait_for_ready=False)
    sidecar._setup_worker(sidecar.resolve_config(), "uv")
    dashboard, setup = spawns.of("Popen")
    _assert_clean([dashboard, setup])
    assert dashboard is not None and dashboard["UNDERFIT_DASHBOARD_PORT"]
    assert [cmd for fn, cmd, _ in spawns.calls if fn == "Popen"][1][:2] == [
        "uv",
        "sync",
    ]


def test_the_lyria_server_and_its_install_start_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.lyria import sidecar

    monkeypatch.setenv("theDAW_LYRIA_PROJECT", str(tmp_path))
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_port_is_listening", _not_listening)
    monkeypatch.setattr(sidecar, "gemini_key", lambda: (None, "none"))
    monkeypatch.setattr(sidecar, "SIDECAR_LOG_PATH", tmp_path / "lyria.log")
    spawns = _Spawns().install(monkeypatch, sidecar)

    # No node_modules yet: npm install runs first, then the server.
    sidecar.ensure_running(wait_for_ready=False)
    _assert_clean(spawns.of("call"))
    [env] = spawns.of("Popen")
    _assert_clean([env])
    assert env is not None and env["PORT"] == str(sidecar.resolve_config().port)


def test_the_magenta_engine_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.magenta import sidecar

    script = tmp_path / "server.py"
    script.write_text("", encoding="utf-8")
    python = tmp_path / "python"
    python.write_text("", encoding="utf-8")
    monkeypatch.setattr(sidecar, "_engine_proc", None)
    monkeypatch.setattr(sidecar, "_ENGINE_SCRIPT", script)
    monkeypatch.setattr(sidecar, "_NATIVE_PYTHON", str(python))
    monkeypatch.setattr(sidecar, "_LOG_DIR", tmp_path / "logs")
    # The native spawn records the engine pid; it belongs in tmp_path.
    monkeypatch.setattr(sidecar, "_PID_FILE", tmp_path / "magenta_engine.pid")
    monkeypatch.setattr(sidecar, "_wsl_distro", lambda: "Ubuntu")
    monkeypatch.setattr(sidecar, "_resolve_start_model", lambda: ("mrt2_small", None))
    spawns = _Spawns().install(monkeypatch, sidecar)

    assert sidecar.start_engine()["spawned"] is True
    _assert_clean(spawns.of("Popen"))


def test_the_stems_server_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.stems import sidecar

    package = tmp_path / "pkg"
    package.mkdir()
    (package / "run_backend.py").write_text("", encoding="utf-8")
    config = sidecar.SidecarConfig(package_path=package, python_exe=tmp_path / "py")
    monkeypatch.setattr(
        sidecar, "probe", lambda cfg=None: {"critical_ok": True, "missing_critical": []}
    )
    spawns = _Spawns().install(monkeypatch, sidecar)

    # The recorded child has exited, so the start reports it never wrote a port.
    with pytest.raises(RuntimeError, match="backend_port.txt"):
        sidecar.StemsSidecar(config).ensure_running()
    _assert_clean(spawns.of("Popen"))

    # The package probe runs the sidecar's Python too.
    sidecar._probe_packages(config.python_exe)
    _assert_clean(spawns.of("run"))


def test_the_whisper_worker_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.vocal.transcription import sidecar

    config = sidecar.WhisperConfig(
        venv_base=tmp_path,
        python_exe=tmp_path / "python",
        model="small",
        device="cpu",
        compute_type="int8",
    )
    envs: list[dict[str, str] | None] = []

    class _Worker:
        returncode = 0

        async def communicate(self, data: bytes) -> tuple[bytes, bytes]:
            return b'{"ok": true, "language": "en", "text": "", "segments": []}\n', b""

        def kill(self) -> None:  # pragma: no cover - never reached
            pass

    async def fake_exec(*args: Any, **kwargs: Any) -> _Worker:
        envs.append(kwargs.get("env"))
        return _Worker()

    monkeypatch.setattr(sidecar, "ensure_ready", lambda cfg=None: {"critical_ok": True})
    monkeypatch.setattr(sidecar.asyncio, "create_subprocess_exec", fake_exec)

    result = asyncio.run(sidecar.transcribe(Path("song.wav"), "en", cfg=config))
    assert result["ok"] is True
    _assert_clean(envs)


def test_the_vj_build_and_server_start_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend.modules.vj import sidecar

    # _vite_bin_js spawns VJ-9000's vite CLI directly (node
    # node_modules/vite/bin/vite.js) instead of going through npm scripts,
    # so the fixture must stub that exact file, not just node_modules/.
    vite_js = tmp_path / "node_modules" / "vite" / "bin" / "vite.js"
    vite_js.parent.mkdir(parents=True)
    vite_js.write_text("", encoding="utf-8")
    monkeypatch.setenv("theDAW_VJ_PROJECT", str(tmp_path))
    monkeypatch.delenv("theDAW_VJ_DEV", raising=False)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "_port_is_listening", _not_listening)
    monkeypatch.setattr(sidecar, "SIDECAR_LOG_PATH", tmp_path / "vj.log")
    spawns = _Spawns().install(monkeypatch, sidecar)

    # No dist/ yet: npm run build runs, then vite preview.
    sidecar.ensure_running(wait_for_ready=False)
    _assert_clean(spawns.of("run"))
    _assert_clean(spawns.of("Popen"))


def test_a_gpu_model_server_starts_without_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.core import sidecar

    envs: list[dict[str, str] | None] = []

    async def fake_exec(*args: Any, **kwargs: Any) -> SimpleNamespace:
        envs.append(kwargs.get("env"))
        return SimpleNamespace(returncode=1)

    async def unhealthy(self: Any) -> bool:
        return False

    monkeypatch.setattr(sidecar.GPUSidecar, "_healthy", unhealthy)
    monkeypatch.setattr(sidecar.asyncio, "create_subprocess_exec", fake_exec)
    server = sidecar.GPUSidecar("restore", server_cmd=["python", "-V"], boot_timeout=5)

    with pytest.raises(sidecar.SidecarUnavailable):
        asyncio.run(server.ensure())
    _assert_clean(envs)


def test_the_dependency_sync_after_an_update_runs_without_the_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from backend import _update_sync

    (tmp_path / "frontend").mkdir()
    (tmp_path / "frontend" / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(_update_sync.shutil, "which", lambda name: name)
    spawns = _Spawns().install(monkeypatch, _update_sync)

    assert _update_sync.run_dependency_sync(tmp_path, lambda line: None) == 0
    assert [cmd[:2] for fn, cmd, _ in spawns.calls] == [
        ["uv", "sync"],
        ["npm", "install"],
    ]
    _assert_clean(spawns.of("Popen"))
