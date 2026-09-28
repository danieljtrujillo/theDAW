"""Opening a project allowlists its TAKE audio, not only each clip's own file.

`_register_project_media` is what turns "the user opened this project" into the
folders `/api/project/clip-audio` will serve from. It walked `clip.audio_file`
only. Embedded takes extract beside the clip's audio, so they were covered by
accident -- but two real cases were not:

  - the clip's own recording is gone (moved, deleted) while a take's file is
    still on disk: nothing registered that folder, so every take answered 403;
  - a LINKED project whose alternate passes were recorded into a different
    folder than the clip's own file: that second folder was never registered.

These pin both, and pin that a project without takes registers exactly what it
registered before.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.modules.project import media_access
from backend.modules.project.router import _register_project_media
from backend.modules.project.tasmo_project import Clip, Take, TasmoProject, Track


@pytest.fixture()
def clean_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """An empty session allowlist, persisted nowhere near the repo's data dir."""
    monkeypatch.delenv("theDAW_MEDIA_ROOTS", raising=False)
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    return media_access._session_roots


def _project(clip: Clip) -> TasmoProject:
    return TasmoProject(
        project_name="Takes",
        tracks=[Track(id="t1", name="Vocal", type="audio", clips=[clip])],
    )


def _take(idx: int, path: Path) -> Take:
    return Take(
        id=f"tk{idx}",
        name=f"Take {idx}",
        audio_file=str(path),
        mime_type="audio/wav",
        source_duration=4.0,
    )


def _clip(audio_file: str | None, takes: list[Take] | None) -> Clip:
    return Clip(
        id="c1",
        name="Vocal",
        clip_type="audio",
        track_id="t1",
        start_time=0.0,
        end_time=4.0,
        audio_file=audio_file,
        takes=takes,
        active_take_index=0 if takes else None,
    )


def _recording(folder: Path, name: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    f = folder / name
    f.write_bytes(b"RIFF....WAVEfmt take-bytes")
    return f


def test_take_only_project_registers_the_take_folder(clean_roots, tmp_path):
    """The clip's own file is gone; its takes must still be servable."""
    takes_dir = tmp_path / "recordings"
    take = _recording(takes_dir, "vocal_take1.wav")
    assert media_access.resolve_media_path(str(take)) is None

    _register_project_media(_project(_clip(None, [_take(1, take)])), request=None)

    assert media_access.resolve_media_path(str(take)) == take.resolve()


def test_linked_take_in_another_folder_is_registered(clean_roots, tmp_path):
    """A linked project may have recorded its second pass somewhere else."""
    clip_audio = _recording(tmp_path / "session", "vocal.wav")
    far_take = _recording(tmp_path / "overdubs", "vocal_take2.wav")

    _register_project_media(
        _project(_clip(str(clip_audio), [_take(1, clip_audio), _take(2, far_take)])),
        request=None,
    )

    assert media_access.resolve_media_path(str(clip_audio)) == clip_audio.resolve()
    assert media_access.resolve_media_path(str(far_take)) == far_take.resolve()


def test_in_archive_take_refs_are_not_registered(clean_roots, tmp_path):
    """``audio/<name>`` never touches disk, so it must not widen the allowlist."""
    clip_audio = _recording(tmp_path / "session", "vocal.wav")
    embedded = Take(
        id="tk1", name="Take 1", audio_file="audio/vocal_take1.wav", mime_type=""
    )

    _register_project_media(_project(_clip(str(clip_audio), [embedded])), request=None)

    assert media_access._session_roots == [(tmp_path / "session").resolve()]


def test_clip_only_project_registers_what_it_did_before(clean_roots, tmp_path):
    """No takes: the same one folder, and nothing else."""
    clip_audio = _recording(tmp_path / "session", "vocal.wav")

    _register_project_media(_project(_clip(str(clip_audio), None)), request=None)

    assert media_access._session_roots == [(tmp_path / "session").resolve()]
    assert media_access.resolve_media_path(str(clip_audio)) == clip_audio.resolve()


def test_extra_paths_argument_still_registers(clean_roots, tmp_path):
    """The .tasmo's own folder is passed positionally by /save and /load."""
    tasmo_dir = tmp_path / "projects"
    tasmo = _recording(tasmo_dir, "song.tasmo")
    take = _recording(tmp_path / "recordings", "vocal_take1.wav")

    _register_project_media(
        _project(_clip(None, [_take(1, take)])), str(tasmo), request=None
    )

    assert media_access.resolve_media_path(str(tasmo)) == tasmo.resolve()
    assert media_access.resolve_media_path(str(take)) == take.resolve()
