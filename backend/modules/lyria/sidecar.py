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

import hashlib
import http.client
import json
import logging
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Lock, RLock
from typing import IO, Callable, Iterator, Optional
from backend.lib import paths
from backend.lib.atomic import atomic_write
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
# it as StarskreamEXE/lyria-3-pro). Install clones the latest commit of its
# default branch, and Update in the Lyria panel fast-forwards a clean checkout
# to the latest again (_fast_forward_checkout). No commit id is frozen here:
# what a checkout reads is decided from the checkout itself
# (checkout_key_slots), so an older checkout and the latest one both get keys
# in the variables they read. Every fetch comes from this URL, whatever the
# checkout's own origin says.
LYRIA_REPO = "StarskreamEXE/lyria-3-pro"
LYRIA_REPO_URL = f"https://github.com/{LYRIA_REPO}.git"
GIT_CLONE_TIMEOUT_SEC = 900.0
# One fetch of the default branch, per Update press, and one ls-remote per
# check_latest.
GIT_FETCH_TIMEOUT_SEC = 120.0
# check_latest asks GitHub at most once per this long, unless forced.
CHECKOUT_RETRY_SEC = 600.0
# How many keys per provider a list-reading checkout takes when its keys.ts
# does not say (numberedEnvValues' own default is 10: <VAR>_2 up to <VAR>_10).
CHILD_KEY_LIMIT = 10

# The provider keys theDAW hands the child (see _child_env). Per provider the
# order is: the OS environment's value(s), then what was stored here (POST
# /api/lyria/key[s]), then keys from the assistant's key pool. From the pool
# the child gets the FIRST Gemini key when neither of the other sources has
# one (what theDAW always handed it), and every pooled Gemini, OpenRouter and
# openrouter-free key only after the user turns on "share the key pool" in the
# Lyria card (share_pool in the key file). A checkout with server/keys.ts
# fails over from a rejected key (invalid, out of credit, or a quota wall) to
# the next one, which matters because Google's free tier grants zero Lyria
# requests per day; an older checkout reads one key per provider, so it is
# handed only the first (see checkout_key_slots).
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
# Every write stores the same payload here too (_key_copy_file), with a record
# of the key file it wrote. main's POST /api/lyria/key writes ``{"key": ...}``
# over the whole key file and its DELETE unlinks it; 8039b45 writes its own
# lists over it. No build before this one knows this file, so it still holds
# this build's store when this build opens again, and the record tells which
# build changed the key file since (_reconcile). Named in .gitignore, and in
# every backup (backend/modules/backup/service.py restores both files through
# restore_key_files).
_KEY_COPY_NAME = "lyria_provider_keys.json"

# Checkouts whose dependencies changed under them (Update moved one
# to a commit with a different package.json / package-lock.json) and whose npm
# install has not finished yet. Written before the move and cleared only when
# npm install succeeds, so a failed or interrupted install is run again on the
# next start: node_modules still exists at that point (the old one, or a
# half-written one), so its presence alone says nothing. Kept in theDAW's data
# folder, never in the user's checkout.
_DEPS_PENDING_FILE = paths.data_path("lyria_deps_pending.json")

# The providers theDAW can hand keys to. Both are the embedded app's own
# (server.ts reads GEMINI_API_KEY and OPENROUTER_API_KEY).
LYRIA_PROVIDERS: tuple[str, ...] = ("gemini", "openrouter")
_PROVIDER_ENV_VAR = {
    "gemini": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}
# key_pool pools that hold keys for each provider. "openrouter-free" is its own
# pool in backend/key_pool.py (PROVIDER_ENV_MAP) with its own entries, so it is
# folded in rather than assumed to be the same list as "openrouter". Read in
# full only when the user shares the pool (see resolved_keys).
_PROVIDER_POOLS = {
    "gemini": ("gemini",),
    "openrouter": ("openrouter", "openrouter-free"),
}
# Serializes the read-modify-write of the key file so two concurrent route
# handlers (add + remove, say) cannot lose one another's edit. Reentrant:
# _read_store takes it to write another build's change back into both files,
# and the writers call _read_store while they hold it.
_key_file_lock = RLock()


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


def _numbered_vars(var: str, limit: int = CHILD_KEY_LIMIT) -> list[str]:
    """``<var>_2`` .. ``<var>_<limit>``: the extra slots a checkout's
    numberedEnvValues reads, in order."""
    return [f"{var}_{n}" for n in range(2, limit + 1)]


# ``numberedEnvValues(process.env, 'GEMINI_API_KEY')``, or with an explicit
# third argument, ``numberedEnvValues(process.env, "X", 5)``: the call a
# checkout makes for every provider whose numbered slots it reads.
_NUMBERED_CALL = re.compile(
    r"numberedEnvValues\(\s*process\.env\s*,\s*(['\"`])(?P<var>[A-Za-z0-9_]+)\1"
    r"\s*(?:,\s*(?P<max>\d+)\s*)?\)"
)
# The default ``max`` in keys.ts's own signature:
# ``function numberedEnvValues(env: NodeJS.ProcessEnv, prefix: string, max = 10)``.
_NUMBERED_DEFAULT = re.compile(
    r"function\s+numberedEnvValues\s*\([^)]*?\bmax\s*(?::\s*number\s*)?=\s*(\d+)"
)
# A checkout's own number, however large, is capped here: the slots are
# environment variables, and a typo like ``max = 100000`` must not make
# theDAW clear a hundred thousand of them on every spawn.
_CHILD_KEY_SLOTS_CAP = 50


def _checkout_sources(project_path: Path) -> list[str]:
    """The server-side TypeScript a checkout runs: server.ts and the files in
    server/, test files left out. Unreadable files are skipped."""
    files = [project_path / "server.ts"]
    server_dir = project_path / "server"
    if server_dir.is_dir():
        files.extend(
            sorted(
                p
                for p in server_dir.glob("*.ts")
                if not p.name.endswith((".test.ts", ".spec.ts"))
            )
        )
    out: list[str] = []
    for path in files:
        try:
            out.append(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
    return out


def checkout_key_slots(project_path: Path) -> dict[str, int]:
    """How many keys each provider variable of this checkout takes, read from
    the checkout's own source.

    theDAW tracks the Lyria repo's latest commit, and what a commit reads has
    changed over time: a checkout from before server/keys.ts reads
    ``process.env.GEMINI_API_KEY`` as ONE key (its server.ts:13), so a list in
    that variable is sent to Google as a single invalid key; from server/keys.ts
    on, server.ts calls ``numberedEnvValues(process.env, 'GEMINI_API_KEY')``,
    which reads ``GEMINI_API_KEY_2`` up to ``_<max>``. So the answer comes from
    the checkout itself, never from a commit id: 1 for a variable with no
    numberedEnvValues call (the unnumbered variable always carries exactly one
    key, which every checkout reads), otherwise ``max`` from the call, or the
    default in keys.ts's own signature, or CHILD_KEY_LIMIT when neither says.
    A call only counts when server/keys.ts defines numberedEnvValues, so a
    half-merged tree reads as a single-key checkout."""
    slots = {var: 1 for var in _PROVIDER_ENV_VAR.values()}
    try:
        keys_ts = (project_path / "server" / "keys.ts").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return slots
    if "function numberedEnvValues" not in keys_ts:
        return slots
    default_match = _NUMBERED_DEFAULT.search(keys_ts)
    default_max = int(default_match.group(1)) if default_match else CHILD_KEY_LIMIT
    for text in _checkout_sources(project_path):
        for call in _NUMBERED_CALL.finditer(text):
            var = call.group("var")
            if var not in slots:
                continue
            limit = int(call.group("max")) if call.group("max") else default_max
            slots[var] = min(max(slots[var], limit, 1), _CHILD_KEY_SLOTS_CAP)
    return slots


def checkout_reads_key_lists(project_path: Path) -> bool:
    """True when the checkout takes more than one key for any provider (see
    checkout_key_slots)."""
    return any(n > 1 for n in checkout_key_slots(project_path).values())


def checkout_compat(project_path: Path) -> dict:
    """What the Lyria panel and the Settings card show about this checkout:
    whether it has server/keys.ts and how many keys each variable takes."""
    slots = checkout_key_slots(project_path)
    return {
        "keys_ts": (project_path / "server" / "keys.ts").is_file(),
        "key_slots": slots,
        "reads_key_lists": any(n > 1 for n in slots.values()),
    }


def _child_env(cfg: LyriaConfig) -> dict[str, str]:
    """Build the child's environment.

    theDAW owns the spawn, so it owns the env -- this is what lets us drive
    Lyria's cost mode and key resolution WITHOUT modifying its source. Every
    Lyria checkout reads ``GEMINI_API_KEY``, ``OPENROUTER_API_KEY``,
    ``AI_PROVIDER``, ``LYRIA_MOCK`` and ``PORT`` from its environment, and its
    in-app Settings modal still overrides the keys per request via
    x-*-api-key headers, so a user who prefers the in-app flow is unaffected.

    ``GEMINI_API_KEY`` and ``OPENROUTER_API_KEY`` each carry exactly ONE key,
    the first of the provider's ordered list, because that is all a checkout
    without server/keys.ts can read. The rest of the list goes into the
    numbered ``_2`` .. ``_<max>`` variables, and only as many as the checkout
    reads (checkout_key_slots). No key value is ever logged.
    """
    env = child_env()
    env["PORT"] = str(cfg.port)
    if cfg.mock:
        env["LYRIA_MOCK"] = "1"
    else:
        # Explicit opt-in to real spending: clear any inherited mock flag so a
        # stale value in the parent's environment can't silently re-enable it.
        env.pop("LYRIA_MOCK", None)
    # Every provider slot is cleared first and then filled from the resolved
    # list, so nothing the parent inherited (a blank value, a stale numbered
    # key the list no longer holds) reaches the child behind theDAW's back.
    # env_keys() already folded the OS environment's own values into the list.
    # A provider with no keys is left unset; Lyria then reports it as
    # unconfigured via its own /api/settings/status, and its Settings modal
    # still works.
    slots = checkout_key_slots(cfg.project_path)
    resolved: dict[str, list[str]] = {}
    passed: dict[str, int] = {}
    for provider in LYRIA_PROVIDERS:
        keys, _source = resolved_keys(provider)
        resolved[provider] = keys
        var = _PROVIDER_ENV_VAR[provider]
        limit = slots.get(var, 1)
        env.pop(var, None)
        for numbered in _numbered_vars(var, max(limit, CHILD_KEY_LIMIT)):
            env.pop(numbered, None)
        if not keys:
            passed[provider] = 0
            continue
        env[var] = keys[0]
        extra = keys[1:limit]
        for numbered, key in zip(_numbered_vars(var, limit), extra):
            env[numbered] = key
        passed[provider] = 1 + len(extra)
    ai_provider = _child_ai_provider(resolved)
    if ai_provider:
        env["AI_PROVIDER"] = ai_provider
    log.info(
        "lyria.sidecar: child keys -- gemini=%d/%d openrouter=%d/%d "
        "(handed/held; this checkout takes %s) provider=%s",
        passed["gemini"],
        len(resolved["gemini"]),
        passed["openrouter"],
        len(resolved["openrouter"]),
        ", ".join(f"{var} x{n}" for var, n in slots.items()),
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


def _empty_store() -> dict:
    return {
        "providers": {provider: [] for provider in LYRIA_PROVIDERS},
        "provider_preference": None,
        "share_pool": False,
    }


def _store_from_payload(raw: object) -> dict:
    """A store from one parsed key-file payload, whichever build wrote it.

    Migrates the legacy single-Gemini shape (``{"key": "..."}``) on the way:
    that key becomes the FIRST Gemini entry, so the key a user already saved
    keeps being the one tried first. _write_store keeps that ``key`` field in
    step with the first stored Gemini key, so reading it back changes
    nothing."""
    store = _empty_store()
    if not isinstance(raw, dict):
        return store
    providers = raw.get("providers")
    if isinstance(providers, dict):
        for provider in LYRIA_PROVIDERS:
            store["providers"][provider] = _split_keys(providers.get(provider))
    legacy = _split_keys(raw.get("key"))
    if legacy:
        store["providers"]["gemini"] = _keys_first(legacy, store["providers"]["gemini"])
    preference = raw.get("provider_preference")
    if isinstance(preference, str) and preference.strip().lower() in LYRIA_PROVIDERS:
        store["provider_preference"] = preference.strip().lower()
    # Only a literal true shares the pool: a hand-edited "yes" or 1 fails safe.
    store["share_pool"] = raw.get("share_pool") is True
    return store


def _keys_first(first: list[str], rest: list[str]) -> list[str]:
    """``first`` in order, then every key of ``rest`` it does not hold."""
    return [*first, *(key for key in rest if key not in first)]


def _copy_store(store: dict) -> dict:
    return {
        "providers": {
            provider: list(store["providers"].get(provider, []))
            for provider in LYRIA_PROVIDERS
        },
        "provider_preference": store.get("provider_preference"),
        "share_pool": store.get("share_pool") is True,
    }


def _forget_gemini(store: dict) -> dict:
    """``store`` with its Gemini list emptied."""
    out = _copy_store(store)
    out["providers"]["gemini"] = []
    return out


def _all_keys(store: dict) -> set[str]:
    return {key for keys in store["providers"].values() for key in keys}


def _union_stores(first: dict, second: dict) -> dict:
    """Every key of both, ``first``'s ahead of ``second``'s, per provider, and
    ``first``'s preference unless it has none. The pool switch is
    ``first``'s; ``second``'s counts only when ``first`` holds no key and no
    preference (an empty store has no switch worth keeping)."""
    out = _copy_store(first)
    for provider in LYRIA_PROVIDERS:
        out["providers"][provider] = _keys_first(
            first["providers"][provider], second["providers"][provider]
        )
    if out["provider_preference"] is None:
        out["provider_preference"] = second.get("provider_preference")
    if not _all_keys(first) and first.get("provider_preference") is None:
        out["share_pool"] = second.get("share_pool") is True
    return out


@dataclass(frozen=True)
class _KeyFileView:
    """The key file as the reader found it: whether it exists, its parsed
    JSON (None when it does not parse), the sha256 of its bytes, and its file
    identity (volume, file index) when the filesystem has one."""

    exists: bool
    raw: object
    digest: Optional[str]
    identity: Optional[tuple[int, int]]


def _file_identity(path: Path) -> Optional[tuple[int, int]]:
    """``(st_dev, st_ino)`` of ``path``, or None when the file is missing or
    the filesystem reports no file index (st_ino 0, as FAT does)."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    if not st.st_ino:
        return None
    return (int(st.st_dev), int(st.st_ino))


def _view_bytes(data: Optional[bytes]) -> _KeyFileView:
    """A view of key-file bytes that did not come from disk (a backup)."""
    if data is None:
        return _KeyFileView(False, None, None, None)
    try:
        raw: object = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raw = None
    return _KeyFileView(True, raw, hashlib.sha256(data).hexdigest(), None)


def _view_key_file(path: Path) -> _KeyFileView:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return _KeyFileView(False, None, None, None)
    except OSError:
        return _KeyFileView(True, None, None, None)
    view = _view_bytes(data)
    return _KeyFileView(True, view.raw, view.digest, _file_identity(path))


def _recorded_identity(record: object) -> Optional[tuple[int, int]]:
    if not isinstance(record, dict):
        return None
    ident = record.get("id")
    if (
        isinstance(ident, list)
        and len(ident) == 2
        and all(isinstance(n, int) and not isinstance(n, bool) for n in ident)
    ):
        return (ident[0], ident[1])
    return None


def _written_from_mains_file(written: dict, base: dict) -> bool:
    """True when an 8039b45 store over the key file shows no sign of having
    been written from this build's store (``base``), so it must have been
    written from a file main had overwritten.

    8039b45 opened on main's ``{"key": ...}`` sees that one key as its first
    Gemini key and nothing else: no other key and no preference. main's card
    shows the first Gemini key this build wrote into ``key``, so main saving
    it again is ordinary and that key is left out of the test. A write from
    this build's store carries every key the user did not remove and the
    preference the user did not change, so either of these is the sign:
      * another key of ``base`` is in the write;
      * the write holds ``base``'s preference (main's file has none to give).
    Without either sign the write never saw ``base``'s keys and could not
    have removed them. An empty write is the user clearing every key and
    counts as seen; so does any write when ``base`` holds no key."""
    written_keys = _all_keys(written)
    base_keys = _all_keys(base)
    if not written_keys or not base_keys:
        return False
    mains_key = set(written["providers"]["gemini"][:1])
    if (written_keys - mains_key) & base_keys:
        return False
    preference = base.get("provider_preference")
    return preference is None or written.get("provider_preference") != preference


def _reconcile(key_file: _KeyFileView, copy: object) -> tuple[dict, str]:
    """The store the key file and the copy beside it describe, and how the
    key file got the way it is.

    Three builds write ``data/lyria_gemini_key.json``, each its own way:
      * main (851f6a0 and before) writes ``{"key": ...}`` over the whole
        file in place (``write_text``) and its DELETE unlinks the file. It
        reads ``.get("key")`` only.
      * 8039b45 (the first multi-key build) writes the whole per-provider
        store in place, without ``key`` or ``share_pool``, from whatever it
        read: every list when this build wrote last, or main's one key when
        main did.
      * this build writes the key file atomically (a new file each time)
        with ``key`` repeating the first Gemini key, then the same store to
        ``lyria_provider_keys.json`` (the copy, which neither older build
        knows) with a record of the key file it wrote: its sha256 and its
        file identity.
    The record is what tells them apart. Bytes that match it are this
    build's own last write. A missing file is main's DELETE: the Gemini
    keys go, as this build's own DELETE /api/lyria/key does, and nothing
    else. A file with another identity on the same volume was created again
    after this build wrote it, which only happens after main's DELETE (main
    and 8039b45 overwrite in place), so that DELETE is applied first.
    Otherwise main's one key goes first and the rest stay behind it; and an
    8039b45 store replaces the lists, unless it shows no sign of having read
    the copy's store (_written_from_mains_file) -- then it was written from
    a file main had overwritten, never saw this build's keys, and could not
    have removed them, so they stay behind its own. Without a copy each file
    is read on its own terms, as before the copy existed.

    Kinds: ``none``, ``legacy`` and ``torn`` (nothing to reconcile, nothing
    rewritten); ``ours``; everything else is a change another build made,
    which _read_store writes back into both files at once."""
    base = (
        _store_from_payload(copy)
        if isinstance(copy, dict) and isinstance(copy.get("providers"), dict)
        else None
    )
    record = copy.get("key_file") if isinstance(copy, dict) else None
    recorded_digest = record.get("sha256") if isinstance(record, dict) else None
    if base is not None and key_file.exists and key_file.digest is not None:
        if key_file.digest == recorded_digest:
            return base, "ours"
    raw = key_file.raw
    if not key_file.exists:
        if base is None:
            return _empty_store(), "none"
        return _forget_gemini(base), "main_deleted"
    if not isinstance(raw, dict):
        # A torn write (main's write_text cut short) or junk.
        if base is None:
            return _empty_store(), "torn"
        return base, "torn_copy"
    recorded_id = _recorded_identity(record)
    recreated = (
        recorded_id is not None
        and key_file.identity is not None
        and recorded_id[0] == key_file.identity[0]
        and recorded_id[1] != key_file.identity[1]
    )
    if not isinstance(raw.get("providers"), dict):
        # main's single-key shape.
        if base is None:
            return _store_from_payload(raw), "legacy"
        main_keys = _split_keys(raw.get("key"))
        store = _forget_gemini(base) if recreated else _copy_store(base)
        store["providers"]["gemini"] = _keys_first(
            main_keys, store["providers"]["gemini"]
        )
        return store, "main_resaved" if recreated else "main_saved"
    written = _store_from_payload(raw)
    if "share_pool" in raw:
        # This build's own shape, but not the write the copy records (the
        # copy predates the record, or a crash fell between the two writes):
        # the key file is complete and is the newer of the two.
        return written, "ours_unrecorded"
    # 8039b45's shape. It has no pool switch, so this build's stays.
    if base is None:
        return written, "older_list"
    if recreated:
        store, kind = (
            _union_stores(written, _forget_gemini(base)),
            "older_list_after_delete",
        )
    elif _written_from_mains_file(written, base):
        store, kind = _union_stores(written, base), "older_list_blind"
    else:
        store, kind = written, "older_list"
    store["share_pool"] = base["share_pool"]
    return store, kind


# Kinds _reconcile reports that leave nothing to write back.
_SETTLED_KINDS = frozenset({"none", "legacy", "torn", "ours"})


def _read_store() -> dict:
    """The stored per-provider key lists, provider preference and pool share.

    Reads the key file and the copy beside it and reconciles them
    (_reconcile). When another build changed the key file, the result is
    written back into both files at once, so main finds the first Gemini key
    in ``key`` again, 8039b45 finds every list, and the copy's record matches
    the key file for the next read. Never raises -- an unreadable or corrupt
    file with no copy reads as "nothing stored", exactly as the single-key
    version did, and a write-back that fails is logged and tried again on
    the next read.
    """
    with _key_file_lock:
        key_file = _view_key_file(_KEY_FILE)
        _copy_exists, copy = _read_key_json(_key_copy_file())
        store, kind = _reconcile(key_file, copy)
        if kind not in _SETTLED_KINDS:
            log.info(
                "lyria.sidecar: %s was changed by another build (%s); "
                "writing the reconciled keys back",
                _KEY_FILE.name,
                kind,
            )
            try:
                _write_store(store)
            except OSError as e:
                log.warning(
                    "lyria.sidecar: could not write the reconciled keys back: %s", e
                )
        return store


def _key_copy_file() -> Path:
    """Where every write keeps a second copy of the key payload: beside the
    key file, so it follows the key file wherever that is pointed."""
    return _KEY_FILE.with_name(_KEY_COPY_NAME)


def _read_key_json(path: Path) -> tuple[bool, object]:
    """``(the file exists, its parsed JSON or None)``. A file that exists but
    does not parse -- main's plain write_text cut short -- is (True, None)."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False, None
    except OSError:
        return True, None
    try:
        return True, json.loads(text)
    except ValueError:
        return True, None


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

    Every file is written with atomic_write, so a crash mid-write leaves the
    previous file whole: _read_store reads a torn file as "nothing stored",
    and the next add_key would then write that empty list over every key.

    ``key`` repeats the first stored Gemini key in the single-key shape main
    reads (``json.loads(...).get("key")``), so a user who runs main against
    this data dir keeps the Gemini key they saved here. The key file goes
    first; the copy follows with the record of what was just written (its
    sha256 and file identity), which is how _reconcile recognises this
    build's own write. A crash between the two leaves a key file in this
    build's shape that the copy does not record, and _reconcile believes the
    key file then.
    """
    if _is_legacy_file() and not _KEY_FILE_BACKUP.exists():
        try:
            atomic_write(_KEY_FILE_BACKUP, _KEY_FILE.read_bytes(), mode=0o600)
            log.info(
                "lyria.sidecar: migrated %s to per-provider keys (backup: %s)",
                _KEY_FILE.name,
                _KEY_FILE_BACKUP.name,
            )
        except OSError as e:
            log.warning("lyria.sidecar: could not back up %s: %s", _KEY_FILE.name, e)
    providers = {
        provider: list(store["providers"].get(provider, []))
        for provider in LYRIA_PROVIDERS
    }
    payload: dict = {
        "version": _KEY_FILE_VERSION,
        "providers": providers,
        "provider_preference": store.get("provider_preference"),
        "share_pool": store.get("share_pool") is True,
    }
    if providers["gemini"]:
        payload["key"] = providers["gemini"][0]
    data = json.dumps(payload, indent=2).encode("utf-8")
    atomic_write(_KEY_FILE, data, mode=0o600)
    identity = _file_identity(_KEY_FILE)
    copy = {
        **payload,
        "key_file": {
            "sha256": hashlib.sha256(data).hexdigest(),
            "id": list(identity) if identity is not None else None,
        },
    }
    atomic_write(
        _key_copy_file(), json.dumps(copy, indent=2).encode("utf-8"), mode=0o600
    )


def settle_key_files() -> None:
    """Reconcile the key file and its copy now, writing back whatever another
    build changed. The backup export runs this first, so the archive holds a
    key file and a copy that agree."""
    _read_store()


def restore_key_files(
    key_file_bytes: Optional[bytes], copy_bytes: Optional[bytes], mode: str
) -> bool:
    """Bring the Lyria keys in a backup archive back. Returns True when the
    archive held a store to restore.

    The backup service hands both files here instead of writing them itself:
    written as plain files, a main backup's ``{"key": ...}`` would sit
    beside this build's copy, and the restored file's new identity would read
    as main having deleted and saved it (_reconcile), forgetting every other
    Gemini key. Here each archive is read on its own terms -- the archive's
    copy with its key file, never this machine's file identities -- and:
      * ``replace``: the archive's store becomes the store, except that an
        archive holding main's single key only (a backup of main's own data
        folder) cannot express the other keys, so its key goes first and the
        keys held now stay behind it, as main saving that key would;
      * ``merge``: every key held now stays first, the archive's follow.
    Both files are then written together (_write_store). Raises OSError when
    they cannot be written."""
    view = _view_bytes(key_file_bytes)
    copy: object = None
    if copy_bytes is not None:
        try:
            copy = json.loads(copy_bytes.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            copy = None
    if not view.exists and not isinstance(copy, dict):
        return False
    archived, kind = _reconcile(view, copy)
    if kind in ("none", "torn"):
        return False
    with _key_file_lock:
        current = _read_store()
        if mode == "merge":
            store = _union_stores(current, archived)
        elif kind == "legacy":
            store = _copy_store(current)
            store["providers"]["gemini"] = _keys_first(
                archived["providers"]["gemini"], current["providers"]["gemini"]
            )
            if store["provider_preference"] is None:
                store["provider_preference"] = archived["provider_preference"]
        else:
            store = archived
            if kind == "older_list" and not isinstance(copy, dict):
                # A backup of 8039b45's own folder: that build has no pool
                # switch, so the one set here stays.
                store["share_pool"] = current["share_pool"]
        _write_store(store)
    log.info(
        "lyria.sidecar: restored Lyria keys from a backup (%s, %s): gemini=%d "
        "openrouter=%d",
        mode,
        kind,
        len(store["providers"]["gemini"]),
        len(store["providers"]["openrouter"]),
    )
    return True


def stored_keys(provider: str) -> list[str]:
    """The keys saved through theDAW's own Lyria settings, in order."""
    return list(_read_store()["providers"][normalize_provider(provider)])


def env_keys(provider: str) -> list[str]:
    """The OS environment's keys for a provider, in order: the variable itself
    (which may hold a comma/newline-separated list), then the numbered
    ``_2`` .. ``_10`` variables server/keys.ts also reads. _child_env clears
    those slots and refills them from the resolved list, so they are read
    here or they would be dropped."""
    var = _PROVIDER_ENV_VAR[normalize_provider(provider)]
    raw = [os.getenv(var) or ""]
    raw.extend(os.getenv(numbered) or "" for numbered in _numbered_vars(var))
    return _split_keys(raw)


def pool_shared() -> bool:
    """True when the user turned on "share the key pool" in the Lyria card."""
    return _read_store()["share_pool"]


def set_pool_shared(share: bool) -> bool:
    """Store the pool-share switch. Returns the stored value."""
    value = share is True
    with _key_file_lock:
        store = _read_store()
        store["share_pool"] = value
        _write_store(store)
    log.info(
        "lyria.sidecar: key pool %s with Lyria", "shared" if value else "not shared"
    )
    return value


def pooled_keys(provider: str) -> list[str]:
    """Every key the assistant's key pool holds for a provider, in order,
    across each pool that feeds it -- whether or not it is shared."""
    provider = normalize_provider(provider)
    out: list[str] = []
    try:
        from backend.key_pool import key_pool

        for pool in _PROVIDER_POOLS[provider]:
            for key in key_pool.get_raw_keys(pool):
                value = (key or "").strip()
                if value and value not in out:
                    out.append(value)
    except Exception:  # the pool is optional here
        return out
    return out


def _pool_keys_for_child(
    provider: str, env: list[str], stored: list[str], share: bool
) -> list[str]:
    """The pooled keys the child may have for a provider.

    Shared pool: all of them. Otherwise only the first pooled GEMINI key, and
    only when the environment and the Lyria card hold no Gemini key -- the
    one pooled key theDAW has always handed the child, so a key pasted for
    the assistant still starts Lyria. OpenRouter and openrouter-free keys
    were never handed over and stay with the assistant until the user shares
    the pool."""
    if share:
        return pooled_keys(provider)
    if provider == "gemini" and not env and not stored:
        return pooled_keys("gemini")[:1]
    return []


def resolved_keys(provider: str) -> tuple[list[str], str]:
    """Every key theDAW holds for the child for a provider, in the order it
    will try them, plus where the FIRST one comes from: ``env`` | ``file`` |
    ``pool`` | ``none`` (the source labels the UI has always shown). How many
    of them a checkout actually receives is _child_env's business: one, or up
    to CHILD_KEY_LIMIT for a checkout that reads lists."""
    provider = normalize_provider(provider)
    env = env_keys(provider)
    stored = stored_keys(provider)
    pooled = _pool_keys_for_child(provider, env, stored, pool_shared())
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

    ``count`` is what theDAW holds for the child (de-duplicated across
    sources), so it can be smaller than ``env + stored + pool`` when the same
    key reaches us twice. ``handed`` is how many of those the configured
    checkout receives: as many as its variable takes (checkout_key_slots), one
    for a checkout without server/keys.ts. ``stored`` is the length of the
    removable list, which is what DELETE /api/lyria/keys indexes into.
    ``pool`` counts the pooled keys that go to the child; ``pool_available``
    counts every key the pool holds, so the card can say what sharing it
    would add. ``key_limit`` is the largest number of keys any variable of
    this checkout takes.
    """
    share = pool_shared()
    slots = checkout_key_slots(resolve_config().project_path)
    reads_lists = any(n > 1 for n in slots.values())
    limit = max(slots.values())
    providers: dict[str, dict] = {}
    for provider in LYRIA_PROVIDERS:
        keys, source = resolved_keys(provider)
        env = env_keys(provider)
        stored = stored_keys(provider)
        taken = slots[_PROVIDER_ENV_VAR[provider]]
        providers[provider] = {
            "count": len(keys),
            "handed": min(len(keys), taken),
            "key_slots": taken,
            "source": source,
            "configured": bool(keys),
            "env": len(env),
            "stored": len(stored),
            "pool": len(_pool_keys_for_child(provider, env, stored, share)),
            "pool_available": len(pooled_keys(provider)),
        }
    return {
        "providers": providers,
        "provider_preference": provider_preference(),
        "share_pool": share,
        "reads_key_lists": reads_lists,
        "key_limit": limit,
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


def _pending_projects() -> list[str]:
    try:
        raw = json.loads(_DEPS_PENDING_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    projects = raw.get("projects") if isinstance(raw, dict) else None
    if not isinstance(projects, list):
        return []
    return [p for p in projects if isinstance(p, str)]


def deps_pending(project: Path) -> bool:
    """True when an Update moved ``project`` to a commit with other
    dependencies and their npm install has not succeeded since."""
    return _norm(str(project)) in _pending_projects()


def _set_deps_pending(project: Path, pending: bool) -> None:
    """Record or clear ``project`` in _DEPS_PENDING_FILE. Raises OSError when
    the record cannot be written."""
    key = _norm(str(project))
    current = _pending_projects()
    if (key in current) == pending:
        return
    projects = [*current, key] if pending else [p for p in current if p != key]
    atomic_write(_DEPS_PENDING_FILE, json.dumps({"projects": projects}, indent=2))


def _clear_deps_pending(project: Path) -> None:
    """Clear ``project`` from _DEPS_PENDING_FILE after its npm install
    succeeded. A record that cannot be cleared costs one more npm install on
    the next start, so it is logged and the start goes on."""
    try:
        _set_deps_pending(project, False)
    except OSError as e:
        log.warning(
            "lyria.sidecar: could not clear %s (%s); npm install runs again on "
            "the next start",
            _DEPS_PENDING_FILE.name,
            e,
        )


def _ensure_deps(cfg: LyriaConfig) -> None:
    """Install node_modules when missing, or when a checkout move left its
    dependencies uninstalled (deps_pending).

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
        pending = deps_pending(cfg.project_path)
        if node_modules.is_dir() and not pending:
            return
        if pending:
            log.info(
                "lyria.sidecar: the checkout moved and its npm install did not "
                "finish -- running npm install"
            )
        else:
            log.info("lyria.sidecar: node_modules missing -- running npm install")
        _run_npm_install(cfg)
        if pending:
            _clear_deps_pending(cfg.project_path)


def _run_npm_install(cfg: LyriaConfig) -> None:
    """``npm install`` in the checkout. The caller holds _spawn_lock: this is
    the body _ensure_deps and _fast_forward_checkout share, and neither may run it
    while the other is."""
    try:
        # Output goes to the sidecar log so install failures are diagnosable;
        # the timeout stops a hung npm (network stall) from pinning
        # _spawn_lock forever.
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
    deps_installed = (pkg / "node_modules").is_dir() and not deps_pending(pkg)
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
        # Counts, never values: how many keys theDAW holds for the child.
        "gemini_keys": len(gemini_list),
        "openrouter_keys": len(openrouter_list),
        "provider_preference": provider_preference(),
        # Whether this checkout takes a key list (server/keys.ts) or one key
        # per provider, read from the checkout itself, and what the last
        # Update or latest-commit check found.
        "reads_key_lists": checkout_reads_key_lists(pkg),
        "compat": checkout_compat(pkg),
        "checkout": checkout_state(),
        "update": update_status(),
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


# ── the latest commit: Install clones it, Update fast-forwards to it ────────


def _git_env() -> dict[str, str]:
    """child_env() plus GIT_TERMINAL_PROMPT=0: a repo that asks for
    credentials fails at once instead of waiting on a prompt nobody sees."""
    env = child_env()
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _git_creationflags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def _git_run(
    git: str, args: list[str], cwd: Path, timeout: float = 60.0
) -> subprocess.CompletedProcess[str]:
    """One git command in ``cwd``, output captured. Never raises for a
    non-zero exit; a timeout raises subprocess.TimeoutExpired."""
    return subprocess.run(
        [git, *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_git_creationflags(),
        env=_git_env(),
        check=False,
    )


def _last_line(text: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


def _remove_staging(path: Path) -> None:
    """Delete a staging folder this module created. git marks its pack files
    read-only, which stops shutil.rmtree on Windows, so the handler clears
    that bit and retries once. The folder only ever holds a fresh clone, never
    a node_modules or a junction."""

    def _clear_readonly(
        func: Callable[[str], object], target: str, _exc: BaseException
    ) -> None:
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if path.exists():
        shutil.rmtree(path, onexc=_clear_readonly)


def _clone_latest(git: str, target: Path, out: IO[bytes] | int) -> str:
    """Clone LYRIA_REPO_URL's default branch at its latest commit to
    ``target`` and return that commit.

    A full clone, not ``--depth 1``: Update fast-forwards the checkout later,
    and a fast-forward is only provable when the old commit's history is
    there. The clone runs in a staging folder beside ``target`` and is renamed
    into place at the end, so a failure at any step leaves ``target`` as it
    was (missing or empty) and removes the staging folder; Install can simply
    run again. Raises RuntimeError naming the step, or
    subprocess.TimeoutExpired."""
    staging = target.with_name(f".{target.name}.install-staging")
    _remove_staging(staging)
    try:
        rc = subprocess.call(
            [git, "clone", "-q", "--no-tags", LYRIA_REPO_URL, str(staging)],
            cwd=str(target.parent),
            stdout=out,
            stderr=subprocess.STDOUT,
            shell=False,
            timeout=GIT_CLONE_TIMEOUT_SEC,
            creationflags=_git_creationflags(),
            env=_git_env(),
        )
        if rc != 0:
            raise RuntimeError(
                f"git clone failed (rc={rc}) while fetching {LYRIA_REPO}. See "
                f"{SIDECAR_LOG_PATH} for the output (network? GitHub reachable?), "
                "then retry."
            )
        head = _git_run(git, ["rev-parse", "HEAD"], staging)
        commit = head.stdout.strip()
        if head.returncode != 0 or not commit:
            raise RuntimeError(
                f"git cannot read the fresh clone of {LYRIA_REPO} "
                f"({_last_line(head.stderr) or f'rc={head.returncode}'}), then retry."
            )
        if target.exists():
            target.rmdir()  # empty: _install_worker refuses a non-empty one
        staging.rename(target)
        return commit
    except BaseException:
        try:
            _remove_staging(staging)
        except OSError as e:
            log.warning("lyria.sidecar: could not remove %s: %s", staging, e)
        raise


_checkout_lock = Lock()
_checkout_state: dict = {
    # unchecked | current | updated | newer | diverged | dirty | branch
    # | failed | managed | not_git
    "state": "unchecked",
    "commit": None,
    # The newest commit of LYRIA_REPO's default branch theDAW has seen, from
    # the last Update or the last check (check_latest), and when.
    "latest": None,
    "latest_checked_at": None,
    "reason": "",
    "checked_at": None,
}


def checkout_state() -> dict:
    """What the last Update or check found or did. ``reason`` is a sentence
    for the Lyria panel whenever the checkout was left where it is, and says
    what moved when it moved."""
    with _checkout_lock:
        return dict(_checkout_state)


def _set_checkout(state: str, commit: Optional[str], reason: str = "") -> dict:
    with _checkout_lock:
        _checkout_state.update(
            state=state, commit=commit, reason=reason, checked_at=time.time()
        )
        return dict(_checkout_state)


def _set_latest(latest: Optional[str]) -> None:
    with _checkout_lock:
        _checkout_state.update(latest=latest, latest_checked_at=time.time())


def _claim_latest_check(force: bool) -> bool:
    """True when check_latest should ask GitHub now, and the time of this ask
    recorded in the same step: forced, or no ask began in the last
    CHECKOUT_RETRY_SEC. Recorded before the ask, so a failed ask (offline,
    GitHub unreachable) counts too, and panels opened while one ask is still
    waiting on the network do not start another."""
    with _checkout_lock:
        last = _checkout_state["latest_checked_at"]
        now = time.time()
        if not force and last is not None and now - last < CHECKOUT_RETRY_SEC:
            return False
        _checkout_state["latest_checked_at"] = now
        return True


def _is_ancestor(git: str, project: Path, older: str, newer: str) -> bool:
    return (
        _git_run(git, ["merge-base", "--is-ancestor", older, newer], project).returncode
        == 0
    )


def _fast_forward_checkout(
    cfg: LyriaConfig, before_move: Optional[Callable[[], None]] = None
) -> dict:
    """Fast-forward an existing checkout to the latest commit of LYRIA_REPO's
    default branch, when that is safe. POST /api/lyria/update runs it.

    It leaves the checkout alone, and says why in checkout_state(), when:
      * theDAW_LYRIA_PROJECT names it (a checkout the user manages),
      * it is not a git checkout, or git is missing,
      * it has local changes to tracked files (``dirty``),
      * it is on a branch of its own: only a detached HEAD, or the default
        branch tracking origin (the two shapes an Install leaves), is moved
        (``branch``),
      * it already holds commits the latest does not have: ``newer`` when
        the latest is in its history, ``diverged`` when neither contains the
        other -- a fast-forward is the only move made,
      * the fetch or the move fails (``failed``, with git's own message).
    The fetch always comes from LYRIA_REPO_URL, whatever the checkout's own
    origin points at. Untracked files (the app's own generations and
    projects) survive the move; git refuses one that would overwrite them,
    which lands in ``failed``. ``before_move`` runs right before the move and
    only when there is one to make: start_update() stops the Lyria running
    from the tree there. When package.json or package-lock.json differ, or
    node_modules is missing, the checkout is recorded in _DEPS_PENDING_FILE
    before the move and npm install runs after it; the record is cleared only
    when that install succeeds, so _ensure_deps runs it again after a failure.
    Raises RuntimeError only for that npm install."""
    project = cfg.project_path
    if os.getenv("theDAW_LYRIA_PROJECT"):
        return _set_checkout(
            "managed",
            None,
            f"theDAW_LYRIA_PROJECT points at {project}, a checkout you manage, so "
            "theDAW does not update it. Pull it yourself, then restart Lyria.",
        )
    git = _git_path()
    if not git or not (project / ".git").exists():
        return _set_checkout(
            "not_git",
            None,
            f"{project} is not a git checkout theDAW can update"
            + ("" if git else " (git is not installed)")
            + ", so it stays as it is.",
        )
    with _spawn_lock:
        head: Optional[str] = None
        try:
            rev = _git_run(git, ["rev-parse", "HEAD"], project)
            head = rev.stdout.strip()
            if rev.returncode != 0 or not head:
                return _set_checkout(
                    "not_git",
                    None,
                    f"git cannot read {project} "
                    f"({_last_line(rev.stderr) or f'rc={rev.returncode}'}), so it "
                    "stays as it is.",
                )
            dirty = _git_run(
                git, ["status", "--porcelain", "--untracked-files=no"], project
            )
            if dirty.returncode != 0 or dirty.stdout.strip():
                return _set_checkout(
                    "dirty",
                    head,
                    f"The Lyria checkout at {project} has local changes to tracked "
                    f"files, so theDAW left it at {head[:7]}. Commit or discard "
                    "them, then press Update again.",
                )
            branch = _own_branch(git, project)
            if branch:
                return _set_checkout(
                    "branch",
                    head,
                    f"The Lyria checkout at {project} is on its own branch "
                    f"'{branch}', so theDAW left it at {head[:7]}. Switch it to "
                    "its default branch, then press Update again.",
                )
            fetch = _git_run(
                git,
                ["fetch", "-q", "--no-tags", LYRIA_REPO_URL, "HEAD"],
                project,
                timeout=GIT_FETCH_TIMEOUT_SEC,
            )
            if fetch.returncode != 0:
                return _set_checkout(
                    "failed",
                    head,
                    f"Could not fetch {LYRIA_REPO}, so Lyria stays at "
                    f"{head[:7]}: {_last_line(fetch.stderr) or f'rc={fetch.returncode}'}",
                )
            latest_rev = _git_run(git, ["rev-parse", "FETCH_HEAD"], project)
            latest = latest_rev.stdout.strip()
            if latest_rev.returncode != 0 or not latest:
                return _set_checkout(
                    "failed",
                    head,
                    f"git fetched {LYRIA_REPO} but cannot read the commit, so "
                    f"Lyria stays at {head[:7]}.",
                )
            _set_latest(latest)
            if latest == head:
                return _set_checkout(
                    "current", head, f"Lyria is at the latest commit, {head[:7]}."
                )
            if _is_ancestor(git, project, latest, head):
                return _set_checkout(
                    "newer",
                    head,
                    f"The Lyria checkout at {project} is at {head[:7]}, which "
                    f"already contains the latest commit {latest[:7]}.",
                )
            if not _is_ancestor(git, project, head, latest):
                return _set_checkout(
                    "diverged",
                    head,
                    f"The Lyria checkout at {project} has commits the latest "
                    f"({latest[:7]}) does not, so theDAW left it at {head[:7]}. "
                    "A fast-forward is the only move theDAW makes.",
                )
            deps_same = _git_run(
                git,
                [
                    "diff",
                    "--quiet",
                    head,
                    latest,
                    "--",
                    "package.json",
                    "package-lock.json",
                ],
                project,
            )
            needs_install = (
                deps_same.returncode != 0 or not (project / "node_modules").is_dir()
            )
            if before_move is not None:
                before_move()
            if needs_install:
                # Recorded BEFORE the move: a crash between the two costs
                # one extra npm install, never a checkout left on the old
                # dependencies.
                _set_deps_pending(project, True)
            on_branch = (
                _git_run(git, ["symbolic-ref", "-q", "HEAD"], project).returncode == 0
            )
            if on_branch:
                moved = _git_run(git, ["merge", "-q", "--ff-only", latest], project)
            else:
                moved = _git_run(git, ["checkout", "-q", "--detach", latest], project)
            if moved.returncode != 0:
                if needs_install:
                    _clear_deps_pending(project)
                return _set_checkout(
                    "failed",
                    head,
                    f"git could not move the Lyria checkout from {head[:7]} to "
                    f"{latest[:7]}: {_last_line(moved.stderr) or f'rc={moved.returncode}'}",
                )
            if on_branch:
                _advance_tracking_ref(git, project, latest)
        except (OSError, subprocess.TimeoutExpired) as e:
            return _set_checkout(
                "failed",
                head,
                f"Could not update the Lyria checkout, so it stays as it is: {e}",
            )
        log.info("lyria.sidecar: moved %s from %s to %s", project, head[:7], latest[:7])
        if needs_install:
            log.info("lyria.sidecar: dependencies changed -- running npm install")
            _run_npm_install(cfg)
            _clear_deps_pending(project)
        return _set_checkout(
            "updated", latest, f"Updated Lyria from {head[:7]} to {latest[:7]}."
        )


def _advance_tracking_ref(git: str, project: Path, latest: str) -> None:
    """After a fast-forward of the default branch, point its origin
    tracking ref at the same commit when origin IS LYRIA_REPO_URL, so git
    status in the checkout does not report the update as local commits.
    Best effort: a failure changes nothing about what runs."""
    url = _git_run(git, ["remote", "get-url", "origin"], project).stdout.strip()
    if url != LYRIA_REPO_URL:
        return
    upstream = _git_run(
        git,
        ["rev-parse", "--symbolic-full-name", "@{upstream}"],
        project,
    ).stdout.strip()
    if upstream.startswith("refs/remotes/origin/"):
        _git_run(git, ["update-ref", upstream, latest], project)


def _own_branch(git: str, project: Path) -> Optional[str]:
    """The checkout's branch when it is one theDAW must not move: None for a
    detached HEAD (what an earlier Install left) or for the default branch
    tracking origin's (what `git clone` leaves), the branch name for anything
    else."""
    current = _git_run(git, ["symbolic-ref", "-q", "--short", "HEAD"], project)
    if current.returncode != 0:
        return None  # detached
    name = current.stdout.strip()
    upstream = _git_run(
        git,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        project,
    ).stdout.strip()
    default = _git_run(
        git, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], project
    ).stdout.strip()
    if upstream == f"origin/{name}" and default == f"origin/{name}":
        return None
    return name


def check_latest(*, force: bool = False) -> dict:
    """Ask GitHub for the latest commit of LYRIA_REPO's default branch
    (``git ls-remote``, no download) and compare it with the checkout's HEAD.

    Asked at most once per CHECKOUT_RETRY_SEC unless ``force``, whether the
    last ask was answered or not (_claim_latest_check), so opening the Lyria
    panel repeatedly, or while GitHub cannot be reached, does not start a
    git ls-remote each time. Returns ``{"head", "latest", "available"}``:
    ``available`` is True when the latest differs from HEAD (the Update press
    then says whether it is a fast-forward). Never raises; a failed ask
    leaves ``latest`` as it was."""
    cfg = resolve_config()
    git = _git_path()
    head: Optional[str] = None
    if git and (cfg.project_path / ".git").exists():
        try:
            rev = _git_run(git, ["rev-parse", "HEAD"], cfg.project_path)
            head = rev.stdout.strip() or None if rev.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            head = None
    if git and _claim_latest_check(force):
        cwd = cfg.project_path if cfg.project_path.is_dir() else _REPO_ROOT
        try:
            remote = _git_run(
                git,
                ["ls-remote", LYRIA_REPO_URL, "HEAD"],
                cwd,
                timeout=GIT_FETCH_TIMEOUT_SEC,
            )
            first = remote.stdout.split()
            if (
                remote.returncode == 0
                and first
                and re.fullmatch(r"[0-9a-f]{40,64}", first[0])
            ):
                _set_latest(first[0])
            else:
                log.info(
                    "lyria.sidecar: could not ask %s for its latest commit: %s",
                    LYRIA_REPO,
                    _last_line(remote.stderr) or f"rc={remote.returncode}",
                )
        except (OSError, subprocess.TimeoutExpired) as e:
            log.info(
                "lyria.sidecar: could not ask %s for its latest commit: %s",
                LYRIA_REPO,
                e,
            )
    latest = checkout_state()["latest"]
    return {
        "head": head,
        "latest": latest,
        "available": bool(head and latest and head != latest),
    }


# ── Update: fast-forward in the background, from the Lyria panel ────────────

_update_lock = Lock()
_update_state: dict = {
    "status": "idle",  # idle | running | done | error
    "message": "",
    "error": None,
    # Lyria was stopped for the move and started again.
    "restarted": False,
    # Lyria was stopped for the move and is not running now (the update or
    # the restart failed): the panel reloads so it does not sit on a dead
    # frame.
    "stopped": False,
    "started_at": None,
    "finished_at": None,
}


def update_status() -> dict:
    with _update_lock:
        return dict(_update_state)


def _set_update(**fields: object) -> None:
    with _update_lock:
        _update_state.update(fields)


def _stop_for_update() -> bool:
    """Stop the Lyria that runs from the checkout before its files move:
    theDAW's own child, and an adopted one that restart() would end. Returns
    True when one was running. A port held by something stop_adopted() will
    not end (not Lyria, a Lyria from another folder) does not run from this
    checkout, so the update goes on."""
    stopped = stop()
    try:
        stopped = stop_adopted() or stopped
    except RestartRefused as e:
        log.info("lyria.sidecar: update goes on beside the process on the port: %s", e)
    return stopped


def _update_worker(cfg: LyriaConfig) -> None:
    was_running = False

    def _before_move() -> None:
        nonlocal was_running
        _set_update(message="Stopping Lyria to update it")
        was_running = _stop_for_update()
        _set_update(message="Moving the checkout to the latest commit")

    try:
        # _run_lock keeps ensure_running() from spawning a child between the
        # stop and the move. It is released before the restart below, which
        # takes it itself.
        with _run_lock:
            state = _fast_forward_checkout(cfg, before_move=_before_move)
    except Exception as e:  # every failure must land in the status
        log.warning("lyria.sidecar: update failed: %s", e)
        _set_update(
            status="error",
            error=str(e),
            restarted=False,
            stopped=was_running,
            finished_at=time.time(),
        )
        return
    reason = state.get("reason") or ""
    if was_running:
        _set_update(message="Starting Lyria again")
        try:
            ensure_running()
        except Exception as e:  # every failure must land in the status
            log.warning("lyria.sidecar: Lyria did not start after the update: %s", e)
            _set_update(
                status="error",
                error=f"{reason} Lyria did not start again: {e}".strip(),
                restarted=False,
                stopped=True,
                finished_at=time.time(),
            )
            return
    _set_update(
        status="done",
        message=reason,
        error=None,
        restarted=was_running,
        stopped=False,
        finished_at=time.time(),
    )


def start_update() -> dict:
    """Fast-forward the checkout to the latest commit on a background thread
    (_fast_forward_checkout), stopping Lyria for the move and starting it
    again afterwards when it was running. Returns the update state; poll
    update_status(). Raises RuntimeError when the checkout is missing or an
    Install is running in it."""
    cfg = resolve_config()
    if not project_present(cfg):
        raise RuntimeError(
            f"There is no Lyria checkout at {cfg.project_path} to update. Press "
            "Install on the Lyria card in Settings > Models first."
        )
    if install_status().get("status") in ("cloning", "installing"):
        raise RuntimeError("Lyria is being installed. Update once that finishes.")
    with _update_lock:
        if _update_state["status"] == "running":
            return {**_update_state, "already_running": True}
        _update_state.update(
            status="running",
            message=f"Fetching the latest {LYRIA_REPO}",
            error=None,
            restarted=False,
            stopped=False,
            started_at=time.time(),
            finished_at=None,
        )
    threading.Thread(
        target=_update_worker, args=(cfg,), daemon=True, name="lyria-update"
    ).start()
    return update_status()


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
                message=f"Cloning the latest {LYRIA_REPO} into {target}",
            )
            log.info("lyria.sidecar: clone %s -> %s", LYRIA_REPO_URL, target)
            with _sidecar_log_handle() as out:
                commit = _clone_latest(git, target, out)
            _set_latest(commit)
            _set_checkout("current", commit, f"Installed at {commit[:7]}.")
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
            error=(
                f"Fetching {LYRIA_REPO} timed out after {int(GIT_CLONE_TIMEOUT_SEC)}s "
                "-- check the network, then retry."
            ),
            finished_at=time.time(),
        )
    except Exception as e:  # every failure must land in the status
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
    if (
        not need_clone
        and (cfg.project_path / "node_modules").is_dir()
        and not deps_pending(cfg.project_path)
    ):
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
            f"Cloning the latest {LYRIA_REPO} into {cfg.project_path}"
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


def running_url() -> Optional[str]:
    """The URL a Lyria already listening on the sidecar's port serves on, or
    None when nothing listens there. Never spawns, installs or waits: this is
    the read ``GET /url`` answers with, for any caller, while starting the
    child stays behind ``ensure_running`` and the gated routes that call it.
    Raises the same port-collision error ``ensure_running`` would when the
    port is held by something that does not answer as Lyria."""
    cfg = resolve_config()
    confirmed, collision = _probe_adoption(cfg)
    if collision:
        raise _port_collision_error(cfg)
    # 127.0.0.1, not localhost -- see _port_is_listening for why.
    return f"http://127.0.0.1:{cfg.port}" if confirmed else None


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
    process started it. The checkout is run as it is: moving it to the latest
    commit is the Update button's job (start_update), never a side effect of
    opening the Lyria tab."""
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
                        f"Lyria project not found at {cfg.project_path}. Press "
                        "Install on the Lyria card in Settings > Models, or set "
                        "theDAW_LYRIA_PROJECT to an existing checkout."
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
                        creationflags = getattr(
                            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
                        )
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


# ── an adopted Lyria: one this process did not spawn ─────────────────────────
#
# ensure_running() adopts a confirmed Lyria that is already on the port -- most
# often a child an earlier backend session spawned and a crash left behind.
# That process keeps the keys and cost mode of the session that started it, and
# stop() cannot end it (it holds no handle). restart() below is the way out:
# it ends such a process, but only one that answers as Lyria AND runs from the
# configured checkout, so it can never kill another program on the port.


class RestartRefused(RuntimeError):
    """stop_adopted() will not end what holds the port; the message says what
    the user can do instead. POST /restart answers it with a 409."""


@dataclass(frozen=True)
class _Listener:
    pid: int
    name: str
    cwd: str
    cmdline: str
    create_time: Optional[float]


def _port_listeners(port: int) -> Optional[list[_Listener]]:
    """The processes listening on ``port``, or None when the connection table
    cannot be read (that can need administrator rights)."""
    try:
        import psutil
    except ImportError:  # psutil is a base dependency (pyproject.toml)
        return None
    try:
        conns = psutil.net_connections(kind="inet")
    except (psutil.AccessDenied, PermissionError, OSError):
        return None
    found: list[_Listener] = []
    seen: set[int] = set()
    for conn in conns:
        if conn.status != psutil.CONN_LISTEN or not conn.laddr:
            continue
        if conn.laddr.port != port or conn.pid is None or conn.pid in seen:
            continue
        seen.add(conn.pid)
        name, cwd, cmdline, created = "", "", "", None
        try:
            proc = psutil.Process(conn.pid)
            name = proc.name()
            cmdline = " ".join(proc.cmdline())
            created = proc.create_time()
            try:
                cwd = proc.cwd()
            except (psutil.AccessDenied, OSError):
                cwd = ""
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        found.append(_Listener(conn.pid, name, cwd, cmdline, created))
    return found


def _norm(path: str) -> str:
    return path.replace("\\", "/").rstrip("/").lower()


def _runs_from_checkout(listener: _Listener, project: Path) -> bool:
    """True when the process's working directory is the checkout (``npm run
    dev`` runs there) or its command line names a file inside it. Compared
    case-insensitively with both separators, as Windows mixes them."""
    root = _norm(str(project))
    cwd = _norm(listener.cwd)
    if cwd and (cwd == root or cwd.startswith(root + "/")):
        return True
    return (root + "/") in _norm(listener.cmdline)


def _kill_listener(listener: _Listener) -> None:
    """End one listener's process tree, after checking the PID still belongs
    to the process that was identified (Windows reuses PIDs quickly)."""
    try:
        import psutil
    except ImportError:
        return
    try:
        proc = psutil.Process(listener.pid)
        if (
            listener.create_time is not None
            and abs(proc.create_time() - listener.create_time) > 0.001
        ):
            return
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return
    if sys.platform == "win32":
        subprocess.call(
            ["taskkill", "/PID", str(listener.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=child_env(),
        )
        return
    try:
        tree = [*proc.children(recursive=True), proc]
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        tree = [proc]
    for member in tree:
        try:
            member.terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    _gone, alive = psutil.wait_procs(tree, timeout=_TERMINATE_WAIT_SEC)
    for member in alive:
        try:
            member.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass


def adopted_running() -> bool:
    """True when a confirmed Lyria serves the port and this process did not
    spawn it, i.e. it runs with keys and a cost mode theDAW did not hand it."""
    if owns_process():
        return False
    port = resolve_config().port
    return _port_is_listening(port) and _is_lyria_server(port)


def stop_adopted() -> bool:
    """End an adopted Lyria that runs from the configured checkout. Returns
    True when one was stopped, False when there was none. Raises
    RestartRefused, naming what to do, when the port is held by something
    that is not Lyria, by a Lyria from another folder, or by a process this
    user cannot see; RuntimeError when the process does not exit."""
    cfg = resolve_config()
    if owns_process() or not _port_is_listening(cfg.port):
        return False
    if not _is_lyria_server(cfg.port):
        raise RestartRefused(str(_port_collision_error(cfg)))
    found = _port_listeners(cfg.port)
    if not found:
        raise RestartRefused(
            f"A Lyria started outside this session holds port {cfg.port}, but "
            "theDAW cannot see which process it is (that can need administrator "
            "rights). Close it, then press Restart again."
        )
    strangers = [
        item for item in found if not _runs_from_checkout(item, cfg.project_path)
    ]
    if strangers:
        where = strangers[0].cwd or strangers[0].name or f"pid {strangers[0].pid}"
        raise RestartRefused(
            f"The Lyria on port {cfg.port} runs from {where}, not from "
            f"{cfg.project_path}. Stop it there, then press Restart again."
        )
    # Held for the whole teardown, as stop() does, so a concurrent
    # ensure_running() waits instead of adopting the server that is exiting.
    _stopping.set()
    try:
        for listener in found:
            _kill_listener(listener)
        deadline = time.monotonic() + _STOPPING_WAIT_TIMEOUT_SEC
        while _port_is_listening(cfg.port) and time.monotonic() < deadline:
            time.sleep(PORT_POLL_INTERVAL_SEC)
    finally:
        _stopping.clear()
    if _port_is_listening(cfg.port):
        raise RuntimeError(
            f"The Lyria on port {cfg.port} did not stop. Close it, then press "
            "Restart again."
        )
    log.info("lyria.sidecar: stopped an adopted Lyria on port %d", cfg.port)
    return True


def restart() -> str:
    """Stop the Lyria serving the port -- this process's child, or an adopted
    one from the configured checkout -- and start a fresh child, which reads
    the current keys, provider and cost mode at spawn. Returns its URL.
    Raises RestartRefused or RuntimeError as stop_adopted() and
    ensure_running() do."""
    stop()
    stop_adopted()
    return ensure_running()
