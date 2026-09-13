"""Package the cockpit scenes and the audio they reference.

A .sway scene names its media by absolute path, and those paths were written on
a machine whose user profile is gone. The audio is still here under other
names. This finds every scene, resolves each media reference against the files
that exist now, and writes one directory (and a zip beside it) holding the
scenes, the audio they need, and a manifest saying where each file came from
and which scene asked for it.

Run:
    uv run python scripts/collect_assets.py
    uv run python scripts/collect_assets.py --out D:/somewhere --no-zip
    uv run python scripts/collect_assets.py --include-ares

Volumetric captures are left out unless --include-ares is passed: there are
dozens of them and they run to gigabytes, so they travel separately.

Nothing is moved or deleted. Anything over --max-file-mb is listed in the
manifest and left where it is, so the package stays sendable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]


def default_roots() -> list[Path]:
    """Where to look when the caller names nothing.

    Every entry is derived from this checkout or from the running user's own
    home directory, so no machine's layout is written into the repository. Add
    anything else with --root, or set THEDAW_ASSET_ROOTS to a list separated by
    the platform path separator. Directories that do not exist are skipped.
    """
    roots = [
        REPO_ROOT / "examples",
        REPO_ROOT.parent / "SwayCommand" / "projects",
        Path.home() / "Music",
        Path.home() / "Documents",
    ]
    extra = os.environ.get("THEDAW_ASSET_ROOTS", "")
    roots.extend(Path(part) for part in extra.split(os.pathsep) if part.strip())
    return roots


# Directories that hold nothing worth collecting and cost minutes to walk.
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "__pycache__",
    "__MACOSX",
    "dist",
    "build",
    "release",
    ".uv-cache",
}

AUDIO_SUFFIXES = {".wav", ".mp3", ".opus", ".flac", ".m4a", ".aiff", ".aif", ".ogg"}
SCENE_SUFFIX = ".sway"
ARES_SUFFIX = ".ares"

# Sidecars an .ares capture is written with: a frame directory and a metadata
# file named after the same asset stem.
ARES_SIDECAR_GLOBS = ("{stem}-meta.json", "{stem}-frames", "{stem}.json")


def walk(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            yield Path(dirpath) / name


def index_audio(roots: list[Path]) -> dict[str, list[Path]]:
    """Basename (lowercased, extension dropped) -> every audio file with it."""
    index: dict[str, list[Path]] = {}
    for root in roots:
        for p in walk(root):
            if p.suffix.lower() in AUDIO_SUFFIXES:
                index.setdefault(p.stem.lower(), []).append(p)
    return index


def normalise(reference: str) -> str:
    """The basename of a path written on any machine, in any slash style."""
    text = reference.replace("\\\\", "\\").replace("\\", "/")
    return Path(text).name


def track_key(name: str) -> str:
    """A comparable form of a track name: no leading number, no punctuation.

    "2 - will i dream.wav" and "New Will I Dream Master Style 2 - Live
    Punchy.mp3" both contain the title; this is what lets the second resolve to
    the first when the exact filename is gone.
    """
    stem = Path(name).stem.lower()
    stem = re.sub(r"^\d+\s*[-.]\s*", "", stem)
    return re.sub(r"[^a-z0-9]+", " ", stem).strip()


def resolve_media(
    reference: str, audio: dict[str, list[Path]]
) -> tuple[Path | None, str]:
    """The file this reference means on this machine, and how it was matched."""
    direct = Path(reference.replace("\\\\", "\\"))
    if direct.is_file():
        return direct, "the path as written"

    base = normalise(reference)
    exact = audio.get(Path(base).stem.lower())
    if exact:
        return exact[0], "same filename"

    wanted = track_key(base)
    if wanted:
        for stem, paths in audio.items():
            key = track_key(stem)
            if key and (key == wanted or key in wanted or wanted in key):
                return paths[0], f"title match on {stem!r}"
    return None, "no file on this machine matches"


def scene_media(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    return [m for m in re.findall(r'"path"\s*:\s*"([^"]+)"', raw) if m.strip()]


def ares_sidecars(path: Path) -> list[Path]:
    out: list[Path] = []
    for pattern in ARES_SIDECAR_GLOBS:
        candidate = path.parent / pattern.format(stem=path.stem)
        if candidate.exists():
            out.append(candidate)
    # A capture directory is often named for the take rather than the file.
    for sibling in path.parent.iterdir():
        if sibling.is_dir() and sibling.name.startswith(path.stem):
            out.append(sibling)
    return sorted(set(out), key=str)


def dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in walk(path) if p.is_file())


# Digest -> the name it was packaged under. The same scene sits in several
# places (the checkout, the staged build, the examples directory), and a
# package with three copies of one file is harder to read, not safer.
_packaged: dict[str, str] = {}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def copy_into(src: Path, dest_dir: Path, max_bytes: int) -> tuple[str, int, bool]:
    """Copy a file or directory into the package. Returns (name, bytes, copied)."""
    size = dir_size(src) if src.is_dir() else src.stat().st_size
    if size > max_bytes:
        return src.name, size, False
    if src.is_file():
        key = digest(src)
        if key in _packaged:
            return _packaged[key], size, True
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / src.name
    n = 2
    while target.exists():
        target = dest_dir / f"{target.stem} ({n}){target.suffix}"
        n += 1
    if src.is_dir():
        shutil.copytree(src, target)
    else:
        shutil.copy2(src, target)
        _packaged[digest(src)] = target.name
    return target.name, size, True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        type=Path,
        default=Path.home() / "Desktop" / "theDAW-asset-package",
        help="where to write the package (default: a folder on the Desktop)",
    )
    ap.add_argument(
        "--max-file-mb",
        type=float,
        default=400.0,
        help="anything larger is listed in the manifest and left in place",
    )
    ap.add_argument("--no-zip", action="store_true", help="skip the zip")
    ap.add_argument(
        "--include-ares",
        action="store_true",
        help="also package every .ares capture and its sidecars (gigabytes)",
    )
    ap.add_argument(
        "--root",
        type=Path,
        action="append",
        default=[],
        help="an extra directory to search; repeatable. THEDAW_ASSET_ROOTS "
        "adds more, separated by the platform path separator.",
    )
    args = ap.parse_args(argv)

    roots = [r for r in (default_roots() + args.root) if r.is_dir()]
    if not roots:
        print("None of the search roots exist. Pass --root.", file=sys.stderr)
        return 1

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    max_bytes = int(args.max_file_mb * 1024 * 1024)

    print(f"Searching {len(roots)} root(s):")
    for r in roots:
        print(f"  {r}")

    files = [p for r in roots for p in walk(r)]
    scenes = [p for p in files if p.suffix.lower() == SCENE_SUFFIX]
    ares = (
        [p for p in files if p.suffix.lower() == ARES_SUFFIX]
        if args.include_ares
        else []
    )
    audio = index_audio(roots)
    found = f"Found {len(scenes)} scene(s) and {len(audio)} audio file(s)"
    if args.include_ares:
        print(f"{found}, {len(ares)} .ares file(s).\n")
    else:
        print(f"{found}.\n")

    manifest: dict[str, Any] = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "machine": os.environ.get("COMPUTERNAME") or os.uname().nodename,
        "roots": [str(r) for r in roots],
        "scenes": [],
        "ares": [],
        "too_large": [],
    }

    for scene in scenes:
        name, size, copied = copy_into(scene, out / "scenes", max_bytes)
        refs = []
        for ref in scene_media(scene):
            target, how = resolve_media(ref, audio)
            entry = {
                "reference": ref,
                "resolved": str(target) if target else None,
                "how": how,
            }
            if target is not None:
                media_name, media_size, media_copied = copy_into(
                    target, out / "audio", max_bytes
                )
                entry["packaged_as"] = f"audio/{media_name}" if media_copied else None
                entry["size_bytes"] = media_size
                if not media_copied:
                    manifest["too_large"].append(
                        {"path": str(target), "size_bytes": media_size}
                    )
            refs.append(entry)
        manifest["scenes"].append(
            {
                "source": str(scene),
                "packaged_as": f"scenes/{name}" if copied else None,
                "size_bytes": size,
                "media": refs,
            }
        )
        unresolved = sum(1 for r in refs if r["resolved"] is None)
        print(
            f"scene  {scene.name:28s} {len(refs)} media ref(s), {unresolved} unresolved"
        )

    for capture in ares:
        name, size, copied = copy_into(capture, out / "ares", max_bytes)
        sidecars = []
        for side in ares_sidecars(capture):
            s_name, s_size, s_copied = copy_into(side, out / "ares", max_bytes)
            sidecars.append(
                {
                    "source": str(side),
                    "packaged_as": f"ares/{s_name}" if s_copied else None,
                    "size_bytes": s_size,
                    "kind": "directory" if side.is_dir() else "file",
                }
            )
            if not s_copied:
                manifest["too_large"].append({"path": str(side), "size_bytes": s_size})
        if not copied:
            manifest["too_large"].append({"path": str(capture), "size_bytes": size})
        manifest["ares"].append(
            {
                "source": str(capture),
                "packaged_as": f"ares/{name}" if copied else None,
                "size_bytes": size,
                "sidecars": sidecars,
            }
        )
        print(
            f"ares   {capture.name:28s} {size / 1048576:7.1f} MB, {len(sidecars)} sidecar(s)"
        )

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    packaged = sum(p.stat().st_size for p in walk(out) if p.is_file())
    print(f"\nPackage: {out}  ({packaged / 1048576:.1f} MB)")
    if manifest["too_large"]:
        print(f"Left in place, over {args.max_file_mb:.0f} MB:")
        for row in manifest["too_large"]:
            print(f"  {row['size_bytes'] / 1048576:8.1f} MB  {row['path']}")

    if not args.no_zip:
        archive = out.with_suffix(".zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            for p in walk(out):
                z.write(p, p.relative_to(out))
        print(f"Zip:     {archive}  ({archive.stat().st_size / 1048576:.1f} MB)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
