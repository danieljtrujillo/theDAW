"""Shared media resolution for DAW importers.

A project authored on another machine stores its samples by an absolute path
that does not exist locally (e.g. ``/Users/someone/.../kick.aif``). DAWs bundle
those samples inside the project folder, so this indexes the project folder by
filename and relinks each clip to the bundled file when its stored path is gone.
Used by every importer that references external audio files.
"""

from __future__ import annotations

from pathlib import Path

# Audio sample extensions worth indexing/relinking (covers what DAWs reference).
AUDIO_EXTS = {
    ".wav",
    ".aif",
    ".aiff",
    ".aifc",
    ".flac",
    ".mp3",
    ".m4a",
    ".ogg",
    ".oga",
    ".opus",
    ".caf",
    ".wv",
    ".wma",
    ".aac",
    ".wave",
}


def build_media_index(project_dir: Path) -> dict[str, str]:
    """Map lowercased filename -> absolute path for every audio file under the
    project folder. macOS AppleDouble junk (``__MACOSX``, ``._name``) is skipped.
    Falls back to the parent folder only when the project folder yields nothing
    (handles a doubly-nested unzip where samples sit beside the project folder)."""

    def scan(root: Path, index: dict[str, str]) -> None:
        try:
            for p in root.rglob("*"):
                try:
                    if not p.is_file():
                        continue
                    if p.name.startswith("._") or "__MACOSX" in p.parts:
                        continue
                    if p.suffix.lower() not in AUDIO_EXTS:
                        continue
                    key = p.name.lower()
                    if key not in index:
                        index[key] = str(p)
                except OSError:
                    continue
        except OSError:
            pass

    index: dict[str, str] = {}
    if project_dir and project_dir.is_dir():
        scan(project_dir, index)
        if not index and project_dir.parent != project_dir:
            scan(project_dir.parent, index)
    return index


def resolve_audio(
    candidates: list[str | None],
    name: str | None,
    media_index: dict[str, str],
    missing: list[str],
) -> str | None:
    """Resolve a clip's on-disk audio path.

    1. Any stored ``candidates`` path that actually exists on disk.
    2. A by-filename lookup in ``media_index`` (relinks a project moved between
       machines to the sample bundled with it).
    3. Otherwise the best-known reference is appended to ``missing`` and returned
       so the caller still records what was wanted.
    """
    clean = [c for c in candidates if c]

    for c in clean:
        try:
            if Path(c).is_file():
                return c
        except OSError:
            continue

    lookups: list[str] = []
    if name:
        lookups.append(name)
    for c in clean:
        try:
            lookups.append(Path(c).name)
        except (OSError, ValueError):
            continue
    for nm in lookups:
        hit = media_index.get(nm.lower())
        if hit:
            return hit

    best = clean[0] if clean else name
    if best and best not in missing:
        missing.append(best)
    return best
