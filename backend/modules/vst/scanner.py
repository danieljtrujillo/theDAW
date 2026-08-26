"""VST3 plugin scanner — discovers VST3 plugins on the filesystem.

Scans the standard VST3 directories per platform, plus any user-specified
paths. Results are cached on disk so subsequent scans are instant unless
the cache goes stale (a scan root changed) or the caller requests a refresh.
"""

from __future__ import annotations
import copy
import json
import logging
import os
import platform
import subprocess
import sys
import threading
import time
from pathlib import Path
from dataclasses import dataclass, asdict, fields

log = logging.getLogger(__name__)


@dataclass
class Vst3PluginInfo:
    """Metadata for a discovered VST3 plugin."""

    name: str
    path: str
    manufacturer: str = ""
    version: str = ""
    category: str = ""  # "effect" | "instrument" | "unknown"
    file_size_mb: float = 0.0
    last_modified: float = 0.0
    # Set once the plugin has been opened out-of-process for metadata; False
    # means the host could not load it (wrong architecture, broken install) and
    # it must not be offered as a usable effect.
    loadable: bool = True
    probed: bool = False
    probe_timeouts: int = 0


# A VST3 bundle stores its binaries under Contents/<architecture>/. Only
# architectures this host can actually load are listed, so a 32-bit-only
# plugin is reported unloadable instead of being offered and then failing.
_ARCH_DIRS_WINDOWS_X64 = ("x86_64-win", "arm64-win", "aarch64-win")
_ARCH_DIRS_WINDOWS_ARM = ("arm64-win", "aarch64-win", "x86_64-win")
_ARCH_DIRS_WINDOWS_X86 = ("x86-win",)
_ARCH_DIRS_LINUX = ("x86_64-linux", "aarch64-linux", "armv7l-linux", "i386-linux")


def _is_64bit_host() -> bool:
    return sys.maxsize > 2**32


def _arch_dirs() -> tuple[str, ...]:
    """Bundle architecture directories this host can load, best first."""
    system = platform.system()
    if system == "Windows":
        if not _is_64bit_host():
            return _ARCH_DIRS_WINDOWS_X86
        if platform.machine().lower() in ("arm64", "aarch64"):
            return _ARCH_DIRS_WINDOWS_ARM
        return _ARCH_DIRS_WINDOWS_X64
    if system == "Darwin":
        return ("MacOS",)
    if not _is_64bit_host():
        return ("i386-linux", "armv7l-linux")
    return _ARCH_DIRS_LINUX


def _default_vst3_dirs() -> list[Path]:
    """Return the standard VST3 search paths for the current platform."""
    system = platform.system()
    dirs: list[Path] = []
    if system == "Windows":
        common = os.environ.get("COMMONPROGRAMFILES", r"C:\Program Files\Common Files")
        dirs.append(Path(common) / "VST3")
        # The Program Files (x86) tree holds 32-bit builds exclusively; a 64-bit
        # host can never load them, so scanning it only produces dead tiles.
        if not _is_64bit_host():
            common_x86 = os.environ.get(
                "COMMONPROGRAMFILES(X86)", r"C:\Program Files (x86)\Common Files"
            )
            dirs.append(Path(common_x86) / "VST3")
    elif system == "Darwin":
        dirs.append(Path("/Library/Audio/Plug-Ins/VST3"))
        dirs.append(Path.home() / "Library" / "Audio" / "Plug-Ins" / "VST3")
    else:
        dirs.append(Path("/usr/lib/vst3"))
        dirs.append(Path("/usr/local/lib/vst3"))
        dirs.append(Path.home() / ".vst3")
    return [d for d in dirs if d.is_dir()]


def _bundle_root(item: Path) -> Path | None:
    """The enclosing ``*.vst3`` bundle if ``item`` sits inside one, else None."""
    for parent in item.parents:
        if parent.suffix.lower() == ".vst3":
            return parent
    return None


def _resolve_bundle_binary(bundle: Path) -> Path | None:
    """Locate the loadable binary inside a VST3 bundle directory.

    pedalboard/JUCE cannot load the bundle directory itself on Windows or Linux;
    it needs the module under ``Contents/<arch>/``. macOS is the exception: there
    the bundle IS the loadable artifact (CFBundle), and its Mach-O under
    Contents/MacOS carries no .vst3 suffix, so nothing there is ever scanned as a
    duplicate. Returns None when no architecture this host supports is present.
    """
    if platform.system() == "Darwin":
        return bundle
    contents = bundle / "Contents"
    if not contents.is_dir():
        return None
    for arch in _arch_dirs():
        arch_dir = contents / arch
        if not arch_dir.is_dir():
            continue
        exact = arch_dir / bundle.name
        if exact.is_file():
            return exact
        for candidate in sorted(arch_dir.iterdir()):
            if candidate.is_file() and candidate.suffix.lower() == ".vst3":
                return candidate
    return None


def _read_moduleinfo(bundle: Path) -> tuple[str, str, str]:
    """(manufacturer, version, category) from a bundle's moduleinfo.json, if any."""
    moduleinfo = bundle / "Contents" / "moduleinfo.json"
    if not moduleinfo.is_file():
        return "", "", ""
    try:
        mi = json.loads(moduleinfo.read_text(encoding="utf-8"))
        plgs = mi.get("plugins", [])
        if not plgs:
            return "", "", ""
        cat = plgs[0].get("category", "")
        return (
            plgs[0].get("vendor", ""),
            plgs[0].get("version", ""),
            _normalize_category(cat),
        )
    except Exception as e:
        log.debug("moduleinfo.json unreadable for %s: %s", bundle, e)
        return "", "", ""


def _normalize_category(raw: str) -> str:
    """Map a VST3 category string ("Fx|Delay") to our effect/instrument buckets."""
    if not raw:
        return ""
    if "Instrument" in raw:
        return "instrument"
    if "Fx" in raw:
        return "effect"
    return ""


def _artifact_size_mb(artifact: Path) -> float:
    """Size of a plugin on disk, the whole bundle, or the single module file."""
    try:
        if artifact.is_dir():
            total = sum(f.stat().st_size for f in artifact.rglob("*") if f.is_file())
        else:
            total = artifact.stat().st_size
    except OSError:
        return 0.0
    return round(total / (1024 * 1024), 1)


def scan_vst3_directories(extra_paths: list[str] | None = None) -> list[Vst3PluginInfo]:
    """Scan all standard (and optional extra) VST3 directories.

    Emits exactly one entry per plugin: a bundle contributes its inner module
    (the only path a host can load) under the bundle's display name, and the
    bundle's own directory is not emitted separately.
    """
    search_dirs = _default_vst3_dirs()
    if extra_paths:
        for p in extra_paths:
            candidate = Path(p)
            if candidate.is_dir():
                search_dirs.append(candidate)
    plugins: list[Vst3PluginInfo] = []
    seen: set[str] = set()
    for search_dir in search_dirs:
        try:
            for item in search_dir.rglob("*.vst3"):
                bundle = _bundle_root(item)
                if bundle is not None and bundle.is_relative_to(search_dir):
                    # Reached from inside a bundle this same scan already emits
                    # under its own name; skipping it keeps the dead twin out.
                    continue
                artifact = item
                if item.is_dir():
                    binary = _resolve_bundle_binary(item)
                    manufacturer, version, category = _read_moduleinfo(item)
                else:
                    binary = item
                    manufacturer, version, category = "", "", ""
                load_path = binary if binary is not None else item
                abs_path = str(load_path.resolve())
                if abs_path in seen:
                    continue
                seen.add(abs_path)
                try:
                    last_mod = artifact.stat().st_mtime
                except OSError:
                    last_mod = 0.0
                plugins.append(
                    Vst3PluginInfo(
                        name=item.stem,
                        path=abs_path,
                        manufacturer=manufacturer,
                        version=version,
                        category=category or "unknown",
                        file_size_mb=_artifact_size_mb(artifact),
                        last_modified=last_mod,
                        # No supported architecture inside the bundle: the host
                        # would fail on load, so say so up front.
                        loadable=binary is not None,
                    )
                )
        except PermissionError:
            log.warning("Permission denied scanning VST3 dir: %s", search_dir)
        except Exception as e:
            log.warning("Error scanning VST3 dir %s: %s", search_dir, e)
    plugins.sort(key=lambda p: p.name.lower())
    return plugins


# --- Metadata enrichment ---
#
# Most plugins ship no moduleinfo.json, so vendor/version/category are only
# available from the plugin itself. Opening one can take seconds, hang, or crash
# the process outright, so each probe runs in a short-lived subprocess with a
# timeout: the server survives a bad plugin, and the answer is cached forever.

_PROBE_TIMEOUT_S = 25.0
_MAX_PROBE_TIMEOUTS = 3
# How much probing the background worker does between cache writes.
_ENRICH_CHUNK_S = 60.0


def probe_plugin(path: str) -> dict:
    """Load one plugin and report its metadata. Runs in the probe subprocess."""
    import pedalboard

    from backend.modules.vst.host import load_plugin_file

    plugin = load_plugin_file(pedalboard, path)
    category = _normalize_category(getattr(plugin, "category", "") or "")
    if not category:
        category = "instrument" if getattr(plugin, "is_instrument", False) else "effect"
    return {
        "manufacturer": getattr(plugin, "manufacturer_name", "") or "",
        "version": getattr(plugin, "version", "") or "",
        "category": category,
    }


def _probe_subprocess(path: str, timeout_s: float) -> tuple[str, dict | None]:
    """Probe one plugin out-of-process.

    Returns ``("ok", metadata)``, ``("failed", None)`` when the host genuinely
    could not load it, or ``("timeout", None)`` when it was merely too slow
    slow is not the same as broken, so the caller must not condemn it.
    """
    cmd = [sys.executable, "-m", "backend.modules.vst.scanner", "--probe", path]
    repo_root = Path(__file__).resolve().parents[3]
    # No console flash when the server itself was launched from a GUI shell.
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(repo_root),
            capture_output=True,
            timeout=timeout_s,
            text=True,
            creationflags=flags,
        )
    except subprocess.TimeoutExpired:
        log.info("VST3 metadata probe timed out after %.0fs: %s", timeout_s, path)
        return "timeout", None
    except Exception as e:
        log.debug("VST3 metadata probe could not run for %s: %s", path, e)
        return "timeout", None
    if proc.returncode != 0:
        log.debug("VST3 metadata probe failed for %s: %s", path, proc.stderr[-200:])
        return "failed", None
    try:
        return "ok", json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return "failed", None


def enrich_plugin_metadata(
    plugins: list[Vst3PluginInfo],
    budget_s: float = 10.0,
    timeout_s: float = _PROBE_TIMEOUT_S,
) -> int:
    """Fill in vendor/version/category for unprobed entries, within a time budget.

    Mutates ``plugins`` in place and returns how many probes were attempted, so a
    caller can keep going until it returns 0. The budget bounds one pass; every
    result is recorded on the entry, so the work resumes where it left off.
    """
    if budget_s <= 0:
        return 0
    deadline = time.monotonic() + budget_s
    probed = 0
    for info in plugins:
        if info.probed or not info.loadable:
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        # One hung plugin must not overrun the caller's budget, so its probe is
        # cut short at whatever is left of it.
        effective = min(timeout_s, remaining)
        status, meta = _probe_subprocess(info.path, effective)
        probed += 1
        if status == "timeout":
            # A slow loader (large sample or model payload) deserves another
            # attempt rather than a permanent verdict, but not an unbounded one:
            # after a few tries it stays listed with unknown metadata. A probe cut
            # short by the budget never had its chance, so it does not count.
            if effective >= timeout_s:
                info.probe_timeouts += 1
                if info.probe_timeouts >= _MAX_PROBE_TIMEOUTS:
                    info.probed = True
            continue
        info.probed = True
        if meta is None:
            info.loadable = False
            continue
        info.manufacturer = info.manufacturer or meta.get("manufacturer", "")
        info.version = info.version or meta.get("version", "")
        if info.category in ("", "unknown"):
            info.category = meta.get("category", "unknown") or "unknown"
    return probed


_enrich_lock = threading.Lock()
_enrich_running = False


def enrichment_running() -> bool:
    return _enrich_running


def start_background_enrichment(plugins: list[Vst3PluginInfo]) -> bool:
    """Probe the still-unknown plugins on a worker thread, updating the cache.

    A full pass costs minutes because some plugins take seconds to open and at
    least one never finishes, so it cannot sit inside a scan request. The worker
    takes its own copy, saves after each chunk (progress survives a shutdown),
    and the next scan serves the enriched cache. Returns False when one is
    already running.
    """
    global _enrich_running
    if not any(not p.probed and p.loadable for p in plugins):
        return False
    with _enrich_lock:
        if _enrich_running:
            return False
        _enrich_running = True
    worker = threading.Thread(
        target=_enrich_worker,
        args=(copy.deepcopy(plugins),),
        name="vst3-metadata-enrichment",
        daemon=True,
    )
    worker.start()
    return True


def _publish_enrichment(plugins: list[Vst3PluginInfo]) -> None:
    """Merge probe results into the cache as it stands now.

    The worker holds a snapshot taken minutes ago; a rescan may have replaced
    the cache since (a plugin was installed), and writing the snapshot straight
    back would erase it.
    """
    current = read_cache_entries()
    if not current:
        save_scan_cache(plugins)
        return
    carry_over_metadata(current, plugins)
    save_scan_cache(current)


def _enrich_worker(plugins: list[Vst3PluginInfo]) -> None:
    global _enrich_running
    try:
        while enrich_plugin_metadata(plugins, budget_s=_ENRICH_CHUNK_S):
            _publish_enrichment(plugins)
        _publish_enrichment(plugins)
        log.info("VST3 metadata enrichment finished for %d plugins", len(plugins))
    except Exception as e:
        log.warning("VST3 metadata enrichment stopped: %s", e)
    finally:
        with _enrich_lock:
            _enrich_running = False


def carry_over_metadata(
    plugins: list[Vst3PluginInfo],
    previous: list[Vst3PluginInfo] | None,
    retry_failed: bool = False,
) -> None:
    """Copy probe results from an earlier scan onto matching fresh entries.

    A rescan must not throw away minutes of probing, so anything whose path and
    mtime are unchanged keeps the metadata already established for it.
    ``retry_failed`` drops the remembered verdict for plugins that failed to
    load, which is what makes an explicit refresh a way out of a bad probe.
    """
    if not previous:
        return
    by_path = {p.path: p for p in previous}
    for info in plugins:
        old = by_path.get(info.path)
        if old is None or old.last_modified != info.last_modified:
            continue
        if retry_failed and not old.loadable:
            continue
        info.probe_timeouts = old.probe_timeouts
        if not old.probed:
            continue
        info.probed = True
        info.loadable = info.loadable and old.loadable
        info.manufacturer = info.manufacturer or old.manufacturer
        info.version = info.version or old.version
        if info.category in ("", "unknown"):
            info.category = old.category


# --- Scan result cache ---
_CACHE_FILENAME = "vst3_scan_cache.json"
# Bumped whenever the scan changes shape, so an older cache is discarded rather
# than served (v2: one entry per plugin instead of bundle + inner-binary twins).
_CACHE_VERSION = 2


def _cache_path() -> Path:
    return Path(__file__).parent / _CACHE_FILENAME


def scan_roots_signature() -> str:
    """Fingerprint of the scan roots, so a new install invalidates the cache.

    Covers each root's mtime plus its immediate subdirectories, because vendors
    install into a subfolder (VST3/Vendor/Plugin.vst3) which leaves the root's
    own mtime untouched.
    """
    parts: list[str] = []
    for root in _default_vst3_dirs():
        try:
            parts.append(f"{root}:{root.stat().st_mtime_ns}")
            for child in sorted(root.iterdir()):
                if child.is_dir() and child.suffix.lower() != ".vst3":
                    parts.append(f"{child.name}:{child.stat().st_mtime_ns}")
        except OSError:
            parts.append(f"{root}:missing")
    return "|".join(parts)


def load_cached_scan() -> list[Vst3PluginInfo] | None:
    """Cached scan results, or None when absent, stale, empty, or unreadable."""
    cp = _cache_path()
    if not cp.is_file():
        return None
    try:
        data = json.loads(cp.read_text(encoding="utf-8"))
    except Exception as e:
        log.debug("VST3 scan cache unreadable: %s", e)
        return None
    if data.get("cache_version") != _CACHE_VERSION:
        log.info("VST3 scan cache version changed, rescanning")
        return None
    if data.get("roots_signature") != scan_roots_signature():
        log.info("VST3 directories changed since last scan, rescanning")
        return None
    known = {f.name for f in fields(Vst3PluginInfo)}
    try:
        plugins = [
            Vst3PluginInfo(**{k: v for k, v in p.items() if k in known})
            for p in data.get("plugins", [])
        ]
    except Exception as e:
        log.debug("VST3 scan cache entries unreadable: %s", e)
        return None
    # An empty cache is never authoritative: a failed or interrupted scan must
    # not hide every plugin on the machine until someone forces a refresh.
    return plugins or None


def read_cache_entries() -> list[Vst3PluginInfo]:
    """Cached entries regardless of staleness, for carrying metadata forward."""
    cp = _cache_path()
    if not cp.is_file():
        return []
    try:
        data = json.loads(cp.read_text(encoding="utf-8"))
        known = {f.name for f in fields(Vst3PluginInfo)}
        return [
            Vst3PluginInfo(**{k: v for k, v in p.items() if k in known})
            for p in data.get("plugins", [])
        ]
    except Exception:
        return []


def save_scan_cache(plugins: list[Vst3PluginInfo]) -> None:
    cp = _cache_path()
    try:
        cp.write_text(
            json.dumps(
                {
                    "cache_version": _CACHE_VERSION,
                    "scanned_at": time.time(),
                    "roots_signature": scan_roots_signature(),
                    "plugins": [asdict(p) for p in plugins],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as e:
        log.warning("Failed to save VST3 scan cache: %s", e)


def _main() -> int:
    """Probe entry point: ``python -m backend.modules.vst.scanner --probe PATH``."""
    if len(sys.argv) != 3 or sys.argv[1] != "--probe":
        print("usage: python -m backend.modules.vst.scanner --probe PATH", flush=True)
        return 2
    try:
        print(json.dumps(probe_plugin(sys.argv[2])), flush=True)
    except Exception as e:
        print(f"probe failed: {e}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main())
