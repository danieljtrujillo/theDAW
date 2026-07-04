"""Backup/migration service: root discovery, size scan, zip export, zip import.

All user-data roots worth backing up are enumerated by :func:`user_data_roots`:

- ``library``  — ``data/generations`` (or ``theDAW_GENERATIONS_DIR``): audio,
  ``library.db`` (entries + genealogy/lineage relations), spectrograms, and the
  per-entry ``stems/``, ``midi/`` and ``notation/`` subfolders.
- ``projects`` — the default ``~/Documents/theDAW Projects`` folder where
  ``.tasmo`` files are saved out of the box.
- ``settings`` — the top-level ``data/*.json`` registries (``settings.json``,
  ``local_checkpoints.json``, ``recent_projects.json``).

Export and import both run in daemon threads tracked by an in-memory job
table so the FastAPI event loop is never blocked; callers poll job status.
Every zip written here embeds a ``theDAW-backup-manifest.json`` describing the
app version, creation date and included roots, and import refuses archives
that lack it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[3]

MANIFEST_NAME = "theDAW-backup-manifest.json"
ZIP_PREFIX = "theDAW-backup-"

# Directory names never worth backing up, even if they appear inside a root.
_SKIP_DIR_NAMES = {
    "__pycache__",
    ".venv",
    "venv",
    "node_modules",
    ".git",
    ".cache",
    "thedaw_transcode",
}

_VERSION_RE = re.compile(r'^version\s*=\s*"([^"]+)"', re.MULTILINE)

_MANIFEST_TIME_BUDGET_SEC = 30.0
_COPY_CHUNK_BYTES = 1024 * 1024


def app_version() -> str:
    """App version from ``pyproject.toml`` project metadata (best effort)."""
    try:
        text = (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    except OSError as e:
        log.warning("backup: could not read pyproject.toml for version: %s", e)
        return "unknown"
    m = _VERSION_RE.search(text)
    return m.group(1) if m else "unknown"


@dataclass(frozen=True)
class RootSpec:
    """One user-data root. ``kind`` is ``dir`` (recursive) or ``files``
    (top-level ``*.json`` only — used for the settings registries so the
    ``data/generations`` tree is not double-counted)."""

    id: str
    label: str
    path: Path
    kind: str


def user_data_roots() -> list[RootSpec]:
    """Every user-data root worth backing up, in a stable order."""
    data_dir = PROJECT_ROOT / "data"
    # Mirrors backend.modules.library.store.default_library_root without
    # importing the library module (keeps this module import-light).
    configured = os.getenv("theDAW_GENERATIONS_DIR")
    library_path = (
        Path(configured).expanduser().resolve()
        if configured
        else data_dir / "generations"
    )
    return [
        RootSpec(
            id="library",
            label="Library (audio, database, stems, MIDI, scores, video, lineage)",
            path=library_path,
            kind="dir",
        ),
        RootSpec(
            id="projects",
            label="Projects (.tasmo)",
            path=Path.home() / "Documents" / "theDAW Projects",
            kind="dir",
        ),
        RootSpec(
            id="settings",
            label="Settings and registries (data/*.json)",
            path=data_dir,
            kind="files",
        ),
    ]


def _is_backup_zip(name: str) -> bool:
    return name.startswith(ZIP_PREFIX) and name.lower().endswith(".zip")


def _iter_root_files(spec: RootSpec) -> Iterator[tuple[Path, str]]:
    """Yield ``(absolute_path, relative_posix_path)`` for every file in a root,
    skipping caches/venvs/__pycache__ and previously written backup zips.
    Missing roots simply yield nothing."""
    base = spec.path
    if spec.kind == "files":
        if base.is_dir():
            for f in sorted(base.glob("*.json")):
                if f.is_file():
                    yield f, f.name
        return
    if not base.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_DIR_NAMES)
        for fn in sorted(filenames):
            if _is_backup_zip(fn):
                continue
            p = Path(dirpath) / fn
            try:
                rel = p.relative_to(base).as_posix()
            except ValueError:
                continue
            yield p, rel


def compute_manifest(time_budget_sec: float = _MANIFEST_TIME_BUDGET_SEC) -> dict:
    """Size up every root. Cooperative deadline caps the walk at
    ``time_budget_sec`` so a huge library can never hang the endpoint; sizes
    are then lower bounds. Missing dirs report ``exists=False`` with zeros."""
    deadline = time.monotonic() + time_budget_sec
    roots_out: list[dict] = []
    total_bytes = 0
    for spec in user_data_roots():
        exists = spec.path.exists()
        n_bytes = 0
        n_files = 0
        if exists:
            for p, _rel in _iter_root_files(spec):
                if time.monotonic() > deadline:
                    log.warning(
                        "backup: manifest scan hit %.0fs budget at root %s",
                        time_budget_sec,
                        spec.id,
                    )
                    break
                try:
                    n_bytes += p.stat().st_size
                    n_files += 1
                except OSError:
                    continue
        roots_out.append(
            {
                "id": spec.id,
                "label": spec.label,
                "path": str(spec.path),
                "exists": exists,
                "bytes": n_bytes,
                "files": n_files,
            }
        )
        total_bytes += n_bytes
    return {"roots": roots_out, "total_bytes": total_bytes}


# --- Job table -----------------------------------------------------------


@dataclass
class _Job:
    id: str
    kind: str  # "export" | "import"
    state: str = "running"  # running | done | error
    zip_path: Optional[str] = None
    bytes_written: int = 0
    progress: float = 0.0
    error: Optional[str] = None


_jobs: dict[str, _Job] = {}
_jobs_lock = threading.Lock()
_MAX_JOBS = 50


def _register_job(kind: str) -> _Job:
    job = _Job(id=uuid.uuid4().hex[:12], kind=kind)
    with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            # Evict oldest finished jobs to keep the table bounded.
            for jid in [j.id for j in _jobs.values() if j.state != "running"]:
                del _jobs[jid]
                if len(_jobs) < _MAX_JOBS:
                    break
        _jobs[job.id] = job
    return job


def job_status(job_id: str, kind: str) -> Optional[dict]:
    """Status dict for a job of the given kind, or ``None`` when unknown."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None or job.kind != kind:
            return None
        return {
            "state": job.state,
            "zip_path": job.zip_path,
            "bytes_written": job.bytes_written,
            "progress": round(job.progress, 4),
            "error": job.error,
        }


def _fail_job(job: _Job, message: str) -> None:
    with _jobs_lock:
        job.state = "error"
        job.error = message
    log.error("backup: %s job %s failed: %s", job.kind, job.id, message)


# --- Export --------------------------------------------------------------


def start_export(dest_dir: Optional[str], include: Optional[list[str]]) -> str:
    """Validate inputs, spawn the export worker thread, return the job id.

    Raises ``ValueError`` on unknown root ids or an unusable destination.
    """
    known = {s.id for s in user_data_roots()}
    if include is not None:
        unknown = sorted(set(include) - known)
        if unknown:
            raise ValueError(f"unknown root ids: {', '.join(unknown)}")
        if not include:
            raise ValueError("include list is empty — nothing to export")
    dest = Path(dest_dir).expanduser() if dest_dir else Path.home() / "Documents"
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ValueError(f"destination not writable: {dest} ({e})") from e

    job = _register_job("export")
    thread = threading.Thread(
        target=_run_export,
        args=(job, dest, include),
        name=f"backup-export-{job.id}",
        daemon=True,
    )
    thread.start()
    return job.id


def _run_export(job: _Job, dest: Path, include: Optional[list[str]]) -> None:
    try:
        specs = [s for s in user_data_roots() if include is None or s.id in include]
        # Enumerate first so progress has a denominator.
        plan: list[tuple[Path, str, int]] = []
        per_root: dict[str, dict] = {
            s.id: {
                "id": s.id,
                "label": s.label,
                "source_path": str(s.path),
                "files": 0,
                "bytes": 0,
            }
            for s in specs
        }
        total = 0
        for spec in specs:
            for p, rel in _iter_root_files(spec):
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                plan.append((p, f"roots/{spec.id}/{rel}", size))
                per_root[spec.id]["files"] += 1
                per_root[spec.id]["bytes"] += size
                total += size

        stamp = time.strftime("%Y%m%d-%H%M%S")
        zip_path = dest / f"{ZIP_PREFIX}{stamp}.zip"
        manifest = {
            "app": "theDAW",
            "version": app_version(),
            "created": datetime.now(timezone.utc).isoformat(),
            "roots": [per_root[s.id] for s in specs],
            "total_bytes": total,
        }
        written = 0
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(MANIFEST_NAME, json.dumps(manifest, indent=2))
            for p, arcname, size in plan:
                try:
                    if p.resolve() == zip_path.resolve():
                        continue  # never zip the archive into itself
                    zf.write(p, arcname)
                except OSError as e:
                    log.warning("backup: skipping unreadable %s: %s", p, e)
                    continue
                written += size
                with _jobs_lock:
                    job.bytes_written = written
                    job.progress = written / total if total else 1.0
        with _jobs_lock:
            job.zip_path = str(zip_path)
            job.bytes_written = written
            job.progress = 1.0
            job.state = "done"
        log.info(
            "backup: export %s wrote %s (%d files, %d bytes)",
            job.id,
            zip_path,
            len(plan),
            written,
        )
    except Exception as e:  # worker thread boundary — report, never raise
        _fail_job(job, str(e))


# --- Import --------------------------------------------------------------


def validate_backup_zip(zip_path: str) -> Path:
    """Cheap synchronous validation for POST /import: the file must exist, be
    a zip, and contain a parseable theDAW backup manifest.

    Raises ``ValueError`` describing the problem; returns the resolved path.
    """
    p = Path(zip_path).expanduser()
    if not p.is_file():
        raise ValueError(f"zip not found: {p}")
    try:
        with zipfile.ZipFile(p) as zf:
            names = set(zf.namelist())
            if MANIFEST_NAME not in names:
                raise ValueError(
                    f"not a theDAW backup: {MANIFEST_NAME} missing from zip"
                )
            manifest = json.loads(zf.read(MANIFEST_NAME))
    except zipfile.BadZipFile as e:
        raise ValueError(f"not a valid zip file: {p}") from e
    except (OSError, json.JSONDecodeError) as e:
        raise ValueError(f"could not read backup manifest: {e}") from e
    if not isinstance(manifest, dict) or "roots" not in manifest:
        raise ValueError("backup manifest is malformed (no roots recorded)")
    return p


def start_import(zip_path: str, mode: str) -> str:
    """Validate the archive, spawn the restore worker, return the job id."""
    p = validate_backup_zip(zip_path)
    job = _register_job("import")
    with _jobs_lock:
        job.zip_path = str(p)
    thread = threading.Thread(
        target=_run_import,
        args=(job, p, mode),
        name=f"backup-import-{job.id}",
        daemon=True,
    )
    thread.start()
    return job.id


def _run_import(job: _Job, zip_path: Path, mode: str) -> None:
    try:
        roots_by_id = {s.id: s for s in user_data_roots()}
        written = 0
        processed = 0
        with zipfile.ZipFile(zip_path) as zf:
            members = [
                m
                for m in zf.infolist()
                if m.filename.startswith("roots/") and not m.is_dir()
            ]
            total = sum(m.file_size for m in members) or 1
            for m in members:
                processed += m.file_size
                parts = m.filename.split("/", 2)
                if len(parts) < 3 or not parts[2]:
                    continue
                spec = roots_by_id.get(parts[1])
                if spec is None:
                    log.warning(
                        "backup: unknown root id %r in archive — skipping %s",
                        parts[1],
                        m.filename,
                    )
                    continue
                base = spec.path
                target = base / parts[2]
                # Zip-slip guard: the resolved target must stay inside the root.
                try:
                    base.mkdir(parents=True, exist_ok=True)
                    if not target.resolve().is_relative_to(base.resolve()):
                        log.warning(
                            "backup: refusing path outside root: %s", m.filename
                        )
                        continue
                except OSError as e:
                    log.warning("backup: cannot resolve %s: %s", m.filename, e)
                    continue
                if mode == "merge" and target.exists():
                    with _jobs_lock:
                        job.progress = processed / total
                    continue
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(m) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst, _COPY_CHUNK_BYTES)
                except OSError as e:
                    log.warning("backup: failed to restore %s: %s", m.filename, e)
                    continue
                written += m.file_size
                with _jobs_lock:
                    job.bytes_written = written
                    job.progress = processed / total
        with _jobs_lock:
            job.bytes_written = written
            job.progress = 1.0
            job.state = "done"
        log.info(
            "backup: import %s restored %d bytes from %s (mode=%s)",
            job.id,
            written,
            zip_path,
            mode,
        )
    except Exception as e:  # worker thread boundary — report, never raise
        _fail_job(job, str(e))
