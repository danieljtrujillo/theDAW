"""Beat Saber custom-level writer: ``Info.dat`` + ``<Difficulty>.dat`` + audio.

Consumes a ``gantasmo.notechart`` document whose events already carry the
Beat Saber mapping (``bsLine`` / ``bsLayer`` / ``bsColor`` / ``bsCut`` /
``bsMinDifficulty``, stamped by :mod:`.beatsaber_map`). Nothing musical is
decided here: this module only serialises those fields into the file layout
the game loads, so the web highway's "blocks" skin and the exported level show
the same notes.

Timing contract: seconds are the invariant, beats are derived. Every note's
``_time`` / ``b`` is ``(onsetSecRaw + timing.audioOffsetSec) * bpm / 60``
against ONE constant ``Info.dat`` BPM (``_beatsPerMinute``), so the game's
grid lands on the recording regardless of the chart's own tempo map.

Field names follow the BSMG map-format reference (bsmg.wiki/mapping/map-format:
``info.html`` and ``beatmap.html``), fetched when this module was written:

  - Info.dat v2 (``_version`` ``2.0.0``): ``_songName``, ``_songSubName``,
    ``_songAuthorName``, ``_levelAuthorName``, ``_beatsPerMinute``,
    ``_shuffle``, ``_shufflePeriod``, ``_previewStartTime``,
    ``_previewDuration``, ``_songFilename``, ``_coverImageFilename``,
    ``_environmentName``, ``_allDirectionsEnvironmentName``,
    ``_songTimeOffset``, ``_difficultyBeatmapSets`` [{
    ``_beatmapCharacteristicName``, ``_difficultyBeatmaps`` [{``_difficulty``,
    ``_difficultyRank``, ``_beatmapFilename``, ``_noteJumpMovementSpeed``,
    ``_noteJumpStartBeatOffset``}]}]. Difficulty names Easy / Normal / Hard /
    Expert / ExpertPlus rank 1 / 3 / 5 / 7 / 9.
  - Beatmap v2 (``_version`` ``2.0.0``): ``_notes`` [{``_time``,
    ``_lineIndex`` 0..3, ``_lineLayer`` 0..2, ``_type`` 0 left / 1 right / 3
    bomb, ``_cutDirection`` 0..8}], ``_obstacles``, ``_events``.
  - Beatmap v3 (``version`` ``3.2.0``): ``bpmEvents`` [{``b``, ``m``}],
    ``rotationEvents``, ``colorNotes`` [{``b``, ``x``, ``y``, ``c``, ``d``,
    ``a``}], ``bombNotes``, ``obstacles``, ``sliders``, ``burstSliders``,
    ``waypoints``, ``basicBeatmapEvents``, ``colorBoostBeatmapEvents``,
    ``lightColorEventBoxGroups``, ``lightRotationEventBoxGroups``,
    ``lightTranslationEventBoxGroups`` (3.2.0+),
    ``basicEventTypesWithKeywords`` {``d``: []},
    ``useNormalEventsAsCompatibleEvents``.

v4 (metadata-array compression, separate lightshow file) is out of scope.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Optional

from backend.modules.library import media as _media

from .beatsaber_map import DIFFICULTIES, DIFFICULTY_NAMES, level_index, notes_for_level

log = logging.getLogger(__name__)

INFO_VERSION = "2.0.0"
BEATMAP_V2_VERSION = "2.0.0"
BEATMAP_V3_VERSION = "3.2.0"
SUPPORTED_VERSIONS = (2, 3)
DEFAULT_DIFFICULTIES = ["Normal", "Hard"]
LEVEL_AUTHOR = "theDAW"
SONG_FILENAME = "song.ogg"
ZIP_SUFFIX = ".beatsaber.zip"
README_NAME = "README.txt"
README_TEXT = (
    "This level has no song.ogg: ffmpeg was not found on the machine that "
    "exported it.\n"
    "Encode the original track to Ogg Vorbis (e.g. `ffmpeg -i track.wav -vn "
    "-c:a libvorbis -q:a 6 -ar 44100 song.ogg`), drop the file next to Info.dat "
    "as song.ogg, and the level loads.\n"
)
# Beat Saber rejects an empty _songFilename; the README variant still names the
# file the player is expected to add.
FFMPEG_TIMEOUT_SEC = 600
# Beats are written to four decimals; the game's own editor does the same and
# 1e-4 beat at 300 BPM is 20 us.
BEAT_DIGITS = 4


def _f(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out and out not in (float("inf"), float("-inf")) else default


def _i(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def find_ffmpeg() -> Optional[str]:
    """The ffmpeg binary on PATH, or ``None``. Thin wrapper so tests (and the
    capabilities probe) can patch one place."""
    return _media.find_ffmpeg()


def beat_time(sec: float, bpm: float) -> float:
    """Seconds → beats against a constant BPM, rounded to :data:`BEAT_DIGITS`."""
    return round(_f(sec) * _f(bpm) / 60.0, BEAT_DIGITS)


def normalise_difficulties(names: Optional[list[str]]) -> list[str]:
    """Known difficulty names in :data:`DIFFICULTIES` order; unknown names are
    dropped and an empty selection falls back to :data:`DEFAULT_DIFFICULTIES`."""
    chosen: set[int] = set()
    for name in names or []:
        index = level_index(str(name))
        if index >= 0:
            chosen.add(index)
    if not chosen:
        chosen = {level_index(name) for name in DEFAULT_DIFFICULTIES}
    return [DIFFICULTY_NAMES[index] for index in sorted(chosen)]


def _note_seconds(chart: dict[str, Any], event: dict[str, Any]) -> float:
    """Audio-time onset of one event: raw when the chart has raw onsets, the
    engraved value otherwise, plus the chart's audio offset."""
    quantization = chart.get("quantization") or {}
    raw_is_quantized = bool(quantization.get("rawIsQuantized", True))
    onset = _f(event.get("onsetSec" if raw_is_quantized else "onsetSecRaw"))
    offset = _f((chart.get("timing") or {}).get("audioOffsetSec", 0.0))
    return onset + offset


def build_difficulty_dat(
    chart: dict[str, Any],
    level: int,
    *,
    bpm: float,
    version: int,
    part_indices: Optional[list[int]] = None,
) -> dict[str, Any]:
    """One ``<Difficulty>.dat`` document for ``level`` (0 Easy .. 4 ExpertPlus).

    Notes come from :func:`beatsaber_map.notes_for_level` (already sorted by
    raw onset, then line), so the output order is the play order.
    """
    if version not in SUPPORTED_VERSIONS:
        raise ValueError(f"unsupported Beat Saber beatmap version: {version!r}")
    bpm = _f(bpm)
    if bpm <= 0:
        raise ValueError(f"bpm must be positive, got {bpm!r}")
    notes = notes_for_level(chart.get("parts") or [], level, part_indices)

    if version == 2:
        return {
            "_version": BEATMAP_V2_VERSION,
            "_events": [],
            "_notes": [
                {
                    "_time": beat_time(_note_seconds(chart, event), bpm),
                    "_lineIndex": _i(event.get("bsLine")),
                    "_lineLayer": _i(event.get("bsLayer")),
                    "_type": _i(event.get("bsColor")),
                    "_cutDirection": _i(event.get("bsCut"), 8),
                }
                for event in notes
            ],
            "_obstacles": [],
        }

    return {
        "version": BEATMAP_V3_VERSION,
        "bpmEvents": [{"b": 0.0, "m": bpm}],
        "rotationEvents": [],
        "colorNotes": [
            {
                "b": beat_time(_note_seconds(chart, event), bpm),
                "x": _i(event.get("bsLine")),
                "y": _i(event.get("bsLayer")),
                "c": _i(event.get("bsColor")),
                "d": _i(event.get("bsCut"), 8),
                "a": 0,
            }
            for event in notes
        ],
        "bombNotes": [],
        "obstacles": [],
        "sliders": [],
        "burstSliders": [],
        "waypoints": [],
        "basicBeatmapEvents": [],
        "colorBoostBeatmapEvents": [],
        "lightColorEventBoxGroups": [],
        "lightRotationEventBoxGroups": [],
        "lightTranslationEventBoxGroups": [],
        "basicEventTypesWithKeywords": {"d": []},
        "useNormalEventsAsCompatibleEvents": False,
    }


def build_info_dat(
    *,
    song_name: str,
    artist: str,
    bpm: float,
    difficulties: list[str],
    version: int,
    has_audio: bool,
) -> dict[str, Any]:
    """The level's ``Info.dat`` (v2 ``2.0.0`` — the layout every loader and
    community tool reads, whichever beatmap version the ``.dat`` files use).

    ``version`` is recorded only in ``_customData`` for provenance; the game
    detects the beatmap version from each ``.dat`` itself. ``has_audio`` is
    informational too: ``_songFilename`` always names ``song.ogg`` so a player
    who adds the file by hand (see README.txt) needs no edit.
    """
    chosen = normalise_difficulties(difficulties)
    beatmaps: list[dict[str, Any]] = []
    for name, rank, njs in DIFFICULTIES:
        if name not in chosen:
            continue
        beatmaps.append(
            {
                "_difficulty": name,
                "_difficultyRank": rank,
                "_beatmapFilename": f"{name}.dat",
                "_noteJumpMovementSpeed": njs,
                "_noteJumpStartBeatOffset": 0,
            }
        )
    return {
        "_version": INFO_VERSION,
        "_songName": str(song_name or "Untitled"),
        "_songSubName": "",
        "_songAuthorName": str(artist or ""),
        "_levelAuthorName": LEVEL_AUTHOR,
        "_beatsPerMinute": _f(bpm),
        "_shuffle": 0,
        "_shufflePeriod": 0.5,
        "_previewStartTime": 12,
        "_previewDuration": 10,
        "_songFilename": SONG_FILENAME,
        "_coverImageFilename": "",
        "_environmentName": "DefaultEnvironment",
        "_allDirectionsEnvironmentName": "GlassDesertEnvironment",
        "_songTimeOffset": 0,
        "_customData": {
            "_generator": LEVEL_AUTHOR,
            "_beatmapVersion": int(version),
            "_hasAudio": bool(has_audio),
        },
        "_difficultyBeatmapSets": [
            {
                "_beatmapCharacteristicName": "Standard",
                "_difficultyBeatmaps": beatmaps,
            }
        ],
    }


def encode_song_ogg(audio_path: Path, out: Path) -> bool:
    """Transcode ``audio_path`` to 44.1 kHz Ogg Vorbis at ``out`` with ffmpeg.

    ``False`` when ffmpeg is absent, fails, times out or writes nothing; never
    raises, because a missing encoder must not lose the rest of the level.
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return False
    audio_path = Path(audio_path)
    if not audio_path.is_file():
        return False
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(audio_path),
        "-vn",
        "-c:a",
        "libvorbis",
        "-q:a",
        "6",
        "-ar",
        "44100",
        str(out),
    ]
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=FFMPEG_TIMEOUT_SEC,
            shell=False,
            **kwargs,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("beatsaber: ffmpeg failed for %s: %s", audio_path, exc)
        return False
    if proc.returncode != 0:
        log.warning(
            "beatsaber: ffmpeg exit %s for %s: %s",
            proc.returncode,
            audio_path,
            (proc.stderr or b"")[-400:].decode("utf-8", "replace"),
        )
        return False
    return out.is_file() and out.stat().st_size > 0


def level_folder_for(zip_path: Path) -> Path:
    """The level directory a zip is built from: ``<name>.beatsaber.zip`` →
    ``<name>``; any other zip name just loses its last suffix."""
    zip_path = Path(zip_path)
    name = zip_path.name
    if name.lower().endswith(ZIP_SUFFIX):
        return zip_path.with_name(name[: -len(ZIP_SUFFIX)])
    return zip_path.with_suffix("")


def _dump(path: Path, document: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(
            document, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ),
        encoding="utf-8",
    )


def _part_names(chart: dict[str, Any], part_indices: Optional[list[int]]) -> list[str]:
    parts = chart.get("parts") or []
    wanted = None if part_indices is None else {int(i) for i in part_indices}
    names: list[str] = []
    for index, part in enumerate(parts):
        if wanted is not None and index not in wanted:
            continue
        names.append(str(part.get("name") or f"Part {index + 1}"))
    return names


def write_beatsaber(
    chart: dict[str, Any],
    zip_path: Path,
    *,
    song_name: str,
    artist: str,
    bpm: float,
    bpm_source: str,
    difficulties: list[str],
    version: int = 2,
    audio_path: Optional[Path],
    include_audio: bool = True,
    part_indices: Optional[list[int]] = None,
) -> dict[str, Any]:
    """Write a complete custom level folder next to ``zip_path`` and zip it.

    The folder is recreated from scratch (stale ``.dat`` files from a previous
    difficulty selection would otherwise ship), then archived under one
    top-level directory named after the folder, which is the layout Beat Saber's
    ``CustomLevels`` and every community viewer expect. Returns the result dict
    described in the plan (``ok``, ``path``, ``folder``, ``difficulties``,
    ``note_counts``, ``bpm``, ``bpm_source``, ``version``, ``song_ogg``,
    ``warning``, ``parts``) or ``{"ok": False, "error": ...}``; never raises.
    """
    try:
        version = int(version)
        if version not in SUPPORTED_VERSIONS:
            return {
                "ok": False,
                "error": f"unsupported Beat Saber beatmap version {version!r} "
                f"(supported: {list(SUPPORTED_VERSIONS)})",
            }
        bpm = _f(bpm)
        if bpm <= 0:
            return {"ok": False, "error": f"bpm must be positive, got {bpm!r}"}
        if not (chart.get("parts") or []):
            return {"ok": False, "error": "chart has no parts"}

        chosen = normalise_difficulties(difficulties)
        zip_path = Path(zip_path)
        folder = level_folder_for(zip_path)
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True, exist_ok=True)

        note_counts: dict[str, int] = {}
        for name in chosen:
            level = level_index(name)
            dat = build_difficulty_dat(
                chart, level, bpm=bpm, version=version, part_indices=part_indices
            )
            notes = dat["_notes"] if version == 2 else dat["colorNotes"]
            note_counts[name] = len(notes)
            _dump(folder / f"{name}.dat", dat)

        warning = ""
        song_ogg = False
        if include_audio and audio_path is not None and Path(audio_path).is_file():
            song_ogg = encode_song_ogg(Path(audio_path), folder / SONG_FILENAME)
            if not song_ogg:
                warning = (
                    "no song.ogg: ffmpeg is not available on this machine "
                    "(or the encode failed); encode the track to Ogg Vorbis and "
                    "drop it into the level folder as song.ogg"
                )
        elif include_audio:
            warning = "no song.ogg: the entry has no audio file to encode"
        else:
            warning = "song.ogg omitted on request"
        if not song_ogg:
            (folder / README_NAME).write_text(README_TEXT, encoding="utf-8")

        _dump(
            folder / "Info.dat",
            build_info_dat(
                song_name=song_name,
                artist=artist,
                bpm=bpm,
                difficulties=chosen,
                version=version,
                has_audio=song_ogg,
            ),
        )

        if sum(note_counts.values()) == 0:
            warning = (warning + "; " if warning else "") + (
                "no notes qualified for the chosen difficulties/parts"
            )

        zip_path.parent.mkdir(parents=True, exist_ok=True)
        if zip_path.exists():
            zip_path.unlink()
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for member in sorted(folder.iterdir()):
                if member.is_file():
                    zf.write(member, arcname=f"{folder.name}/{member.name}")
        with zipfile.ZipFile(zip_path) as zf:
            bad = zf.testzip()
        if bad is not None:
            return {"ok": False, "error": f"zip failed verification at {bad!r}"}

        return {
            "ok": True,
            "path": str(zip_path),
            "folder": str(folder),
            "difficulties": chosen,
            "note_counts": note_counts,
            "bpm": bpm,
            "bpm_source": str(bpm_source or ""),
            "version": version,
            "song_ogg": song_ogg,
            "warning": warning,
            "parts": _part_names(chart, part_indices),
        }
    except Exception as exc:  # noqa: BLE001 - report, never raise into the route
        log.warning("beatsaber: write failed for %s: %s", zip_path, exc)
        return {"ok": False, "error": repr(exc)}
