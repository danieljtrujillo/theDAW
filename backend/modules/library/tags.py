"""Extract embedded metadata tags from audio files via mutagen.

Many AI-generated audio files (Udio, Suno, Riffusion, etc.) embed the
prompt + model + seed directly into the file's metadata frames. We read
those at import time so the library entry's ``prompt``, ``model``,
``seed`` etc. populate automatically — no copy-paste from the user.

Returns a flat ``{key: value}`` dict where keys are lowercase tag names
and values are stringified. Multi-value frames (e.g., multiple artists)
become a comma-separated string. The raw mutagen object is intentionally
NOT exposed — callers get a stable JSON-serializable shape.

Supported containers:
  - ID3v2 (MP3) — TIT2, TPE1, TBPM, TXXX:<key>, COMM
  - Vorbis comments (FLAC, OGG)
  - MP4/M4A iTunes atoms, including ``----:com.apple.iTunes:<key>``
  - RIFF INFO chunks (WAV)
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


# AI-tool tag keys we recognize (case-insensitive). When we see one of
# these inside a TXXX / ----: / VORBIS_COMMENT frame, we surface it at
# the top level under the canonical name on the right.
KNOWN_AI_TAGS: dict[str, str] = {
    "prompt": "prompt",
    "positive_prompt": "prompt",
    "negative_prompt": "negative_prompt",
    "negative prompt": "negative_prompt",
    "model": "model",
    "model_name": "model",
    "seed": "seed",
    "cfg": "cfg",
    "cfg_scale": "cfg",
    "steps": "steps",
    "generator": "generator",
    "tool": "generator",
    "udio_prompt": "prompt",
    "udio_lyrics": "lyrics",
    "suno_prompt": "prompt",
    "suno_lyrics": "lyrics",
    "riffusion_prompt": "prompt",
}


def _stringify(value: Any) -> str:
    """Coerce a mutagen value (often a list / Frame object) to a clean str."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(_stringify(v) for v in value if v is not None).strip(", ")
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace").strip()
        except Exception:
            return value.decode("latin-1", errors="replace").strip()
    return str(value).strip()


def _id3_payload(audio: Any) -> dict[str, str]:
    """Read an ID3-tagged MP3. ``audio`` is a ``mutagen.id3.ID3`` or
    a ``mutagen.mp3.MP3`` instance."""
    out: dict[str, str] = {}
    tags = getattr(audio, "tags", None) or audio
    try:
        for key, frame in tags.items():
            # Standard frames
            if key == "TIT2":
                out["title"] = _stringify(frame.text)
            elif key == "TPE1":
                out["artist"] = _stringify(frame.text)
            elif key == "TALB":
                out["album"] = _stringify(frame.text)
            elif key == "TBPM":
                out["bpm"] = _stringify(frame.text)
            elif key == "TDRC":
                out["date"] = _stringify(frame.text)
            elif key == "COMM" or key.startswith("COMM:"):
                comm_value = _stringify(frame.text)
                if comm_value:
                    out.setdefault("comment", comm_value)
            elif key.startswith("TXXX:"):
                sub = key[5:].strip().lower()
                value = _stringify(frame.text)
                out[f"txxx_{sub}"] = value
                if sub in KNOWN_AI_TAGS:
                    out.setdefault(KNOWN_AI_TAGS[sub], value)
    except Exception as e:
        log.debug("library.tags: ID3 read failed: %s", e)
    return out


def _vorbis_payload(audio: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for key, value in audio.tags.items() if audio.tags else []:
            low = key.lower()
            out[low] = _stringify(value)
            if low in KNOWN_AI_TAGS:
                out.setdefault(KNOWN_AI_TAGS[low], _stringify(value))
    except Exception as e:
        log.debug("library.tags: Vorbis read failed: %s", e)
    return out


def _mp4_payload(audio: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for key, value in audio.tags.items() if audio.tags else []:
            if key == "\xa9nam":
                out["title"] = _stringify(value)
            elif key == "\xa9ART":
                out["artist"] = _stringify(value)
            elif key == "\xa9alb":
                out["album"] = _stringify(value)
            elif key.startswith("----:"):
                # iTunes freeform: ----:com.apple.iTunes:<key>
                parts = key.split(":")
                if len(parts) >= 3:
                    sub = parts[-1].lower()
                    out[f"itunes_{sub}"] = _stringify(value)
                    if sub in KNOWN_AI_TAGS:
                        out.setdefault(KNOWN_AI_TAGS[sub], _stringify(value))
    except Exception as e:
        log.debug("library.tags: MP4 read failed: %s", e)
    return out


def _wav_payload(audio: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        if audio.tags:
            for key, value in audio.tags.items():
                low = key.lower()
                out[low] = _stringify(value)
                if low in KNOWN_AI_TAGS:
                    out.setdefault(KNOWN_AI_TAGS[low], _stringify(value))
    except Exception as e:
        log.debug("library.tags: WAV read failed: %s", e)
    return out


def extract_embedded_tags(path: Path) -> dict[str, str]:
    """Return a flat dict of embedded tags from the audio file.

    On any failure (corrupt file, unsupported container, mutagen missing)
    returns an empty dict — never raises. The caller treats this as a
    best-effort enrichment; absence is fine.
    """
    try:
        import mutagen
    except ImportError:
        log.debug("library.tags: mutagen not installed, returning empty tags")
        return {}

    p = Path(path)
    if not p.is_file():
        return {}

    suffix = p.suffix.lower()
    try:
        if suffix == ".mp3":
            # Read ID3 directly rather than going through MP3() — the
            # latter requires a valid MPEG sync frame, which fragile
            # fixtures may lack.
            try:
                from mutagen.id3 import ID3

                tags = ID3(str(p))
                return _id3_payload(tags)
            except Exception:
                # Fall through to mutagen.File sniff.
                pass
        if suffix in {".flac", ".ogg", ".opus", ".oga"}:
            audio = mutagen.File(str(p))  # type: ignore[attr-defined]
            return _vorbis_payload(audio) if audio is not None else {}
        if suffix in {".m4a", ".mp4", ".aac"}:
            from mutagen.mp4 import MP4

            audio = MP4(str(p))
            return _mp4_payload(audio)
        if suffix == ".wav":
            from mutagen.wave import WAVE

            audio = WAVE(str(p))
            return _wav_payload(audio)
        # Fallback: let mutagen sniff.
        audio = mutagen.File(str(p))  # type: ignore[attr-defined]
        if audio is None:
            return {}
        # Best-effort dispatch on the loaded type.
        type_name = type(audio).__name__
        if "MP3" in type_name or "ID3" in type_name:
            return _id3_payload(audio)
        if "MP4" in type_name:
            return _mp4_payload(audio)
        if "Wave" in type_name or "WAVE" in type_name:
            return _wav_payload(audio)
        return _vorbis_payload(audio)
    except Exception as e:
        log.info("library.tags: tag read failed for %s (%s): %s", p.name, suffix, e)
        return {}
