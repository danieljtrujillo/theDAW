"""Parse notated scores into piano-roll note batches.

Uses music21 (a core dependency). Notes are returned already mapped to the piano
roll's 16th-note step grid:

    step   = offset_in_quarters   * STEPS_PER_QUARTER
    length = duration_in_quarters * STEPS_PER_QUARTER   (>= 1)

Because music21 offsets/durations are in quarter-note units (tempo-independent),
the resulting grid lines up regardless of the score's metronome mark. The
returned ``bpm`` is a hint the caller can apply to the roll so playback speed
matches the score.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# Symbolic formats music21 can read that we treat as "sheet" sources. MIDI is
# included so the endpoint is complete; the frontend parses .mid locally and only
# routes true notation formats here.
SHEET_SUFFIXES = (".musicxml", ".mxl", ".xml", ".abc", ".krn", ".mid", ".midi")

# 16th-note grid — one quarter note is four steps.
STEPS_PER_QUARTER = 4


def _fmt_for_suffix(suffix: str) -> str:
    s = suffix.lower().lstrip(".")
    if s in ("musicxml", "mxl", "xml"):
        return "musicxml"
    if s == "abc":
        return "abc"
    if s == "krn":
        return "humdrum"
    if s in ("mid", "midi"):
        return "midi"
    return s or "musicxml"


def parse_score_bytes(data: bytes, filename: str) -> dict[str, Any]:
    """Parse uploaded score bytes. Writes to a temp file with the original
    suffix so music21 detects the format (and can unzip .mxl)."""
    suffix = Path(filename).suffix.lower() or ".musicxml"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        tf.write(data)
        tmp = Path(tf.name)
    try:
        return parse_score_path(str(tmp), display_name=Path(filename).stem)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def parse_score_path(path: str, display_name: str | None = None) -> dict[str, Any]:
    """Parse a score on disk into a piano-roll note batch."""
    src = Path(path)
    if not src.exists():
        raise FileNotFoundError(f"Score not found: {path}")

    try:
        from music21 import chord as m21chord  # type: ignore[import]
        from music21 import converter  # type: ignore[import]
        from music21 import key as m21key  # type: ignore[import]
        from music21 import note as m21note  # type: ignore[import]
        from music21 import tempo as m21tempo  # type: ignore[import]
    except ImportError as e:  # pragma: no cover - music21 is a declared dependency
        raise RuntimeError("music21 is not installed") from e

    score = converter.parse(str(src))

    # Play out repeats / D.C. / D.S. so the imported roll matches the full piece.
    try:
        expanded = score.expandRepeats()
        if expanded is not None:
            score = expanded
    except Exception as exc:  # noqa: BLE001 - not every score defines repeats
        log.debug("sheetimport: expandRepeats skipped for %s: %s", src.name, exc)

    flat = score.flatten()

    # Tempo — first metronome mark, else 120.
    bpm = 120.0
    marks = list(flat.getElementsByClass(m21tempo.MetronomeMark))
    if marks:
        try:
            qbpm = marks[0].getQuarterBPM()
            bpm = float(qbpm if qbpm else (marks[0].number or 120))
        except Exception:  # noqa: BLE001 - fall back to the raw number
            bpm = float(getattr(marks[0], "number", 120) or 120)

    # Time signature — first one, else 4/4.
    time_sig = [4, 4]
    tss = list(flat.getTimeSignatures())
    if tss:
        time_sig = [int(tss[0].numerator), int(tss[0].denominator)]

    # Key signature (informational).
    detected_key = ""
    try:
        ksigs = list(flat.getElementsByClass(m21key.KeySignature))
        if ksigs:
            first = ksigs[0]
            as_key = first.asKey() if hasattr(first, "asKey") else None
            detected_key = str(as_key) if as_key is not None else str(first)
    except Exception:  # noqa: BLE001 - key detection is best-effort
        detected_key = ""

    # Per-part tracks; fall back to the whole score as a single part.
    parts = list(getattr(score, "parts", []) or [])
    if not parts:
        parts = [score]

    tracks: list[dict[str, Any]] = []
    total_notes = 0
    for idx, part in enumerate(parts):
        # Strip ties so a note held across a barline (or any tie) becomes ONE
        # sustained note event, not several re-articulated ones — otherwise the
        # roll would re-attack every tied note and change the sound.
        try:
            pflat = part.flatten().stripTies()
        except Exception as exc:  # noqa: BLE001 - stripTies is best-effort
            log.debug("sheetimport: stripTies skipped for part %d: %s", idx, exc)
            pflat = part.flatten()
        try:
            name = str(getattr(part, "partName", "") or "")
        except Exception:  # noqa: BLE001
            name = ""

        notes_out: list[dict[str, Any]] = []
        for el in pflat.notes:  # Note or Chord elements only
            off = float(el.offset)
            if off < 0:
                continue
            ql = float(el.duration.quarterLength or 0)
            step = int(round(off * STEPS_PER_QUARTER))
            length = max(1, int(round(ql * STEPS_PER_QUARTER)))

            vel = 90
            try:
                if el.volume is not None and el.volume.velocity is not None:
                    vel = int(el.volume.velocity)
            except Exception:  # noqa: BLE001 - many scores carry no velocity
                vel = 90
            vel = max(1, min(127, vel))

            if isinstance(el, m21chord.Chord):
                pitches = [p.midi for p in el.pitches]
            elif isinstance(el, m21note.Note):
                pitches = [el.pitch.midi]
            else:
                continue

            for midi in pitches:
                notes_out.append(
                    {
                        "pitch": int(midi),
                        "step": step,
                        "length": length,
                        "velocity": vel,
                    }
                )

        total_notes += len(notes_out)
        tracks.append({"name": name or f"Part {idx + 1}", "notes": notes_out})

    return {
        "ok": True,
        "name": display_name or src.stem,
        "format": _fmt_for_suffix(src.suffix),
        "bpm": round(bpm, 3),
        "time_signature": time_sig,
        "detected_key": detected_key,
        "track_count": len(tracks),
        "note_count": total_notes,
        "tracks": tracks,
        "steps_per_quarter": STEPS_PER_QUARTER,
    }
