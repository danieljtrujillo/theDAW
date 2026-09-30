"""Which FFmpeg the backend runs (backend.lib.ffmpeg_tools).

The first ffmpeg on PATH can be gyan.dev's "essentials" build, which has no
libsoxr, and every soxr filter (Classical Upsample, Super-Res, High-Quality SRC)
then failed with "Could not open encoder before EOF". The resolver probes each
candidate and keeps one with libsoxr; with none, a soxr command fails before it
runs, with a message that names the problem and the FFmpeg in use.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import ffmpeg, ffmpeg_tools
from backend.lib.ffmpeg_tools import FFmpegBuild, Resolution


def _build(path: str, *, soxr: bool, rubberband: bool = True) -> FFmpegBuild:
    return FFmpegBuild(
        ffmpeg=path,
        version=f"ffmpeg version test ({path})",
        soxr=soxr,
        rubberband=rubberband,
        ffprobe=path.replace("ffmpeg", "ffprobe"),
    )


def _fake_probe(builds: dict[str, FFmpegBuild | None], calls: list[str]):
    def probe(path: str) -> FFmpegBuild | None:
        calls.append(path)
        return builds[path]

    return probe


@pytest.fixture
def resolved(monkeypatch: pytest.MonkeyPatch):
    """Install a resolution as if the startup probe had chosen it."""

    def install(build: FFmpegBuild | None, checked=None) -> Resolution:
        res = Resolution(
            build=build,
            checked=checked or ([(build.ffmpeg, build.soxr)] if build else []),
            ffprobe=build.ffprobe if build else None,
        )
        monkeypatch.setattr(ffmpeg_tools, "_resolution", res if build else None)
        monkeypatch.setattr(ffmpeg_tools, "_last", res)
        return res

    return install


# --------------------------------------------------------------------------- #
#  selection
# --------------------------------------------------------------------------- #


def test_first_candidate_without_soxr_loses_to_the_second_with_it():
    builds = {
        "/a/ffmpeg": _build("/a/ffmpeg", soxr=False),
        "/b/ffmpeg": _build("/b/ffmpeg", soxr=True),
    }
    calls: list[str] = []
    res = ffmpeg_tools.select_build(
        ["/a/ffmpeg", "/b/ffmpeg"], probe=_fake_probe(builds, calls)
    )
    assert res.build is builds["/b/ffmpeg"]
    assert res.checked == [("/a/ffmpeg", False), ("/b/ffmpeg", True)]


def test_no_candidate_with_soxr_keeps_the_first_that_runs():
    builds = {
        "/broken/ffmpeg": None,
        "/a/ffmpeg": _build("/a/ffmpeg", soxr=False),
        "/b/ffmpeg": _build("/b/ffmpeg", soxr=False),
    }
    res = ffmpeg_tools.select_build(list(builds), probe=_fake_probe(builds, []))
    assert res.build is builds["/a/ffmpeg"]
    assert res.checked == [
        ("/broken/ffmpeg", None),
        ("/a/ffmpeg", False),
        ("/b/ffmpeg", False),
    ]


def test_soxr_with_rubberband_beats_an_earlier_soxr_only_build_and_stops_there():
    builds = {
        "/a/ffmpeg": _build("/a/ffmpeg", soxr=True, rubberband=False),
        "/b/ffmpeg": _build("/b/ffmpeg", soxr=True, rubberband=True),
        "/c/ffmpeg": _build("/c/ffmpeg", soxr=True, rubberband=True),
    }
    calls: list[str] = []
    res = ffmpeg_tools.select_build(list(builds), probe=_fake_probe(builds, calls))
    assert res.build is builds["/b/ffmpeg"]
    assert calls == ["/a/ffmpeg", "/b/ffmpeg"], "probing stops at the first full build"


def test_soxr_only_build_beats_rubberband_only_build():
    builds = {
        "/a/ffmpeg": _build("/a/ffmpeg", soxr=False, rubberband=True),
        "/b/ffmpeg": _build("/b/ffmpeg", soxr=True, rubberband=False),
    }
    res = ffmpeg_tools.select_build(list(builds), probe=_fake_probe(builds, []))
    assert res.build is builds["/b/ffmpeg"]


def test_no_candidates_resolves_to_nothing():
    res = ffmpeg_tools.select_build([], probe=_fake_probe({}, []))
    assert res.build is None
    assert res.checked == []


# --------------------------------------------------------------------------- #
#  the clear error
# --------------------------------------------------------------------------- #


def test_soxr_command_on_a_build_without_soxr_fails_with_the_clear_message(
    resolved, monkeypatch: pytest.MonkeyPatch
):
    essentials = r"C:\Tools\ffmpeg-8.0-essentials_build\bin\ffmpeg.exe"
    resolved(
        _build(essentials, soxr=False),
        checked=[(essentials, False), (r"C:\Other\ffmpeg.exe", False)],
    )

    async def must_not_spawn(*_a, **_k):
        raise AssertionError("a soxr command must not reach ffmpeg without libsoxr")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", must_not_spawn)

    with pytest.raises(ffmpeg.FFmpegCapabilityError) as excinfo:
        asyncio.run(
            ffmpeg.render(
                Path("in.wav"),
                Path("out.wav"),
                ["-af", "aresample=resampler=soxr:precision=28", "-ar", "96000"],
            )
        )
    message = str(excinfo.value)
    assert "This FFmpeg has no libsoxr; install the full FFmpeg build" in message
    assert essentials in message
    assert r"C:\Other\ffmpeg.exe" in message
    assert isinstance(excinfo.value, ffmpeg.FFmpegError)
    assert excinfo.value.stderr == message


def test_non_soxr_command_still_runs_on_a_build_without_soxr(
    resolved, monkeypatch: pytest.MonkeyPatch
):
    resolved(_build("/opt/essentials/ffmpeg", soxr=False))
    seen: list[tuple] = []

    class _Proc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def fake_exec(*cmd, **_k):
        seen.append(cmd)
        return _Proc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    asyncio.run(ffmpeg.run(["ffmpeg", "-i", "in.wav", "-af", "volume=1", "out.wav"]))
    assert seen and seen[0][0] == "/opt/essentials/ffmpeg"


def test_bare_names_in_argv0_run_the_resolved_build(
    resolved, monkeypatch: pytest.MonkeyPatch
):
    resolved(_build("/opt/full/bin/ffmpeg", soxr=True))
    seen: list[tuple] = []

    class _Proc:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def fake_exec(*cmd, **_k):
        seen.append(cmd)
        return _Proc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    asyncio.run(ffmpeg.run(["ffmpeg", "-af", "aresample=resampler=soxr", "-"]))
    asyncio.run(ffmpeg.run(["ffprobe", "-v", "error", "x.wav"]))
    assert seen[0][0] == "/opt/full/bin/ffmpeg"
    assert seen[1][0] == "/opt/full/bin/ffprobe"


def test_the_message_reaches_the_tool_endpoint_whole(resolved):
    """module_base turns the error into the HTTP detail the edit pages show;
    the stderr tail the generic FFmpegError path keeps would cut a long path."""
    from backend.core.module_base import build_router
    from backend.lib.params import ToolSpec

    # High-Quality SRC, Classical Upsample and Super-Res fall back to swr, so
    # a tool that hard-codes the soxr resampler stands in for any future one.
    def _soxr_only(_params):
        return ["-af", "aresample=resampler=soxr:precision=28", "-ar", "96000"]

    tool = ToolSpec(
        id="soxr_only",
        name="Soxr Only",
        family="enhance",
        mode="filter",
        requires=("soxr",),
        handler=_soxr_only,
    )
    long_path = "C:\\" + "\\".join(["deep-folder-name"] * 30) + "\\ffmpeg.exe"
    resolved(_build(long_path, soxr=False))

    app = FastAPI()
    app.include_router(build_router("enhance", [tool]), prefix="/api/edit/enhance")
    client = TestClient(app)

    buf = io.BytesIO()
    sf.write(buf, np.zeros(4410, dtype=np.float32), 44100, format="WAV")
    buf.seek(0)
    resp = client.post(
        "/api/edit/enhance/process",
        files={"audio": ("in.wav", buf, "audio/wav")},
        data={
            "effect": "soxr_only",
            "params": json.dumps({}),
            "output_format": "wav",
        },
    )
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert "This FFmpeg has no libsoxr; install the full FFmpeg build" in detail
    assert long_path in detail


# --------------------------------------------------------------------------- #
#  probing a real executable
# --------------------------------------------------------------------------- #


def test_probe_reads_version_rubberband_and_a_failed_soxr_run(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    exe = tmp_path / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
    exe.write_bytes(b"")
    (exe.parent / exe.name.replace("ffmpeg", "ffprobe")).write_bytes(b"")
    version_text = (
        "ffmpeg version 8.0-essentials_build-www.gyan.dev\n"
        "configuration: --enable-gpl --enable-librubberband\n"
    )

    def fake_run(argv, **_k):
        if "-version" in argv:
            return subprocess.CompletedProcess(argv, 0, version_text, "")
        assert "aresample=48000:resampler=soxr" in argv
        return subprocess.CompletedProcess(
            argv, 234, "", "Requested resampling engine is unavailable"
        )

    monkeypatch.setattr(ffmpeg_tools.subprocess, "run", fake_run)
    build = ffmpeg_tools.probe_build(str(exe))
    assert build is not None
    assert build.version == "ffmpeg version 8.0-essentials_build-www.gyan.dev"
    assert build.rubberband is True
    assert build.soxr is False
    assert build.ffprobe == str(exe.parent / exe.name.replace("ffmpeg", "ffprobe"))


def test_probe_rejects_an_executable_that_is_not_ffmpeg():
    assert ffmpeg_tools.probe_build(sys.executable) is None


def test_probe_rejects_a_spawn_that_answers_nothing(monkeypatch: pytest.MonkeyPatch):
    """A replaced subprocess.run that returns empty output must not be read as
    a working build (and so must never be cached)."""
    monkeypatch.setattr(
        ffmpeg_tools.subprocess,
        "run",
        lambda argv, **_k: subprocess.CompletedProcess(argv, 0, "", ""),
    )
    assert ffmpeg_tools.probe_build("/whatever/ffmpeg") is None


# --------------------------------------------------------------------------- #
#  candidates
# --------------------------------------------------------------------------- #


def _fake_exe(folder: Path, stem: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    exe = folder / (f"{stem}.exe" if sys.platform == "win32" else stem)
    exe.write_bytes(b"")
    exe.chmod(0o755)
    return exe


def test_candidates_env_first_then_path_order_without_duplicates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    a = _fake_exe(tmp_path / "a", "ffmpeg")
    b = _fake_exe(tmp_path / "b", "ffmpeg")
    c = _fake_exe(tmp_path / "c", "ffmpeg")
    (tmp_path / "empty").mkdir()
    monkeypatch.setenv(
        "PATH",
        os.pathsep.join(
            [str(tmp_path / "empty"), str(a.parent), str(b.parent), str(a.parent)]
        ),
    )
    monkeypatch.setenv(ffmpeg_tools.ENV_VAR, str(c.parent))
    monkeypatch.setattr(ffmpeg_tools, "_winget_candidates", lambda: [str(b)])
    monkeypatch.setattr(ffmpeg_tools, "_unix_candidates", lambda: [str(b)])

    got = [os.path.normcase(p) for p in ffmpeg_tools.candidate_paths()]
    assert got == [os.path.normcase(str(p)) for p in (c, a, b)]


def test_env_var_may_name_the_executable_itself(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    c = _fake_exe(tmp_path / "c", "ffmpeg")
    monkeypatch.setenv(ffmpeg_tools.ENV_VAR, str(c))
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(ffmpeg_tools, "_winget_candidates", lambda: [])
    monkeypatch.setattr(ffmpeg_tools, "_unix_candidates", lambda: [])
    assert ffmpeg_tools.candidate_paths() == [str(c)]


@pytest.mark.skipif(sys.platform != "win32", reason="winget locations are Windows")
def test_winget_gyan_install_and_links_are_candidates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    local = tmp_path / "LocalAppData"
    links = _fake_exe(local / "Microsoft" / "WinGet" / "Links", "ffmpeg")
    pkg = local / "Microsoft" / "WinGet" / "Packages"
    old = _fake_exe(
        pkg
        / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
        / "ffmpeg-8.0-full_build"
        / "bin",
        "ffmpeg",
    )
    new = _fake_exe(
        pkg
        / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
        / "ffmpeg-8.1-full_build"
        / "bin",
        "ffmpeg",
    )
    newest = _fake_exe(
        pkg
        / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
        / "ffmpeg-10.0-full_build"
        / "bin",
        "ffmpeg",
    )
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "ProgramFiles"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "profile"))
    monkeypatch.setenv("ProgramData", str(tmp_path / "ProgramData"))
    monkeypatch.setenv("PATH", "")
    monkeypatch.delenv(ffmpeg_tools.ENV_VAR, raising=False)
    assert ffmpeg_tools.candidate_paths() == [
        str(links),
        str(newest),
        str(new),
        str(old),
    ]


def test_ffprobe_comes_from_the_ffmpeg_folder(tmp_path: Path):
    ff = _fake_exe(tmp_path / "full", "ffmpeg")
    probe = _fake_exe(tmp_path / "full", "ffprobe")
    assert ffmpeg_tools.sibling_ffprobe(str(ff)) == str(probe)
    lone = _fake_exe(tmp_path / "lone", "ffmpeg")
    assert ffmpeg_tools.sibling_ffprobe(str(lone)) is None


# --------------------------------------------------------------------------- #
#  caching + status
# --------------------------------------------------------------------------- #


def test_resolve_caches_a_found_build_and_not_a_miss(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(ffmpeg_tools, "_resolution", None)
    monkeypatch.setattr(ffmpeg_tools, "_last", None)
    monkeypatch.setattr(ffmpeg_tools, "candidate_paths", lambda: ["/x/ffmpeg"])
    answers = {"/x/ffmpeg": None}
    calls: list[str] = []
    monkeypatch.setattr(ffmpeg_tools, "probe_build", _fake_probe(answers, calls))

    assert ffmpeg_tools.resolve().build is None
    assert ffmpeg_tools.status()["resolved"] is True
    assert ffmpeg_tools.status()["path"] is None

    answers["/x/ffmpeg"] = _build("/x/ffmpeg", soxr=True)
    assert ffmpeg_tools.find_ffmpeg() == "/x/ffmpeg"
    assert ffmpeg_tools.find_ffmpeg() == "/x/ffmpeg"
    assert calls == ["/x/ffmpeg", "/x/ffmpeg"], "a found build is probed once"


def test_status_reports_path_and_soxr(resolved):
    resolved(_build("/opt/full/bin/ffmpeg", soxr=True))
    st = ffmpeg_tools.status()
    assert st["resolved"] is True
    assert st["path"] == "/opt/full/bin/ffmpeg"
    assert st["soxr"] is True
    assert st["ffprobe"] == "/opt/full/bin/ffprobe"
    assert st["ffprobe_same_build"] is True


def test_health_carries_the_ffmpeg_status(resolved):
    from backend import server

    resolved(_build("/opt/essentials/ffmpeg", soxr=False))
    body = asyncio.run(server.health())
    assert body["ffmpeg"]["path"] == "/opt/essentials/ffmpeg"
    assert body["ffmpeg"]["soxr"] is False


# --------------------------------------------------------------------------- #
#  the tools manifest
# --------------------------------------------------------------------------- #


def _manifest(family: str, tools) -> dict:
    from backend.core.module_base import build_router

    app = FastAPI()
    app.include_router(build_router(family, tools), prefix=f"/api/edit/{family}")
    client = TestClient(app)
    return client.get(f"/api/edit/{family}/tools").json()


def test_manifest_keeps_soxr_tools_available_with_the_swr_notice(resolved):
    """The three soxr tools render through swr at matching quality on a build
    without libsoxr; the manifest keeps them available and says so."""
    from backend.modules.delivery.router import TOOLS as DELIVERY
    from backend.modules.enhance.router import TOOLS as ENHANCE

    resolved(_build("/opt/essentials/ffmpeg", soxr=False))
    by_id = {t["id"]: t for t in _manifest("enhance", ENHANCE)["tools"]}
    by_id |= {t["id"]: t for t in _manifest("delivery", DELIVERY)["tools"]}

    for tid in ("super_res", "classical_upsample", "high_quality_src"):
        assert by_id[tid]["prefers"] == ["soxr"]
        assert by_id[tid]["requires"] == []
        assert by_id[tid]["available"] is True
        assert by_id[tid]["unavailable_reason"] is None
        notice = by_id[tid]["notice"]
        assert notice.startswith(
            "Running on FFmpeg's swr resampler at matching quality."
        )
        assert "This FFmpeg has no libsoxr; install the full FFmpeg build" in notice
        assert "/opt/essentials/ffmpeg" in notice
    assert by_id["uncrush"]["available"] is True
    assert by_id["uncrush"]["notice"] is None


def test_manifest_marks_a_tool_that_requires_soxr_unavailable(resolved):
    from backend.lib.params import ToolSpec

    tool = ToolSpec(
        id="soxr_only", name="Soxr Only", family="enhance", requires=("soxr",)
    )
    resolved(_build("/opt/essentials/ffmpeg", soxr=False))
    (entry,) = _manifest("enhance", [tool])["tools"]
    assert entry["available"] is False
    assert "This FFmpeg has no libsoxr" in entry["unavailable_reason"]
    assert "/opt/essentials/ffmpeg" in entry["unavailable_reason"]


def test_manifest_reads_available_on_a_soxr_build_and_before_any_probe(
    resolved, monkeypatch: pytest.MonkeyPatch
):
    from backend.modules.enhance.router import TOOLS as ENHANCE

    resolved(_build("/opt/full/ffmpeg", soxr=True))
    tools = _manifest("enhance", ENHANCE)["tools"]
    assert all(t["available"] for t in tools)
    assert all(t["notice"] is None for t in tools)

    monkeypatch.setattr(ffmpeg_tools, "_last", None)
    monkeypatch.setattr(ffmpeg_tools, "_resolution", None)
    monkeypatch.setattr(
        ffmpeg_tools,
        "resolve",
        lambda force=False: pytest.fail("the manifest must never probe"),
    )
    assert all(t["available"] for t in _manifest("enhance", ENHANCE)["tools"])


def test_every_tool_whose_ffmpeg_command_uses_soxr_declares_it():
    """A new soxr tool that forgets ``requires`` would read as available on a
    build that cannot run it; one that resamples through ``hq_resampler``
    declares ``prefers`` so its manifest names the swr fallback."""
    import inspect

    from backend.modules.creative_fx.router import TOOLS as CREATIVE_FX
    from backend.modules.creative_neural.router import TOOLS as CREATIVE_NEURAL
    from backend.modules.delivery.router import TOOLS as DELIVERY
    from backend.modules.enhance.router import TOOLS as ENHANCE
    from backend.modules.mastering.router import TOOLS as MASTERING
    from backend.modules.restoration.router import TOOLS as RESTORATION

    for tool in [
        *CREATIVE_FX,
        *CREATIVE_NEURAL,
        *DELIVERY,
        *ENHANCE,
        *MASTERING,
        *RESTORATION,
    ]:
        if tool.handler is None:
            continue
        source = inspect.getsource(tool.handler)
        uses_soxr = ffmpeg_tools.SOXR_MARKER in source
        assert uses_soxr == ("soxr" in tool.requires), tool.id
        assert ("hq_resampler" in source) == ("soxr" in tool.prefers), tool.id
