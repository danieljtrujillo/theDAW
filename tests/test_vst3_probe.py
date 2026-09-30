"""End-to-end checks for the native VST3 hosting layer, through its probe CLI.

These tests drive a real plugin, so they are opt-in on both sides and skip by
default — nothing is loaded in a CI-like run:

* the probe binary must exist. It is not built by ``uv sync``; point
  ``THEDAW_VST3_PROBE`` at it, or build it with::

      cmake -S native/vst-host/src/vst3 -B <build dir> -G "Visual Studio 17 2022" -A x64
      cmake --build <build dir> --config Release

  naming the Visual Studio generator you have installed ("Visual Studio 16
  2019" for the 2019 build tools): ``-A`` is accepted only by the Visual Studio
  generators, and a CMake whose default is Ninja rejects it.

* ``THEDAW_TEST_VST3`` must name the plugins to try, separated by ``os.pathsep``
  (``;`` on Windows). The first entry that loads is used; the rest are the
  fallback list. Example::

      set THEDAW_TEST_VST3=C:\\Program Files\\Common Files\\VST3\\iZotope\\Vinyl.vst3

What is covered is the contract the live host depends on: the file lists its
audio-effect classes, the plugin prepares at a given rate/block/channel count,
it processes a second of audio without producing anything non-finite, and its
state survives a capture/restore round trip through the container the offline
renderer also reads.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

# Where a build normally leaves the binary, in the order worth trying.
PROBE_CANDIDATES = (
    Path("native/vst-host/bin/vst3_probe.exe"),
    Path("native/vst-host/build/vst3_probe/Release/vst3_probe.exe"),
    Path("native/vst-host/build/vst3_probe/vst3_probe.exe"),
)

# A plugin that needs longer than this is not something a live host can wait on.
PROBE_TIMEOUT_SECONDS = 120


def _find_probe() -> Path | None:
    override = os.environ.get("THEDAW_VST3_PROBE", "").strip()
    if override:
        candidate = Path(override)
        return candidate if candidate.is_file() else None
    for relative in PROBE_CANDIDATES:
        candidate = REPO_ROOT / relative
        if candidate.is_file():
            return candidate
    found = shutil.which("vst3_probe")
    return Path(found) if found else None


def _allow_list() -> list[str]:
    raw = os.environ.get("THEDAW_TEST_VST3", "").strip()
    if not raw:
        return []
    return [entry for entry in raw.split(os.pathsep) if entry.strip()]


def _run_probe_raw(probe: Path, *args: str) -> subprocess.CompletedProcess:
    """Run the probe and return the raw ``CompletedProcess`` (stdout, stderr, exit code)."""
    return subprocess.run(
        [str(probe), *args],
        capture_output=True,
        text=True,
        timeout=PROBE_TIMEOUT_SECONDS,
        cwd=str(REPO_ROOT),
    )


def _run_probe(probe: Path, *args: str) -> tuple[int, dict]:
    """Run the probe and return ``(exit code, parsed report)``.

    Plugins write to stdout uncontrollably (one of the AIR effects prints a
    teardown notice), so the report is the FIRST line and anything after it is
    the plugin's noise, not ours.
    """
    completed = _run_probe_raw(probe, *args)
    first_line = completed.stdout.strip().splitlines()
    if not first_line:
        return completed.returncode, {}
    try:
        return completed.returncode, json.loads(first_line[0])
    except json.JSONDecodeError:
        return completed.returncode, {}


@pytest.fixture(scope="module")
def probe() -> Path:
    found = _find_probe()
    if found is None:
        pytest.skip(
            "vst3_probe is not built; set THEDAW_VST3_PROBE or build "
            "native/vst-host/src/vst3"
        )
    return found


@pytest.fixture(scope="module")
def plugin_path(probe: Path) -> str:
    candidates = _allow_list()
    if not candidates:
        pytest.skip("set THEDAW_TEST_VST3 to a VST3 path to run the native host tests")
    for candidate in candidates:
        code, report = _run_probe(probe, "--list", candidate)
        if code == 0 and report.get("ok") and report.get("plugins"):
            return candidate
    pytest.skip(
        f"none of the {len(candidates)} plugin(s) in THEDAW_TEST_VST3 would load"
    )


def test_list_reports_audio_effect_classes(probe: Path, plugin_path: str):
    code, report = _run_probe(probe, "--list", plugin_path)
    assert code == 0, report
    assert report["ok"] is True
    assert report["count"] >= 1
    first = report["plugins"][0]
    assert first["name"]
    assert first["format"] == "VST3"
    # The class id is what the host selects a plugin by, so it has to be the
    # full 32-character hex form and nothing else.
    assert len(first["identifier"]) == 32
    assert set(first["identifier"]) <= set("0123456789ABCDEF")


def test_load_reports_a_usable_setup(probe: Path, plugin_path: str):
    code, report = _run_probe(
        probe,
        "--load",
        plugin_path,
        "--rate",
        "48000",
        "--block",
        "512",
        "--channels",
        "2",
    )
    assert code == 0, report
    assert report["ok"] is True
    assert report["channels_out"] >= 1
    assert report["latency_samples"] >= 0
    # < 0 means an infinite tail, which is legal; anything else must be a real duration.
    assert report["tail_seconds"] >= 0 or report["tail_seconds"] == -1
    assert report["param_count"] >= 0
    assert len(report["params"]) <= 20


def test_process_produces_finite_audio_within_the_realtime_budget(
    probe: Path, plugin_path: str
):
    code, report = _run_probe(
        probe,
        "--load",
        plugin_path,
        "--rate",
        "48000",
        "--block",
        "512",
        "--channels",
        "2",
        "--process-seconds",
        "1",
    )
    assert code == 0, report
    process = report["process"]
    assert process["blocks"] > 0
    # The one thing that is never acceptable: a NaN or an infinity reaching the mixer.
    assert process["non_finite_samples"] == 0
    assert process["block_ms_avg"] < process["block_ms_budget"]


def test_state_survives_a_round_trip(probe: Path, plugin_path: str, tmp_path: Path):
    captured = tmp_path / "state.bin"
    code, report = _run_probe(
        probe, "--load", plugin_path, "--state-out", str(captured)
    )
    assert code == 0, report
    assert report["state_out"]["written"] is True
    assert captured.is_file()
    blob = captured.read_bytes()
    assert len(blob) > 8

    # The container the offline renderer also reads: "VC2!" then the XML length.
    assert blob[:4] == b"VC2!"
    declared = int.from_bytes(blob[4:8], "little")
    assert declared > 0
    assert 8 + declared <= len(blob)
    assert b"<VST3PluginState>" in blob
    assert b"<IComponent>" in blob

    restored = tmp_path / "state2.bin"
    code, report = _run_probe(
        probe,
        "--load",
        plugin_path,
        "--state-in",
        str(captured),
        "--state-out",
        str(restored),
    )
    assert code == 0, report
    assert report["state_in"]["applied"] is True, report["state_in"]["error"]
    assert restored.read_bytes() == blob


def test_state_is_interchangeable_with_the_offline_renderer(
    probe: Path, plugin_path: str, tmp_path: Path
):
    """The whole point of one ``raw_state`` field: both hosts must read each other.

    pedalboard is the offline renderer the app already ships, so a state captured live has to
    load there and a state captured there has to load here — byte for byte, since both sides
    serialise the same plugin at the same settings.
    """
    pedalboard = pytest.importorskip("pedalboard")

    ours = tmp_path / "ours.bin"
    code, report = _run_probe(probe, "--load", plugin_path, "--state-out", str(ours))
    assert code == 0, report
    assert report["state_out"]["written"] is True
    our_blob = ours.read_bytes()

    # Some plugins put something run-varying in their own state (iZotope Ozone 12 does: two
    # captures from the SAME host differ, and even in length). Cross-host byte equality can only
    # be demanded of a plugin whose own capture is reproducible, so measure that first.
    again = tmp_path / "ours_again.bin"
    code, report = _run_probe(probe, "--load", plugin_path, "--state-out", str(again))
    assert code == 0, report
    reproducible = again.read_bytes() == our_blob

    plugin = pedalboard.load_plugin(plugin_path)
    try:
        their_blob = bytes(plugin.raw_state)
        # host -> pedalboard: it must take our blob and give the same bytes back.
        plugin.raw_state = our_blob
        assert bytes(plugin.raw_state) == our_blob, (
            "pedalboard did not accept the state this host captured"
        )
    finally:
        del plugin

    # pedalboard -> host: the probe must apply their blob and re-capture it unchanged.
    theirs = tmp_path / "theirs.bin"
    theirs.write_bytes(their_blob)
    recaptured = tmp_path / "recaptured.bin"
    code, report = _run_probe(
        probe,
        "--load",
        plugin_path,
        "--state-in",
        str(theirs),
        "--state-out",
        str(recaptured),
    )
    assert code == 0, report
    assert report["state_in"]["applied"] is True, report["state_in"]["error"]
    assert recaptured.read_bytes() == their_blob, (
        "this host did not reproduce the state pedalboard captured"
    )

    # And where the plugin serialises itself reproducibly, the two hosts must agree outright at
    # defaults — that is what proves the container's payload encoding matches rather than merely
    # being self-consistent on each side.
    if reproducible:
        assert our_blob == their_blob


def test_a_foreign_blob_is_refused_without_crashing(
    probe: Path, plugin_path: str, tmp_path: Path
):
    """A state blob from a project file is untrusted input.

    Some plugins fault inside their own setState() on bytes they do not
    recognise, so the host contains the fault and answers with an error. Either
    way the probe must exit cleanly and say the state was not applied.
    """
    junk = tmp_path / "junk.bin"
    junk.write_bytes(b"this is not a plugin state container at all")

    code, report = _run_probe(probe, "--load", plugin_path, "--state-in", str(junk))
    assert code == 0, report
    assert report["state_in"]["applied"] is False
    assert report["state_in"]["error"]


# --------------------------------------------------------------------------------------
# The state container's text codec.
#
# pedalboard writes `vst.raw_state` through JUCE, whose MemoryBlock::toBase64Encoding emits
# base64EncodingTable[getBitRange(i * 6, 6)]; getBitRange accumulates
# (data[byte] >> offsetInByte) << bitsSoFar, so the bits run LEAST-significant-first both
# within each byte and within each 6-bit group. Packing them most-significant-first produces
# text of the same length that still round-trips against itself, so a self-round-trip proves
# nothing -- only these captured vectors do.
#
# Measured headless (pedalboard 0.9.25) against real plugins:
#   AIR Vocal Doubler IComponent, 187 bytes -> 41 43 56 53 00 00 00 00 41 49 52 20 56 6f 63 61
#                                             ("ACVS" chunk magic, then "AIR Vocal Doubler")
#   iZotope Vinyl     IComponent, 594 bytes -> 25 2b 9c 05 ... 78 9c (a zlib header)
# Most-significant-first gives 04 d9 15 4c ... and 96 c0 a7 14 ... respectively: noise.
# --------------------------------------------------------------------------------------

STATE_ALPHABET = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"

# Bytes 00 01 02 ... FF in this encoding, and the <IComponent> text lifted verbatim out of a
# pedalboard raw_state capture of AIR Vocal Doubler. Both are also compiled into the probe's
# --selftest, so the two implementations are pinned to the same numbers.
KNOWN_VECTOR_TEXT = (
    "256..Df.CPPAFb.BInvBLzfCO.QDRLAEUXwEXjgFavQGd7AHgHxHjThImfRJprBKs3xKvDiLyPSM"
    "1bCN4nyN7ziO+.TPBMDQEYzQHkjRKwTSN8DTQI0TTUkUWgUVZsEWc40WfElXiQVYlcFZoo1Zr0la"
    "uAWbxMGc0Y2c3kmd6wWe98GfAJ3fDVngGhXhJtHiM53iPFojSRYkVdIlYp4lb1omeBZnhNJokZ5o"
    "nlppqxZqt9JrwJ6rzVqs2hat5tKu856u.GrvCSbwFeLxIq7xL2ryOCczROM0Ua80Xms1ayc2d+M3"
    "gK93jWt4mid5puN6s696vGu7ySe81eO94q+972u++C"
)

AIR_CAPTURED_TEXT = (
    "187.AMjUSA....PPIIEHV81XgwFHD8VchwVYxA......................................"
    "........................A....b........vO.....fUNz5yiBWmO...f+Hwff7C6QgwOI4VZ"
    "zA.TRUzTEQkSA0TQE...............JU0PEAkboYWXzUFQgQWX.DP.BkGbgM2b.DP.C.PG...."
    ".....nTUCUDTxklcgQWYDEFcgA"
)

AIR_CAPTURED_HEAD = bytes.fromhex("414356530000000041495220566f6361")
AIR_CAPTURED_SIZE = 187


def _encode_state_text(data: bytes, *, lsb_first: bool) -> str:
    """The container's text encoding, in either bit order. ``lsb_first`` is the correct one."""
    total_bits = len(data) * 8
    chars = [f"{len(data)}."]
    for i in range((total_bits + 5) // 6):
        value = 0
        for k in range(6):
            bit = i * 6 + k
            if bit >= total_bits:
                break
            byte = data[bit >> 3]
            if lsb_first:
                value |= ((byte >> (bit & 7)) & 1) << k
            else:
                value |= ((byte >> (7 - (bit & 7))) & 1) << (5 - k)
        chars.append(STATE_ALPHABET[value])
    return "".join(chars)


def _decode_state_text(text: str, *, lsb_first: bool) -> bytes:
    dot = text.index(".")
    size = int(text[:dot])
    total_bits = size * 8
    out = bytearray(size)
    for i, char in enumerate(text[dot + 1 :]):
        value = STATE_ALPHABET.index(char)
        for k in range(6):
            bit = i * 6 + k
            if bit >= total_bits:
                break
            if lsb_first:
                if (value >> k) & 1:
                    out[bit >> 3] |= 1 << (bit & 7)
            elif (value >> (5 - k)) & 1:
                out[bit >> 3] |= 1 << (7 - (bit & 7))
    return bytes(out)


def test_known_vector_encodes_least_significant_bit_first():
    every_byte = bytes(range(256))
    assert _encode_state_text(every_byte, lsb_first=True) == KNOWN_VECTOR_TEXT
    assert _decode_state_text(KNOWN_VECTOR_TEXT, lsb_first=True) == every_byte


def test_the_other_bit_order_round_trips_but_does_not_match_the_vector():
    """Why a self-round-trip is not evidence: the wrong order passes that and fails this."""
    every_byte = bytes(range(256))
    wrong = _encode_state_text(every_byte, lsb_first=False)
    assert _decode_state_text(wrong, lsb_first=False) == every_byte
    assert wrong != KNOWN_VECTOR_TEXT


def test_a_captured_pedalboard_state_decodes_to_the_bytes_pedalboard_stored():
    decoded = _decode_state_text(AIR_CAPTURED_TEXT, lsb_first=True)
    assert len(decoded) == AIR_CAPTURED_SIZE
    assert decoded[:16] == AIR_CAPTURED_HEAD
    assert decoded[:4] == b"ACVS"
    assert decoded[8:17] == b"AIR Vocal"
    assert _encode_state_text(decoded, lsb_first=True) == AIR_CAPTURED_TEXT


def test_the_other_bit_order_turns_the_captured_state_into_noise():
    decoded = _decode_state_text(AIR_CAPTURED_TEXT, lsb_first=False)
    assert decoded[:16] != AIR_CAPTURED_HEAD
    assert decoded[:4] != b"ACVS"


def test_probe_selftest_pins_the_codec_to_the_same_vectors(probe: Path):
    """The C++ side of the same pin. No plugin needed, so it runs wherever the probe is."""
    code, report = _run_probe(probe, "--selftest")
    assert code == 0, report
    assert report.get("ok") is True, report.get("error")
    assert report.get("selftest") == "state_codec"


# --------------------------------------------------------------------------------------
# --set-param argument validation.
#
# These are pure argument-shape checks: they fail during parsing, before any plugin path is
# even required, so they run wherever the probe binary is built -- no THEDAW_TEST_VST3 needed.
# --------------------------------------------------------------------------------------


def test_set_param_needs_a_value(probe: Path):
    completed = _run_probe_raw(probe, "--set-param")
    assert completed.returncode == 2, completed.stdout
    assert "--set-param" in completed.stderr


def test_set_param_rejects_a_pair_with_no_equals_sign(probe: Path):
    completed = _run_probe_raw(probe, "--set-param", "3")
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


def test_set_param_rejects_a_pair_with_two_equals_signs(probe: Path):
    completed = _run_probe_raw(probe, "--set-param", "3=0.5=0.2")
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


def test_set_param_rejects_a_non_numeric_index_or_id(probe: Path):
    completed = _run_probe_raw(probe, "--set-param", "abc=0.5")
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


def test_set_param_rejects_a_negative_index_or_id(probe: Path):
    completed = _run_probe_raw(probe, "--set-param", "-1=0.5")
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


def test_set_param_rejects_a_non_numeric_value(probe: Path):
    completed = _run_probe_raw(probe, "--set-param", "0=abc")
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


def test_set_param_rejects_a_value_with_trailing_garbage(probe: Path):
    """A partially-numeric value must not be silently truncated and accepted.

    ``std::stod`` happily parses the numeric prefix of "0.5abc" and reports how much
    of the string it consumed; a parser that only checks *that something* was
    consumed (rather than the *whole* value part) accepts this pair. Asserting the
    "--set-param" message specifically (not just any exit-2 stderr) is what catches
    that: on the bug, parsing wrongly succeeds and the run instead dies later on a
    missing --list/--load/--selftest, which is also exit 2 but names none of them.
    """
    completed = _run_probe_raw(probe, "--set-param", "0=0.5abc")
    assert completed.returncode == 2, completed.stdout
    assert "--set-param" in completed.stderr, completed.stderr


def test_set_param_rejects_an_id_above_the_paramid_range(probe: Path):
    """An id/index that overflows uint32_t must not be silently truncated.

    VST3 ParamIDs are uint32_t, and the fallback lookup narrows the candidate id with
    ``static_cast<std::uint32_t>(arg.id)`` before comparing it against a real parameter's id.
    Without an explicit range check right after parsing, 4294967296 (2**32) truncates to 0,
    4294967297 to 1, and so on -- so a value one past the valid range would silently alias onto
    parameter id 0 instead of being rejected. Asserting the "--set-param" message specifically
    is what catches that: on the bug this pair parses successfully and the run instead dies
    later on a missing --list/--load/--selftest, which is also exit 2 but names neither.
    """
    completed = _run_probe_raw(probe, "--set-param", "4294967296=0.5")
    assert completed.returncode == 2, completed.stdout
    assert "--set-param" in completed.stderr, completed.stderr


def test_set_param_rejects_a_value_above_one(probe: Path):
    completed = _run_probe_raw(probe, "--set-param", "0=1.5")
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


def test_set_param_rejects_a_negative_value(probe: Path):
    completed = _run_probe_raw(probe, "--set-param", "0=-0.1")
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


# --------------------------------------------------------------------------------------
# --set-param against a real plugin: needs THEDAW_TEST_VST3, same as the rest of the file.
# --------------------------------------------------------------------------------------


def test_set_param_rejects_an_unknown_id_or_index(probe: Path, plugin_path: str):
    completed = _run_probe_raw(
        probe, "--load", plugin_path, "--set-param", "999999999=0.5"
    )
    assert completed.returncode == 2, completed.stdout
    assert completed.stderr.strip()


def test_set_param_applied_value_survives_a_state_round_trip(
    probe: Path, plugin_path: str, tmp_path: Path
):
    """The whole point of --set-param: prove a state captured with a non-default value

    restores that value, not the plugin's default. Picks a continuous automatable parameter
    so the target value is not quantised away by a stepped/boolean control.
    """
    code, report = _run_probe(probe, "--load", plugin_path)
    assert code == 0, report
    candidates = [p for p in report["params"] if p["automatable"] and not p["discrete"]]
    if not candidates:
        pytest.skip(
            "plugin exposes no continuous automatable parameter to test against"
        )
    target = candidates[0]
    # Clearly away from the default so the round trip cannot pass by accident.
    new_value = 0.15 if abs(target["default"] - 0.15) > 0.05 else 0.85

    captured = tmp_path / "set_param_state.bin"
    code, report = _run_probe(
        probe,
        "--load",
        plugin_path,
        "--set-param",
        f"{target['index']}={new_value}",
        "--state-out",
        str(captured),
    )
    assert code == 0, report
    applied = report["applied_params"]
    assert len(applied) == 1
    assert applied[0]["index"] == target["index"]
    assert applied[0]["id"] == target["id"]
    assert applied[0]["requested"] == pytest.approx(new_value, abs=1e-3)
    assert applied[0]["readback"] == pytest.approx(new_value, abs=1e-3)
    # The dump in the SAME run already reflects the applied value, not the default.
    dumped = next(p for p in report["params"] if p["index"] == target["index"])
    assert dumped["value"] == pytest.approx(new_value, abs=1e-3)

    restored_code, restored_report = _run_probe(
        probe, "--load", plugin_path, "--state-in", str(captured)
    )
    assert restored_code == 0, restored_report
    assert restored_report["state_in"]["applied"] is True, restored_report["state_in"][
        "error"
    ]
    restored_param = next(
        p for p in restored_report["params"] if p["index"] == target["index"]
    )
    assert restored_param["value"] == pytest.approx(new_value, abs=1e-3)
