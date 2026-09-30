"""Orchestral sound banks in the download manager (job ``kind: "soundbank"``).

Each catalog entry names its licence, and ``GET /api/models/soundbanks`` sends
the licence with the entry, so Settings shows it before anything is fetched.
Two kinds of entry:

``download``  a file the app fetches into ``data/soundbanks/<id>/``. A ``.zip``
              is unpacked (only its ``.sf2``/``.sf3``/``.dls`` and text files)
              and removed. Every bank file that lands is passed to
              ``register_downloaded_bank``.
``link``      a library published only as SFZ, which the soundfont engine
              cannot load. The entry links to its upstream download page.

theDAW Orchestra is the bank ``scripts/build_orchestra_sf3.py`` builds. It is
published as an asset on a GitHub release of this repository whose tag starts
with ``soundbank-orchestra``; the newest such release is looked up when the
download starts, so a rebuilt bank ships by publishing a new release.

``register_downloaded_bank`` is the one hook the soundfont bank registry
(``backend/modules/soundfonts``) needs: it remembers the path in
``known_paths`` and calls every function added with ``add_soundbank_hook``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import time
import urllib.request
import zipfile
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from backend.lib import known_paths, paths

log = logging.getLogger(__name__)

#: File types the soundfont engine loads.
BANK_EXTS = (".sf2", ".sf3", ".dls")
#: Extra files kept from an archive, so its licence travels with the bank.
TEXT_EXTS = (".txt", ".md", ".pdf", ".json")
#: known_paths kind every downloaded bank is recorded under.
SOUNDFONT_KIND = "soundfont"

GITHUB_RELEASES_API = "https://api.github.com/repos/{repo}/releases?per_page=50"
USER_AGENT = "theDAW-soundbank-download"
CHUNK = 1 << 20


@dataclass(frozen=True)
class Licence:
    name: str
    url: str
    #: One line on what the licence lets the user do with the bank.
    summary: str
    spdx: str = ""


@dataclass(frozen=True)
class GithubAsset:
    """A release asset looked up at download time (newest matching release)."""

    repo: str
    tag_prefix: str
    asset: str
    extra_assets: tuple[str, ...] = ()


@dataclass(frozen=True)
class SoundbankEntry:
    id: str
    label: str
    summary: str
    format: str  # "sf3" | "sf2" | "sfz"
    licence: Licence
    homepage: str
    credit: str
    kind: str = "download"  # "download" | "link"
    url: str | None = None
    github: GithubAsset | None = None
    size_bytes: int | None = None
    sha256: str | None = None
    #: The soundfont pickers can load what this entry downloads.
    loadable: bool = True
    notes: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)


CC0 = Licence(
    name="CC0 1.0 Universal",
    spdx="CC0-1.0",
    url="https://creativecommons.org/publicdomain/zero/1.0/",
    summary="Public domain: use it for anything, commercial music included; no credit required.",
)
CC_SAMPLING_PLUS = Licence(
    name="Creative Commons Sampling Plus 1.0",
    url="https://creativecommons.org/licenses/sampling+/1.0/",
    summary=(
        "Use it in your music, commercial releases included. Share the whole library "
        "only non-commercially, and never use it in advertising."
    ),
)
VPO_MIXED = Licence(
    name="Mixed: CC Sampling Plus 1.0, CC BY-SA 3.0, CC BY-SA 4.0, CC0 1.0",
    url="https://virtualplaying.com/virtual-playing-orchestra/",
    summary=(
        "Music made with it may be used for any purpose, commercial included. "
        "Repackaging or reselling the samples needs attribution under each source's licence."
    ),
)

ORCHESTRA_ID = "thedaw-orchestra"

CATALOG: tuple[SoundbankEntry, ...] = (
    SoundbankEntry(
        id=ORCHESTRA_ID,
        label="theDAW Orchestra",
        summary=(
            "Strings, woodwinds, brass, harp and orchestral percussion from VSCO 2 CE and VCSL. "
            "Sustained parts swell between dynamic layers on CC1."
        ),
        format="sf3",
        licence=CC0,
        homepage="https://github.com/gantasmo/theDAW/releases?q=soundbank-orchestra",
        credit="Samples by Versilian Studios (VSCO 2 CE, VCSL); built by scripts/build_orchestra_sf3.py.",
        github=GithubAsset(
            repo="gantasmo/theDAW",
            tag_prefix="soundbank-orchestra",
            asset="theDAW-Orchestra.sf3",
            extra_assets=("theDAW-Orchestra.json", "theDAW-Orchestra-ATTRIBUTION.txt"),
        ),
        tags=("orchestra", "cc1-dynamics", "articulation-banks"),
    ),
    SoundbankEntry(
        id="sonatina-sf2",
        label="Sonatina Symphonic Orchestra (SF2)",
        summary="Mattias Westlund's free orchestral library as one SF2 per section and articulation.",
        format="sf2",
        licence=CC_SAMPLING_PLUS,
        homepage="https://archive.org/details/SonatinaSymphonicOrchestraSF2",
        credit="Sonatina Symphonic Orchestra by Mattias Westlund and contributors.",
        url=(
            "https://archive.org/download/SonatinaSymphonicOrchestraSF2/"
            "Sonatina%20Symphonic%20Orchestra%20SF2.zip"
        ),
        size_bytes=512_093_492,
        tags=("orchestra",),
    ),
    SoundbankEntry(
        id="sonatina-sfz",
        label="Sonatina Symphonic Orchestra (SFZ, current)",
        summary="The maintained SFZ edition by Peter Eastman, with added articulations and instruments.",
        format="sfz",
        licence=CC_SAMPLING_PLUS,
        homepage="https://github.com/peastman/sso/releases/latest",
        credit="Sonatina Symphonic Orchestra by Mattias Westlund; SFZ edition by Peter Eastman.",
        kind="link",
        loadable=False,
        notes="SFZ: load it in an SFZ player such as sfizz, used as a VST3 instrument.",
        tags=("orchestra", "sfz"),
    ),
    SoundbankEntry(
        id="virtual-playing-orchestra",
        label="Virtual Playing Orchestra 3",
        summary="Paul Battersby's orchestra with many articulations, built from several free libraries.",
        format="sfz",
        licence=VPO_MIXED,
        homepage="https://virtualplaying.com/virtual-playing-orchestra/",
        credit="Virtual Playing Orchestra by Paul Battersby.",
        kind="link",
        loadable=False,
        notes=(
            "SFZ: download the Wave Files and one set of scripts from the page, "
            "then load them in an SFZ player such as sfizz, used as a VST3 instrument."
        ),
        tags=("orchestra", "sfz"),
    ),
)

_BY_ID = {e.id: e for e in CATALOG}


def get_entry(bank_id: str) -> SoundbankEntry | None:
    return _BY_ID.get(bank_id)


def bank_dir(entry: SoundbankEntry) -> Path:
    return paths.data_path("soundbanks", entry.id)


def installed_files(entry: SoundbankEntry) -> list[Path]:
    """The bank files an earlier download left in the entry's folder."""
    folder = bank_dir(entry)
    if not folder.is_dir():
        return []
    return sorted(
        p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in BANK_EXTS
    )


def installed_manifest(entry: SoundbankEntry) -> dict | None:
    """The build manifest a download left beside its bank (``<bank>.json``,
    written by scripts/build_orchestra_sf3.py), or None."""
    for bank in installed_files(entry):
        path = bank.with_suffix(".json")
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            return data
    return None


def public_entry(entry: SoundbankEntry) -> dict:
    """The entry as JSON for the Settings list, with what is installed."""
    out = asdict(entry)
    out.pop("github", None)
    files = installed_files(entry)
    out["installed"] = [str(p) for p in files]
    out["installed_bytes"] = sum(p.stat().st_size for p in files)
    return out


# ---------------------------------------------------------------------------
# Registration hook
# ---------------------------------------------------------------------------

SoundbankHook = Callable[[Path, SoundbankEntry], None]
_HOOKS: list[SoundbankHook] = []


def add_soundbank_hook(hook: SoundbankHook) -> None:
    """Call ``hook(path, entry)`` for every bank file a download installs.

    The soundfont bank registry adds itself here so a downloaded bank appears
    in the pickers without a restart.
    """
    if hook not in _HOOKS:
        _HOOKS.append(hook)


def register_downloaded_bank(path: Path, entry: SoundbankEntry) -> None:
    """Make a freshly downloaded bank known to every surface that lists banks.

    Remembers the path (``known_paths``: the installed-asset slot for the entry
    and the ``soundfont`` recent list, servable as an install) and runs every
    hook. A hook that raises is logged and skipped; the download still counts.
    """
    known_paths.set_installed_asset(f"soundbank:{entry.id}", path)
    known_paths.record(path, kind=SOUNDFONT_KIND, source="install", update_folder=False)
    for hook in list(_HOOKS):
        try:
            hook(path, entry)
        except Exception:
            log.exception("soundbank hook %r failed for %s", hook, path)


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

ProgressFn = Callable[[int, int], None]


def _request(url: str, *, api: bool = False) -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT}
    if api:
        headers["Accept"] = "application/vnd.github+json"
        token = os.getenv("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def resolve_github_asset(spec: GithubAsset) -> dict:
    """The newest published release of ``spec.repo`` whose tag starts with
    ``spec.tag_prefix`` and carries ``spec.asset``.

    Returns ``{"tag", "url", "size", "sha256", "extras": [(name, url, size)]}``.
    """
    with urllib.request.urlopen(
        _request(GITHUB_RELEASES_API.format(repo=spec.repo), api=True), timeout=30
    ) as resp:
        releases = json.loads(resp.read())
    for release in releases:
        if release.get("draft") or not str(release.get("tag_name", "")).startswith(
            spec.tag_prefix
        ):
            continue
        assets = {a["name"]: a for a in release.get("assets", [])}
        main = assets.get(spec.asset)
        if not main:
            continue
        digest = str(main.get("digest") or "")
        return {
            "tag": release["tag_name"],
            "url": main["browser_download_url"],
            "size": int(main.get("size") or 0),
            "sha256": digest.split(":", 1)[1] if digest.startswith("sha256:") else None,
            "extras": [
                (n, assets[n]["browser_download_url"], int(assets[n].get("size") or 0))
                for n in spec.extra_assets
                if n in assets
            ],
        }
    raise FileNotFoundError(
        f"No published release of {spec.repo} with a tag starting {spec.tag_prefix!r} "
        f"carries {spec.asset}. Build it with scripts/build_orchestra_sf3.py and attach "
        "it to a release."
    )


def download_file(
    url: str,
    dest: Path,
    progress: ProgressFn,
    *,
    expected_size: int | None = None,
    sha256: str | None = None,
) -> Path:
    """Stream ``url`` to ``dest`` through a ``.part`` file, reporting bytes.

    Checks the size and the SHA-256 when they are known, and only then moves
    the file into place.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    digest = hashlib.sha256()
    done = 0
    with urllib.request.urlopen(_request(url), timeout=60) as resp:
        total = int(resp.headers.get("Content-Length") or 0) or int(expected_size or 0)
        progress(0, total)
        with open(part, "wb") as fh:
            while True:
                block = resp.read(CHUNK)
                if not block:
                    break
                fh.write(block)
                digest.update(block)
                done += len(block)
                progress(done, total)
    if expected_size and done != expected_size:
        part.unlink(missing_ok=True)
        raise OSError(f"{dest.name}: got {done} bytes, expected {expected_size}")
    if sha256 and digest.hexdigest().lower() != sha256.lower():
        part.unlink(missing_ok=True)
        raise OSError(f"{dest.name}: SHA-256 does not match the published digest")
    os.replace(part, dest)
    return dest


def unpack_archive(archive: Path, folder: Path) -> list[Path]:
    """Extract the bank and text files of a zip into ``folder`` (flattened),
    then delete the zip. Member names never escape ``folder``."""
    kept: list[Path] = []
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = Path(info.filename.replace("\\", "/")).name
            if not name or name.startswith("."):
                continue
            if not name.lower().endswith(BANK_EXTS + TEXT_EXTS):
                continue
            target = folder / name
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, CHUNK)
            kept.append(target)
    archive.unlink(missing_ok=True)
    return kept


@dataclass
class DownloadPlan:
    files: list[tuple[str, str, int | None, str | None]]  # (name, url, size, sha256)
    source: str


def plan_download(entry: SoundbankEntry) -> DownloadPlan:
    if entry.kind != "download":
        raise ValueError(
            f"{entry.label} is a link to its upstream page, not a download"
        )
    if entry.github is not None:
        found = resolve_github_asset(entry.github)
        files = [
            (entry.github.asset, found["url"], found["size"] or None, found["sha256"])
        ]
        files += [(n, u, s or None, None) for n, u, s in found["extras"]]
        return DownloadPlan(files, f"{entry.github.repo} {found['tag']}")
    if not entry.url:
        raise ValueError(f"{entry.label} has no download URL")
    name = entry.url.rsplit("/", 1)[-1]
    name = urllib.request.url2pathname(name) if "%" in name else name
    return DownloadPlan(
        [(Path(name).name, entry.url, entry.size_bytes, entry.sha256)], entry.url
    )


def install(
    entry: SoundbankEntry,
    on_file: Callable[[str], None],
    progress: ProgressFn,
    plan: DownloadPlan | None = None,
) -> list[Path]:
    """Download ``entry`` into its folder, unpack it, register every bank file.

    ``on_file(name)`` is called as each file starts; ``progress(done, total)``
    reports that file's bytes. Returns the installed bank files.
    """
    plan = plan or plan_download(entry)
    folder = bank_dir(entry)
    folder.mkdir(parents=True, exist_ok=True)
    landed: list[Path] = []
    for name, url, size, sha in plan.files:
        on_file(name)
        path = download_file(
            url, folder / name, progress, expected_size=size, sha256=sha
        )
        if path.suffix.lower() == ".zip":
            landed += unpack_archive(path, folder)
        else:
            landed.append(path)
    banks = [p for p in landed if p.suffix.lower() in BANK_EXTS]
    if not banks:
        raise OSError(f"{entry.label}: the download held no .sf2, .sf3 or .dls file")
    for bank in banks:
        register_downloaded_bank(bank, entry)
    stamp = {
        "id": entry.id,
        "source": plan.source,
        "licence": entry.licence.name,
        "licence_url": entry.licence.url,
        "credit": entry.credit,
        "installed": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "files": [p.name for p in banks],
    }
    (folder / "soundbank.json").write_text(
        json.dumps(stamp, indent=2), encoding="utf-8"
    )
    return banks
