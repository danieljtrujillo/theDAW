"""``thedaw-vst-host --render --automation-json``: parameters that move as the file plays.

A print of an automated insert hands the native host a curve per parameter
(``[frame, value]`` points, linear between them) and the host sets each
parameter to its curve's value at the start of every block, only when it
moved. The null plugin declares two parameters (``Alpha``, ``Beta``), so the
render's report says how many curves were applied and how many writes the
blocks made, which is the whole contract: a ramp over four blocks is five
writes (one per block up to the ramp's end, then none while it holds).

Skipped as a whole when the binary has not been built.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from tests.vst_host_client import host_exe, run_host

pytestmark = pytest.mark.skipif(
    host_exe() is None,
    reason="native/vst-host/bin/thedaw-vst-host.exe not built",
)

BLOCK = 1024


def _render(tmp_path: Path, automation: list[dict]) -> dict:
    src = tmp_path / "in.wav"
    out = tmp_path / "out.wav"
    curves = tmp_path / "automation.json"
    sf.write(src, np.zeros((BLOCK * 8, 2), dtype="float32"), 48000, subtype="FLOAT")
    curves.write_text(json.dumps(automation), encoding="utf-8")
    proc = run_host(
        [
            "--render",
            "--null-plugin",
            "--in",
            str(src),
            "--out",
            str(out),
            "--block-size",
            str(BLOCK),
            "--automation-json",
            str(curves),
        ]
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout.strip().splitlines()[-1])
    assert report["ok"] is True
    return report


def test_a_ramp_moves_its_parameter_once_a_block_until_it_holds(tmp_path: Path) -> None:
    report = _render(tmp_path, [{"index": 0, "points": [[0, 0.0], [BLOCK * 4, 1.0]]}])

    assert report["automated_params"] == 1
    # Blocks at 0, 1024, 2048, 3072 and 4096 each find a new value; the last
    # four blocks hold 1.0 and write nothing.
    assert report["automation_writes"] == 5


def test_a_parameter_is_found_by_name_when_its_index_is_not_the_plugins(
    tmp_path: Path,
) -> None:
    report = _render(
        tmp_path,
        [
            {"index": 99, "name": "Beta", "points": [[0, 0.2]]},
            {"index": 42, "points": [[0, 0.7]]},
        ],
    )

    assert report["automated_params"] == 1
    assert report["automation_writes"] == 1
    assert any('no parameter "42"' in w for w in report["warnings"])


def test_a_render_with_no_automation_writes_nothing(tmp_path: Path) -> None:
    report = _render(tmp_path, [])

    assert report["automated_params"] == 0
    assert report["automation_writes"] == 0
