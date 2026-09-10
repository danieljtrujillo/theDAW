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

The same frames also carry the front-cover picture (ID3 ``APIC``, FLAC
``Picture`` blocks, Vorbis ``metadata_block_picture``, MP4 ``covr``); see
``extract_embedded_cover`` / ``write_cover_image`` at the bottom of this
module for how a track's artwork is read and normalised.
"""

from __future__ import annotations

import base64
import io
import logging
import uuid
from pathlib import Path
from typing import Any, Optional

from backend.lib.atomic import atomic_replace

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
    "thedaw": "stable-audio",
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


# ---- Cover art --------------------------------------------------------------
#
# An embedded picture is attacker-controlled data in a file the user merely
# dragged in, so every step below bounds something BEFORE the next one runs:
# the raw frame length, then the header's pixel count (Pillow's ``open()``
# only parses the header, so this lands before any decode), then the edge
# length we write. The picture's own filename and MIME string are never used
# for anything — the caller writes to a fixed name it chose itself.

# Bigger than any plausible album cover; a 7MB original is a tagging accident,
# a 40MB one is a decompression bomb wearing a hat.
MAX_EMBEDDED_COVER_BYTES = 24 * 1024 * 1024
# 4000x4000 is already twice what stores ship. Beyond it we refuse rather than
# hand Pillow a buffer that would decode to hundreds of MB of RGBA.
MAX_COVER_PIXELS = 16_000_000
# The rail and grid draw a cover at ~100px, the details pane at ~200px; 640
# stays sharp at 2x there and keeps a track's artwork around 80KB instead of
# the 500KB the file shipped. Quality matches the poster thumbnails.
COVER_MAX_EDGE = 640
COVER_JPEG_QUALITY = 82
# Transparent art is flattened onto the app's panel tone, matching the poster
# thumbnails in `media.py` so a cover and a video poster read the same.
_COVER_BG = (11, 10, 18)

# ID3 / FLAC picture type 3 == "Cover (front)". Anything else (back cover,
# artist photo, a scan of the booklet) is only used when there is no front.
_PICTURE_TYPE_FRONT = 3


def _picture_bytes(data: Any) -> Optional[bytes]:
    """Accept a picture payload only if it is bytes of a plausible size."""
    if not isinstance(data, (bytes, bytearray)):
        return None
    if not data or len(data) > MAX_EMBEDDED_COVER_BYTES:
        return None
    return bytes(data)


def _pick_front(pictures: list[Any]) -> Optional[bytes]:
    """The front cover's bytes, else the first picture that has usable ones.

    A picture is only a candidate once ``_picture_bytes`` has accepted it, so
    a file whose front cover is absurdly large does not lose the ordinary back
    cover sitting next to it — picking the frame first and validating after
    would return nothing at all. This is the same fall-through the Vorbis
    reader does across its own list.
    """
    fallback: Optional[bytes] = None
    for pic in pictures:
        data = _picture_bytes(getattr(pic, "data", None))
        if data is None:
            continue
        try:
            is_front = int(getattr(pic, "type", -1)) == _PICTURE_TYPE_FRONT
        except (TypeError, ValueError):
            is_front = False
        if is_front:
            return data
        if fallback is None:
            fallback = data
    return fallback


def _cover_from_flac(audio: Any) -> Optional[bytes]:
    """FLAC keeps pictures in their own metadata blocks, not the comments."""
    return _pick_front(list(getattr(audio, "pictures", None) or []))


def _cover_from_id3(audio: Any) -> Optional[bytes]:
    """ID3v2 APIC frames (MP3, and AIFF/WAV files carrying an ID3 chunk)."""
    tags = getattr(audio, "tags", None)
    getall = getattr(tags, "getall", None)
    if getall is None:
        return None
    return _pick_front(list(getall("APIC") or []))


def _cover_from_vorbis(audio: Any) -> Optional[bytes]:
    """Ogg/Opus/Vorbis: a base64 FLAC Picture block in a comment field.

    Falls back to the legacy ``coverart`` field (bare base64 image bytes)
    that older taggers wrote before ``metadata_block_picture`` existed.
    """
    tags = getattr(audio, "tags", None)
    if tags is None or not hasattr(tags, "get"):
        return None
    # base64 inflates by 4/3 — reject the string before decoding it, so an
    # oversized picture never gets materialised in memory at all.
    max_b64 = MAX_EMBEDDED_COVER_BYTES * 4 // 3 + 8

    from mutagen.flac import Picture

    fallback: Optional[bytes] = None
    for raw in tags.get("metadata_block_picture") or []:
        if not isinstance(raw, str) or len(raw) > max_b64:
            continue
        try:
            picture = Picture(base64.b64decode(raw))
        except Exception as e:  # noqa: BLE001 — malformed block, try the next
            log.debug("library.cover: bad metadata_block_picture: %s", e)
            continue
        data = _picture_bytes(picture.data)
        if data is None:
            continue
        if int(getattr(picture, "type", -1) or -1) == _PICTURE_TYPE_FRONT:
            return data
        if fallback is None:
            fallback = data
    if fallback is not None:
        return fallback
    for raw in tags.get("coverart") or []:
        if not isinstance(raw, str) or len(raw) > max_b64:
            continue
        try:
            return _picture_bytes(base64.b64decode(raw))
        except Exception as e:  # noqa: BLE001 — malformed base64, no art
            log.debug("library.cover: bad coverart field: %s", e)
    return None


def _cover_from_mp4(audio: Any) -> Optional[bytes]:
    """MP4/M4A ``covr`` atoms. MP4Cover subclasses bytes, so no unwrapping."""
    tags = getattr(audio, "tags", None)
    if tags is None or not hasattr(tags, "get"):
        return None
    for cover in tags.get("covr") or []:
        data = _picture_bytes(cover)
        if data is not None:
            return data
    return None


# Ordered by how the containers actually store pictures. Each reader is a
# no-op on a file that is not its format, so one pass covers every type.
_COVER_READERS = (
    _cover_from_flac,
    _cover_from_id3,
    _cover_from_vorbis,
    _cover_from_mp4,
)


def extract_embedded_cover(path: Path) -> Optional[bytes]:
    """Return the raw bytes of the file's front-cover picture, or ``None``.

    Never raises. A file with no picture, an unreadable container, a missing
    mutagen and a picture too large to be plausible all read the same to the
    caller: this track has no artwork. The bytes are NOT validated as an
    image here — ``write_cover_image`` does that before anything is written.
    """
    try:
        import mutagen
    except ImportError:
        log.debug("library.cover: mutagen not installed, no cover art")
        return None

    p = Path(path)
    if not p.is_file():
        return None
    try:
        audio = mutagen.File(str(p))  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001 — mutagen raises per-format errors
        log.debug("library.cover: could not open %s: %s", p.name, e)
        return None
    if audio is None:
        return None

    for reader in _COVER_READERS:
        try:
            data = reader(audio)
        except Exception as e:  # noqa: BLE001 — a broken frame is not an error
            log.debug("library.cover: %s failed on %s: %s", reader.__name__, p.name, e)
            continue
        if data:
            return data
    return None


def write_cover_image(data: bytes, out_path: Path) -> bool:
    """Normalise raw picture bytes into a bounded JPEG at ``out_path``.

    Returns True only when a file was actually written. Corrupt bytes, an
    absurd pixel count and a missing Pillow all return False, leaving any
    existing cover untouched — the write goes through a temp file so a
    half-encoded JPEG is never visible under ``out_path``.
    """
    if not data or len(data) > MAX_EMBEDDED_COVER_BYTES:
        log.info("library.cover: refusing a %d-byte picture", len(data or b""))
        return False
    try:
        from PIL import Image, ImageOps
    except ImportError:
        log.debug("library.cover: Pillow missing, cannot normalise cover art")
        return False

    # A temp name unique to this call. Two requests can normalise art for the
    # SAME entry concurrently (FastAPI runs sync handlers on a threadpool), and
    # a shared "<name>.tmp" let one call's cleanup delete the other's half-
    # written file — losing a cover, or failing the replace outright.
    tmp = out_path.with_name(f"{out_path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with Image.open(io.BytesIO(data)) as im:
            width, height = im.size
            if width < 1 or height < 1 or width * height > MAX_COVER_PIXELS:
                log.info("library.cover: refusing a %dx%d picture", width, height)
                return False
            # JPEG-only hint: lets libjpeg decode at a reduced scale, so a big
            # cover never fully materialises before we shrink it.
            im.draft("RGB", (COVER_MAX_EDGE, COVER_MAX_EDGE))
            # Rotate to the orientation the picture is meant to be seen at. We
            # re-encode without EXIF, so a camera-tagged cover left untransposed
            # would hang in the rail sideways with nothing downstream able to
            # correct it.
            upright = ImageOps.exif_transpose(im)
            rgba = (upright if upright is not None else im).convert("RGBA")
        rgba.thumbnail((COVER_MAX_EDGE, COVER_MAX_EDGE))
        flat = Image.new("RGB", rgba.size, _COVER_BG)
        flat.paste(rgba, mask=rgba.split()[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        flat.save(tmp, "JPEG", quality=COVER_JPEG_QUALITY)
        atomic_replace(tmp, out_path)
        return out_path.is_file()
    except Exception as e:  # noqa: BLE001 — Pillow raises many decode errors
        log.info("library.cover: could not normalise cover art: %s", e)
        return False
    finally:
        # Only ever our own temp: the name carries this call's uuid, so a
        # concurrent write's in-flight file is never touched.
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            log.debug("library.cover: leftover temp file %s", tmp)
