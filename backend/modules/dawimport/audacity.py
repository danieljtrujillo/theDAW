"""Audacity .aup3 project parser via py-aup3.

Audacity 3+ projects are SQLite databases containing a custom binary XML
serialization for the project tree plus raw PCM audio in a ``sampleblocks``
table. The py-aup3 library deserializes the binary XML into Python dataclasses
(``proj.project``) and exposes ``proj.get_block(blockid)`` which returns a
sample block as a normalized numpy array.

Audacity has no real concept of MIDI/note tracks in the common case, and audio
is embedded in the database rather than referenced as external files. To make
clips usable by theDAW, every clip's PCM samples are reassembled from its
sequence blocks and exported to a WAV on disk; ``file_path`` then points at that
WAV. Effects/devices are best-effort because py-aup3's ``Effects`` element is a
stub (only an ``active`` flag), so the raw XML tree is consulted for any effect
names.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any

from backend.modules.dawimport.models import (
    DawClip,
    DawDevice,
    DawProject,
    DawTrack,
)

log = logging.getLogger(__name__)


def _linear_to_db(gain: Any) -> float:
    """Convert a linear amplitude gain to decibels, clamped for silence."""
    try:
        g = float(gain)
    except (TypeError, ValueError):
        return 0.0
    if g <= 0.0:
        return -120.0
    return 20.0 * math.log10(g)


def _safe_attr(obj: object, name: str, default: Any = None) -> Any:
    try:
        val = getattr(obj, name, default)
    except Exception:
        return default
    return val if val is not None else default


def _export_clip_wav(
    proj,
    clip,
    rate: float,
    out_dir: Path,
    base_name: str,
    daw: DawProject,
) -> str | None:
    """Reassemble a clip's PCM from its sequence blocks and write a WAV.

    Returns the absolute path to the written WAV, or None on failure (with a
    warning appended to ``daw``).
    """
    seq = _safe_attr(clip, "sequence")
    if seq is None:
        daw.warnings.append(
            f"Clip '{base_name}' has no sequence; skipping audio export."
        )
        return None
    blocks = _safe_attr(seq, "blocks", []) or []
    if not blocks:
        daw.warnings.append(
            f"Clip '{base_name}' has no sample blocks; skipping audio export."
        )
        return None

    try:
        import numpy as np
        import soundfile as sf
    except ImportError as e:
        daw.warnings.append(
            f"numpy/soundfile unavailable, cannot export clip audio: {e}"
        )
        return None

    # Reassemble blocks in order of their start sample. get_block returns a flat
    # normalized float32 array; Audacity stores one Sequence per channel so this
    # is mono per clip channel. We treat each clip as mono (most aup3 clips are).
    ordered = sorted(blocks, key=lambda b: _safe_attr(b, "start", 0) or 0)
    chunks: list = []
    for blk in ordered:
        bid = _safe_attr(blk, "blockid")
        if bid is None:
            continue
        try:
            arr = proj.get_block(int(bid), normalized=True)
        except Exception as e:
            daw.warnings.append(f"Clip '{base_name}' block {bid} unreadable: {e}")
            continue
        if arr is None or len(arr) == 0:
            continue
        chunks.append(np.asarray(arr, dtype="float32").reshape(-1))

    if not chunks:
        daw.warnings.append(
            f"Clip '{base_name}' produced no audio samples; no WAV written."
        )
        return None

    data = np.concatenate(chunks)

    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        safe = (
            "".join(c if c.isalnum() or c in "-_." else "_" for c in base_name)
            or "clip"
        )
        out_path = out_dir / f"{safe}.wav"
        # Avoid clobbering distinct clips that sanitize to the same name.
        n = 1
        while out_path.exists():
            out_path = out_dir / f"{safe}_{n}.wav"
            n += 1
        sr = int(rate) if rate and rate > 0 else 44100
        sf.write(str(out_path), data, sr, subtype="FLOAT")
        return str(out_path.resolve())
    except Exception as e:
        daw.warnings.append(f"Failed to write WAV for clip '{base_name}': {e}")
        return None


def _color_from_index(idx) -> str | None:
    """Map an Audacity colorindex to a hex string (best-effort).

    Audacity uses a small fixed palette of waveform colors. Indices outside the
    known range return None.
    """
    palette = {
        0: "#3070c8",  # default blue
        1: "#d04040",  # red
        2: "#40b060",  # green
        3: "#c0a020",  # yellow/gold
    }
    try:
        return palette.get(int(idx))
    except (TypeError, ValueError):
        return None


def _collect_effect_names(raw_root) -> list[str]:
    """Walk the raw XML tree for any effect-bearing elements (best-effort)."""
    names: list[str] = []
    if raw_root is None:
        return names

    def walk(node):
        tag = (_safe_attr(node, "tag", "") or "").lower()
        attrs = _safe_attr(node, "attrs", {}) or {}
        if "effect" in tag or "realtimeeffect" in tag:
            disp = None
            for key in ("name", "id", "title"):
                v = attrs.get(key)
                if isinstance(v, tuple) and len(v) >= 2:
                    disp = v[1]
                elif v:
                    disp = v
                if disp:
                    break
            if disp:
                names.append(str(disp))
        for child in _safe_attr(node, "children", []) or []:
            if hasattr(child, "tag"):
                walk(child)

    try:
        walk(raw_root)
    except Exception:
        pass
    # de-dup, preserve order
    seen = set()
    out = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def parse_aup3(path: str) -> DawProject:
    """Parse an Audacity .aup3 file into a DawProject.

    Extracts: project tempo/time signature/sample rate; wave tracks (name, gain
    as dB, pan, mute, solo, color); wave clips with real timeline timing and
    per-clip audio exported to WAV. Best-effort effect-name capture. Audacity
    has no MIDI, so no clips carry midi_notes.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".aup3 file not found: {path}")

    try:
        from aup3 import AUP3
    except ImportError:
        raise ImportError(
            "py-aup3 is required for Audacity .aup3 parsing. Install: "
            "pip install git+https://github.com/mildsunrise/py-aup3.git"
        )

    daw = DawProject(source_daw="audacity", name=file_path.stem)
    daw.warnings.append(
        "Audacity has no MIDI/note tracks; no midi_notes are produced for any clip."
    )

    # Media cache dir for exported clip WAVs, beside the .aup3.
    media_dir = file_path.parent / f"{file_path.stem}_tasmo_media"

    try:
        try:
            proj = AUP3(str(file_path))
        except AssertionError as e:
            # An unsaved/autosave-bearing project trips the health check; retry
            # while ignoring autosave so we can still read the committed tree.
            daw.warnings.append(
                f"Project health check tripped ({e}); retrying ignoring autosave."
            )
            proj = AUP3(str(file_path), ignore_autosave=True)

        try:
            project = proj.project
        except Exception as e:
            daw.warnings.append(
                f"Could not unmarshal project tree (schema mismatch): {e}"
            )
            project = None

        raw_root = None
        try:
            raw_root = proj.raw_project
        except Exception:
            raw_root = None

        if project is not None:
            daw.source_version = str(_safe_attr(project, "audacityversion", "") or "")

            tempo = _safe_attr(project, "time_signature_tempo")
            try:
                if tempo is not None and float(tempo) > 0:
                    daw.tempo = float(tempo)
            except (TypeError, ValueError):
                pass

            upper = _safe_attr(project, "time_signature_upper")
            lower = _safe_attr(project, "time_signature_lower")
            try:
                if upper and lower:
                    daw.time_signature = (int(upper), int(lower))
            except (TypeError, ValueError):
                pass

            rate = _safe_attr(project, "rate")
            try:
                if rate is not None and float(rate) > 0:
                    daw.sample_rate = int(float(rate))
            except (TypeError, ValueError):
                pass

        # Project-level effect names captured once for plugins_used.
        effect_names = _collect_effect_names(raw_root)
        if effect_names:
            for nm in effect_names:
                if nm not in daw.plugins_used:
                    daw.plugins_used.append(nm)
        else:
            daw.warnings.append(
                "No effect metadata exposed by py-aup3; track devices may be incomplete."
            )

        tracks = _safe_attr(project, "tracks", []) if project is not None else []
        for track in tracks or []:
            cls_name = type(track).__name__
            # Only WaveTrack carries audio; Label/Time tracks become note-free
            # markers we skip (they are not audio/midi clip tracks).
            if cls_name != "WaveTrack":
                continue

            t_name = _safe_attr(track, "name", "Track") or "Track"
            t_rate = _safe_attr(track, "rate", daw.sample_rate)
            try:
                t_rate = float(t_rate)
                if t_rate <= 0:
                    t_rate = float(daw.sample_rate)
            except (TypeError, ValueError):
                t_rate = float(daw.sample_rate)

            dtrack = DawTrack(
                name=str(t_name),
                type="audio",
                volume_db=_linear_to_db(_safe_attr(track, "gain", 1.0)),
                pan=max(-1.0, min(1.0, float(_safe_attr(track, "pan", 0.0) or 0.0))),
                mute=bool(_safe_attr(track, "mute", False)),
                solo=bool(_safe_attr(track, "solo", False)),
                color=_color_from_index(_safe_attr(track, "colorindex")),
            )

            # Effects on the track (py-aup3 Effects is a stub: only `active`).
            eff = _safe_attr(track, "effects")
            if eff is not None:
                active = bool(_safe_attr(eff, "active", True))
                dtrack.devices.append(
                    DawDevice(
                        name="Audacity Realtime Effects",
                        plugin_type="builtin",
                        plugin_path=None,
                        bypass=not active,
                    )
                )

            clips = _safe_attr(track, "clips", []) or []
            for ci, clip in enumerate(clips):
                offset = _safe_attr(clip, "offset", 0.0) or 0.0
                trim_left = _safe_attr(clip, "trimLeft", 0.0) or 0.0
                trim_right = _safe_attr(clip, "trimRight", 0.0) or 0.0
                seq = _safe_attr(clip, "sequence")
                numsamples = _safe_attr(seq, "numsamples", 0) if seq is not None else 0
                try:
                    numsamples = int(numsamples)
                except (TypeError, ValueError):
                    numsamples = 0

                try:
                    full_dur = numsamples / t_rate if t_rate > 0 else 0.0
                except ZeroDivisionError:
                    full_dur = 0.0

                # trimLeft/trimRight are seconds hidden at each edge of the
                # sequence. The visible clip on the timeline starts at offset
                # and lasts (full_dur - trimLeft - trimRight).
                try:
                    start_time = float(offset)
                except (TypeError, ValueError):
                    start_time = 0.0
                visible = full_dur - float(trim_left or 0.0) - float(trim_right or 0.0)
                if visible < 0:
                    visible = full_dur
                end_time = start_time + max(0.0, visible)

                clip_name = _safe_attr(clip, "name", "") or f"{t_name}_clip{ci + 1}"
                wav_path = _export_clip_wav(
                    proj,
                    clip,
                    t_rate,
                    media_dir,
                    f"{t_name}_{clip_name}_{ci + 1}",
                    daw,
                )
                if wav_path is None:
                    daw.missing_files.append(f"{t_name}/{clip_name}")

                dtrack.clips.append(
                    DawClip(
                        name=str(clip_name),
                        start_time=start_time,
                        end_time=end_time,
                        file_path=wav_path,
                        midi_notes=None,
                    )
                )

            daw.tracks.append(dtrack)

        # Labels -> locators (Audacity label tracks).
        for track in tracks or []:
            if type(track).__name__ != "LabelTrack":
                continue
            for lbl in _safe_attr(track, "labels", []) or []:
                try:
                    from backend.modules.dawimport.models import DawLocator

                    daw.locators.append(
                        DawLocator(
                            name=str(_safe_attr(lbl, "title", "") or ""),
                            position=float(_safe_attr(lbl, "t", 0.0) or 0.0),
                        )
                    )
                except Exception:
                    continue

        try:
            proj.close()
        except Exception:
            pass

    except Exception as e:
        daw.warnings.append(f"Error parsing .aup3: {e}")

    return daw
