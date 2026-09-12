"""GanFile — read and write .gan web-plugin packages (ZIP).

Mirrors the container approach of .tasmo (manifest.json + payload in a ZIP,
version-checked on load), but the payload is a bundled web app (index.html +
assets) instead of a serialized music project.

Every write lands through a temp file + rename. A .gan and its extracted runtime
are read while they are rewritten — the /list sweep walks the library, the stage
iframe fetches the runtime — and a reader that opened a half-deflated archive got
BadZipFile, which 500'd the whole plugin list.
"""

from __future__ import annotations

import json
import logging
import shutil
import zipfile
from pathlib import Path
from datetime import datetime, timezone

from backend.lib.atomic import atomic_replace, atomic_write, temp_sibling
from backend.modules.plugin.gan_manifest import GanManifest

log = logging.getLogger(__name__)

GAN_COMMENT = b"GANv1"
CURRENT_FORMAT_VERSION = 1
SOFT_SIZE_WARN_BYTES = 200 * 1024 * 1024  # 200 MB

# Assets carrying these names are reserved/handled separately.
_MANIFEST_NAME = "manifest.json"


def _open_zip(path: str) -> zipfile.ZipFile:
    """Open a .gan for reading, reporting an unreadable archive as a ValueError.

    ``zipfile.BadZipFile`` derives straight from ``Exception``, not ``OSError``,
    so every ``except (ValueError, OSError)`` guard around a .gan used to miss it
    and one unreadable file took out the endpoint that touched it.
    """
    try:
        return zipfile.ZipFile(path, "r")
    except zipfile.BadZipFile as e:
        raise ValueError(f"Invalid .gan: not a readable ZIP archive ({e})") from e


class GanFile:
    """Read and write .gan plugin files."""

    @staticmethod
    def save(manifest: GanManifest, assets: dict[str, bytes], path: str) -> dict:
        """Write a .gan file. ``assets`` maps in-zip paths (e.g. ``index.html``,
        ``background.png``) to bytes. Returns the manifest dict that was written.
        """
        now = datetime.now(timezone.utc).isoformat()
        if not manifest.created_at:
            manifest.created_at = now
        manifest.modified_at = now
        manifest.format_version = CURRENT_FORMAT_VERSION
        manifest_dict = manifest.model_dump()

        # Deflate beside the destination and swap it in with one rename, so a
        # reader mid-write opens the whole old archive or the whole new one.
        dest = Path(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = temp_sibling(dest)
        total_size = 0
        try:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.comment = GAN_COMMENT
                zf.writestr(_MANIFEST_NAME, json.dumps(manifest_dict, indent=2))
                for name, data in assets.items():
                    if name == _MANIFEST_NAME:
                        continue
                    zf.writestr(name, data)
                    total_size += len(data)
            atomic_replace(tmp, dest)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

        if total_size > SOFT_SIZE_WARN_BYTES:
            log.warning(
                "Large .gan file: %d MB (soft warn at %d MB).",
                total_size // (1024 * 1024),
                SOFT_SIZE_WARN_BYTES // (1024 * 1024),
            )
        return manifest_dict

    @staticmethod
    def install(src: str, dest: str) -> None:
        """Copy a .gan into the library so a concurrent /list sweep never reads
        the destination mid-copy. Streamed — a bundle may be hundreds of MB."""
        target = Path(dest)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = temp_sibling(target)
        try:
            shutil.copyfile(src, tmp)
            atomic_replace(tmp, target)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    @staticmethod
    def info(path: str) -> dict:
        """Read only the manifest from a .gan (no asset extraction)."""
        if not Path(path).is_file():
            raise FileNotFoundError(f".gan file not found: {path}")
        with _open_zip(path) as zf:
            try:
                manifest = json.loads(zf.read(_MANIFEST_NAME))
            except KeyError:
                raise ValueError("Invalid .gan: missing manifest.json")
        fv = manifest.get("format_version", 1)
        if fv > CURRENT_FORMAT_VERSION:
            raise ValueError(
                f"This .gan uses format v{fv}, but theDAW supports up to "
                f"v{CURRENT_FORMAT_VERSION}. Please update theDAW."
            )
        return manifest

    @staticmethod
    def load(path: str) -> tuple[dict, dict[str, bytes]]:
        """Read a .gan fully. Returns (manifest, assets) where assets maps
        in-zip path -> bytes (excluding manifest.json)."""
        manifest = GanFile.info(path)
        assets: dict[str, bytes] = {}
        with _open_zip(path) as zf:
            for name in zf.namelist():
                if name == _MANIFEST_NAME or name.endswith("/"):
                    continue
                assets[name] = zf.read(name)
        return manifest, assets

    @staticmethod
    def extract(path: str, out_dir: str) -> dict:
        """Extract a .gan's assets to ``out_dir`` for static serving. Returns the
        manifest dict. Guards against zip-slip path traversal."""
        manifest = GanFile.info(path)
        out = Path(out_dir).resolve()
        out.mkdir(parents=True, exist_ok=True)
        with _open_zip(path) as zf:
            for name in zf.namelist():
                if name == _MANIFEST_NAME or name.endswith("/"):
                    continue
                dest = (out / name).resolve()
                if not str(dest).startswith(str(out)):
                    log.warning("Skipping unsafe .gan entry: %s", name)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                # Atomic per file: the iframe re-fetching the runtime during a
                # rebuild gets the whole old asset or the whole new one, never a
                # truncated one (a half-written background.png renders as no
                # artwork at all).
                atomic_write(dest, zf.read(name))
        atomic_write(out / _MANIFEST_NAME, json.dumps(manifest, indent=2))
        return manifest
