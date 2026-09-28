"""Manage the Lyria 3 Pro Express server as a theDAW sidecar.

The Lyria project is its own repo (``StarskreamEXE/lyria-3-pro``), discovered
relative to this app or overridable via ``theDAW_LYRIA_PROJECT``. theDAW
embeds it whole: its frontend is served by its own Express server and is
kept as-is, per the integration constraint. We spawn it, we don't rebuild it.

WHY THERE IS NO STATIC MODE (the key difference from vj/sidecar.py):
the VJ app is a pure static SPA, so its compiled ``dist/`` IS the whole app
and the backend can serve it with no Node process. Lyria is not: its Express
server answers ``/api/ai/*``, ``/api/lyria/generate``, ``/api/generations``,
and mounts ``/generations`` static. The server is load-bearing, so the Node
process must always run. This module is therefore modeled on VJ's dev-mode
branch only.

The port (5188) deliberately avoids every port already in play:
  * 3000 is the user's explicit "never use this" — too many collisions.
  * 3001 is Lyria's own standalone default, and is NOT safe here: VS Code
    binds it on IPv6 (``::``) on at least one dev machine, and because
    Windows resolves ``localhost`` to ``::1`` first, every request silently
    times out against the squatter while Lyria sits healthy on IPv4.
  * 5173 is the theDAW frontend; 5174 is Vite's next-port fallback.
  * 5187 is the VJ sidecar.
  * 8600 is the theDAW backend; 5472 is in use elsewhere.
  * 5188 sits beside VJ's port, out of the way of all of the above.

Override with ``theDAW_LYRIA_PORT``.

COST SAFETY: every real Lyria 3 Pro generation costs $0.08 and every clip
$0.04, on the user's own key, with no seed and no reproducibility. This
sidecar therefore injects ``LYRIA_MOCK=1`` BY DEFAULT, which makes the child
synthesize a local WAV instead of calling either paid provider. Real spending
requires an explicit opt-in via ``theDAW_LYRIA_MOCK=0``. A mis-click in MAKE
costs nothing for SA3 or Magenta (both local); here it would cost money, so
the default is the safe one.

Lifecycle:
  * ``probe()`` -- does the project exist? Is the port listening? Are we
    in mock mode? Non-spawning; safe for /status.
  * ``ensure_running()`` -- lazy spawn, returns the live URL or raises
    RuntimeError with a diagnostic.
  * ``stop()`` -- terminates the subprocess (registered in
    backend/core/teardown.py, or Shutdown/Restart orphans it on its port).
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import IO, Iterator, Optional
from backend.lib import paths
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)


# Repo root (.../stable-audio-3): backend/modules/lyria/sidecar.py -> parents[3].
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _lyria_project_candidates() -> list[Path]:
    """Portable search order for the Lyria project when theDAW_LYRIA_PROJECT
    is unset. Ordered from "bundled inside the app" to "dev checkout near
    this repo". Every entry derives from this file's location, so it resolves
    the same on any install. First candidate with a package.json wins; if none
    do, the first is used so diagnostics name a path local to THIS install."""
    return [
        _REPO_ROOT / "lyria",  # bundled checkout inside the app (release layout)
        _REPO_ROOT.parent / "lyria-3-pro",  # sibling of the repo
        _REPO_ROOT.parent.parent / "lyria-3-pro",  # nested dev layout
    ]


def _default_project_path() -> Path:
    candidates = _lyria_project_candidates()
    for c in candidates:
        if (c / "package.json").is_file():
            return c
    return candidates[0]


DEFAULT_PROJECT_PATH = _default_project_path()
DEFAULT_PORT = 5188
PORT_READY_TIMEOUT_SEC = 90.0
PORT_POLL_INTERVAL_SEC = 0.5
NPM_INSTALL_TIMEOUT_SEC = 600.0

# _terminate_proc's own wait() budget: taskkill/terminate, then (if that
# doesn't land within this) kill -- each phase waits up to this long for the
# process to actually exit.
_TERMINATE_WAIT_SEC = 5.0
# Worst case for a full _terminate_proc call: the first wait() times out
# (_TERMINATE_WAIT_SEC), THEN kill()'s wait() also has to complete
# (_TERMINATE_WAIT_SEC again) -- 2x, plus a small margin for the taskkill/
# terminate calls themselves. _wait_while_stopping and the adoption-race
# guard (item 1) both use this as their bound, so a truly slow teardown
# is never treated as "stopped()" giving up too early.
_STOPPING_WAIT_TIMEOUT_SEC = 2 * _TERMINATE_WAIT_SEC + 2.0

# Child-process output (npm install, the Express/tsx server) lands here so
# failures are diagnosable rather than vanishing into DEVNULL.
SIDECAR_LOG_PATH = paths.data_path("logs", "lyria-sidecar.log")

# The upstream project the sidecar embeds (module.json / the docstrings name
# it as StarskreamEXE/lyria-3-pro). ``start_install`` clones exactly this.
LYRIA_REPO = "StarskreamEXE/lyria-3-pro"
LYRIA_REPO_URL = f"https://github.com/{LYRIA_REPO}.git"
GIT_CLONE_TIMEOUT_SEC = 900.0

# The provider keys theDAW hands the child (see _child_env). Per provider the
# order is: the OS environment's value(s), then what was stored here (POST
# /api/lyria/key[s]), then the assistant's key pool, so a key pasted for the
# assistant serves Lyria too. EVERY key is passed, not just the first: the
# embedded app takes an ordered comma-separated list per provider and fails
# over from a rejected key (invalid, out of credit, or a quota wall) to the
# next one -- see its server/keys.ts. That matters because Google's free tier
# grants zero Lyria requests per day, so a lone Gemini key is often a dead end
# that the next key, or an OpenRouter key, recovers from.
#
# The file name still says "gemini" although its CONTENTS are now per-provider
# (see _read_store): .gitignore ignores exactly ``data/lyria_gemini_key.json``,
# and a renamed file of API keys would sit outside that entry until .gitignore
# is changed too. Not a trade worth making -- the shape is versioned instead.
_KEY_FILE = paths.data_path("lyria_gemini_key.json")
_KEY_FILE_VERSION = 2
# Copy of the pre-migration (single-Gemini) file, kept once, the first time the
# new shape is written over the old one. ``*.bak`` is already gitignored.
_KEY_FILE_BACKUP = _KEY_FILE.with_name(_KEY_FILE.name + ".bak")

# The providers theDAW can hand keys to. Both are the embedded app's own
# (server.ts reads GEMINI_API_KEY and OPENROUTER_API_KEY).
LYRIA_PROVIDERS: tuple[str, ...] = ("gemini", "openrouter")
_PROVIDER_ENV_VAR = {
    "gemini": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}
# key_pool pools that hold keys for each provider. "openrouter-free" is its own
# pool in backend/key_pool.py (PROVIDER_ENV_MAP) with its own entries, so it is
# folded in rather than assumed to be the same list as "openrouter".
_PROVIDER_POOLS = {
    "gemini": ("gemini",),
    "openrouter": ("openrouter", "openrouter-free"),
}
# Serializes the read-modify-write of the key file so two concurrent route
# handlers (add + remove, say) cannot lose one another's edit.
_key_file_lock = Lock()


@contextmanager
def _sidecar_log_handle() -> Iterator[IO[bytes] | int]:
    """Yield a child-stdout target: the sidecar log file, or DEVNULL when the
    file can't be opened (read-only disk). Closes the parent's handle on exit;
    a spawned child keeps its inherited copy."""
    handle: IO[bytes] | int = subprocess.DEVNULL
    try:
        SIDECAR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        handle = open(SIDECAR_LOG_PATH, "ab")
    except OSError:
        handle = subprocess.DEVNULL
    try:
        yield handle
    finally:
        if not isinstance(handle, int):
            try:
                handle.close()
            except OSError:
                pass


@dataclass
class LyriaConfig:
    project_path: Path
    port: int
    npm_path: str
    mock: bool


_state_lock = Lock()
# Serializes ensure_running()'s own "decide to spawn, then Popen" sequence
# against itself, so two concurrent ensure_running() callers don't both spawn
# a second Node process. Deliberately separate from _state_lock: the section
# it guards can take up to NPM_INSTALL_TIMEOUT_SEC (10 min) via _ensure_deps,
# and stop()/probe() -- which only need a quick read of _proc/_resolved_url --
# must never block behind it.
_run_lock = Lock()
# Serializes _ensure_deps' own critical section (node_modules re-check + the
# `npm install` call) -- acquired INSIDE _ensure_deps, not by its callers, so
# both callers (ensure_running(), which also holds _run_lock while it calls
# _ensure_deps, and _install_worker()/start_install()'s "Install" button path,
# which holds neither) are covered without two concurrent `npm install`s ever
# running in the same directory. A plain Lock is safe here specifically
# because _run_lock and _spawn_lock are different objects: ensure_running()
# holding _run_lock while _ensure_deps acquires _spawn_lock is not a
# self-deadlock.
_spawn_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
_resolved_url: Optional[str] = None
# Set by stop() under _state_lock; consumed by ensure_running() right before
# (and right after) it spawns a new child. A stop() that arrives while
# ensure_running() is mid-install or mid-Popen -- i.e. before _proc exists,
# so stop()'s own "_proc is None" early return has nothing to terminate --
# must still prevent that in-flight spawn from completing, or it orphans a
# Node process holding the port with nothing left tracking it.
_stop_requested = False
# .is_set() while stop() is actively tearing down the previous process (from
# just after _proc is cleared under _state_lock, until _terminate_proc's
# taskkill/wait or terminate/wait completes -- up to ~10s worst case).
# _proc going back to None happens BEFORE the process is actually dead, so
# without this a concurrent ensure_running() could see "nothing of ours is
# running", probe the port, get a confirmed answer from the still-alive (but
# dying) server, and adopt it moments before it exits (item 5). A plain
# Event.wait() blocks until SET, which is the wrong direction for "wait until
# no longer stopping" -- _wait_while_stopping() below polls it instead.
_stopping = threading.Event()


def is_mock() -> bool:
    """True when the child will synthesize local WAVs instead of calling a
    paid provider. Defaults to True -- see the COST SAFETY note above. Only
    the exact string "0" opts in to real spending, so a typo fails safe."""
    return os.getenv("theDAW_LYRIA_MOCK", "1") != "0"


def resolve_config() -> LyriaConfig:
    """Resolve project path + port + the npm binary to use."""
    pkg = os.getenv("theDAW_LYRIA_PROJECT")
    project_path = Path(pkg).expanduser().resolve() if pkg else DEFAULT_PROJECT_PATH

    port_env = os.getenv("theDAW_LYRIA_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT

    # On Windows the executable is npm.cmd; shutil.which handles the shim
    # resolution. Fall back to a bare 'npm' so the error at spawn time reads
    # "npm not found" rather than a generic FileNotFoundError.
    npm_path = shutil.which("npm.cmd") or shutil.which("npm") or "npm"

    return LyriaConfig(
        project_path=project_path, port=port, npm_path=npm_path, mock=is_mock()
    )


def _child_env(cfg: LyriaConfig) -> dict[str, str]:
    """Build the child's environment.

    theDAW owns the spawn, so it owns the env -- this is what lets us drive
    Lyria's cost mode and key resolution WITHOUT modifying its source. Lyria
    already reads all of these (server.ts:10 dotenv, :13 GEMINI_API_KEY,
    :33-36 OPENROUTER_API_KEY, :102 PORT), and its in-app Settings modal still
    overrides the keys per-request via x-*-api-key headers, so a user who
    prefers the in-app flow is unaffected.

    Both provider variables are handed the FULL ordered list theDAW knows
    about, comma-separated, because the child walks that list and skips a
    rejected key (server/keys.ts). Passing one key throws away the failover
    the child was built for. No key value is ever logged.
    """
    env = child_env()
    env["PORT"] = str(cfg.port)
    if cfg.mock:
        env["LYRIA_MOCK"] = "1"
    else:
        # Explicit opt-in to real spending: clear any inherited mock flag so a
        # stale value in the parent's environment can't silently re-enable it.
        env.pop("LYRIA_MOCK", None)
    # Pass through every key theDAW already holds so the user needn't re-enter
    # them. A provider with no keys has its variable REMOVED rather than left
    # at whatever the parent inherited (a blank or whitespace-only value would
    # otherwise reach the child); Lyria then reports it as unconfigured via its
    # own /api/settings/status, and its Settings modal still works.
    resolved: dict[str, list[str]] = {}
    for provider in LYRIA_PROVIDERS:
        keys, _source = resolved_keys(provider)
        resolved[provider] = keys
        var = _PROVIDER_ENV_VAR[provider]
        if keys:
            env[var] = ",".join(keys)
        else:
            env.pop(var, None)
    ai_provider = _child_ai_provider(resolved)
    if ai_provider:
        env["AI_PROVIDER"] = ai_provider
    log.info(
        "lyria.sidecar: child keys -- gemini=%d openrouter=%d provider=%s",
        len(resolved["gemini"]),
        len(resolved["openrouter"]),
        ai_provider or "child default",
    )
    return env


def _child_ai_provider(resolved: dict[str, list[str]]) -> Optional[str]:
    """The AI_PROVIDER value to hand the child, or None to leave the child's
    own default alone.

    A preference the user set in theDAW's Settings wins -- it is the one thing
    here that was chosen for THIS child, and a selector that an ambient shell
    variable could silently override would be a lie. An ``AI_PROVIDER`` in the
    OS environment is honoured next, since setting it is also a deliberate
    act. With no preference at all the choice follows the keys: point the
    child at the only provider it can actually reach, and when it can reach
    both (or neither) leave its own default in place.
    """
    stored = provider_preference()
    if stored:
        return stored
    env_pref = (os.getenv("AI_PROVIDER") or "").strip()
    if env_pref:
        return env_pref
    gemini, openrouter = resolved["gemini"], resolved["openrouter"]
    if openrouter and not gemini:
        return "openrouter"
    if gemini and not openrouter:
        return "gemini"
    return None


# ── prerequisites, keys, project presence ────────────────────────────────────


def _git_path() -> Optional[str]:
    return shutil.which("git") or shutil.which("git.exe")


def _npm_path() -> Optional[str]:
    return shutil.which("npm.cmd") or shutil.which("npm")


def _node_path() -> Optional[str]:
    return shutil.which("node") or shutil.which("node.exe")


def project_present(cfg: Optional[LyriaConfig] = None) -> bool:
    """True when the checkout exists (package.json is the marker)."""
    cfg = cfg or resolve_config()
    return (cfg.project_path / "package.json").is_file()


def normalize_provider(provider: str) -> str:
    """``provider`` lowercased and validated. Raises ValueError otherwise, so
    a bad value becomes a 400 at the route rather than a silent no-op."""
    value = (provider or "").strip().lower()
    if value not in LYRIA_PROVIDERS:
        raise ValueError(
            f"Unknown provider {provider!r}: expected one of "
            f"{', '.join(LYRIA_PROVIDERS)}."
        )
    return value


def _split_keys(raw: object) -> list[str]:
    """Ordered, de-duplicated, blank-free keys from a raw value that may hold
    a list -- a comma/newline-separated string, or an actual list. Mirrors the
    embedded app's own parseKeyList so both ends agree on what "a list of
    keys" means."""
    parts: list[str] = []
    if isinstance(raw, (list, tuple)):
        for item in raw:
            if isinstance(item, str):
                parts.extend(re.split(r"[,\n\r]+", item))
    elif isinstance(raw, str):
        parts.extend(re.split(r"[,\n\r]+", raw))
    out: list[str] = []
    for part in parts:
        key = part.strip()
        if key and key not in out:
            out.append(key)
    return out


def _read_store() -> dict:
    """The stored per-provider key lists and provider preference.

    Migrates the legacy single-Gemini shape (``{"key": "..."}``) transparently
    on read: that key becomes the FIRST Gemini entry, so the key a user
    already saved keeps being the one tried first. Never raises -- an
    unreadable or corrupt file reads as "nothing stored", exactly as the
    single-key version did.
    """
    store: dict = {
        "providers": {provider: [] for provider in LYRIA_PROVIDERS},
        "provider_preference": None,
    }
    try:
        raw = json.loads(_KEY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return store
    if not isinstance(raw, dict):
        return store
    providers = raw.get("providers")
    if isinstance(providers, dict):
        for provider in LYRIA_PROVIDERS:
            store["providers"][provider] = _split_keys(providers.get(provider))
    legacy = _split_keys(raw.get("key"))
    if legacy:
        gemini = list(store["providers"]["gemini"])
        for key in reversed(legacy):
            if key in gemini:
                gemini.remove(key)
            gemini.insert(0, key)
        store["providers"]["gemini"] = gemini
    preference = raw.get("provider_preference")
    if isinstance(preference, str) and preference.strip().lower() in LYRIA_PROVIDERS:
        store["provider_preference"] = preference.strip().lower()
    return store


def _is_legacy_file() -> bool:
    """True when the file on disk is still the pre-migration single-key shape,
    i.e. rewriting it would destroy the only copy of that shape."""
    try:
        raw = json.loads(_KEY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(raw, dict) and "key" in raw and "providers" not in raw


def _write_store(store: dict) -> None:
    """Persist the per-provider shape, backing the legacy file up once first.

    The backup exists because this is user data theDAW did not create: a
    migration that turns out to be wrong must not be the end of the key the
    user saved months ago.
    """
    _KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    if _is_legacy_file() and not _KEY_FILE_BACKUP.exists():
        try:
            _KEY_FILE_BACKUP.write_bytes(_KEY_FILE.read_bytes())
            log.info(
                "lyria.sidecar: migrated %s to per-provider keys (backup: %s)",
                _KEY_FILE.name,
                _KEY_FILE_BACKUP.name,
            )
        except OSError as e:
            log.warning("lyria.sidecar: could not back up %s: %s", _KEY_FILE.name, e)
    payload = {
        "version": _KEY_FILE_VERSION,
        "providers": {
            provider: list(store["providers"].get(provider, []))
            for provider in LYRIA_PROVIDERS
        },
        "provider_preference": store.get("provider_preference"),
    }
    _KEY_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def stored_keys(provider: str) -> list[str]:
    """The keys saved through theDAW's own Lyria settings, in order."""
    return list(_read_store()["providers"][normalize_provider(provider)])


def env_keys(provider: str) -> list[str]:
    """The OS environment's keys for a provider, in order. The variable may
    itself hold a comma/newline-separated list."""
    return _split_keys(os.getenv(_PROVIDER_ENV_VAR[normalize_provider(provider)]))


def pooled_keys(provider: str) -> list[str]:
    """Every key the assistant's key pool holds for a provider, in order,
    across each pool that feeds it."""
    provider = normalize_provider(provider)
    out: list[str] = []
    try:
        from backend.key_pool import key_pool

        for pool in _PROVIDER_POOLS[provider]:
            for key in key_pool.get_raw_keys(pool):
                value = (key or "").strip()
                if value and value not in out:
                    out.append(value)
    except Exception:  # noqa: BLE001 - the pool is optional here
        return out
    return out


def resolved_keys(provider: str) -> tuple[list[str], str]:
    """Every key the child will be handed for a provider, in the order it will
    try them, plus where the FIRST one comes from: ``env`` | ``file`` |
    ``pool`` | ``none`` (the source labels the UI has always shown)."""
    provider = normalize_provider(provider)
    env = env_keys(provider)
    stored = stored_keys(provider)
    pooled = pooled_keys(provider)
    ordered: list[str] = []
    for key in (*env, *stored, *pooled):
        if key not in ordered:
            ordered.append(key)
    if env:
        source = "env"
    elif stored:
        source = "file"
    elif pooled:
        source = "pool"
    else:
        source = "none"
    return ordered, source


def provider_key(provider: str) -> tuple[Optional[str], str]:
    """The first key the child will try for a provider, and its source."""
    keys, source = resolved_keys(provider)
    return (keys[0] if keys else None), source


def gemini_key() -> tuple[Optional[str], str]:
    """The first GEMINI_API_KEY the child will get, and where it comes from:
    ``env`` | ``file`` | ``pool`` | ``none``. Kept as-is (name and shape)
    because probe(), the storage provider-status block and GET /api/lyria/key
    are all built on it."""
    return provider_key("gemini")


def openrouter_key() -> tuple[Optional[str], str]:
    """gemini_key()'s OpenRouter counterpart. OpenRouter matters because
    Google's free tier grants zero Lyria requests per day, so it is often the
    only provider that can actually generate."""
    return provider_key("openrouter")


def provider_preference() -> Optional[str]:
    """The provider the user picked for the child, or None for "let Lyria
    decide"."""
    return _read_store()["provider_preference"]


def set_provider_preference(provider: Optional[str]) -> Optional[str]:
    """Store the provider preference. An empty/None value clears it, which
    hands the choice back to the key-count rule and then to the child's own
    default. Returns the stored value."""
    value = (
        None
        if provider is None or not str(provider).strip()
        else (normalize_provider(str(provider)))
    )
    with _key_file_lock:
        store = _read_store()
        store["provider_preference"] = value
        _write_store(store)
    log.info("lyria.sidecar: provider preference set to %s", value or "auto")
    return value


def add_key(provider: str, key: str) -> int:
    """Append a key to a provider's stored list (no-op when already present).
    Returns the new stored count. The value itself is never logged."""
    provider = normalize_provider(provider)
    value = (key or "").strip()
    if not value:
        raise ValueError("An empty value is not a key.")
    with _key_file_lock:
        store = _read_store()
        keys = store["providers"][provider]
        if value not in keys:
            keys.append(value)
        _write_store(store)
        count = len(keys)
    log.info("lyria.sidecar: %s key stored (%d saved here)", provider, count)
    return count


def remove_key(provider: str, index: int) -> bool:
    """Forget the stored key at ``index`` (position in the stored list only --
    environment and pooled keys are not ours to remove). False when the index
    is out of range."""
    provider = normalize_provider(provider)
    with _key_file_lock:
        store = _read_store()
        keys = store["providers"][provider]
        if not isinstance(index, int) or index < 0 or index >= len(keys):
            return False
        keys.pop(index)
        _write_store(store)
        count = len(keys)
    log.info("lyria.sidecar: %s key #%d forgotten (%d left)", provider, index, count)
    return True


def key_summary() -> dict:
    """Counts and sources only -- never a key value, not even a prefix.

    ``count`` is what the child is handed (de-duplicated across sources), so
    it can be smaller than ``env + stored + pool`` when the same key reaches
    us twice. ``stored`` is the length of the removable list, which is what
    DELETE /api/lyria/keys indexes into.
    """
    providers: dict[str, dict] = {}
    for provider in LYRIA_PROVIDERS:
        keys, source = resolved_keys(provider)
        providers[provider] = {
            "count": len(keys),
            "source": source,
            "configured": bool(keys),
            "env": len(env_keys(provider)),
            "stored": len(stored_keys(provider)),
            "pool": len(pooled_keys(provider)),
        }
    return {
        "providers": providers,
        "provider_preference": provider_preference(),
        "mock": is_mock(),
    }


def set_gemini_key(key: str) -> None:
    """Compatibility wrapper for POST /api/lyria/key: appends to the Gemini
    list rather than replacing it, so an older client adding a second key
    gains a fallback instead of throwing the first one away."""
    add_key("gemini", key)


def clear_gemini_key() -> bool:
    """Compatibility wrapper for DELETE /api/lyria/key: forgets every Gemini
    key stored here (the OpenRouter list and the preference are untouched).
    True when something was actually removed."""
    with _key_file_lock:
        store = _read_store()
        had = bool(store["providers"]["gemini"])
        if had:
            store["providers"]["gemini"] = []
            _write_store(store)
    if had:
        log.info("lyria.sidecar: stored Gemini keys forgotten")
    return had


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is already listening on host:port -- used both for
    readiness polls and for detecting an existing instance we shouldn't
    double-spawn.

    Note the explicit 127.0.0.1: this must NOT be "localhost". On Windows
    localhost resolves to ::1 first, and an unrelated IPv6 listener on the
    same port (VS Code does this on 3001) would make a healthy sidecar look
    dead, or a dead one look alive.
    """
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def _is_lyria_server(port: int) -> bool:
    """Identity check: does whatever is listening on ``port`` answer as OUR
    Lyria sidecar, not some other process that happened to grab the port?

    ``_port_is_listening`` only proves a TCP listener exists there -- on
    Windows another dev server (or a leftover process from a prior run of a
    different app) can easily be squatting on it, and treating that as "our
    sidecar is up" would silently point generate calls at the wrong service
    (see the port-collision history in this module's docstring). Lyria's
    server (server.ts) registers ``GET /api/settings/status`` before it calls
    ``app.listen`` -- so a successful TCP connect already guarantees the route
    table is live -- and the handler always returns exactly the keys
    ``geminiServerKey`` / ``openRouterServerKey`` / ``defaultProvider``. No
    unrelated service is expected to answer with that shape, so requiring
    both keys is a cheap, sufficient identity check without needing a
    dedicated health route we'd have to add to the vendored project (we spawn
    it, we don't rebuild it -- see the module docstring).

    Uses a ProxyHandler({}) opener rather than plain ``urlopen`` -- which
    honours ``HTTP_PROXY``/``NO_PROXY`` from the environment by default -- so
    a system/corporate proxy can never sit between theDAW and its own
    loopback sidecar (same rule as underfit/router.py's ``trust_env=False``
    httpx client). Without it, a proxy that can't reach 127.0.0.1 would make
    this identity check -- and therefore every real Lyria sidecar -- fail.

    A port collision doesn't always mean an HTTP server: an SSH banner or
    any other non-HTTP listener makes ``http.client`` raise
    ``http.client.HTTPException`` (e.g. ``BadStatusLine``) rather than
    ``OSError``/``URLError`` -- uncaught, that propagates out of probe()/
    ensure_running() as a 500 instead of the intended "port in use" 503.
    ``ValueError`` also covers malformed/undecodable headers on top of the
    JSON-parse failures it already catches.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(
            f"http://127.0.0.1:{port}/api/settings/status", timeout=1.0
        ) as response:
            body = json.loads(response.read(4096))
    except (OSError, urllib.error.URLError, http.client.HTTPException, ValueError):
        return False
    return (
        isinstance(body, dict)
        and "geminiServerKey" in body
        and "openRouterServerKey" in body
    )


def _ensure_deps(cfg: LyriaConfig) -> None:
    """Install node_modules when missing.

    Hoisted into its own function deliberately: vj/sidecar.py has this check
    inline in ensure_running() only, so its _ensure_build() path can run
    `npm run build` against a checkout with no node_modules and fail with a
    bare "vite: not found". Every path that runs npm here goes through this
    first -- ensure_running()'s spawn sequence AND the "Install" button's
    _install_worker() both call this directly, so the node_modules re-check
    and the `npm install` call itself are wrapped in _spawn_lock: without it,
    both paths could see node_modules missing at the same instant and run
    `npm install` concurrently in the same directory (the Install button is a
    background thread with no lock of its own).
    """
    with _spawn_lock:
        node_modules = cfg.project_path / "node_modules"
        if node_modules.is_dir():
            return
        log.info("lyria.sidecar: node_modules missing -- running npm install")
        try:
            # Output goes to the sidecar log so install failures are
            # diagnosable; the timeout stops a hung npm (network stall) from
            # pinning _spawn_lock forever.
            with _sidecar_log_handle() as install_log:
                rc = subprocess.call(
                    [cfg.npm_path, "install"],
                    cwd=str(cfg.project_path),
                    stdout=install_log,
                    stderr=subprocess.STDOUT,
                    shell=False,
                    timeout=NPM_INSTALL_TIMEOUT_SEC,
                    env=child_env(),
                )
        except FileNotFoundError as e:
            raise RuntimeError(
                f"Lyria sidecar: npm not found ({e}). Install Node.js."
            ) from e
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(
                f"npm install timed out after {int(NPM_INSTALL_TIMEOUT_SEC)}s in "
                f"{cfg.project_path} -- check the network, then retry."
            ) from e
        if rc != 0:
            raise RuntimeError(
                f"npm install failed in {cfg.project_path} (rc={rc}). See "
                f"{SIDECAR_LOG_PATH} for the full output, then retry."
            )
        log.info("lyria.sidecar: npm install complete")


def detect_lan_ip() -> Optional[str]:
    """Best-effort detection of this machine's primary LAN IPv4 address.

    Opens a UDP socket "toward" a public address (no packets are sent for a
    UDP connect) and reads back the local end of the route the OS picked,
    dodging the 127.0.0.1 that gethostbyname(gethostname()) often returns.
    Returns None when no non-loopback address can be determined.
    """
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 8.8.8.8 is just a routing hint; nothing is transmitted.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        ip = ""
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass
    if ip and not ip.startswith("127."):
        return ip
    return None


def probe() -> dict:
    """Non-spawning diagnostics for the Settings UI / /status endpoint.

    ``missing`` names each absent piece by id (``project``, ``deps``, ``git``,
    ``node``, ``key``) so the UI can say precisely what stands in the way and
    offer the matching fix; ``issues`` keeps the human sentences. A missing key
    is only an *issue* in live mode: mock mode (the default) spends nothing and
    needs no key, and Lyria's own Settings modal also accepts one at runtime.

    "Missing key" means BOTH providers are empty. Either one on its own can
    generate -- and an OpenRouter key is the one that reliably can, since
    Google's free tier grants zero Lyria requests per day -- so reporting a
    Gemini-shaped problem to someone who deliberately runs on OpenRouter would
    be a false alarm.
    """
    cfg = resolve_config()
    pkg = cfg.project_path
    pkg_json = pkg / "package.json"
    git = _git_path()
    npm = _npm_path()
    node = _node_path()
    # One resolve per provider (each reads the key file and the pool), with the
    # first key and its source taken from the same list the child would get.
    gemini_list, key_source = resolved_keys("gemini")
    openrouter_list, or_key_source = resolved_keys("openrouter")
    key = gemini_list[0] if gemini_list else None
    or_key = openrouter_list[0] if openrouter_list else None
    deps_installed = (pkg / "node_modules").is_dir()
    install = install_status()
    installing = install.get("status") in ("cloning", "installing")

    issues: list[str] = []
    missing: list[str] = []
    if not pkg_json.is_file():
        missing.append("project")
        if installing:
            issues.append(f"Installing: {install.get('message')}")
        elif not pkg.is_dir():
            issues.append(
                f"Lyria project not found at {pkg}: Install clones {LYRIA_REPO} "
                "there (or set theDAW_LYRIA_PROJECT to an existing checkout)."
            )
        else:
            issues.append(
                f"{pkg} exists but has no package.json: move it aside so Install "
                f"can clone {LYRIA_REPO}, or set theDAW_LYRIA_PROJECT."
            )
        if not git:
            missing.append("git")
            issues.append("git is not installed, so the project cannot be cloned.")
    elif not deps_installed:
        missing.append("deps")
        if installing:
            issues.append(f"Installing: {install.get('message')}")
        else:
            issues.append("Node dependencies are not installed yet (npm install).")
    if not npm or not node:
        missing.append("node")
        issues.append("Node.js (node + npm) is not installed.")
    if not key and not or_key:
        missing.append("key")
        if not cfg.mock:
            issues.append(
                "No Gemini or OpenRouter key is set: live mode cannot generate "
                "without one."
            )
    # A TCP listener on the port isn't enough -- confirm it actually answers
    # as our Lyria sidecar before reporting "listening" (INT-001). A listener
    # that fails the identity check is a port collision -- UNLESS we already
    # own a live process on this port (owns_process()), in which case it's
    # almost always our own child still starting up, not a rogue process
    # (round-4 item 3): don't report a false "port already in use" against
    # ourselves, just leave "listening" False so the normal readiness wait
    # keeps polling.
    port_open = _port_is_listening(cfg.port)
    confirmed = port_open and _is_lyria_server(cfg.port)
    listening = confirmed
    if port_open and not confirmed and not owns_process():
        issues.append(
            f"Port {cfg.port} is already in use by another process that is not "
            "the Lyria sidecar. Set theDAW_LYRIA_PORT to a free port, or stop "
            "the process using it."
        )
    return {
        "project_path": str(pkg),
        "project_exists": pkg_json.is_file(),
        "repo": LYRIA_REPO,
        "repo_url": LYRIA_REPO_URL,
        "port": cfg.port,
        "mock": cfg.mock,
        "deps_installed": deps_installed,
        "git": bool(git),
        "npm": bool(npm),
        "node": bool(node),
        "gemini_key": bool(key),
        "gemini_key_source": key_source,
        "openrouter_key": bool(or_key),
        "openrouter_key_source": or_key_source,
        # Counts, never values: how many keys the child would be handed.
        "gemini_keys": len(gemini_list),
        "openrouter_keys": len(openrouter_list),
        "provider_preference": provider_preference(),
        "listening": listening,
        "process_alive": _proc is not None and _proc.poll() is None,
        "url": _resolved_url or f"http://127.0.0.1:{cfg.port}",
        "lan_ip": detect_lan_ip(),
        "issues": issues,
        "missing": missing,
        # Installable = the in-app install can make progress from here.
        "installable": bool(npm and node and (pkg_json.is_file() or git)),
        "install": install,
        "log_path": str(SIDECAR_LOG_PATH),
    }


# ── install: clone + npm install, in the background ─────────────────────────

_install_lock = Lock()
_install_state: dict = {
    "status": "idle",  # idle | cloning | installing | done | error
    "step": None,
    "message": "",
    "error": None,
    "started_at": None,
    "finished_at": None,
    "project_path": None,
    "log_path": str(SIDECAR_LOG_PATH),
}


def install_status() -> dict:
    with _install_lock:
        return dict(_install_state)


def _set_install(**fields: object) -> None:
    with _install_lock:
        _install_state.update(fields)


def _install_worker(cfg: LyriaConfig, need_clone: bool, git: str) -> None:
    try:
        if need_clone:
            target = cfg.project_path
            if target.exists() and any(target.iterdir()):
                raise RuntimeError(
                    f"{target} exists but is not a Lyria checkout (no package.json). "
                    "Move it aside, or point theDAW_LYRIA_PROJECT at a checkout."
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            _set_install(
                status="cloning",
                step="clone",
                message=f"Cloning {LYRIA_REPO} into {target}",
            )
            log.info("lyria.sidecar: git clone %s -> %s", LYRIA_REPO_URL, target)
            creationflags = 0
            if sys.platform == "win32":
                creationflags = subprocess.CREATE_NO_WINDOW
            with _sidecar_log_handle() as out:
                rc = subprocess.call(
                    [git, "clone", "--depth", "1", LYRIA_REPO_URL, str(target)],
                    stdout=out,
                    stderr=subprocess.STDOUT,
                    shell=False,
                    timeout=GIT_CLONE_TIMEOUT_SEC,
                    creationflags=creationflags,
                    env=child_env(),
                )
            if rc != 0:
                raise RuntimeError(
                    f"git clone failed (rc={rc}). See {SIDECAR_LOG_PATH} for the "
                    "output (network? GitHub reachable?), then retry."
                )
        _set_install(
            status="installing",
            step="npm",
            message="Installing Node dependencies (npm install) — this can take a few minutes",
        )
        _ensure_deps(cfg)
        _set_install(
            status="done",
            step=None,
            message="Installed. Open the Lyria tab to start it.",
            finished_at=time.time(),
        )
    except subprocess.TimeoutExpired:
        _set_install(
            status="error",
            error=f"git clone timed out after {int(GIT_CLONE_TIMEOUT_SEC)}s.",
            finished_at=time.time(),
        )
    except Exception as e:  # noqa: BLE001 - every failure must land in the status
        log.warning("lyria.sidecar: install failed: %s", e)
        _set_install(status="error", error=str(e), finished_at=time.time())


def start_install() -> dict:
    """Clone the project into the folder the sidecar expects (when missing)
    and run its npm install, on a background thread. Returns the install
    state; raises RuntimeError naming the missing prerequisite when the
    install cannot even start (no git to clone with, no Node.js for npm)."""
    with _install_lock:
        if _install_state["status"] in ("cloning", "installing"):
            return {**_install_state, "already_running": True}
    cfg = resolve_config()
    need_clone = not project_present(cfg)
    git = _git_path()
    npm = _npm_path()
    if need_clone and not git:
        raise RuntimeError(
            "git is not installed, so the Lyria project cannot be cloned. Install "
            "Git (git-scm.com), restart theDAW, then press Install again."
        )
    if not npm or not _node_path():
        raise RuntimeError(
            "Node.js is not installed (npm/node not on PATH). Install Node.js LTS "
            "(nodejs.org), restart theDAW, then press Install again."
        )
    if not need_clone and (cfg.project_path / "node_modules").is_dir():
        _set_install(
            status="done",
            step=None,
            message="Already installed.",
            error=None,
            started_at=time.time(),
            finished_at=time.time(),
            project_path=str(cfg.project_path),
        )
        return {**install_status(), "already_installed": True}
    _set_install(
        status="cloning" if need_clone else "installing",
        step="clone" if need_clone else "npm",
        message=(
            f"Cloning {LYRIA_REPO} into {cfg.project_path}"
            if need_clone
            else "Installing Node dependencies (npm install)"
        ),
        error=None,
        started_at=time.time(),
        finished_at=None,
        project_path=str(cfg.project_path),
    )
    threading.Thread(
        target=_install_worker,
        args=(cfg, need_clone, git or "git"),
        daemon=True,
        name="lyria-install",
    ).start()
    return install_status()


def _probe_adoption(cfg: LyriaConfig) -> tuple[bool, bool]:
    """Network probe for "is a confirmed Lyria instance already listening on
    cfg.port" -- deliberately run WITHOUT holding _state_lock (item 6): the
    TCP connect (~0.4s) plus the HTTP identity check (~1s) worst case must
    never block stop()/probe()/owns_process(), which only need a quick read
    of _proc/_resolved_url under that same lock. Callers re-check whatever
    state they need under _state_lock immediately after calling this.

    Returns ``(confirmed, collision)``: ``confirmed`` is True when a Lyria
    instance is already listening there (our child, or one the user launched
    manually); ``collision`` is True when the port is held by something else
    (INT-001: a bare TCP connect alone is not enough to adopt a listener as
    "our sidecar").

    A failed identity check while we already own a live child on this port
    (round-4 item 3) is NOT a collision: it almost always means our own
    just-spawned process is still starting up (Vite/Express warm-up) rather
    than a rogue process having grabbed the port out from under us. Treating
    it as "not confirmed, no collision" lets the caller fall through to the
    normal readiness-wait loop instead of raising a false "port already in
    use" error against our own child."""
    if not _port_is_listening(cfg.port):
        return False, False
    if _is_lyria_server(cfg.port):
        return True, False
    if owns_process():
        return False, False
    return False, True


def _port_collision_error(cfg: LyriaConfig) -> RuntimeError:
    return RuntimeError(
        f"Port {cfg.port} is already in use by another process that did not "
        "answer as the Lyria sidecar. Set theDAW_LYRIA_PORT to a free port, "
        "or stop the process using it, then retry."
    )


def _wait_while_stopping(timeout: float = _STOPPING_WAIT_TIMEOUT_SEC) -> None:
    """Bounded poll for an in-progress stop() to finish tearing down the
    previous process (item 5), so ensure_running() doesn't probe/adopt a
    server that is dying right now. Defaults to _STOPPING_WAIT_TIMEOUT_SEC,
    derived from _terminate_proc's own worst-case duration -- see that
    constant's comment -- rather than an arbitrary guess."""
    deadline = time.monotonic() + timeout
    while _stopping.is_set() and time.monotonic() < deadline:
        time.sleep(0.05)


def _probe_adoption_guarded(cfg: LyriaConfig) -> tuple[bool, bool]:
    """_probe_adoption() guarded against the stop() race from round-4 item 1:
    a stop() firing between the identity probe (inside _probe_adoption) and
    the caller trusting its `confirmed` result could make ensure_running()
    adopt the very process now being torn down -- it can briefly still
    answer HTTP requests while _terminate_proc is mid-kill. Rejects a
    `confirmed` result that raced against a stop() like that, waits for the
    teardown to finish, and retries -- bounded by _STOPPING_WAIT_TIMEOUT_SEC,
    after which it raises "stopped" rather than looping forever."""
    deadline = time.monotonic() + _STOPPING_WAIT_TIMEOUT_SEC
    while True:
        _wait_while_stopping()
        confirmed, collision = _probe_adoption(cfg)
        if not (confirmed and _stopping.is_set()):
            return confirmed, collision
        if time.monotonic() >= deadline:
            raise RuntimeError("stopped")


def owns_process() -> bool:
    """True when the module holds a live handle to the process currently
    listening on the sidecar's port -- i.e. WE spawned it, as opposed to an
    already-running instance ensure_running() merely adopted (INT-001's
    "one the user launched manually" case). Callers (the /url route, the
    storage provider-status summary) use this to avoid claiming a cost mode
    (mock/live) for a process whose environment theDAW never set (item 5)."""
    with _state_lock:
        return _proc is not None and _proc.poll() is None


def _consume_stop_requested() -> bool:
    """Read-and-clear _stop_requested under _state_lock. Returns the value it
    held before clearing."""
    global _stop_requested
    with _state_lock:
        was = _stop_requested
        _stop_requested = False
        return was


def _terminate_proc(proc: subprocess.Popen[bytes]) -> None:
    """Best-effort kill of a Lyria child process tree. Shared by stop() and
    ensure_running()'s post-Popen stop-request check (item 1). Worst-case
    duration is bounded by _STOPPING_WAIT_TIMEOUT_SEC (see its comment)."""
    try:
        if sys.platform == "win32":
            # npm.cmd is a shim: terminate() kills the cmd wrapper and leaves
            # the node child listening. Kill the whole tree.
            subprocess.call(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=child_env(),
            )
            proc.wait(timeout=_TERMINATE_WAIT_SEC)
        else:
            proc.terminate()
            proc.wait(timeout=_TERMINATE_WAIT_SEC)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            # Reap the killed child so it doesn't linger as a zombie until
            # interpreter shutdown (POSIX).
            proc.wait(timeout=_TERMINATE_WAIT_SEC)
        except (subprocess.TimeoutExpired, OSError):
            pass


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Spawn the Lyria Express server if it isn't already, and return the URL
    it serves on. Safe to call repeatedly -- no-ops if the port is already
    listening AND confirmed to be our sidecar (INT-001), even if some other
    process started it."""
    global _proc, _resolved_url, _stop_requested
    cfg = resolve_config()
    # 127.0.0.1, not localhost -- see _port_is_listening for why.
    url = f"http://127.0.0.1:{cfg.port}"

    # Network probe happens OUTSIDE _state_lock (item 6) -- see
    # _probe_adoption's docstring. _probe_adoption_guarded also waits out an
    # in-progress stop() and rejects a `confirmed` result that raced against
    # one (round-4 item 1) -- see its docstring.
    confirmed, collision = _probe_adoption_guarded(cfg)
    if collision:
        raise _port_collision_error(cfg)
    with _state_lock:
        if confirmed:
            _resolved_url = url
            return url
        proc_alive = _proc is not None and _proc.poll() is None

    if not proc_alive:
        # _run_lock (not _state_lock) serializes this whole sequence so two
        # concurrent callers can't both spawn a second Node process, while
        # leaving _state_lock free for stop()/probe() to keep reading _proc
        # without waiting on it (INT-003). _ensure_deps takes the separate
        # _spawn_lock for its own npm-install critical section (item 3) --
        # different lock object, so holding _run_lock here doesn't deadlock.
        with _run_lock:
            # Another caller may have started tearing down the previous
            # process, or finished spawning, while we waited for _run_lock --
            # re-check both before deciding to spawn ourselves.
            confirmed, collision = _probe_adoption_guarded(cfg)
            if collision:
                raise _port_collision_error(cfg)
            with _state_lock:
                if confirmed:
                    _resolved_url = url
                    return url
                proc_alive = _proc is not None and _proc.poll() is None

            if not proc_alive:
                if not cfg.project_path.is_dir():
                    raise RuntimeError(
                        f"Lyria project not found at {cfg.project_path}. Clone "
                        "StarskreamEXE/lyria-3-pro beside this repo, or set "
                        "theDAW_LYRIA_PROJECT to override."
                    )
                # A stop() from BEFORE this attempt began is stale -- clear it
                # so a fresh attempt isn't haunted by an old request that
                # already had its effect (or had nothing to act on).
                _consume_stop_requested()
                _ensure_deps(cfg)  # npm install -- runs outside _state_lock
                # A stop() may have arrived while _ensure_deps (up to
                # NPM_INSTALL_TIMEOUT_SEC) was running -- with nothing yet
                # spawned, stop()'s own "_proc is None" check has nothing to
                # terminate, so this is the only place that can prevent the
                # install from completing into an orphaned Node process.
                if _consume_stop_requested():
                    raise RuntimeError("stopped")
                # `npm run dev` is `tsx server.ts`: the Express server hosts
                # Vite in middleware mode and serves both the API and the SPA
                # from one port. We use it rather than build+start because it
                # needs no build step and is the path the app is developed
                # and tested against.
                cmd = [cfg.npm_path, "run", "dev"]
                log.info(
                    "lyria.sidecar: spawning %s (cwd=%s, port=%d, mock=%s)",
                    " ".join(cmd),
                    cfg.project_path,
                    cfg.port,
                    cfg.mock,
                )
                try:
                    # On Windows npm is a .cmd shim; CREATE_NEW_PROCESS_GROUP
                    # keeps the spawn quiet inside the theDAW console instead
                    # of popping a separate cmd window.
                    creationflags = 0
                    if sys.platform == "win32":
                        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
                    with _sidecar_log_handle() as spawn_out:
                        new_proc = subprocess.Popen(
                            cmd,
                            cwd=str(cfg.project_path),
                            stdout=spawn_out,
                            stderr=subprocess.STDOUT,
                            creationflags=creationflags,
                            shell=False,
                            env=_child_env(cfg),
                        )
                except FileNotFoundError as e:
                    raise RuntimeError(
                        f"Failed to launch Lyria sidecar: {e}. Is npm on PATH?"
                    ) from e
                # item 4: read-and-clear the stop flag AND assign _proc
                # atomically in ONE _state_lock section -- doing them as two
                # separate critical sections (as before) left a gap where a
                # stop() landing between them would see _proc still None
                # (nothing to terminate) right before this assigns it,
                # orphaning the just-spawned process. Terminate OUTSIDE the
                # lock: _terminate_proc can block for several seconds.
                with _state_lock:
                    if _stop_requested:
                        _stop_requested = False
                        stop_hit = True
                    else:
                        stop_hit = False
                        _proc = new_proc
                if stop_hit:
                    _terminate_proc(new_proc)
                    raise RuntimeError("stopped")

    with _state_lock:
        expected_proc = _proc

    if not wait_for_ready:
        with _state_lock:
            _resolved_url = url
        return url

    deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
    while time.monotonic() < deadline:
        # item 3: a stop() during the readiness wait must abort immediately
        # instead of being silently ignored until the 90s deadline, which
        # then reports a misleading "npm-install or server startup hang"
        # message for what was actually a deliberate stop.
        with _state_lock:
            proc = _proc
        # Always consume the flag -- `or` short-circuits and would otherwise
        # leave _stop_requested stuck True (never cleared) whenever the
        # `proc is not expected_proc` branch is the one that fires (item 4).
        stop_requested = _consume_stop_requested()
        if proc is not expected_proc or stop_requested:
            raise RuntimeError("stopped")
        if _port_is_listening(cfg.port) and _is_lyria_server(cfg.port):
            with _state_lock:
                _resolved_url = url
            log.info("lyria.sidecar: ready at %s (mock=%s)", url, cfg.mock)
            return url
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(
                f"Lyria sidecar exited before becoming ready "
                f"(rc={proc.returncode}). See {SIDECAR_LOG_PATH}."
            )
        time.sleep(PORT_POLL_INTERVAL_SEC)
    raise RuntimeError(
        f"Lyria sidecar didn't open port {cfg.port} within "
        f"{int(PORT_READY_TIMEOUT_SEC)}s -- likely an npm-install or "
        f"server startup hang. See {SIDECAR_LOG_PATH}."
    )


def stop() -> bool:
    """Terminate the sidecar if we spawned it. Returns True if we actually
    stopped a live process.

    Always sets _stop_requested BEFORE the "_proc is None" early return:
    called while ensure_running() is mid-install or mid-Popen, _proc doesn't
    exist yet, so this function alone has nothing to terminate -- without the
    flag, the in-flight spawn would complete moments later into an orphaned
    Node process holding the port that nothing is left tracking (item 1).

    _proc is cleared to None BEFORE the process is actually dead (the kill
    itself can take up to _STOPPING_WAIT_TIMEOUT_SEC and must not hold
    _state_lock -- see _terminate_proc). _stopping is set INSIDE the same
    _state_lock section that clears _proc (round-4 item 1) -- not after
    releasing the lock -- so there is no window where a concurrent reader
    could observe _proc already None but _stopping still clear. It stays set
    for the whole teardown so a concurrent ensure_running() waits it out
    (_wait_while_stopping) instead of adopting a server that answers now but
    is about to exit (item 5)."""
    global _proc, _resolved_url, _stop_requested
    with _state_lock:
        _stop_requested = True
        if _proc is None:
            return False
        if _proc.poll() is not None:
            _proc = None
            return False
        proc, _proc, _resolved_url = _proc, None, None
        _stopping.set()
    try:
        _terminate_proc(proc)
    finally:
        _stopping.clear()
    return True
