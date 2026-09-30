"""The cockpit's track VST chain, rendered by theDAW.

The embedded SwayCommand cockpit has no plugin host of its own: a track's VST3
chain is rendered once to a wet file and played under the track's wet / dry
mix, exactly as its desktop sidecar does. ``POST /api/sway/vst-render`` in
``router.py`` is that render; the parts here have no request, no plugin and
no file write, so they are the ones a unit test exercises directly.

- ``resolve_input`` turns what the cockpit holds for a clip into a file on
  disk, or None. The cockpit holds an absolute path for a scene theDAW wrote,
  and a URL for audio theDAW handed it from the library, a stem or clip-audio.
  A file picked in the browser (``swaydrop:``) has no disk path at all.
- ``render_key`` names the output, so an unchanged chain on an unchanged file
  reuses its render.
- ``with_tail`` appends the seconds of silence a reverb or delay decays into.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import numpy as np

from backend.lib import known_paths, paths
from backend.modules.project import media_access

#: An hour of audio is the ceiling, as it is for /api/vst/render-midi.
MAX_INPUT_SECONDS = 3600.0
#: The tail is silence appended for a plugin's decay; a minute covers any.
MAX_TAIL_SECONDS = 60.0
DEFAULT_TAIL_SECONDS = 3.0
RENDERS_DIRNAME = "sway-renders"

#: Media the cockpit registers in the browser: no file for theDAW to read.
_BROWSER_ONLY_SCHEMES = ("swaydrop:", "swayproject:")
_LIBRARY_AUDIO = re.compile(r"^/api/library/audio/([^/]+?)(?:\.[A-Za-z0-9]+)?$")
_LIBRARY_STEM = re.compile(r"^/api/library/stems/([^/]+)/audio$")
_CLIP_AUDIO = "/api/project/clip-audio"

PathLookup = Callable[[str], Path | None]


def renders_dir() -> Path:
    """Where the renders land, under the data folder (a clip-audio root)."""
    return paths.data_path(RENDERS_DIRNAME)


def chain_signature(plugins: list[dict]) -> list[list]:
    """The chain as the render key sees it: path, sorted raw params, state."""
    out: list[list] = []
    for entry in plugins:
        params = entry.get("params") or {}
        out.append(
            [
                str(entry.get("path") or ""),
                {str(k): float(v) for k, v in sorted(params.items())},
                str(entry.get("rawState") or ""),
            ]
        )
    return out


def render_key(
    input_path: str | os.PathLike[str],
    mtime_ns: int,
    size: int,
    plugins: list[dict],
    tail: float,
) -> str:
    """sha256 over the input's identity (path, mtime, size), the chain and the
    tail. A file rewritten in place gets a new key; a chain with one moved
    slider gets a new key; the same chain on the same file finds its render."""
    payload = json.dumps(
        [
            os.path.normcase(str(input_path)),
            int(mtime_ns),
            int(size),
            chain_signature(plugins),
            float(tail),
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def with_tail(audio: np.ndarray, sample_rate: int, tail: float) -> np.ndarray:
    """``audio`` (frames, channels) with ``tail`` seconds of silence appended."""
    frames = int(round(max(0.0, float(tail)) * int(sample_rate)))
    if frames <= 0:
        return audio
    pad = np.zeros((frames, audio.shape[1]), dtype=audio.dtype)
    return np.concatenate([audio, pad], axis=0)


def _existing_file(path: Path | None) -> Path | None:
    if path is None:
        return None
    try:
        return path if path.is_file() else None
    except OSError:
        return None


def _servable_file(text: str) -> Path | None:
    """A disk path theDAW may read: one known_paths recorded from a dialog,
    a save, an install or a download, or one inside the clip-audio roots."""
    if known_paths.is_remote_or_device_path(text):
        return None
    served = known_paths.find_servable(text)
    if served:
        return Path(served)
    return _existing_file(media_access.resolve_media_path(text))


def resolve_input(
    raw: object,
    *,
    library_audio: PathLookup | None = None,
    stem_audio: PathLookup | None = None,
) -> Path | None:
    """The file behind what the cockpit holds for a clip, or None.

    Accepts an absolute path (a scene's media), or one of the URLs theDAW
    hands the cockpit: ``/api/library/audio/<id>``, ``/api/library/stems/
    <id>/audio`` and ``/api/project/clip-audio?path=...``. ``library_audio``
    and ``stem_audio`` map an id to its file; without them those URLs refuse.
    Everything else, a browser-only ``swaydrop:`` path above all, is None.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text or text.lower().startswith(_BROWSER_ONLY_SCHEMES):
        return None
    if text.startswith("/api/") or re.match(r"^https?://", text, re.IGNORECASE):
        parts = urlsplit(text)
        path = parts.path
        found = _LIBRARY_AUDIO.match(path)
        if found:
            return (
                _existing_file(library_audio(found.group(1))) if library_audio else None
            )
        found = _LIBRARY_STEM.match(path)
        if found:
            return _existing_file(stem_audio(found.group(1))) if stem_audio else None
        if path == _CLIP_AUDIO:
            inner = parse_qs(parts.query).get("path", [""])[0].strip()
            return _servable_file(inner) if inner else None
        return None
    return _servable_file(text)
