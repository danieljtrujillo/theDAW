"""Take audio round-trips through an embedded .tasmo like clip audio does.

T46E gave a clip its `takes`, but only the clip's OWN `audio_file` was carried
into the archive on save and relinked to disk on open. A take's `audio_file`
stayed at its in-zip `audio/<name>`, which `/api/project/clip-audio` cannot
serve, so a real save -> open of a comped project came back with the clip
playing and its takes dropped. These pin both halves: every take's bytes are
embedded alongside the clip's (stored once when they are the same file), and
every take reference is relinked to the extracted file under `<stem>_media`.

A take whose file is not in the archive is NOT an error: the reference is left
exactly as written and the frontend drops takes+comp together and logs.
"""

import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    Clip,
    CompRegion,
    Take,
    TasmoProject,
    Track,
)

TAKE0_BYTES = b"RIFF....take-zero-audio"
TAKE1_BYTES = b"RIFF....take-one-audio-which-is-longer"


def _workdir() -> str:
    return tempfile.mkdtemp(prefix="tasmo_takes_embed_")


def _source_files(root: str) -> tuple[str, str]:
    """Two on-disk 'recordings': the active take's file, and a second pass."""
    a = os.path.join(root, "vocal_take0.wav")
    b = os.path.join(root, "vocal_take1.wav")
    with open(a, "wb") as f:
        f.write(TAKE0_BYTES)
    with open(b, "wb") as f:
        f.write(TAKE1_BYTES)
    return a, b


def _comped_project(take0: str, take1: str) -> TasmoProject:
    """One comped clip: two takes, the ACTIVE one sharing the clip's own file."""
    clip = Clip(
        id="c1",
        name="Vocal",
        clip_type="audio",
        track_id="t1",
        start_time=1.0,
        end_time=5.0,
        audio_file=take0,
        offset_into_source=0.25,
        takes=[
            Take(
                id="tk0",
                name="Take 0",
                audio_file=take0,
                mime_type="audio/wav",
                offset_into_source=0.25,
                source_duration=4.0,
            ),
            Take(
                id="tk1",
                name="Take 1",
                audio_file=take1,
                mime_type="audio/wav",
                offset_into_source=0.5,
                source_duration=4.5,
            ),
        ],
        comp=[
            CompRegion(start_sec=0.0, take_index=0),
            CompRegion(start_sec=1.5, take_index=1, crossfade_sec=0.02),
        ],
        active_take_index=0,
    )
    project = TasmoProject(project_name="Comped", tempo=96.0)
    project.tracks.append(
        Track(id="t1", name="Vox", type="audio", clips=[clip]),
    )
    return project


def test_every_take_file_is_embedded_and_relinked_on_open():
    root = _workdir()
    take0, take1 = _source_files(root)
    path = os.path.join(root, "comped.tasmo")

    project = _comped_project(take0, take1)
    manifest = TasmoFile.save(project, path, embed_audio=True)
    assert manifest["audio_mode"] == "embedded"

    # Both recordings made it into the archive, and the file the clip shares
    # with its active take is stored ONCE.
    names = sorted(TasmoFile.list_audio(path))
    assert names == ["audio/vocal_take0.wav", "audio/vocal_take1.wav"]

    loaded, _ = TasmoFile.load(path)
    clip = loaded.tracks[0].clips[0]
    media = os.path.join(root, "comped_media")

    assert clip.audio_file is not None
    assert os.path.isfile(clip.audio_file)
    assert os.path.dirname(clip.audio_file) == media

    assert clip.takes is not None and len(clip.takes) == 2
    for take in clip.takes:
        assert take.audio_file is not None
        assert os.path.isfile(take.audio_file), take.audio_file
        assert os.path.dirname(take.audio_file) == media

    # The active take and the clip name the same extracted file...
    assert clip.takes[0].audio_file == clip.audio_file
    # ...and each take's bytes are its own recording, not the other's.
    with open(clip.takes[0].audio_file, "rb") as f:
        assert f.read() == TAKE0_BYTES
    with open(clip.takes[1].audio_file, "rb") as f:
        assert f.read() == TAKE1_BYTES

    # Nothing else about the takes or the comp moved.
    assert [t.id for t in clip.takes] == ["tk0", "tk1"]
    assert clip.takes[1].offset_into_source == 0.5
    assert clip.takes[1].source_duration == 4.5
    assert [(r.start_sec, r.take_index) for r in clip.comp or []] == [
        (0.0, 0),
        (1.5, 1),
    ]
    assert clip.active_take_index == 0
    assert clip.offset_into_source == 0.25


def test_a_take_sharing_the_clips_file_is_stored_once_in_the_archive():
    """Dedup is by resolved path, across clip and take references alike."""
    root = _workdir()
    take0, _ = _source_files(root)
    path = os.path.join(root, "shared.tasmo")

    project = _comped_project(take0, take0)  # both takes = the clip's own file
    TasmoFile.save(project, path, embed_audio=True)

    assert TasmoFile.list_audio(path) == ["audio/vocal_take0.wav"]
    clip = project.tracks[0].clips[0]
    assert clip.audio_file == "audio/vocal_take0.wav"
    assert clip.takes is not None
    assert [t.audio_file for t in clip.takes] == [
        "audio/vocal_take0.wav",
        "audio/vocal_take0.wav",
    ]

    loaded, _ = TasmoFile.load(path)
    reloaded = loaded.tracks[0].clips[0]
    assert reloaded.takes is not None
    assert {t.audio_file for t in reloaded.takes} == {reloaded.audio_file}
    assert reloaded.audio_file is not None and os.path.isfile(reloaded.audio_file)


def test_a_project_without_takes_round_trips_byte_identically():
    """The pre-takes shape: clip audio in, the same bytes and fields out."""
    root = _workdir()
    take0, _ = _source_files(root)
    path = os.path.join(root, "legacy.tasmo")

    project = TasmoProject(project_name="Old", tempo=90.0)
    project.tracks.append(
        Track(
            id="t1",
            name="Gtr",
            type="audio",
            clips=[
                Clip(
                    id="c1",
                    name="riff",
                    clip_type="audio",
                    track_id="t1",
                    start_time=0.0,
                    end_time=2.0,
                    audio_file=take0,
                    offset_into_source=0.5,
                )
            ],
        )
    )
    TasmoFile.save(project, path, embed_audio=True)
    assert TasmoFile.list_audio(path) == ["audio/vocal_take0.wav"]

    loaded, _ = TasmoFile.load(path)
    clip = loaded.tracks[0].clips[0]
    assert clip.takes is None
    assert clip.comp is None
    assert clip.active_take_index is None
    assert clip.offset_into_source == 0.5
    assert clip.audio_file is not None
    with open(clip.audio_file, "rb") as f:
        assert f.read() == TAKE0_BYTES


def test_an_archive_missing_one_take_file_opens_and_leaves_that_take_alone():
    """A file written by a build that embedded only clip audio, or a hand-made
    archive: relink what is there, leave the rest exactly as written, raise
    nothing. The frontend drops takes+comp together and logs."""
    root = _workdir()
    path = os.path.join(root, "partial.tasmo")

    clip = Clip(
        id="c1",
        name="Vocal",
        clip_type="audio",
        track_id="t1",
        start_time=0.0,
        end_time=4.0,
        audio_file="audio/vocal_take0.wav",
        takes=[
            Take(id="tk0", audio_file="audio/vocal_take0.wav"),
            Take(id="tk1", audio_file="audio/vocal_take1.wav"),
            Take(id="tk2", audio_file=None),
        ],
        comp=[CompRegion(start_sec=0.0, take_index=0)],
        active_take_index=0,
    )
    project = TasmoProject(project_name="Partial", tempo=120.0)
    project.tracks.append(Track(id="t1", name="Vox", type="audio", clips=[clip]))

    # Only the clip's own file is in the archive — take 1's is not.
    TasmoFile.save(project, path, audio_files={"vocal_take0.wav": TAKE0_BYTES})
    with zipfile.ZipFile(path) as zf:
        assert "audio/vocal_take1.wav" not in zf.namelist()

    loaded, _ = TasmoFile.load(path)  # must not raise
    out = loaded.tracks[0].clips[0]
    assert out.takes is not None
    assert out.audio_file is not None and os.path.isfile(out.audio_file)
    assert out.takes[0].audio_file == out.audio_file
    # Untouched: the reference is still the in-zip path it was written with.
    assert out.takes[1].audio_file == "audio/vocal_take1.wav"
    assert out.takes[2].audio_file is None


def test_a_take_pointing_at_a_file_that_is_not_on_disk_is_skipped_on_save():
    """Embedding cannot read a take whose recording was moved away; the clip's
    own audio still embeds and the dangling reference is left as written."""
    root = _workdir()
    take0, _ = _source_files(root)
    gone = os.path.join(root, "deleted_take.wav")
    path = os.path.join(root, "dangling.tasmo")

    project = _comped_project(take0, gone)
    TasmoFile.save(project, path, embed_audio=True)

    assert TasmoFile.list_audio(path) == ["audio/vocal_take0.wav"]
    clip = project.tracks[0].clips[0]
    assert clip.takes is not None
    assert clip.takes[0].audio_file == "audio/vocal_take0.wav"
    assert clip.takes[1].audio_file == gone

    loaded, _ = TasmoFile.load(path)  # must not raise
    out = loaded.tracks[0].clips[0]
    assert out.takes is not None
    assert out.takes[1].audio_file == gone


def test_a_new_take_cannot_be_given_a_name_a_stale_in_zip_ref_already_uses(
    tmp_path,
):
    """A half-embedded project: the clip already names `audio/vocal_take0.wav`
    (kept as written), so a take being embedded from a DIFFERENT file that
    happens to be called vocal_take0.wav must get its own name rather than
    shadow the clip's reference."""
    root = str(tmp_path)
    other = tmp_path / "elsewhere"
    other.mkdir()
    fresh = other / "vocal_take0.wav"
    fresh.write_bytes(TAKE1_BYTES)
    path = os.path.join(root, "stale.tasmo")

    clip = Clip(
        id="c1",
        name="Vocal",
        clip_type="audio",
        track_id="t1",
        audio_file="audio/vocal_take0.wav",  # already in-zip, not re-read
        takes=[
            Take(id="tk0", audio_file="audio/vocal_take0.wav"),
            Take(id="tk1", audio_file=str(fresh)),
        ],
        active_take_index=0,
    )
    project = TasmoProject(project_name="Stale", tempo=120.0)
    project.tracks.append(Track(id="t1", name="Vox", type="audio", clips=[clip]))

    TasmoFile.save(project, path, embed_audio=True)

    assert clip.audio_file == "audio/vocal_take0.wav"
    assert clip.takes is not None
    assert clip.takes[0].audio_file == "audio/vocal_take0.wav"
    assert clip.takes[1].audio_file == "audio/vocal_take0_1.wav"
    assert TasmoFile.list_audio(path) == ["audio/vocal_take0_1.wav"]


def test_two_clips_sharing_one_source_file_get_the_same_checksum(tmp_path):
    """The file is stored once, so both clips name it AND its one checksum."""
    src = tmp_path / "shared_loop.wav"
    src.write_bytes(TAKE0_BYTES)
    path = str(tmp_path / "twoclips.tasmo")

    def _clip(cid: str) -> Clip:
        return Clip(
            id=cid,
            name=cid,
            clip_type="audio",
            track_id="t1",
            audio_file=str(src),
        )

    project = TasmoProject(project_name="Shared", tempo=120.0)
    project.tracks.append(
        Track(id="t1", name="Drums", type="audio", clips=[_clip("c1"), _clip("c2")])
    )
    TasmoFile.save(project, path, embed_audio=True)

    c1, c2 = project.tracks[0].clips
    assert TasmoFile.list_audio(path) == ["audio/shared_loop.wav"]
    assert c1.audio_file == c2.audio_file == "audio/shared_loop.wav"
    assert c1.audio_file_checksum is not None
    assert c1.audio_file_checksum.startswith("sha256:")
    assert c2.audio_file_checksum == c1.audio_file_checksum
