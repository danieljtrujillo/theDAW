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
from backend.lib.launch_token import child_env

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
    # ``probed`` is set once the plugin has been loaded out-of-process through
    # pedalboard, the host every plugin the server itself loads goes through
    # (an effect chain, a MIDI print), or has run out of tries at that.
    # ``loadable`` False means that load failed or killed the process (wrong
    # architecture, broken install, an access violation) and it must not be
    # offered as a usable plugin.
    loadable: bool = True
    probed: bool = False
    probe_timeouts: int = 0
    # The plugin's OWN name and VST3 identifier, read from the module's factory
    # by ``thedaw-vst-host --list`` (the 32-hex class id), or from the loaded
    # plugin by ``probe_plugin`` where the host cannot list it. ``name`` above
    # is only the bundle/file stem — the host library's filename, which is
    # often not what the vendor calls the plugin ("FabFilter Pro-Q 4.vst3" vs
    # "Pro-Q 4"), and for a multi-plugin shell is not a plugin name at all.
    # Empty until one of those lands (and for a plugin that never loads), so
    # every consumer falls back to ``name``.
    display_name: str = ""
    identifier: str = ""
    # Set once theDAW's native host has listed the module's classes: the
    # category, vendor, version, name and class id above then come from the
    # module's factory, read without instantiating anything. It says what the
    # plugin is; only the load above says whether the server can host it.
    listed: bool = False


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
# Most plugins ship no moduleinfo.json, so vendor/version/category come from
# the plugin's module. theDAW's own host reads them from the module's factory
# (``thedaw-vst-host --list``): it loads the library and asks the factory for
# its class info without creating an instance of any class, which takes well
# under a second even for a synth whose full load runs past half a minute.
# Where the host is not built or cannot list the module, the plugin's full
# load through pedalboard classifies it instead.
#
# That full load runs for every plugin all the same, listed or not, because
# it answers a second question the listing cannot: whether pedalboard, which
# hosts every plugin the server loads in its own process, survives it.
# MT-PowerDrumKit lists cleanly and kills pedalboard with an access violation
# on load; offered, it would take the server down on its first bounce. A load
# that outlasts its timeout changes nothing the listing said. Both run in a
# short-lived subprocess with a timeout: the server survives a bad plugin, and
# the answer is cached.

_PROBE_TIMEOUT_S = 25.0
_MAX_PROBE_TIMEOUTS = 3
# How much probing the background worker does between cache writes.
_ENRICH_CHUNK_S = 60.0
# One module's class listing. Reading a factory is a library load and a few
# calls; a module that has not answered in this long is blocked in its own
# entry point (a licence dialog, a network check) and goes to the load probe.
_LIST_TIMEOUT_S = 10.0
# How long a scan request may spend listing modules before it answers. 46
# modules listed in 5.0 s on the machine this was measured on (2026-09-29);
# what is left over when it runs out goes to the background worker, which
# lists before it loads too.
_SCAN_LIST_BUDGET_S = 20.0


def _host_command() -> list[str] | None:
    """The argv prefix that runs theDAW's native VST host, or None when it is
    not built.

    Found the way the live host finds it (``live_host.HostLocator``):
    ``THEDAW_VST_HOST`` first, then ``native/vst-host/bin``. Imported here,
    not at the top: ``live_host`` imports ``path_policy``, which imports this
    module.
    """
    from backend.modules.vst.live_host import HostLocator

    locator = HostLocator()
    host = locator.resolve()
    return None if host is None else locator.launch_prefix(host)


def _parse_class_listing(stdout: str) -> list[dict]:
    """The class array ``--list`` printed, or [] when there is none.

    The host prints one JSON array line, but the module it loads can print too
    (Six Sines logs "Initializing Six Sines ..." from its entry point, before
    the listing), and a line printed without a newline runs into the array.
    So the last line holding a JSON array that runs to the end of the line is
    the listing. An empty array means the module has no audio class, which
    classifies nothing.
    """
    decoder = json.JSONDecoder()
    for line in reversed((stdout or "").splitlines()):
        text = line.strip()
        start = text.find("[")
        while start != -1:
            try:
                value, end = decoder.raw_decode(text, start)
            except ValueError:
                value, end = None, start
            if isinstance(value, list) and not text[end:].strip():
                return [c for c in value if isinstance(c, dict)]
            start = text.find("[", start + 1)
    return []


def _list_subprocess(
    host: list[str], path: str, timeout_s: float
) -> tuple[str, list[dict] | None]:
    """List one module's classes through the native host.

    Returns ``("ok", classes)``, ``("failed", None)`` when the host ran and
    could not list it (exit 3 missing, 4 load failed, a stub host built
    without its VST3 layer, no audio class), or ``("timeout", None)``.
    """
    cmd = [*host, "--list", "--plugin", path]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=timeout_s,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
            env=child_env(),
        )
    except subprocess.TimeoutExpired:
        log.info("VST3 class listing timed out after %.0fs: %s", timeout_s, path)
        return "timeout", None
    except OSError as e:
        log.info("VST3 class listing could not run for %s: %s", path, e)
        return "failed", None
    classes = _parse_class_listing(proc.stdout) if proc.returncode == 0 else []
    if not classes:
        log.info(
            "VST3 class listing failed for %s (exit %s): %s",
            path,
            proc.returncode,
            (proc.stderr or "").strip()[-200:],
        )
        return "failed", None
    return "ok", classes


def _metadata_from_classes(classes: list[dict]) -> dict:
    """An entry's metadata from its module's audio classes, in the probe's shape.

    A module can hold several classes: Six Sines ships "Six Sines" and "Six
    Sines, Seven Outs", sfizz ships "sfizz" and "sfizz-multi". The entry
    describes the first one. It is the class every loader here opens when no
    class is named (pedalboard's first sub-plugin, the native host's first
    audio class), and its name is what the instrument slot and the effect
    chain hand back as ``plugin_name``, so its category is the one the entry
    has to carry. A class whose sub-categories name neither "Instrument" nor
    "Fx" is an effect, as it is to the load probe.
    """
    first = classes[0]
    return {
        "display_name": str(first.get("name") or ""),
        "identifier": str(first.get("identifier") or ""),
        "manufacturer": str(first.get("vendor") or ""),
        "version": str(first.get("version") or ""),
        "category": _normalize_category(str(first.get("category") or "")) or "effect",
    }


def _fill_metadata(info: Vst3PluginInfo, meta: dict) -> None:
    """Write a listing's or a probe's metadata onto the entry.

    What the entry already knows (moduleinfo.json, an earlier listing) stays;
    only gaps fill. Whether the entry is ``listed`` or ``probed`` is the
    caller's to record.
    """
    info.display_name = info.display_name or meta.get("display_name", "")
    info.identifier = info.identifier or meta.get("identifier", "")
    info.manufacturer = info.manufacturer or meta.get("manufacturer", "")
    info.version = info.version or meta.get("version", "")
    if info.category in ("", "unknown"):
        info.category = meta.get("category", "unknown") or "unknown"


def probe_plugin(path: str) -> dict:
    """Load one plugin and report its metadata. Runs in the probe subprocess."""
    import pedalboard

    from backend.modules.vst.host import load_plugin_file

    plugin = load_plugin_file(pedalboard, path)
    category = _normalize_category(getattr(plugin, "category", "") or "")
    if not category:
        category = "instrument" if getattr(plugin, "is_instrument", False) else "effect"
    return {
        # The plugin's own name and identifier, which no filesystem scan can
        # know. Every value is coerced to a string so a plugin that reports
        # None (or nothing) yields "" rather than a null in the cache/API.
        "display_name": str(getattr(plugin, "name", "") or ""),
        "identifier": str(getattr(plugin, "identifier", "") or ""),
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
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
            env=child_env(),
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
    *,
    list_only: bool = False,
    list_failed: set[str] | None = None,
) -> int:
    """Classify and load-check the entries not yet probed, within a time budget.

    Each entry is listed through the native host first, which says what it is
    (instrument or effect, vendor, version, name), and then loaded through the
    pedalboard probe, which says whether the server can host it and classifies
    whatever the host could not list. ``list_only`` stops after the listing,
    for a caller that must answer quickly (a scan request): the loads, and
    every entry the host could not list, are left for the worker.
    ``list_failed`` holds the paths the host already failed to list; pass the
    same set across calls so a module that hangs in its entry point costs the
    listing timeout once, not once per round of load probes.

    Mutates ``plugins`` in place and returns how many entries it worked on, so
    a caller can keep going until it returns 0. The budget bounds one pass;
    every result is recorded on the entry, so the work resumes where it left
    off.
    """
    if budget_s <= 0:
        return 0
    deadline = time.monotonic() + budget_s
    host = _host_command()
    failed = list_failed if list_failed is not None else set()
    worked = 0
    for info in plugins:
        if info.probed or not info.loadable:
            continue
        listable = host is not None and not info.listed and info.path not in failed
        if list_only and not listable:
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        worked += 1
        if listable:
            effective = min(_LIST_TIMEOUT_S, remaining)
            status, classes = _list_subprocess(host, info.path, effective)
            if status == "ok" and classes:
                _fill_metadata(info, _metadata_from_classes(classes))
                info.listed = True
            # A listing cut short by the budget never had its chance, so it is
            # tried again on the next pass rather than written off.
            elif status == "failed" or effective >= _LIST_TIMEOUT_S:
                failed.add(info.path)
            if list_only:
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
        # One hung plugin must not overrun the caller's budget, so its probe is
        # cut short at whatever is left of it.
        effective = min(timeout_s, remaining)
        status, meta = _probe_subprocess(info.path, effective)
        if status == "timeout":
            # A slow loader (large sample or model payload) deserves another
            # attempt rather than a permanent verdict, but not an unbounded one:
            # after a few tries it stays offered, with what its listing said or
            # unknown metadata, until a rescan. A probe cut short by the budget
            # never had its chance, so it does not count.
            if effective >= timeout_s:
                info.probe_timeouts += 1
                if info.probe_timeouts >= _MAX_PROBE_TIMEOUTS:
                    info.probed = True
            continue
        info.probed = True
        if meta is None:
            # It failed to load, or killed the probe: listed or not, the server
            # must not load it in its own process.
            info.loadable = False
            continue
        _fill_metadata(info, meta)
    return worked


def list_plugin_classes(
    plugins: list[Vst3PluginInfo], budget_s: float = _SCAN_LIST_BUDGET_S
) -> int:
    """Classify the unlisted entries through the native host, within a budget.

    Short enough to sit inside a scan request, so the list the user opens
    already says which plugins are instruments. Loads nothing through
    pedalboard; the loads, and whatever the host cannot list, are left for
    the background worker. Returns how many modules were classified.
    """
    before = sum(1 for p in plugins if p.listed)
    started = time.monotonic()
    enrich_plugin_metadata(plugins, budget_s=budget_s, list_only=True)
    listed = sum(1 for p in plugins if p.listed) - before
    if listed:
        log.info(
            "Listed %d VST3 module(s) through thedaw-vst-host in %.1fs",
            listed,
            time.monotonic() - started,
        )
    left = sum(1 for p in plugins if not p.listed and not p.probed and p.loadable)
    if left:
        log.info("%d VST3 module(s) left for the load probe to classify", left)
    return listed


_enrich_lock = threading.Lock()
_enrich_running = False
# Held for every write of the cache by a scan request and for each of the
# worker's read-merge-write publishes, so neither lands inside the other.
_cache_lock = threading.Lock()
# Counts the user's rescans. A worker notes it when it takes its list; a rescan
# after that dropped verdicts on purpose (a failed load, a plugin out of load
# probes) that the worker's list still holds.
_rescan_serial = 0


def enrichment_running() -> bool:
    return _enrich_running


def save_scan(plugins: list[Vst3PluginInfo], *, rescan: bool = False) -> None:
    """Write a scan request's list as the cache; ``rescan`` for ``refresh=true``.

    A rescan is counted in the same step as its write, so a worker that took
    its list before it publishes afterwards without writing back what the
    rescan dropped (``_publish_enrichment``).
    """
    global _rescan_serial
    with _cache_lock:
        save_scan_cache(plugins)
        if rescan:
            _rescan_serial += 1


def start_background_enrichment(plugins: list[Vst3PluginInfo]) -> bool:
    """Load-probe the plugins not yet probed on a worker thread, updating the cache.

    What is left after a scan's class listing (``list_plugin_classes``) is the
    load of every new plugin, which says whether the server can host it, and
    the classification of any module the host could not list, or of every
    module when the host is not built. Loading through pedalboard costs
    seconds each, up to the probe's timeout for one that never finishes, so it
    cannot sit inside a scan request. The worker takes its own copy, saves
    after each chunk (progress survives a shutdown), and the next scan serves
    the enriched cache. Returns False when one is already running; a rescan
    that finds one running is taken up by it (``_enrich_worker``).
    """
    global _enrich_running
    if not any(not p.probed and p.loadable for p in plugins):
        return False
    with _enrich_lock:
        if _enrich_running:
            return False
        _enrich_running = True
        serial = _rescan_serial
    worker = threading.Thread(
        target=_enrich_worker,
        args=(copy.deepcopy(plugins), serial),
        name="vst3-metadata-enrichment",
        daemon=True,
    )
    worker.start()
    return True


def _publish_enrichment(plugins: list[Vst3PluginInfo], serial: int) -> None:
    """Merge probe results into the cache as it stands now.

    The worker holds a snapshot taken minutes ago; a rescan may have replaced
    the cache since (a plugin was installed), and writing the snapshot straight
    back would erase it. When a rescan came after the snapshot (``serial`` is
    the rescan count the worker's list was taken at), only what loaded is
    carried: the rescan dropped the failures and the timeouts on purpose, to
    give those plugins a fresh chance, and the snapshot still holds them.
    """
    with _cache_lock:
        superseded = serial != _rescan_serial
        current = read_cache_entries()
        if not current:
            if not superseded:
                save_scan_cache(plugins)
            return
        carry_over_metadata(current, plugins, retry_failed=superseded)
        save_scan_cache(current)


def _enrich_worker(plugins: list[Vst3PluginInfo], serial: int) -> None:
    """Enrich ``plugins``, taken at rescan count ``serial``, then any list a
    rescan saved while this ran: that rescan found this worker running and
    started none, so the plugins it gave a fresh chance get it here."""
    global _enrich_running
    list_failed: set[str] = set()
    try:
        while True:
            while enrich_plugin_metadata(
                plugins, budget_s=_ENRICH_CHUNK_S, list_failed=list_failed
            ):
                _publish_enrichment(plugins, serial)
            _publish_enrichment(plugins, serial)
            with _enrich_lock:
                if serial == _rescan_serial:
                    _enrich_running = False
                    break
                serial = _rescan_serial
            with _cache_lock:
                plugins = read_cache_entries()
            list_failed = set()
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
    """Copy listing and probe results from an earlier scan onto matching fresh
    entries.

    A rescan must not throw away minutes of probing, so anything whose path and
    mtime are unchanged keeps the metadata already established for it: a
    listing's, even while its load probe is still to come, and a load probe's.

    ``retry_failed`` is the user's rescan (``refresh=true``), the way out of a
    bad verdict. It drops the remembered verdict for plugins that failed to
    load and for plugins that only ran out of load-probe timeouts, and it
    carries no timeout count, so each of those is listed and probed again
    from scratch. A scan that is not a rescan keeps the count, which is what
    bounds the load probes a slow plugin costs. A worker's publish that a
    rescan came after passes it too, so it carries only what loaded.
    """
    if not previous:
        return
    by_path = {p.path: p for p in previous}
    for info in plugins:
        old = by_path.get(info.path)
        if old is None or old.last_modified != info.last_modified:
            continue
        if retry_failed:
            timed_out = old.probed and old.probe_timeouts >= _MAX_PROBE_TIMEOUTS
            if not old.loadable or timed_out:
                continue
        else:
            info.probe_timeouts = old.probe_timeouts
        if not (old.probed or old.listed):
            continue
        info.probed = info.probed or old.probed
        info.listed = info.listed or old.listed
        info.loadable = info.loadable and old.loadable
        info.display_name = info.display_name or old.display_name
        info.identifier = info.identifier or old.identifier
        info.manufacturer = info.manufacturer or old.manufacturer
        info.version = info.version or old.version
        if info.category in ("", "unknown"):
            info.category = old.category


# --- Scan result cache ---
_CACHE_FILENAME = "vst3_scan_cache.json"
# Bumped whenever the scan changes shape, so an older cache is discarded rather
# than served, and its entries are not carried into the new scan either
# (``read_cache_entries``): v2: one entry per plugin instead of bundle +
# inner-binary twins; v3: the probe also records display_name/identifier — a v2
# entry carries probed=True, so without the bump it would never be probed again
# and every name would stay stuck at the filename stem; v4: entries are
# classified by the native host's class listing — a v3 entry that ran out of
# load-probe timeouts is probed=True with category "unknown", so a synth whose
# load outlasts the probe (Surge XT, Zebralette 3, Six Sines) would never reach
# the instrument slot; v5: a listed entry records ``listed`` and is still load-
# probed for ``loadable`` — a v4 entry was marked probed by its listing alone,
# so a plugin that kills pedalboard on load (MT-PowerDrumKit) was offered as
# loadable for good.
_CACHE_VERSION = 5


def _cache_path() -> Path:
    return Path(__file__).parent / _CACHE_FILENAME


def _log_walk_error(error: OSError) -> None:
    """``Path.walk``'s ``on_error`` callback: a directory ``scandir`` could
    not read (permissions, a removed drive mid-walk) — the old ``rglob``
    version let this surface as an ``OSError`` the caller's own ``try/except``
    caught; ``Path.walk`` instead silently skips the unreadable subtree
    unless given a callback, which would have dropped it from the signature
    with no record anywhere that anything was missed."""
    log.warning("VST3 scan-signature walk could not read %s: %s", error.filename, error)


def _dir_identity(path: Path) -> tuple[int, int] | None:
    """``(st_dev, st_ino)`` for a directory, following reparse points the way
    ``os.stat`` always does.

    ``Path.is_symlink()`` is False for a Windows directory junction, so
    ``Path.walk(follow_symlinks=False)`` does not prune one, and a junction
    that points back at an ancestor directory (or another already-visited
    one) turns the walk into unbounded recursion. ``os.stat`` follows a
    junction like any other directory and reports the REAL target's
    identity, so a directory reached a second time via such a cycle can be
    recognised and skipped. Returns None when the directory cannot be
    stat'd (removed mid-walk, permissions) — left for ``scandir``/
    ``_log_walk_error`` to skip on its own.
    """
    try:
        st = path.stat()
    except OSError:
        return None
    if st.st_ino == 0:
        # A filesystem that reports st_ino == 0 for every entry would let the
        # first subdirectory poison `visited` and prune every later sibling,
        # silently losing real plugins -- None already means "no identity, do
        # not prune".
        return None
    return (st.st_dev, st.st_ino)


def _walk_vst3_paths(root: Path) -> list[Path]:
    """Every ``.vst3`` bundle directory or standalone file under ``root``,
    never descending into a bundle once one is found.

    ``root.rglob("*.vst3")`` cannot express that: a bundle is a directory
    ending in ``.vst3`` that itself CONTAINS a same-suffixed module
    (``Contents/<arch>/Plugin.vst3`` on Windows/Linux — see
    ``_resolve_bundle_binary``), so the pattern matches the bundle AND that
    inner module, double-counting every plugin — and to find the second match
    it still has to walk the bundle's whole resource tree (icons, presets,
    ``moduleinfo.json``; hundreds of files for some vendors' bundles), which
    is pure waste when all this signature needs is "has this plugin's
    directory entry been added, replaced, or removed". Pruned here with
    ``Path.walk``'s own ``dirnames`` mutation, which stops the walk there
    instead. Measured on a synthetic tree of 150 bundles (20 resource files
    each, matching a real commercial VST3's rough shape): ``rglob`` took ~93
    ms/call and produced 301 signature entries (150 doubled, plus the root);
    this walk took ~6 ms/call and produced the correct 151 — roughly 16-40x
    faster depending on the tree (a T03 audit independently re-measured this
    exact change at 39.7x), for the identical VST-003 nested-install
    coverage.

    Trade-off this pruning makes, on top of what the old code already missed:
    the bundle DIRECTORY's own mtime does not change when a file already
    inside it is overwritten in place — only when a direct child is added,
    removed, or renamed. An in-place vendor upgrade that replaces
    ``Contents/<arch>/Plugin.vst3`` without touching the bundle folder itself
    is therefore invisible to this signature (not a regression: the pre-VST-003
    code never covered it either, since it only fingerprinted the *vendor*
    folder's mtime, one level higher). ``refresh=true`` on ``/api/vst/scan``
    is the way out for that case — it forces a fresh walk regardless of what
    the cached signature says.

    Also prunes a directory whose identity (``st_dev``/``st_ino``, which
    ``os.stat`` reports for the REAL target of a Windows junction) was
    already visited earlier in this same walk — a junction cycling back to
    an ancestor directory would otherwise recurse without bound, since
    ``Path.walk(follow_symlinks=False)`` does not treat a junction as a
    symlink and so never prunes it on its own (see ``_dir_identity``).
    """
    found: list[Path] = []
    visited: set[tuple[int, int]] = set()
    root_id = _dir_identity(root)
    if root_id is not None:
        visited.add(root_id)
    for dirpath, dirnames, filenames in root.walk(
        top_down=True, on_error=_log_walk_error
    ):
        kept: list[str] = []
        for name in dirnames:
            if name.lower().endswith(".vst3"):
                found.append(dirpath / name)
                continue
            sub_id = _dir_identity(dirpath / name)
            if sub_id is not None:
                if sub_id in visited:
                    # Already walked this directory once in this scan (a
                    # junction/reparse point cycling back to an ancestor) —
                    # descending into it again would recurse without bound.
                    continue
                visited.add(sub_id)
            kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            if name.lower().endswith(".vst3"):
                found.append(dirpath / name)
    return found


def scan_roots_signature() -> str:
    """Fingerprint of the scan roots, so a new install invalidates the cache.

    Covers each root's own mtime plus every ``.vst3`` bundle under it, at any
    nesting depth (VST-003) — vendors install into a subfolder
    (``VST3/Vendor/Plugin.vst3``, sometimes nested another level under a
    product-line folder), and neither the vendor folder's mtime nor the
    root's own mtime changes when only a bundle further down is added,
    replaced or removed. Walking every ``.vst3`` bundle directly, the same
    way ``scan_vst3_directories`` enumerates them, is the only way the
    signature sees a change at any depth.
    """
    parts: list[str] = []
    for root in _default_vst3_dirs():
        try:
            parts.append(f"{root}:{root.stat().st_mtime_ns}")
        except OSError:
            parts.append(f"{root}:missing")
            continue
        for bundle in sorted(_walk_vst3_paths(root)):
            try:
                parts.append(f"{bundle}:{bundle.stat().st_mtime_ns}")
            except OSError:
                continue
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
    """Cached entries regardless of staleness, for carrying metadata forward.

    Only from a cache this version of the scanner wrote: an older one's
    verdicts came from a scan that has since changed (see ``_CACHE_VERSION``),
    and carrying them forward would serve them again under the new version.
    """
    cp = _cache_path()
    if not cp.is_file():
        return []
    try:
        data = json.loads(cp.read_text(encoding="utf-8"))
        if data.get("cache_version") != _CACHE_VERSION:
            return []
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
