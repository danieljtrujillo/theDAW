"""TasmoFile — read and write .tasmo project files (ZIP + MsgPack)."""

from __future__ import annotations
import hashlib
import json
import logging
import zipfile
from pathlib import Path
from datetime import datetime, timezone

import msgpack

from backend.lib.atomic import atomic_replace, temp_sibling
from backend.modules.project.tasmo_project import TasmoProject

log = logging.getLogger(__name__)

TASMO_COMMENT = b"TASMOv1"
CURRENT_FORMAT_VERSION = 1
SOFT_SIZE_WARN_BYTES = 500 * 1024 * 1024  # 500 MB


class TasmoFile:
    """Read and write .tasmo project files."""

    @staticmethod
    def save(
        project: TasmoProject,
        path: str,
        audio_files: dict[str, bytes] | None = None,
        vst_presets: dict[str, bytes] | None = None,
        embed_audio: bool = False,
    ) -> dict:
        """Write a .tasmo file. Returns manifest dict.

        When ``embed_audio`` is True (and no explicit ``audio_files`` are
        supplied), each clip's on-disk audio — and each of its takes' — is read
        into the archive and every one of those ``audio_file`` references is
        rewritten to a portable in-zip path (``audio/<name>``), so the project,
        including its comps, round-trips on another machine.

        The archive is written beside ``path`` and moved over it only once it
        is complete, so a save that fails part way (a disk that fills, an
        unreadable upload) leaves the file that was there before untouched.
        Writing straight into ``path`` truncated it on open, and a failure
        after that left the user's project replaced by a partial archive.
        ``atomic_write`` is not used because it takes the whole payload as one
        value, and an embedded-audio archive can be hundreds of megabytes.
        """
        project.modified_at = datetime.now(timezone.utc).isoformat()
        if embed_audio and audio_files is None:
            audio_files = _gather_embedded_audio(project)
        project_bytes = msgpack.packb(project.model_dump(), use_bin_type=True) or b""

        manifest = {
            "format": "tasmo",
            "format_version": CURRENT_FORMAT_VERSION,
            "thedaw_version": "0.1.0",
            "project_name": project.project_name,
            "created_at": project.created_at,
            "modified_at": project.modified_at,
            "audio_mode": "embedded" if audio_files else "linked",
            "total_tracks": len(project.tracks),
            "total_clips": sum(len(t.clips) for t in project.tracks),
            "sample_rate": project.sample_rate,
        }

        total_size = len(project_bytes)
        tmp = temp_sibling(path)
        try:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.comment = TASMO_COMMENT
                zf.writestr("manifest.json", json.dumps(manifest, indent=2))
                zf.writestr("project.msgpack", project_bytes)

                if audio_files:
                    for name, data in audio_files.items():
                        zf.writestr(f"audio/{name}", data)
                        total_size += len(data)

                if vst_presets:
                    for name, data in vst_presets.items():
                        zf.writestr(f"vst_presets/{name}", data)
            atomic_replace(tmp, path)
        except BaseException:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                log.debug("TasmoFile.save: leftover temp file %s", tmp)
            raise

        if total_size > SOFT_SIZE_WARN_BYTES:
            log.warning(
                "Large .tasmo file: %d MB (soft warn at %d MB). Consider 'linked' audio mode.",
                total_size // (1024 * 1024),
                SOFT_SIZE_WARN_BYTES // (1024 * 1024),
            )

        return manifest

    @staticmethod
    def load(path: str, media_dir: str | None = None) -> tuple[TasmoProject, dict]:
        """Read a .tasmo file. Returns (project, manifest).

        If the archive embeds audio, it is extracted to ``media_dir`` (default:
        a ``<stem>_media`` folder beside the .tasmo) and each clip's
        ``audio_file`` — plus each of its takes' — is relinked to the extracted
        on-disk path.
        """
        if not Path(path).is_file():
            raise FileNotFoundError(f".tasmo file not found: {path}")

        with zipfile.ZipFile(path, "r") as zf:
            # manifest
            try:
                manifest = json.loads(zf.read("manifest.json"))
            except KeyError:
                raise ValueError("Invalid .tasmo: missing manifest.json")

            # Format version check
            fv = manifest.get("format_version", 1)
            if fv > CURRENT_FORMAT_VERSION:
                raise ValueError(
                    f"This .tasmo uses format v{fv}, but theDAW supports up to "
                    f"v{CURRENT_FORMAT_VERSION}. Please update theDAW."
                )

            # Apply migrations if needed
            # (currently only v1, so no migration needed yet)

            # Project data
            try:
                raw = zf.read("project.msgpack")
            except KeyError:
                raise ValueError("Invalid .tasmo: missing project.msgpack")

            project_data = msgpack.unpackb(raw, raw=False)
            project = TasmoProject.model_validate(project_data)

            if manifest.get("audio_mode") == "embedded":
                target = (
                    Path(media_dir)
                    if media_dir
                    else Path(path).parent / f"{Path(path).stem}_media"
                )
                _extract_and_relink(zf, project, target)

            return project, manifest

    @staticmethod
    def info(path: str) -> dict:
        """Read only the manifest from a .tasmo (no full project load)."""
        with zipfile.ZipFile(path, "r") as zf:
            try:
                return json.loads(zf.read("manifest.json"))
            except KeyError:
                raise ValueError("Invalid .tasmo: missing manifest.json")

    @staticmethod
    def list_audio(path: str) -> list[str]:
        """List embedded audio file names inside a .tasmo."""
        with zipfile.ZipFile(path, "r") as zf:
            return [n for n in zf.namelist() if n.startswith("audio/")]

    @staticmethod
    def extract_audio(path: str, output_dir: str) -> list[str]:
        """Extract all embedded audio files from a .tasmo to disk."""
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        extracted = []
        with zipfile.ZipFile(path, "r") as zf:
            for name in zf.namelist():
                if name.startswith("audio/"):
                    # zf.extract() already sanitizes '..' in the member name
                    # and returns the REAL path it wrote to; re-joining the
                    # raw (still-'..'-bearing) name onto `out` by hand, as
                    # before, produced a different string whose resolved form
                    # could land outside `out` -- and this return value feeds
                    # media_access.register_paths, which resolves it.
                    extracted.append(zf.extract(name, out))
        return extracted


def _gather_embedded_audio(project: TasmoProject) -> dict[str, bytes]:
    """Read each clip's on-disk audio — and each of its takes' — into bytes.

    Files referenced more than once are stored once, whether the second
    reference is another clip or one of this clip's takes: the active take
    normally names the very file the clip itself plays, and embedding it twice
    would double the archive for nothing. Mutates the project in place: every
    embedded reference (``clip.audio_file`` and each ``take.audio_file``) is
    rewritten to its in-zip path (``audio/<name>``), and the clip's
    ``audio_file_checksum`` is filled in. References that are missing, already
    relative, or name a file that is not on disk are left untouched — a take
    whose recording was moved away must not fail the save.
    Returns a mapping of {archive_name: bytes}.
    """
    audio_files: dict[str, bytes] = {}
    path_to_name: dict[str, str] = {}
    checksums: dict[str, str] = {}
    # Names already spoken for by a reference that is ALREADY an in-zip path —
    # a partly-embedded project, or one loaded from an archive whose files were
    # not all extracted. Those entries are not re-read here, so without seeding
    # them a newly embedded take could be allocated the same ``audio/<name>``
    # and silently shadow the older reference.
    used_names: set[str] = {
        Path(ref).name
        for track in project.tracks
        for clip in track.clips
        for ref in (clip.audio_file, *(t.audio_file for t in clip.takes or []))
        if ref and ref.startswith("audio/")
    }

    def embed(src: str | None) -> tuple[str, str] | None:
        """Return (in-zip ref, checksum) for ``src``, or None if unembeddable."""
        if not src or src.startswith("audio/"):
            return None
        sp = Path(src)
        if not sp.is_file():
            return None  # cannot embed a file that is not on disk
        key = str(sp.resolve())
        name = path_to_name.get(key)
        if name is None:
            data = sp.read_bytes()
            name = _unique_name(sp.name, used_names)
            used_names.add(name)
            path_to_name[key] = name
            audio_files[name] = data
            checksums[name] = "sha256:" + hashlib.sha256(data).hexdigest()
        return f"audio/{name}", checksums[name]

    for track in project.tracks:
        for clip in track.clips:
            embedded = embed(clip.audio_file)
            if embedded is not None:
                clip.audio_file, clip.audio_file_checksum = embedded
            for take in clip.takes or []:
                take_embedded = embed(take.audio_file)
                if take_embedded is not None:
                    take.audio_file = take_embedded[0]
    return audio_files


def _extract_and_relink(
    zf: zipfile.ZipFile, project: TasmoProject, media_dir: Path
) -> None:
    """Extract embedded clip and take audio to ``media_dir`` and relink refs.

    Every reference pointing at an ``audio/<name>`` entry — a clip's own
    ``audio_file`` and each of its takes' — is rewritten to the extracted
    on-disk path, because ``/api/project/clip-audio`` serves files from disk
    and cannot reach into the archive. Each archive entry is extracted at most
    once even when several clips or takes share it.

    A reference naming an entry the archive does not have (a file written
    before take audio was embedded, or a hand-made archive) is left EXACTLY as
    written and nothing is raised: the frontend reader drops a clip's takes and
    comp together and logs, which is a clip that still plays rather than a
    project that will not open.
    """
    names = set(zf.namelist())
    extracted: dict[str, str] = {}

    def relink(ref: str | None) -> str | None:
        """Return the on-disk path for ``ref``, or None to leave it alone."""
        if not ref or not ref.startswith("audio/") or ref not in names:
            return None
        if ref not in extracted:
            media_dir.mkdir(parents=True, exist_ok=True)
            out = media_dir / Path(ref).name
            out.write_bytes(zf.read(ref))
            extracted[ref] = str(out)
        return extracted[ref]

    for track in project.tracks:
        for clip in track.clips:
            clip_path = relink(clip.audio_file)
            if clip_path is not None:
                clip.audio_file = clip_path
            for take in clip.takes or []:
                take_path = relink(take.audio_file)
                if take_path is not None:
                    take.audio_file = take_path


def _unique_name(name: str, used: set[str]) -> str:
    """Return ``name`` or a ``stem_N.ext`` variant not present in ``used``."""
    if name not in used:
        return name
    stem = Path(name).stem
    ext = Path(name).suffix
    i = 1
    while f"{stem}_{i}{ext}" in used:
        i += 1
    return f"{stem}_{i}{ext}"
