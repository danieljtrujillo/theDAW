"""Rendering a score to audio with MuseScore 4 and Muse Sounds.

MuseScore is never run here: the finder is pointed at files made in a temp
folder and ``subprocess.run`` is replaced by a stand-in that writes the WAV
MuseScore would. The Library store is a stand-in that records what it is
handed.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pretty_midi
import pytest
import soundfile

from backend.modules.library.db import LibraryDB
from backend.modules.notation import engine, musescore_render
from backend.modules.notation.engine import convert_score
from backend.modules.notation.musescore_render import (
    MUSE_SOUNDS_PROFILE,
    REASON_NO_MUSE_SOUNDS,
    REASON_NO_MUSESCORE,
    find_musescore4,
    is_musescore4,
    musescore_status,
)


def _file(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return path


@pytest.fixture
def machine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A machine with no MuseScore and no Muse Sounds: every place the finder
    looks is under ``tmp_path`` and empty."""
    monkeypatch.delenv("MUSESCORE_BIN", raising=False)
    monkeypatch.setattr(engine, "_musescore_settings_path", lambda: "")
    monkeypatch.setattr(engine, "_musescore_install_candidates", lambda: [])
    monkeypatch.setattr(musescore_render, "_registry_candidates", lambda: [])
    monkeypatch.setattr(musescore_render.shutil, "which", lambda name: None)
    sampler = tmp_path / "MuseSampler" / "lib" / "MuseSamplerCoreLib.dll"
    monkeypatch.setattr(musescore_render, "muse_sampler_paths", lambda: [sampler])
    monkeypatch.setattr(engine, "_musescore_version", lambda binary: "MuseScore4 4.6.2")

    @dataclass
    class Machine:
        root: Path
        sampler: Path

        def install_musescore(self, name: str = "MuseScore4.exe") -> Path:
            exe = _file(self.root / "MuseScore 4" / "bin" / name)
            monkeypatch.setenv("MUSESCORE_BIN", str(exe))
            return exe

        def install_muse_sounds(self) -> None:
            _file(self.sampler)

    return Machine(tmp_path, sampler)


# --------------------------------------------------------------------------
# the finder
# --------------------------------------------------------------------------


def test_status_without_musescore(machine) -> None:
    status = musescore_status()
    assert status == {
        "found": False,
        "path": None,
        "muse_sounds": False,
        "reason": REASON_NO_MUSESCORE,
    }


def test_status_with_musescore_and_no_muse_sounds(machine) -> None:
    exe = machine.install_musescore()
    status = musescore_status()
    assert status["found"] is True
    assert status["path"] == str(exe)
    assert status["muse_sounds"] is False
    assert status["reason"] == REASON_NO_MUSE_SOUNDS


def test_status_with_musescore_and_muse_sounds(machine) -> None:
    exe = machine.install_musescore()
    machine.install_muse_sounds()
    assert musescore_status() == {
        "found": True,
        "path": str(exe),
        "muse_sounds": True,
        "reason": "",
    }


def test_the_registry_finds_musescore_off_path(machine, monkeypatch) -> None:
    exe = _file(
        machine.root / "Program Files" / "MuseScore 4" / "bin" / "MuseScore4.exe"
    )
    monkeypatch.setattr(musescore_render, "_registry_candidates", lambda: [exe])
    assert find_musescore4() == exe


def test_path_names_are_found(machine, monkeypatch) -> None:
    exe = _file(machine.root / "bin" / "mscore")
    monkeypatch.setattr(
        musescore_render.shutil,
        "which",
        lambda name: str(exe) if name == "mscore" else None,
    )
    assert find_musescore4() == exe


def test_musescore_3_is_not_musescore_4(machine, monkeypatch) -> None:
    exe = _file(machine.root / "MuseScore 3" / "bin" / "MuseScore3.exe")
    monkeypatch.setenv("MUSESCORE_BIN", str(exe))
    assert find_musescore4() is None
    assert musescore_status()["reason"] == REASON_NO_MUSESCORE


def test_a_plain_name_is_judged_by_its_version() -> None:
    assert is_musescore4(Path("/usr/bin/mscore"), version=lambda b: "MuseScore4 4.5.2")
    assert not is_musescore4(
        Path("/usr/bin/mscore"), version=lambda b: "MuseScore3 3.6.2"
    )
    assert is_musescore4(Path("C:/x/MuseScore4.exe"), version=lambda b: "")
    assert not is_musescore4(Path("C:/x/MuseScore3.exe"), version=lambda b: "4.0")


def test_the_route_reports_the_status(machine) -> None:
    from backend.modules.notation.router import get_musescore

    machine.install_musescore()
    assert get_musescore()["reason"] == REASON_NO_MUSE_SOUNDS


# --------------------------------------------------------------------------
# the audio target
# --------------------------------------------------------------------------


@dataclass
class _Record:
    id: str
    audio_url: str


class _Store:
    def __init__(self) -> None:
        self.imported: list[dict[str, Any]] = []

    def import_blob(
        self,
        audio_bytes: bytes,
        filename: str,
        mime_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> _Record:
        self.imported.append(
            {
                "bytes": audio_bytes,
                "filename": filename,
                "mime_type": mime_type,
                "metadata": dict(metadata or {}),
            }
        )
        return _Record(
            id="rendered-entry", audio_url="/api/library/rendered-entry/audio"
        )


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> _Store:
    from backend.modules.library import router as library_router

    fake = _Store()
    monkeypatch.setattr(library_router, "get_store", lambda: fake)
    return fake


class _MuseScoreRun:
    """Stands in for ``subprocess.run``: records the argv and writes one
    second of silence where ``-o`` says."""

    def __init__(self, returncode: int = 0, write: bool = True) -> None:
        self.calls: list[list[str]] = []
        self.returncode = returncode
        self.write = write
        self.sources_seen: list[bool] = []

    def __call__(self, argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
        self.calls.append(list(argv))
        self.sources_seen.append(Path(argv[-1]).is_file())
        if self.write:
            out = Path(argv[argv.index("-o") + 1])
            soundfile.write(str(out), np.zeros((44100, 2), dtype="float32"), 44100)
        return subprocess.CompletedProcess(argv, self.returncode, "", "render failed")


def _musicxml(tmp_path: Path) -> Path:
    from music21 import note, stream

    part = stream.Part()
    for pitch in ("C4", "E4", "G4", "C5"):
        part.append(note.Note(pitch))
    score = stream.Score()
    score.insert(0, part)
    path = tmp_path / "sheet" / "song.musicxml"
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))
    return path


def _midi(tmp_path: Path) -> Path:
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate([60, 64, 67, 72]):
        inst.notes.append(pretty_midi.Note(100, pitch, i * 0.5, i * 0.5 + 0.5))
    pm.instruments.append(inst)
    path = tmp_path / "midi" / "song.mid"
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return path


def _db(tmp_path: Path) -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    return db


def test_audio_renders_with_muse_sounds_into_the_library(
    machine, store, tmp_path: Path, monkeypatch
) -> None:
    exe = machine.install_musescore()
    machine.install_muse_sounds()
    run = _MuseScoreRun()
    monkeypatch.setattr(musescore_render.subprocess, "run", run)
    source = _musicxml(tmp_path)
    output = tmp_path / "notation" / "song.wav"
    db = _db(tmp_path)

    result = convert_score(
        db,
        entry_id="track",
        source_path=source,
        fmt="audio",
        output_path=output,
        source_ref="sheet-1",
        title="Song",
    )

    assert result["ok"] is True, result
    assert result["library_entry_id"] == "rendered-entry"
    assert result["artifact"] is None
    assert run.calls == [
        [
            str(exe),
            "-o",
            str(output),
            "--sound-profile",
            MUSE_SOUNDS_PROFILE,
            str(source),
        ]
    ]
    (imported,) = store.imported
    assert imported["mime_type"] == "audio/wav"
    assert imported["bytes"][:4] == b"RIFF"
    assert imported["metadata"]["title"] == "Song (MuseScore)"
    assert imported["metadata"]["source"] == "generate"
    assert imported["metadata"]["duration"] == pytest.approx(1.0)
    assert "musescore" in imported["metadata"]["tags"]
    # The Library holds the WAV now; the scratch copy is gone.
    assert not output.exists()
    (relation,) = db.list_relations(from_id="sheet-1", kind="rendered_as_audio")
    assert relation["to_id"] == "rendered-entry"


def test_a_midi_source_is_staged_as_musicxml_for_musescore(
    machine, store, tmp_path: Path, monkeypatch
) -> None:
    machine.install_musescore()
    machine.install_muse_sounds()
    run = _MuseScoreRun()
    monkeypatch.setattr(musescore_render.subprocess, "run", run)
    output = tmp_path / "notation" / "song.wav"

    result = convert_score(
        _db(tmp_path),
        entry_id="track",
        source_path=_midi(tmp_path),
        fmt="audio",
        output_path=output,
        title="Song",
    )

    assert result["ok"] is True, result
    staged = Path(run.calls[0][-1])
    assert staged.suffix == ".musicxml"
    assert run.sources_seen == [True]
    assert not staged.exists()


@pytest.mark.parametrize(
    ("musescore", "muse_sounds", "reason"),
    [(False, False, REASON_NO_MUSESCORE), (True, False, REASON_NO_MUSE_SOUNDS)],
)
def test_audio_names_what_is_missing_and_never_runs(
    machine, store, tmp_path: Path, monkeypatch, musescore, muse_sounds, reason
) -> None:
    if musescore:
        machine.install_musescore()
    if muse_sounds:
        machine.install_muse_sounds()
    run = _MuseScoreRun()
    monkeypatch.setattr(musescore_render.subprocess, "run", run)

    result = convert_score(
        _db(tmp_path),
        entry_id="track",
        source_path=_musicxml(tmp_path),
        fmt="audio",
        output_path=tmp_path / "notation" / "song.wav",
    )

    assert result == {"ok": False, "engine": "musescore", "error": reason}
    assert run.calls == []
    assert store.imported == []


def test_a_failed_render_reports_musescore_and_adds_nothing(
    machine, store, tmp_path: Path, monkeypatch
) -> None:
    machine.install_musescore()
    machine.install_muse_sounds()
    monkeypatch.setattr(
        musescore_render.subprocess, "run", _MuseScoreRun(returncode=1, write=False)
    )

    result = convert_score(
        _db(tmp_path),
        entry_id="track",
        source_path=_musicxml(tmp_path),
        fmt="audio",
        output_path=tmp_path / "notation" / "song.wav",
    )

    assert result["ok"] is False
    assert "render failed" in result["error"]
    assert store.imported == []


def test_the_export_route_takes_audio() -> None:
    from backend.modules.notation.router import _EXT_FOR_FORMAT

    assert _EXT_FOR_FORMAT["audio"] == ".wav"
