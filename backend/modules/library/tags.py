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
# Expanded based on docs/guides/AUDIO_VS_NONAUDIO_FIELD_GUIDE.md +
# LIVE_CACHE_FIELD_DICTIONARY.md so we capture Suno/Udio cache field
# names as well as the bare AI-tool conventions.
KNOWN_AI_TAGS: dict[str, str] = {
    # Core prompt / lyrics
    "prompt": "prompt",
    "positive_prompt": "prompt",
    "negative_prompt": "negative_prompt",
    "negative prompt": "negative_prompt",
    "negative_tags": "negative_prompt",
    "udio_prompt": "prompt",
    "udio_lyrics": "lyrics",
    "suno_prompt": "prompt",
    "suno_lyrics": "lyrics",
    "riffusion_prompt": "prompt",
    "lyrics": "lyrics",
    "lyrics_prompt": "lyrics",
    "style_prompt": "style_prompt",
    "style": "style",
    "tags": "tags",
    "control_tags": "control_tags",
    # Model / generator identity
    "model": "model",
    "model_name": "model",
    "model_version": "model_version",
    "major_model_version": "model_version",
    "generator": "generator",
    "tool": "generator",
    "artist": "artist",
    "display_name": "creator",
    "user_id": "creator_id",
    "handle": "creator_handle",
    # Generation knobs
    "seed": "seed",
    "cfg": "cfg",
    "cfg_scale": "cfg",
    "steps": "steps",
    "audio_weight": "audio_weight",
    "style_weight": "style_weight",
    "weirdness": "weirdness",
    "weirdness_constraint": "weirdness",
    "make_instrumental": "make_instrumental",
    "is_instrumental": "is_instrumental",
    "infill": "infill",
    "has_vocal": "has_vocal",
    "has_stem": "has_stem",
    "persona_id": "persona_id",
    # Musical features (often pre-computed by the source tool)
    "bpm": "bpm",
    "avg_bpm": "bpm",
    "min_bpm": "bpm_min",
    "max_bpm": "bpm_max",
    "key": "key",
    "musical_key": "key",
    "scale": "scale",
    "tempo": "bpm",
    "genre": "genre",
    "genres": "genres",
    "mood": "mood",
    "moods": "moods",
    "energy": "energy",
    "vocal_type": "vocal_type",
    "instruments": "instruments",
    # Identity / lineage
    "id": "source_id",
    "clip_id": "source_id",
    "parent_id": "parent_id",
    "root_id": "root_id",
    "title": "title",
    # Engagement (Suno-style)
    "play_count": "play_count",
    "upvote_count": "upvote_count",
    "skip_rate": "skip_rate",
    "engagement_score": "engagement_score",
    "popularity_class": "popularity_class",
}

# Substrings on TXXX descriptors that signal which tool authored the
# file. Detected generator gets surfaced as the canonical ``generator``
# field even when the file doesn't have an explicit ``tool``/``generator``
# tag.
GENERATOR_SIGNATURES: dict[str, str] = {
    "suno": "suno",
    "udio": "udio",
    "riffusion": "riffusion",
    "musicgen": "musicgen",
    "stable_audio": "stable-audio",
    "stable-audio": "stable-audio",
    "stabledaw": "stable-audio",
    "audacity": "audacity",
    "logic pro": "logic-pro",
    "ableton": "ableton-live",
    "fl studio": "fl-studio",
    "reaper": "reaper",
    "pro tools": "pro-tools",
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


def _coerce_json(value: str) -> Any:
    """If ``value`` parses as JSON, return the parsed object. Otherwise
    return the string unchanged. Suno + Udio both stash structured blobs
    inside text-only TXXX frames (e.g. ``control_sliders`` as JSON)."""
    if not isinstance(value, str):
        return value
    s = value.strip()
    if not s:
        return s
    if s[0] not in '{["':
        return s
    try:
        import json

        return json.loads(s)
    except (ValueError, TypeError):
        return s


def _detect_generator(tags: dict[str, Any]) -> str | None:
    """Best-guess which tool authored this file based on which tag keys
    + values appear. Returns a canonical lowercase name or None."""
    haystack = " ".join(
        f"{k} {v}" for k, v in tags.items() if isinstance(v, (str, int, float))
    ).lower()
    for needle, canonical in GENERATOR_SIGNATURES.items():
        if needle in haystack:
            return canonical
    # Heuristics: if Suno-specific fields are present (e.g. control_sliders)
    # we call it Suno even if no explicit tool tag appears.
    if any(k.startswith("control_sliders") for k in tags):
        return "suno"
    if any("udio" in k for k in tags):
        return "udio"
    return None


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
    result: dict[str, Any] = {}
    try:
        if suffix == ".mp3":
            try:
                from mutagen.id3 import ID3

                tags = ID3(str(p))
                result = _id3_payload(tags)
            except Exception:
                pass
        if not result and suffix in {".flac", ".ogg", ".opus", ".oga"}:
            audio = mutagen.File(str(p))  # type: ignore[attr-defined]
            if audio is not None:
                result = _vorbis_payload(audio)
        if not result and suffix in {".m4a", ".mp4", ".aac"}:
            from mutagen.mp4 import MP4

            try:
                result = _mp4_payload(MP4(str(p)))
            except Exception:
                pass
        if not result and suffix == ".wav":
            from mutagen.wave import WAVE

            try:
                result = _wav_payload(WAVE(str(p)))
            except Exception:
                pass
        if not result:
            audio = mutagen.File(str(p))  # type: ignore[attr-defined]
            if audio is not None:
                type_name = type(audio).__name__
                if "MP3" in type_name or "ID3" in type_name:
                    result = _id3_payload(audio)
                elif "MP4" in type_name:
                    result = _mp4_payload(audio)
                elif "Wave" in type_name or "WAVE" in type_name:
                    result = _wav_payload(audio)
                else:
                    result = _vorbis_payload(audio)
    except Exception as e:
        log.info("library.tags: tag read failed for %s (%s): %s", p.name, suffix, e)
        return {}

    if not result:
        return {}

    # Promote any value that looks like JSON into a structured dict/list
    # so downstream consumers can read fields like `control_sliders.audio_weight`.
    cleaned: dict[str, Any] = {}
    for k, v in result.items():
        cleaned[k] = _coerce_json(v) if isinstance(v, str) else v
    # Detect the source tool (suno / udio / audacity / etc) and surface
    # it under the canonical `generator` field if we didn't already.
    if "generator" not in cleaned:
        detected = _detect_generator(cleaned)
        if detected:
            cleaned["generator"] = detected
    return cleaned
