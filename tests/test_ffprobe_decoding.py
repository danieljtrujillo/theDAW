"""probe_file survives what ffprobe actually prints on Windows.

The analysis tab 500'd on a song whose ffprobe output held a byte outside the
Windows ANSI codepage: subprocess.run decoded it with that codepage and raised
UnicodeDecodeError, and a second path reached json.loads with stdout None and
raised TypeError. probe_file is documented never to raise, so both are covered
here, along with the encoding the run must name.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from backend.modules.analysis import ffprobe


class _Result:
    def __init__(self, returncode: int = 0, stdout=None, stderr=None):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@pytest.fixture
def probe_target(tmp_path):
    f = tmp_path / "song.wav"
    f.write_bytes(b"RIFF....WAVE")
    return f


def test_run_names_utf8_and_replaces_undecodable_bytes(monkeypatch, probe_target):
    """The call must pass encoding + errors, or a stray byte raises in Python."""
    seen: dict[str, object] = {}

    def fake_run(argv, **kwargs):
        seen.update(kwargs)
        return _Result(
            stdout=json.dumps({"format": {"format_name": "wav"}, "streams": []})
        )

    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(subprocess, "run", fake_run)

    payload = ffprobe.probe_file(probe_target)

    assert seen.get("encoding") == "utf-8"
    assert seen.get("errors") == "replace"
    assert payload["format"]["format_name"] == "wav"


def test_utf8_metadata_survives_the_round_trip(monkeypatch, probe_target):
    """A title outside cp1252 comes back intact rather than raising."""
    title = "Everything is Chrome in the Future — 日本語 – Å"
    out = json.dumps(
        {
            "format": {
                "format_name": "wav",
                "duration": "30.5",
                "tags": {"title": title},
            },
            "streams": [
                {
                    "codec_type": "audio",
                    "codec_name": "pcm_s16le",
                    "sample_rate": "44100",
                    "channels": 2,
                    "bits_per_sample": 16,
                }
            ],
        }
    )
    # What subprocess.run hands back once it decodes the child's UTF-8 bytes.
    decoded = out.encode("utf-8").decode("utf-8")

    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: _Result(stdout=decoded))

    payload = ffprobe.probe_file(probe_target)

    assert payload["format"]["tags"]["title"] == title
    assert payload["_summary"]["sample_rate"] == 44100
    assert payload["_summary"]["channels"] == 2


def test_undecodable_output_returns_empty_instead_of_raising(monkeypatch, probe_target):
    """UnicodeDecodeError is a ValueError; it used to escape as a 500."""

    def fake_run(argv, **kwargs):
        raise UnicodeDecodeError(
            "charmap", b"\x81", 0, 1, "character maps to <undefined>"
        )

    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(subprocess, "run", fake_run)

    assert ffprobe.probe_file(probe_target) == {}


def test_no_stdout_returns_empty_instead_of_raising(monkeypatch, probe_target):
    """json.loads(None) raised TypeError from a function that never raises."""
    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: _Result(stdout=None))

    assert ffprobe.probe_file(probe_target) == {}


def test_blank_stdout_returns_empty(monkeypatch, probe_target):
    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(subprocess, "run", lambda argv, **kw: _Result(stdout=""))

    assert ffprobe.probe_file(probe_target) == {}


def test_unparseable_stdout_returns_empty(monkeypatch, probe_target):
    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(
        subprocess, "run", lambda argv, **kw: _Result(stdout="not json {")
    )

    assert ffprobe.probe_file(probe_target) == {}


def test_json_that_is_not_an_object_returns_empty(monkeypatch, probe_target):
    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(
        subprocess, "run", lambda argv, **kw: _Result(stdout="[1, 2, 3]")
    )

    assert ffprobe.probe_file(probe_target) == {}


def test_nonzero_exit_with_no_stderr_returns_empty(monkeypatch, probe_target):
    """`result.stderr.strip()` crashed the error path when stderr was None."""
    monkeypatch.setattr(ffprobe.ffmpeg_tools, "find_ffprobe", lambda: "ffprobe")
    monkeypatch.setattr(
        subprocess, "run", lambda argv, **kw: _Result(returncode=1, stderr=None)
    )

    assert ffprobe.probe_file(probe_target) == {}


def test_every_backend_text_subprocess_names_an_encoding():
    """The sweep that went with this fix, kept as a rule.

    A call that asks for text without an encoding decodes with the machine's
    ANSI codepage, so it works on the author's machine and raises on a user's.
    """
    import io
    import os
    import re

    roots = ["backend", "sidecars", "scripts", "stable_audio_3", "install"]
    skip = {
        "node_modules",
        ".venv",
        ".whisper_venv",
        "release",
        "dist",
        "__pycache__",
        "port_src",
    }
    call = re.compile(r"subprocess\.(run|Popen|check_output|call)\s*\(")
    offenders = []

    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in skip]
            for name in filenames:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    src = io.open(path, encoding="utf-8").read()
                except OSError:
                    continue
                for m in call.finditer(src):
                    i, depth = m.end(), 1
                    while i < len(src) and depth:
                        depth += {"(": 1, ")": -1}.get(src[i], 0)
                        i += 1
                    body = src[m.start() : i]
                    asks_for_text = (
                        "text=True" in body or "universal_newlines=True" in body
                    )
                    if asks_for_text and "encoding=" not in body:
                        offenders.append(
                            f"{path}:{src[: m.start()].count(chr(10)) + 1}"
                        )

    assert not offenders, (
        "subprocess calls decoding with the locale codepage: " + ", ".join(offenders)
    )
