"""The launch-time live-VST-host check, wired the way the docs describe it.

``native/vst-host/README.md`` ("At launch") specifies one flow: ``theDAW.bat``
runs ``scripts/check_vst_host.py`` and prints its status line verbatim, then --
only when the exe is missing, CMake is on PATH, ``THEDAW_SKIP_VST_HOST_BUILD``
is not ``1``, and no earlier decline is remembered -- offers the build through
``install\\setup.ps1 -VstHost``. It asks once: an interactive decline leaves
``native/vst-host/.build-declined`` behind and the launcher stops offering until
that file goes. Nothing in the flow may stop the launch. ``theDAW.sh`` prints the
not-available line and never offers, because the host is Windows-only.

The assertions are static, in the style of ``tests/test_launch_token_child_env.py``:
running ``theDAW.bat`` would start the app and running ``build.ps1`` would start a
compiler, so neither is executed here. The two PowerShell files are checked with
PowerShell's own parser, and everything that can run on its own is run as itself --
``build.ps1``'s build-directory resolution, ``setup.ps1``'s interactive-console
test and its marker helper, and ``setup.ps1 -VstHost`` end to end against a
throwaway copy of the tree, where the stand-in ``build.ps1`` throws if anything
ever tries to build.
"""

from __future__ import annotations

import importlib.util
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

BAT_PATH = REPO_ROOT / "theDAW.bat"
SH_PATH = REPO_ROOT / "theDAW.sh"
SETUP_PATH = REPO_ROOT / "install" / "setup.ps1"
BUILD_PATH = REPO_ROOT / "native" / "vst-host" / "build.ps1"
HOST_GITIGNORE = REPO_ROOT / "native" / "vst-host" / ".gitignore"

BAT = BAT_PATH.read_text(encoding="utf-8")
SH = SH_PATH.read_text(encoding="utf-8")
SETUP = SETUP_PATH.read_text(encoding="utf-8")
BUILD = BUILD_PATH.read_text(encoding="utf-8")

#: The interpreter theDAW.bat already uses for its other Python one-liners (the
#: launch-mode read, the desktop-deps staleness check), each guarded by an
#: ``if not exist`` that skips the step when the venv is not there yet.
LAUNCHER_PYTHON = r".venv\Scripts\python.exe"

#: The exact test theDAW.bat makes against the documented opt-out. Anchoring on
#: the expression rather than the bare variable name leaves the comments above
#: it free to say what the variable is for.
SKIP_GATE = '"!THEDAW_SKIP_VST_HOST_BUILD!"=="1"'

#: The invocation itself, as opposed to the comments that explain it.
CHECK_CALL = rf"{LAUNCHER_PYTHON} scripts\check_vst_host.py"

#: The substring theDAW.bat matches the status line against to decide whether
#: the exe is missing. ``test_the_not_built_gate_matches_the_real_status_lines``
#: holds it to the strings ``status_line`` actually returns.
NOT_BUILT = "not built"

#: Written by an interactive decline; while it exists the launcher does not
#: offer the build again. Relative to the repo root, which is theDAW.bat's cwd.
MARKER = r"native\vst-host\.build-declined"

#: The offer as invoked, not as named in the comments that explain it.
OFFER_CALL = r'-File "install\setup.ps1" -VstHost'

_POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")
requires_powershell = pytest.mark.skipif(
    sys.platform != "win32" or _POWERSHELL is None,
    reason="needs Windows PowerShell to parse and run the .ps1 fragments",
)


def _load_check_vst_host() -> ModuleType:
    """``scripts/`` is not a package, so the status script is loaded off disk."""
    path = REPO_ROOT / "scripts" / "check_vst_host.py"
    spec = importlib.util.spec_from_file_location("check_vst_host_for_launcher", path)
    assert spec is not None and spec.loader is not None, f"could not load {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _at(source: str, needle: str, *, where: str) -> int:
    """The single offset of ``needle`` in ``source``; fails if it is not unique."""
    first = source.find(needle)
    assert first != -1, f"{where}: {needle!r} is missing"
    assert source.find(needle, first + 1) == -1, f"{where}: {needle!r} appears twice"
    return first


def _bat_block() -> tuple[int, int]:
    """The offsets of theDAW.bat's live-VST-host block.

    It opens with the guard that skips the whole thing when the launcher's
    interpreter is absent and closes with the ERRORLEVEL reset, so everything
    the check does has to live between the two.
    """
    check = _at(BAT, CHECK_CALL, where="theDAW.bat")
    guard = BAT.rfind(f'if not exist "{LAUNCHER_PYTHON}"', 0, check)
    assert guard != -1, "theDAW.bat: the check is not guarded by an interpreter test"
    reset = BAT.find("ver >nul", check)
    assert reset != -1, "theDAW.bat: the check block never resets ERRORLEVEL"
    return guard, reset + len("ver >nul")


def _ps_function(source: str, name: str, *, where: str) -> str:
    """The body of ``function name`` in a PowerShell source, braces matched.

    Both spellings are in play here: setup.ps1 writes ``function Foo(){`` and
    build.ps1 writes ``function Foo {``, so the opening brace is found by
    scanning rather than by assuming a parameter list.
    """
    match = re.search(rf"\bfunction {re.escape(name)}\b", source)
    assert match, f"{where}: there is no function {name}"
    start = source.index("{", match.end())
    depth = 0
    for i in range(start, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[start : i + 1]
    raise AssertionError(f"{where}: function {name} is never closed")


def _run_powershell(script: str) -> subprocess.CompletedProcess[str]:
    """Run a PowerShell fragment with stdin redirected (never interactive)."""
    assert _POWERSHELL is not None
    return subprocess.run(
        [_POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120.0,
        stdin=subprocess.DEVNULL,
        cwd=REPO_ROOT,
    )


# ---------------------------------------------------------------------------
# theDAW.bat -- the check itself
# ---------------------------------------------------------------------------


def test_the_bat_runs_the_check_with_the_interpreter_it_already_uses() -> None:
    """The check runs on the launcher's own Python, captured in one ``for /f``.

    ``scripts/check_vst_host.py`` imports nothing from ``backend``, so any
    interpreter would do -- but the launcher has exactly one, the same
    ``.venv\\Scripts\\python.exe`` its launch-mode read uses, and reusing it
    keeps the check from adding a second way to find Python.
    """
    line = next(
        raw
        for raw in BAT.splitlines()
        if "check_vst_host.py" in raw and "::" not in raw
    )
    assert 'for /f "usebackq delims="' in line, line
    assert f"{LAUNCHER_PYTHON} scripts\\check_vst_host.py" in line
    assert "2^>nul" in line, "stderr from the check must not reach the console"
    # The same interpreter, spelled the same way, as the pre-existing one-liners.
    assert f"{LAUNCHER_PYTHON} -c" in BAT, "the launch-mode read is the precedent"


def test_a_missing_interpreter_skips_the_check_silently() -> None:
    """No venv yet -> jump clean over the block; no output, no prompt, no error."""
    start, end = _bat_block()
    guard_line = BAT[start : BAT.index("\n", start)]
    target = re.search(r"goto\s+(:\S+)", guard_line)
    assert target, f"theDAW.bat: the guard does not jump: {guard_line!r}"
    label = f"\n{target.group(1)}\n"
    assert label in BAT, f"theDAW.bat: {target.group(1)} is not a label"
    # The guard's landing point is past everything the block does.
    assert BAT.index(label) > BAT.index(OFFER_CALL)


def test_the_skip_path_never_enters_the_scoped_setlocal() -> None:
    """The one jump that leaves before ``setlocal`` also lands after ``endlocal``.

    Every other way out of the block goes to ``:vsthostend``, which is inside
    the scope and falls into ``endlocal``. This guard is the exception: it fires
    before the scope is pushed, so its label has to sit past the pop or the
    pair would be unbalanced for the rest of the launch.
    """
    guard = BAT.index(f'if not exist "{LAUNCHER_PYTHON}" goto :vsthostdone')
    setlocal = BAT.index("setlocal enabledelayedexpansion", guard)
    endlocal = BAT.index("\nendlocal\n", guard)
    label = BAT.index("\n:vsthostdone\n", guard)
    assert guard < setlocal < endlocal < label

    # And the scope really is one pair, opened and closed inside the block.
    start, end = _bat_block()
    block = BAT[start:end]
    assert block.count("setlocal") == block.count("endlocal") == 1


def test_the_check_sits_where_theDAW_sh_already_puts_it() -> None:
    """After the dependency bootstrap, before the port sweep -- the position
    theDAW.sh committed to for the same advisory line."""
    deps = BAT.index(r"VST-Foundry-UI\VST-UI-FOUNDRY")
    check = BAT.index("check_vst_host.py")
    ports = BAT.index("backend.ports --free")
    assert deps < check < ports

    sh_deps = SH.index("VST-Foundry-UI/VST-UI-FOUNDRY")
    sh_line = SH.index("live VST host: not available on this platform")
    sh_ports = SH.index("backend.ports --free")
    assert sh_deps < sh_line < sh_ports


def test_the_status_line_is_printed_verbatim() -> None:
    """One echo of the captured line, with nothing bolted onto either end.

    Delayed expansion is what makes that echo safe: the line carries the host's
    own ``--version`` output, and ``!var!`` is substituted after cmd has parsed
    the command, so a ``&`` in a version string is text rather than an operator.
    """
    start, end = _bat_block()
    block = BAT[start:end]
    assert "setlocal enabledelayedexpansion" in block
    assert block.count("setlocal") == block.count("endlocal") == 1
    echoes = [
        raw.strip()
        for raw in block.splitlines()
        if raw.strip().lower().startswith("echo ")
    ]
    assert len(echoes) == 1, f"theDAW.bat: expected one echo in the block, got {echoes}"
    assert re.fullmatch(r"echo !\w+!", echoes[0]), echoes[0]


# ---------------------------------------------------------------------------
# theDAW.bat -- the build offer
# ---------------------------------------------------------------------------


def test_the_build_offer_is_gated_on_every_documented_condition() -> None:
    """Missing exe AND cmake on PATH AND no skip var AND no remembered decline."""
    start, end = _bat_block()
    block = BAT[start:end]

    offer = _at(block, OFFER_CALL, where="theDAW.bat")
    skip = _at(block, SKIP_GATE, where="theDAW.bat")
    not_built = _at(block, f"{NOT_BUILT}=", where="theDAW.bat")
    marker = _at(block, f'if exist "{MARKER}"', where="theDAW.bat")
    cmake = _at(block, "where cmake", where="theDAW.bat")
    assert max(skip, not_built, marker, cmake) < offer

    for gate in (skip, not_built, marker, cmake):
        gate_line = block[block.rindex("\n", 0, gate) + 1 : block.index("\n", gate)]
        assert "goto" in gate_line, f"theDAW.bat: gate does not leave: {gate_line!r}"

    offer_line = block[block.rindex("\n", 0, offer) + 1 : block.index("\n", offer)]
    assert "install\\setup.ps1" in offer_line
    assert "-NoProfile -ExecutionPolicy Bypass -File" in offer_line


def test_the_block_runs_no_percent_dp0_path() -> None:
    """``%~dp0`` expands before the delayed pass, which then eats any ``!`` out
    of the repo path it pasted in -- so a checkout under ``C:\\hi!\\theDAW``
    would hand PowerShell a ``-File`` that does not exist. cwd is the repo root
    already, so every path in the block is relative."""
    start, end = _bat_block()
    assert "%~dp0" not in BAT[start:end]
    # Outside the block, where there is no delayed expansion, it stays correct.
    assert "%~dp0install\\setup.ps1" in BAT, "the other setup.ps1 calls are absolute"


def test_the_not_built_gate_matches_the_real_status_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The literal theDAW.bat searches for appears in the missing-exe line and
    in neither of the other two, so the gate cannot fire on a working host."""
    module = _load_check_vst_host()
    start, end = _bat_block()
    assert f'"!VST_HOST_LINE:{NOT_BUILT}=!"' in BAT[start:end]

    missing = module.status_line(
        {"THEDAW_VST_HOST": str(tmp_path / "absent.exe")}, platform="win32"
    )
    assert NOT_BUILT in missing

    assert NOT_BUILT not in module.status_line(platform="linux")

    present = tmp_path / "host.exe"
    present.write_bytes(b"")
    monkeypatch.setattr(module, "probe_version", lambda exe: "9.9.9")
    ready = module.status_line({"THEDAW_VST_HOST": str(present)}, platform="win32")
    assert ready == "live VST host: ready (9.9.9)"
    assert NOT_BUILT not in ready


def test_the_skip_variable_suppresses_only_the_offer() -> None:
    """``THEDAW_SKIP_VST_HOST_BUILD=1`` is tested after the echo, so the status
    line still prints -- the README promises the line on every launch."""
    start, end = _bat_block()
    block = BAT[start:end]
    assert SKIP_GATE in block
    assert block.index("echo !") < block.index(SKIP_GATE)


def test_nothing_in_the_check_can_stop_the_launch() -> None:
    """No exit, no pause, no fall-through into the needtools path, and the
    ERRORLEVEL the block leaves behind is cleared before the launch continues."""
    start, end = _bat_block()
    block = BAT[start:end]
    for forbidden in ("exit /b", "pause", ":needtools", ":rerun"):
        assert forbidden not in block, f"theDAW.bat: {forbidden!r} is inside the block"
    assert block.rstrip().endswith("ver >nul")
    assert BAT.index("ver >nul") < BAT.index("backend.ports --free")


# ---------------------------------------------------------------------------
# theDAW.sh
# ---------------------------------------------------------------------------


def test_the_sh_prints_the_scripts_own_not_available_line() -> None:
    """Byte-identical to what ``status_line`` returns off Windows, so the two
    launchers cannot drift apart in wording."""
    expected = _load_check_vst_host().status_line(platform="linux")
    assert expected == "live VST host: not available on this platform"
    assert expected in SH


def test_the_sh_never_offers_to_build() -> None:
    """The host is C++17 against Win32; there is nothing to offer on POSIX."""
    for forbidden in ("check_vst_host", "build.ps1", "-VstHost", "cmake"):
        assert forbidden not in SH, f"theDAW.sh: {forbidden!r} has no business here"


# ---------------------------------------------------------------------------
# install/setup.ps1
# ---------------------------------------------------------------------------


def test_setup_declares_the_vst_host_switch() -> None:
    """A switch and a dedicated mode, exactly like -UnderfitVenv."""
    param = SETUP[SETUP.index("param(") : SETUP.index("\n", SETUP.index("param("))]
    assert "[switch]$VstHost" in param
    assert "[switch]$UnderfitVenv" in param, "the existing switches must stay"

    dispatch = re.search(r"if\(\s*\$VstHost\s*\)\{[^}]*\}", SETUP)
    assert dispatch, "setup.ps1: -VstHost has no dedicated mode"
    assert "Initialize-VstHost" in dispatch.group(0)
    assert "exit 0" in dispatch.group(0), "the mode must always exit 0"

    header = SETUP[: SETUP.index("#>")]
    assert "-VstHost" in header, "setup.ps1: the switch is undocumented"

    # Dispatched before the doctor starts: Clear-Host would wipe the launcher's
    # scrollback, and everything below it is the full install flow.
    assert SETUP.index("if($VstHost)") < SETUP.index("Clear-Host")
    assert SETUP.index("if($UnderfitVenv)") < SETUP.index("Clear-Host")


def test_the_offer_uses_the_scripts_own_consent_prompt() -> None:
    """Initialize-VstHost prompts the way Initialize-UnderfitVenv prompts."""
    body = _ps_function(SETUP, "Initialize-VstHost", where="setup.ps1")
    underfit = _ps_function(SETUP, "Initialize-UnderfitVenv", where="setup.ps1")
    for helper in ("Update-Path", "Head ", "Info ", "WARN ", "(Ask "):
        assert helper in body, f"setup.ps1: Initialize-VstHost skips {helper!r}"
        assert helper in underfit, f"setup.ps1: the pattern moved: {helper!r}"
    assert "Have 'cmake'" in body, "the offer must check CMake itself too"
    assert re.search(r"build\.ps1", body), (
        "the offer must run native\\vst-host\\build.ps1"
    )
    assert "if(-not (Ask " in body, "declining must be the branch that returns"


def test_a_declined_or_failed_build_says_so_and_returns() -> None:
    """Every way out other than a successful build is one WARN and a return;
    nothing throws out of the function and stops setup.ps1."""
    body = _ps_function(SETUP, "Initialize-VstHost", where="setup.ps1")
    assert body.count("WARN ") >= 3, "decline, no-cmake and build failure each warn"
    assert "try {" in body and "catch {" in body, "build.ps1 throws; catch it"
    assert "$LASTEXITCODE" in body


def test_only_an_interactive_decline_is_remembered() -> None:
    """The marker is written in the ``Ask`` branch and nowhere else.

    The no-console auto-decline must leave nothing behind: one redirected run
    (CI, a piped launch) would otherwise silence the offer on the real console
    afterwards, and the user would never see the prompt that explains the file.
    """
    body = _ps_function(SETUP, "Initialize-VstHost", where="setup.ps1")

    no_console = next(line for line in body.splitlines() if "Interactive" in line)
    assert "Set-VstHostDeclined" not in no_console, no_console

    decline = body[body.index("if(-not (Ask ") : body.index("Info 'Building via")]
    assert "Set-VstHostDeclined $hostDir $true" in decline, decline
    # And the decline names every way back, per the README.
    assert ".build-declined" in decline
    assert "install\\setup.ps1 -VstHost" in decline
    assert "THEDAW_SKIP_VST_HOST_BUILD=1" in decline

    built = next(line for line in body.splitlines() if "$LASTEXITCODE -eq 0" in line)
    assert "Set-VstHostDeclined $hostDir $false" in built, built


def test_setup_never_consults_the_marker_itself() -> None:
    """Only theDAW.bat reads it, which is what makes a by-hand run always ask."""
    assert "Test-Path" not in _ps_function(
        SETUP, "Set-VstHostDeclined", where="setup.ps1"
    )
    body = _ps_function(SETUP, "Initialize-VstHost", where="setup.ps1")
    reads = [line for line in body.splitlines() if ".build-declined" in line]
    assert reads, "the decline must still name the file to the user"
    for line in reads:
        assert "Test-Path" not in line and "if(" not in line, line


def test_the_marker_is_gitignored() -> None:
    """It is per-checkout state, like bin/ and the build tree beside it."""
    ignored = HOST_GITIGNORE.read_text(encoding="utf-8")
    assert ".build-declined" in ignored
    assert "build/" in ignored
    # The stale rationale for build/ went with the drive-letter default.
    assert "on E:" not in ignored and "E:\\" not in ignored


@requires_powershell
def test_the_marker_helper_writes_and_removes_the_real_file(tmp_path: Path) -> None:
    """setup.ps1's own function, run on a throwaway directory: one timestamped
    line goes in, and clearing it takes the file away again."""
    helper = _ps_function(SETUP, "Set-VstHostDeclined", where="setup.ps1")
    marker = "(Join-Path $d '.build-declined')"
    done = _run_powershell(
        "\n".join(
            [
                f"function Set-VstHostDeclined($hostDir, $declined) {helper}",
                f"$d = '{tmp_path}'",
                "Set-VstHostDeclined $d $true",
                f"Write-Output ('wrote=' + (Test-Path {marker}))",
                f"Write-Output ('text=' + (Get-Content {marker}))",
                "Set-VstHostDeclined $d $false",
                f"Write-Output ('kept=' + (Test-Path {marker}))",
            ]
        )
    )
    assert done.returncode == 0, done.stderr
    reported = dict(
        line.split("=", 1) for line in done.stdout.splitlines() if "=" in line
    )
    assert reported["wrote"] == "True", done.stdout
    assert reported["kept"] == "False", done.stdout
    assert re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}  delete this file to be asked again",
        reported["text"],
    ), reported["text"]


def _isolated_setup(
    tmp_path: Path, *, marker: str | None
) -> tuple[Path, subprocess.CompletedProcess[str]]:
    """Run the real ``setup.ps1 -VstHost`` against a throwaway copy of the tree.

    setup.ps1 finds everything from ``$PSScriptRoot``, so a copy of it beside a
    stand-in build.ps1 is a complete world: the worktree is never touched, and
    the stand-in throws if anything ever tries to build.
    """
    (tmp_path / "install").mkdir(parents=True)
    shutil.copy2(SETUP_PATH, tmp_path / "install" / "setup.ps1")
    host_dir = tmp_path / "native" / "vst-host"
    host_dir.mkdir(parents=True)
    (host_dir / "build.ps1").write_text(
        "throw 'this test must never start a build'\n", encoding="utf-8"
    )
    if marker is not None:
        (host_dir / ".build-declined").write_text(marker, encoding="utf-8")

    assert _POWERSHELL is not None
    done = subprocess.run(
        [
            _POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(tmp_path / "install" / "setup.ps1"),
            "-VstHost",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120.0,
        stdin=subprocess.DEVNULL,
        cwd=tmp_path,
    )
    return host_dir, done


@requires_powershell
def test_a_no_console_decline_leaves_no_marker(tmp_path: Path) -> None:
    """The real script, stdin redirected: it declines, exits 0, writes nothing."""
    host_dir, done = _isolated_setup(tmp_path, marker=None)
    assert done.returncode == 0, done.stderr
    assert "Live VST host (optional)" in done.stdout
    assert not (host_dir / ".build-declined").exists(), done.stdout


@requires_powershell
def test_a_by_hand_run_ignores_the_marker(tmp_path: Path) -> None:
    """Same script, same answer, marker or no marker -- the file is the
    launcher's business, so running setup.ps1 yourself always reaches the
    prompt. The marker is left exactly as it was found."""
    stamp = "2026-01-01T00:00:00  delete this file to be asked again\n"
    with_marker, declined = _isolated_setup(tmp_path / "with", marker=stamp)
    _, without = _isolated_setup(tmp_path / "without", marker=None)

    assert declined.returncode == without.returncode == 0
    assert declined.stdout == without.stdout, "the marker changed a by-hand run"
    assert (with_marker / ".build-declined").read_text(encoding="utf-8") == stamp
    assert ".build-declined" not in declined.stdout


@requires_powershell
def test_a_redirected_stdin_counts_as_a_decline() -> None:
    """``Ask`` reads an empty line as yes, and a redirected stdin hands it one
    immediately -- so the offer tests the console before it prompts. The real
    test from setup.ps1 is run here with stdin redirected, as an automated
    launch would have it."""
    body = _ps_function(SETUP, "Initialize-VstHost", where="setup.ps1")
    assert "Interactive" in body, "setup.ps1: the offer never tests the console"

    interactive = _ps_function(SETUP, "Interactive", where="setup.ps1")
    done = _run_powershell(
        f"function Interactive() {interactive}\nWrite-Output (Interactive)"
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "False", done.stdout


# ---------------------------------------------------------------------------
# native/vst-host/build.ps1
# ---------------------------------------------------------------------------


def _build_dir_resolution() -> str:
    """The statements in build.ps1 that settle ``$BuildDir``, lifted verbatim."""
    lines = [
        raw
        for raw in BUILD.splitlines()
        if re.match(r"\s*if\s*\(-not \$BuildDir\)", raw)
    ]
    assert lines, "build.ps1: nothing resolves $BuildDir"
    return "\n".join(lines)


def test_the_build_dir_default_names_no_drive() -> None:
    """A hardcoded ``E:\\...`` default fails at mkdir on any machine without
    that drive. The parameter defaults to empty and is resolved afterwards."""
    param_block = BUILD[BUILD.index("param(") : BUILD.index("$ErrorActionPreference")]
    assert re.search(r"\[string\]\$BuildDir\s*=\s*''", param_block), param_block
    assert not re.search(r"[A-Za-z]:\\\\?\w", param_block), param_block
    assert "E:\\" not in BUILD and "E:/" not in BUILD


def test_the_build_dir_falls_back_to_the_gitignored_build_tree() -> None:
    """Resolution order: -BuildDir, then THEDAW_VST_BUILD_DIR, then here\\build."""
    resolution = _build_dir_resolution()
    assert "THEDAW_VST_BUILD_DIR" in resolution
    assert "Join-Path $here 'build'" in resolution
    assert resolution.index("THEDAW_VST_BUILD_DIR") < resolution.index("'build'")
    assert "build/" in HOST_GITIGNORE.read_text(encoding="utf-8")


@requires_powershell
@pytest.mark.parametrize(
    ("argument", "env_value", "expected"),
    [
        (r"D:\from-argument", r"D:\from-env", r"D:\from-argument"),
        ("", r"D:\from-env", r"D:\from-env"),
        ("", "", r"C:\fake-here\build"),
    ],
)
def test_the_resolution_statements_pick_the_documented_winner(
    argument: str, env_value: str, expected: str
) -> None:
    """build.ps1's own lines, run on their own: no cmake, no compiler, no tree."""
    script = "\n".join(
        [
            f"$BuildDir = '{argument}'",
            r"$here = 'C:\fake-here'",
            f"$env:THEDAW_VST_BUILD_DIR = '{env_value}'",
            _build_dir_resolution(),
            "Write-Output $BuildDir",
        ]
    )
    done = _run_powershell(script)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == expected, done.stdout


def test_resolve_cmake_prefers_the_cmake_on_path() -> None:
    """Whatever ``cmake`` the user's shell resolves is the one that builds; the
    absolute paths are only there for installs that never touch PATH."""
    body = _ps_function(BUILD, "Resolve-Cmake", where="build.ps1")
    assert body.index("Get-Command cmake") < body.index("C:\\Program Files")


def test_build_ps1_carries_no_machine_specific_rationale() -> None:
    """ "C: is nearly full on this machine" is one person's disk, not a design."""
    header = BUILD[: BUILD.index("[CmdletBinding()]")]
    assert "nearly full" not in header
    assert "THEDAW_VST_BUILD_DIR" in header, "document the override that replaced it"


# ---------------------------------------------------------------------------
# Both PowerShell files still parse
# ---------------------------------------------------------------------------


@requires_powershell
@pytest.mark.parametrize("path", [SETUP_PATH, BUILD_PATH], ids=lambda p: p.name)
def test_the_powershell_files_parse_without_errors(path: Path) -> None:
    """PowerShell's own parser, so a syntax slip cannot reach a user's launch."""
    script = (
        "$errors = $null\n"
        "$null = [System.Management.Automation.Language.Parser]::ParseFile("
        f"'{path}', [ref]$null, [ref]$errors)\n"
        "if ($errors) { $errors | ForEach-Object { Write-Output $_.ToString() } }\n"
        "else { Write-Output 'OK' }\n"
    )
    done = _run_powershell(script)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "OK", done.stdout
