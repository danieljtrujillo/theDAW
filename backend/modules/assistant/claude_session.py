"""
Persistent Claude Code CLI sessions — ONE long-lived child per conversation.

Port of the VST Foundry's proven BCC wiring (``server/claude-bridge.ts``) to
asyncio. The old theDAW path spawned ``claude`` (and every global MCP server)
once PER MESSAGE, which is why the user saw "Claude Code session initialized
(179 tools, 28 MCP servers)" on every single turn. Here the child is spawned
once with::

    -p --input-format stream-json --output-format stream-json --verbose
    --include-partial-messages

and then kept alive across turns. Each user turn is a single NDJSON line written
to the SAME stdin (stdin is NEVER closed between turns); turn completion is the
CLI's real ``{"type":"result"}`` event, with a child-exit fallback. The per
session stdio MCP server therefore lives for the whole conversation instead of
being re-spawned and killed every message.

This module is a PURE session engine: it owns the child process, the stdout
parser, the turn queue, the interrupt/watchdog/reaper machinery and the
control_request plumbing. It knows nothing about FastAPI, prompts or app tools —
callers hand it a ready-made NDJSON user line and consume SSE lines.
"""

from __future__ import annotations

import asyncio
import codecs
import json
import logging
import os
import re
import sys
import tempfile
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from backend.lib.launch_token import child_env
from backend.modules.assistant import permissions

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[3]
THEDAW_MCP_SERVER = (
    REPO_ROOT / "backend" / "modules" / "assistant" / "thedaw_mcp_server.py"
)

MAX_SESSIONS = 8  # live persistent children cap (LRU-reaped above this)
SESSION_IDLE_S = 15 * 60  # reap a session idle longer than this
REAP_INTERVAL_S = 60.0  # idle-reaper tick
HEARTBEAT_S = 15.0  # SSE keepalive cadence during a turn
# Inactivity (NOT total-duration) watchdog for a busy turn. Re-armed on EVERY
# stdout frame, so a productive long task (which streams frames continuously)
# NEVER trips it — only a genuine upstream stall with no output for this long
# does, letting the wedged turn self-heal so its session can be reaped.
TURN_STALL_S = 300.0
# A permission bubble nobody answers blocks the CLI on stdin forever. Deny it
# for the user after this long so the turn can finish.
PENDING_CONTROL_TIMEOUT_S = 180.0
AUTO_DENY_MESSAGE = "No answer from the user within 3 minutes."
STALL_MESSAGE = (
    "The turn stalled (no output for several minutes) and was ended "
    "so the assistant can continue."
)
CONTROL_RESPONSE_TIMEOUT_S = 10.0
# The CLI blocks on stdin until a control_request is answered, so the policy
# hook gets a hard bound; on timeout we fall back to asking the user.
CONTROL_HOOK_TIMEOUT_S = 5.0
STDOUT_LIMIT = 10 * 1024 * 1024  # 10 MiB — long Claude JSON lines are normal

DEFAULT_EFFORT = "max"
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max")

# Contract C5: the ONLY tools pre-approved without a permission bubble.
ALLOWED_TOOLS = (
    "Read",
    "Grep",
    "Glob",
    "LS",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "NotebookRead",
)

# Setting sources the CLI may load when the session is ISOLATED (the app
# setting "Use my Claude settings and MCP servers" is off). The `user` source is
# EXCLUDED there so ~/.claude/settings.json (on the machine this was proven on:
# defaultMode=bypassPermissions + ~290 Bash allow rules) cannot pre-empt
# theDAW's own permission policy. See build_base_args' docstring for the
# live-proof detail.
SETTING_SOURCES = "project,local"
# Setting sources when the user asked for their own Claude setup (the app
# setting is on, its default). `user` is what carries ~/.claude/settings.json,
# ~/.claude/CLAUDE.md and rules, and the user's skills, commands and agents;
# without it the in-app Claude is a stranger to the user's own setup.
USER_SETTING_SOURCES = "user,project,local"

# Contract C2: our permission modes -> the CLI's --permission-mode values.
# "default" is accepted by claude 2.1.278 even though `claude --help` lists
# only acceptEdits/auto/bypassPermissions/manual/dontAsk/plan (live-verified:
# `--permission-mode default` still parses; `--permission-mode DEFAULT` is
# rejected as an invalid choice).
#
# CRITICAL: every mode maps to "default", not to the CLI's own acceptEdits /
# bypassPermissions. A live proof against 2.1.278 (see build_base_args'
# docstring) showed that under "bypassPermissions" and "acceptEdits" the CLI
# auto-approves tools ITSELF and never emits a control_request at all -- so
# the policy hook (decide(), permissions.py) never runs, and a self-modify
# write (which must always become "ask", in every mode) sails through
# ungoverned. "default" is the only CLI mode that asks the host for EVERY
# tool, which is what lets decide() be the sole authority on the verdict for
# every one of theDAW's four modes -- they differ only in what decide()
# itself returns, never in what the CLI pre-approves. Do not reintroduce
# acceptEdits/bypassPermissions here without re-running that live proof.
CLI_PERMISSION_MODES = {
    "ask": "default",
    "accept_edits": "default",
    "readonly": "default",
    "trusted": "default",
}

ControlHook = Callable[["ClaudeSession", dict], Awaitable[Optional[dict]]]


def find_claude_cmd() -> str:
    """Locate the Claude Code CLI binary from env, PATH, or the npm shim."""
    for var in ("CLAUDE_CODE_PATH", "CLAUDE_CMD"):
        override = os.environ.get(var, "").strip()
        if override:
            # Returned whether or not it exists on disk: an explicit override is
            # honoured verbatim so a bare command name still resolves via PATH.
            return override
    import shutil

    candidates = ["claude.cmd", "claude"] if sys.platform == "win32" else ["claude"]
    for name in candidates:
        found = shutil.which(name)
        if found:
            return found
    if sys.platform == "win32":
        npm_path = Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd"
        if npm_path.exists():
            return str(npm_path)
        return "claude.cmd"
    return "claude"


CLAUDE_CMD = find_claude_cmd()


def build_spawn_argv(base_args: list[str]) -> list[str]:
    """
    Platform-conditional argv for the CLI.

    On Windows ``claude`` is a ``.cmd`` shim, so it must run through ``cmd /c``;
    elsewhere it is invoked directly.
    """
    if sys.platform == "win32":
        return ["cmd", "/c", CLAUDE_CMD, *base_args]
    return [CLAUDE_CMD, *base_args]


# ---------------------------------------------------------------------------
# Session registry
# ---------------------------------------------------------------------------
# Claude session ids THIS process has created (captured from the CLI's
# system/init session_id). The browser persists its claudeSessionId, so after a
# backend restart it sends an id the CLI no longer knows — passing that to
# --resume fails the entire turn with "No conversation found with session ID".
# We only --resume ids in this set; an unknown id falls back to a fresh turn
# (which works) instead of erroring.
known_claude_sessions: set[str] = set()

sessions: dict[str, "ClaudeSession"] = {}
# Secondary index: Claude's own session_id -> our conversation_id. Lets a turn
# that arrives with only a claudeSessionId still resolve its live session.
sid_to_conversation: dict[str, str] = {}
# UI-initiated control requests awaiting the CLI's control_response, keyed by
# the request_id we minted.
control_waiters: dict[str, asyncio.Future] = {}
# Per-conversation creation/claim lock. Without it two concurrent first turns
# for one conversation BOTH spawn a child: the second overwrites sessions[cid]
# and the first is orphaned — unreachable by teardown, the reapers and
# kill_all, so it lives (with its MCP children) until the machine reboots. The
# same race lets two woken idle-waiters both claim the slot, because claiming
# spans an await (spawn/respawn). Held from resolve through `busy = True`.
#
# A lock only helps if every contender uses the SAME object, so its lifetime is
# tied to the turns using it, never to the session: `_conversation_lock_users`
# counts turns currently in their claim phase (resolve -> park -> claim), and
# the lock is dropped only when that count returns to zero. `teardown` must not
# drop it — `asyncio.Lock.release()` clears the locked flag BEFORE the woken
# waiter runs, so an "unlocked" lock can still have a turn about to take it,
# and a teardown in that window would let the next turn mint a second lock.
_conversation_locks: dict[str, asyncio.Lock] = {}
_conversation_lock_users: dict[str, int] = {}

_reaper_task: Optional[asyncio.Task] = None


def _conversation_lock(conversation_id: str) -> asyncio.Lock:
    lock = _conversation_locks.get(conversation_id)
    if lock is None:
        lock = asyncio.Lock()
        _conversation_locks[conversation_id] = lock
    return lock


def _enter_claim(conversation_id: str) -> None:
    """A turn starts its claim phase; its conversation's lock must persist."""
    _conversation_lock_users[conversation_id] = (
        _conversation_lock_users.get(conversation_id, 0) + 1
    )


def _exit_claim(conversation_id: str) -> None:
    """A turn left its claim phase; drop the lock once no turn is using it."""
    remaining = _conversation_lock_users.get(conversation_id, 0) - 1
    if remaining > 0:
        _conversation_lock_users[conversation_id] = remaining
        return
    _conversation_lock_users.pop(conversation_id, None)
    lock = _conversation_locks.get(conversation_id)
    if lock is not None and not lock.locked():
        _conversation_locks.pop(conversation_id, None)


@dataclass
class ClaudeSession:
    """One persistent Claude CLI child plus everything a turn needs."""

    proc: Any
    relay_id: str
    conversation_id: str
    model: str
    effort: str
    permission_mode: str = "ask"
    # True when the child loads the user's own Claude settings and MCP servers
    # (see build_base_args / _mcp_config_args). A change respawns the child.
    use_user_config: bool = False
    # The permission rules the child was given (``permission_rules_key``). A
    # turn whose rules differ -- a rule marked "always allow", or an allow rule
    # added to a settings file since -- respawns the child.
    permission_rules_key: str = ""
    claude_session_id: Optional[str] = None
    mcp_config_path: str = ""
    mcp_config_written: bool = False
    # Set when the per-session MCP config could not be written: the child was
    # spawned without the relay (fail-closed -- strict, empty allowlist -- when
    # isolated) and the next turn must tell the user the relay is gone.
    # Consumed once by stream_turn.
    mcp_error_pending: bool = False
    # SSE lines for the CURRENT turn; ``None`` is the end-of-turn sentinel.
    active_queue: Optional[asyncio.Queue] = None
    stdout_buf: str = ""
    stderr: str = ""
    busy: bool = False
    last_activity: float = 0.0
    aliased_sids: set[str] = field(default_factory=set)
    # Turn generation token. ``turn_gen`` is bumped at the START of every turn;
    # ``result_gen`` is bumped each time a `result`-derived `done` frame is
    # consumed. A `result` legitimately ends the turn only when
    # result_gen == turn_gen while busy; a stale `result` from an
    # interrupted/superseded turn satisfies result_gen < turn_gen and is DRAINED
    # so it cannot end the NEXT turn.
    turn_gen: int = 0
    result_gen: int = 0
    stall_task: Optional[asyncio.Task] = None
    stall_deadline: float = 0.0
    # FIFO turn queue: a turn arriving while this session is busy is QUEUED, not
    # rejected — sending mid-turn just serializes behind the in-flight turn.
    idle_waiters: list = field(default_factory=list)
    # request_id -> {"request": dict, "created": float, "task": Task|None}
    pending_controls: dict = field(default_factory=dict)
    # Policy state owned by the permission layer, carried per session.
    session_allow: set[str] = field(default_factory=set)
    deny_counts: dict = field(default_factory=dict)
    first_turn_pending: bool = True
    interrupt_seq: int = 0
    reader_task: Optional[asyncio.Task] = None
    stderr_task: Optional[asyncio.Task] = None
    on_control_request: Optional[ControlHook] = None


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
_UUID_LIKE = re.compile(r"^[a-fA-F0-9-]{8,64}$")


def _is_uuid_like(value: Optional[str]) -> bool:
    return bool(value) and bool(_UUID_LIKE.match(value or ""))


def _sse(frame: dict) -> str:
    return f"data: {json.dumps(frame)}\n\n"


def _ping() -> str:
    return f": ping {int(time.time() * 1000)}\n\n"


def _synthetic_done(is_error: bool = False) -> dict:
    """A `done` frame for a turn that ended WITHOUT the CLI's own `result`."""
    return {
        "type": "done",
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        },
        "isError": is_error,
    }


def _emit(session: ClaudeSession, frame: dict) -> None:
    queue = session.active_queue
    if queue is None:
        return
    queue.put_nowait(_sse(frame))


def _is_alive(proc: Any) -> bool:
    if proc is None or proc.returncode is not None:
        return False
    stdin = getattr(proc, "stdin", None)
    if stdin is None:
        return False
    try:
        return not stdin.is_closing()
    except Exception:
        return True


def build_user_ndjson_line(text: str) -> str:
    """Build the NDJSON user-turn line written to the CLI's shared stdin."""
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}})


# ---------------------------------------------------------------------------
# Spawn arguments (contract C5) and per-session MCP config
# ---------------------------------------------------------------------------
def build_base_args(
    model: str,
    effort: str,
    permission_mode: str,
    *,
    fallback_model: Optional[str] = None,
    use_user_config: bool = False,
) -> list[str]:
    """
    Base CLI args per contract C5 — no ``--mcp-config``/``--resume`` (spawn adds
    those). EXACT set and order; do not reorder or drop members.

    Deliberately absent:

    * ``--dangerously-skip-permissions`` — permissions are the whole point now;
      the host answers every prompt through ``--permission-prompts host``.
    * ``--max-turns`` — the flag does not exist on this CLI (2.1.261; verified
      with ``claude --help | grep -c max-turns`` -> 0) and an agentic turn must
      run to completion anyway.

    ``--setting-sources`` follows ``use_user_config`` (the app setting "Use my
    Claude settings and MCP servers"):

    * ``True`` -> ``user,project,local``, the CLI's own default and what the
      in-app Claude always loaded before this engine: the user's
      ``~/.claude/settings.json``, ``~/.claude/CLAUDE.md`` and rules, and their
      skills, commands and agents all come with it. The user's own allow rules
      then approve the commands they match without asking theDAW, as they do
      in the user's terminal, except where ``permission_rules`` (passed with
      ``--settings`` in both setups) sends a call to decide() first: every
      edit, command, sub-agent and MCP tool in Read-only mode, every call an
      allow rule matches in Ask mode (unless the user marked the rule "always
      allow"), and every edit of the assistant's own code.
    * ``False`` -> ``project,local``. The CLI applies USER-level settings BEFORE
      it consults the host permission prompt. On the machine this was proven
      on, the user settings set ``permissions.defaultMode = "bypassPermissions"``
      and carried ~290 Bash allow rules, so a live proof against 2.1.261 showed
      a Bash call running in our "Ask" mode with NO ``control_request`` at all,
      while an ``mcp__thedaw__*`` call (matched by no allow rule) still
      bubbled. Dropping the ``user`` source makes theDAW's policy the only
      authority, at the price of the user's CLAUDE.md, skills and agents.

    ``project`` and ``local`` stay either way, so repo-scoped settings apply.
    The flag is genuinely validated by the CLI (``--setting-sources bogus``
    errors with "Valid options are: user, project, local"), unlike unknown
    options, which this CLI silently tolerates.
    """
    use_effort = (effort or DEFAULT_EFFORT).strip().lower()
    if use_effort not in VALID_EFFORTS:
        use_effort = DEFAULT_EFFORT
    cli_mode = CLI_PERMISSION_MODES.get(permission_mode, "default")
    sources = USER_SETTING_SOURCES if use_user_config else SETTING_SOURCES
    args = ["--model", model, "--effort", use_effort]
    if fallback_model:
        args += ["--fallback-model", fallback_model]
    args += [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-prompts",
        "host",
        "--permission-mode",
        cli_mode,
        "--setting-sources",
        sources,
        "--allowedTools",
        *ALLOWED_TOOLS,
    ]
    return args


def write_mcp_config(
    relay_id: str,
    path: str,
    *,
    port: int,
    extra_servers: Optional[dict] = None,
) -> bool:
    """
    Write the per-session ``--mcp-config`` file.

    Always registers the ``thedaw`` stdio relay server. ``extra_servers`` (e.g.
    the underfit trainer) is merged in, as is the ``mcpServers`` block of any
    file named by ``THEDAW_ASSISTANT_EXTRA_MCP_CONFIG``. For an isolated session
    it is paired with ``--strict-mcp-config`` and is then the whole MCP surface;
    for a session using the user's own setup the CLI adds the user's servers to
    it (see ``_mcp_config_args``).

    The ``thedaw`` entry is applied LAST, so neither the env file nor
    ``extra_servers`` can shadow the relay the assistant's own tools ride on.
    """
    relay_entry = {
        "command": sys.executable,
        "args": [str(THEDAW_MCP_SERVER), str(port), relay_id],
        "env": {},
    }
    servers: dict[str, Any] = {}
    env_path = os.environ.get("THEDAW_ASSISTANT_EXTRA_MCP_CONFIG", "").strip()
    if env_path:
        try:
            loaded = json.loads(Path(env_path).read_text(encoding="utf-8"))
            extra = loaded.get("mcpServers")
            if isinstance(extra, dict):
                servers.update(extra)
        except (OSError, ValueError) as exc:
            logger.warning("[Claude] extra MCP config %s unusable: %s", env_path, exc)
    if extra_servers:
        servers.update(extra_servers)
    servers["thedaw"] = relay_entry
    try:
        Path(path).write_text(
            json.dumps({"mcpServers": servers}, indent=2), encoding="utf-8"
        )
        return True
    except OSError as exc:
        logger.warning("[Claude] failed to write mcp-config for %s: %s", relay_id, exc)
        return False


MCP_UNAVAILABLE_MESSAGE = "thedaw relay unavailable for this turn"


def _fallback_config_path(relay_id: str) -> Path:
    """
    Per-relay name for the fail-closed config. Deterministic from the relay id,
    so teardown and a failed spawn can always find and remove it without the
    session having to remember whether a fallback was ever written.
    """
    return Path(tempfile.gettempdir()) / f"thedaw-mcp-empty-{relay_id}.json"


def _unlink_quietly(path: Any) -> None:
    """Remove one of this module's own runtime temp files, if it exists."""
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


def write_empty_mcp_config(relay_id: str) -> Optional[str]:
    """
    Write the fail-CLOSED fallback config: no servers at all.

    Used when the per-session config of an ISOLATED session could not be
    written. Spawning that session WITHOUT ``--strict-mcp-config`` would
    silently fall back to the user's entire global MCP set, which is exactly
    what the user turned off, so a degraded turn gets an empty allowlist
    instead of an unbounded one. One file per relay, so concurrent sessions
    never share (or delete) each other's fallback.
    """
    path = _fallback_config_path(relay_id)
    try:
        path.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
        return str(path)
    except OSError as exc:
        logger.warning("[Claude] failed to write fallback mcp-config: %s", exc)
        return None


def _mcp_config_args(
    relay_id: str,
    mcp_config_path: str,
    *,
    port: int,
    extra_servers: Optional[dict],
    use_user_config: bool = False,
) -> tuple[list[str], bool]:
    """
    Build the MCP args for a spawn. Returns ``(args, written)``.

    Isolated session (``use_user_config`` False): ``--strict-mcp-config`` is
    ALWAYS passed — on the happy path it pins the CLI to our relay, and on the
    failure path it pins it to nothing. It is never omitted there, because
    omitting it is what opens the global MCP set.

    User's own setup (``use_user_config`` True): ``--strict-mcp-config`` is
    NEVER passed, so the CLI loads the MCP servers the user configured for
    Claude Code (``~/.claude.json`` is read whatever the setting sources) and
    adds the relay config on top. A failed write then costs the relay only; the
    user's servers still load.
    """
    written = write_mcp_config(
        relay_id, mcp_config_path, port=port, extra_servers=extra_servers or {}
    )
    if use_user_config:
        return (["--mcp-config", mcp_config_path] if written else []), written
    if written:
        return ["--mcp-config", mcp_config_path, "--strict-mcp-config"], True
    fallback = write_empty_mcp_config(relay_id)
    args = ["--mcp-config", fallback] if fallback else []
    return [*args, "--strict-mcp-config"], False


# ---------------------------------------------------------------------------
# Permission rules every child is spawned with (``--settings``)
# ---------------------------------------------------------------------------
# decide() (permissions.py) only ever sees a tool call the CLI turns into a
# control_request, and the CLI approves a call an ALLOW rule matches before it
# asks anyone. Any loaded setting source can carry allow rules: the user's
# ~/.claude/settings.json when the session uses the user's own setup, and this
# project's .claude/settings*.json in either setup. The CLI checks deny, then
# ask, then allow, and an ask rule from any source beats an allow rule from any
# other, so these ask rules send the calls theDAW must govern to decide() no
# matter what the loaded allow rules say.


# The edit, shell and sub-agent tools (permissions.EDIT_TOOLS, SHELL_TOOLS,
# AGENT_TOOLS) under the names the installed CLI has (2.1.283's tools
# reference). permissions.py also knows `MultiEdit` and `Task`, older names
# this CLI no longer has; an `Edit` rule already covers every file-writing tool.
READONLY_ASK_TOOLS = ("Agent", "Bash", "Edit", "NotebookEdit", "PowerShell", "Write")


def _cli_absolute_rule_path(path: Path) -> str:
    """``path`` in the CLI's absolute rule form: ``//`` plus its POSIX spelling,
    with a Windows drive written the way the CLI normalises it before matching
    (``G:\\Users\\x`` -> ``//g/Users/x``)."""
    posix = path.as_posix()
    if re.match(r"^[A-Za-z]:/", posix):
        posix = f"/{posix[0].lower()}{posix[2:]}"
    return "/" + posix


def claude_config_dir() -> Path:
    """The CLI's user config folder: ``CLAUDE_CONFIG_DIR``, else ``~/.claude``."""
    configured = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".claude"


def _allow_rules_in(path: Path) -> list[str]:
    """``permissions.allow`` of one settings file; [] when absent or unreadable."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    perms = payload.get("permissions") if isinstance(payload, dict) else None
    allow = perms.get("allow") if isinstance(perms, dict) else None
    if not isinstance(allow, list):
        return []
    return [r.strip() for r in allow if isinstance(r, str) and r.strip()]


def loaded_allow_rules(
    use_user_config: bool, repo_root: Optional[Path] = None
) -> list[dict]:
    """
    Every allow rule the child's setting sources carry, once each, with where
    it came from: ``user`` (``~/.claude/settings.json``, only when the session
    uses the user's own setup, see ``build_base_args``), ``project``
    (``.claude/settings.json``) and ``local`` (``.claude/settings.local.json``).
    ``repo_root`` defaults to ``REPO_ROOT``, read at call time.
    """
    repo_root = repo_root or REPO_ROOT
    files = []
    if use_user_config:
        files.append(("user", claude_config_dir() / "settings.json"))
    files += [
        ("project", repo_root / ".claude" / "settings.json"),
        ("local", repo_root / ".claude" / "settings.local.json"),
    ]
    seen: set[str] = set()
    rules: list[dict] = []
    for source, path in files:
        for rule in _allow_rules_in(path):
            if rule in seen:
                continue
            seen.add(rule)
            rules.append({"rule": rule, "source": source, "path": str(path)})
    return rules


def permission_rules(
    permission_mode: str,
    repo_root: Optional[Path] = None,
    *,
    use_user_config: bool = False,
    always_allow: tuple[str, ...] | list[str] = (),
) -> dict:
    """
    The ``--settings`` payload for a child in ``permission_mode``.

    * Every mode: an ``Edit`` ask rule per ``permissions.SELF_SURFACE_GLOBS``
      entry (an ``Edit(path)`` rule governs every built-in tool that writes
      files), so a write to the assistant's own surface always reaches
      decide(), which asks the user.
    * ``ask``: also an ask rule mirroring each loaded allow rule
      (``loaded_allow_rules``) the user has not marked "always allow" in the
      assistant panel (settings ``assistant.always_allow_rules``). The CLI
      checks ask rules before allow rules, so a call such a rule matches
      reaches decide() and the user is asked, where it used to run unasked.
      theDAW's own read-only ``ALLOWED_TOOLS`` are not mirrored.
    * ``readonly``: also a bare ask rule for every edit, shell and sub-agent
      tool, and ``mcp__*`` for every MCP tool, so each one reaches decide(),
      which refuses all but reads.

    Paths are absolute (``//...``): a ``/path`` rule anchors at a place that
    depends on where the CLI thinks the rule came from.
    """
    repo_root = repo_root or REPO_ROOT
    root = _cli_absolute_rule_path(repo_root)
    ask = [f"Edit({root}/{glob})" for glob in permissions.SELF_SURFACE_GLOBS]
    if permission_mode == "ask":
        keep = set(always_allow)
        for entry in loaded_allow_rules(use_user_config, repo_root):
            rule = entry["rule"]
            if rule in keep or rule in ALLOWED_TOOLS or rule in ask:
                continue
            ask.append(rule)
    if permission_mode == "readonly":
        ask += [*READONLY_ASK_TOOLS, "mcp__*"]
    return {"permissions": {"ask": ask}}


def permission_rules_key(
    permission_mode: str,
    *,
    use_user_config: bool = False,
    always_allow: tuple[str, ...] | list[str] = (),
) -> str:
    """A stable text form of ``permission_rules``, to tell whether a child's
    rules still hold."""
    return json.dumps(
        permission_rules(
            permission_mode, use_user_config=use_user_config, always_allow=always_allow
        ),
        sort_keys=True,
    )


def ask_rules_missing(
    session: "ClaudeSession",
    permission_mode: str,
    *,
    always_allow: tuple[str, ...] | list[str] = (),
) -> list[str]:
    """
    The ask rules a child in ``permission_mode`` would carry that ``session``'s
    child was not given. The rules are fixed at spawn, so while this is not
    empty the running child still lets the CLI approve calls those rules would
    send to decide(), until the next turn respawns it.
    """
    try:
        given = json.loads(session.permission_rules_key)["permissions"]["ask"]
    except (ValueError, KeyError, TypeError):
        given = []
    have = set(given) if isinstance(given, list) else set()
    wanted = permission_rules(
        permission_mode,
        use_user_config=session.use_user_config,
        always_allow=always_allow,
    )["permissions"]["ask"]
    return [rule for rule in wanted if rule not in have]


def _permission_settings_path(relay_id: str, permission_mode: str) -> Path:
    """Per-relay, per-mode file, so a respawn into another mode never rewrites
    the file the outgoing child loaded, and teardown can find every one."""
    mode = permission_mode if permission_mode in CLI_PERMISSION_MODES else "other"
    return Path(tempfile.gettempdir()) / f"thedaw-permissions-{relay_id}-{mode}.json"


def _permission_settings_args(
    relay_id: str,
    permission_mode: str,
    *,
    use_user_config: bool = False,
    always_allow: tuple[str, ...] | list[str] = (),
) -> list[str]:
    """
    Write this child's permission rules and return ``["--settings", path]``.

    Raises ``OSError`` when the file cannot be written. Fail CLOSED: a child
    spawned without these rules would let the loaded allow rules approve edits
    in Read-only mode, matched calls in Ask mode, and writes to the assistant's
    own code, so the caller turns the error into a failed turn and no child
    starts.
    """
    path = _permission_settings_path(relay_id, permission_mode)
    rules = permission_rules(
        permission_mode, use_user_config=use_user_config, always_allow=always_allow
    )
    path.write_text(json.dumps(rules, indent=2), encoding="utf-8")
    return ["--settings", str(path)]


def _unlink_permission_settings(relay_id: str) -> None:
    """Remove every permission-rules file this relay's children were given."""
    for mode in (*CLI_PERMISSION_MODES, "other"):
        _unlink_quietly(_permission_settings_path(relay_id, mode))


# ---------------------------------------------------------------------------
# stream-json event parsing (contract C1)
# ---------------------------------------------------------------------------
def _resolve_tool_result_text(content: Any) -> str:
    """Normalize a tool_result's polymorphic content into a display string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(block.get("text", "")) if isinstance(block, dict) else str(block)
            for block in content
        )
    return json.dumps(content if content is not None else "")


def parse_claude_event(data: Any) -> list[dict]:
    """Translate one stream-json event into zero or more C1 SSE frames."""
    if not isinstance(data, dict):
        return []
    kind = data.get("type")

    # Partial-message stream events nest the real event under `event`.
    if kind == "stream_event" and isinstance(data.get("event"), dict):
        return parse_claude_event(data["event"])

    frames: list[dict] = []

    if kind == "system" and data.get("subtype") == "init":
        if data.get("session_id"):
            frames.append({"type": "session_id", "sessionId": data["session_id"]})
        # The CLI's ACTUAL model may differ from the requested alias.
        if data.get("model"):
            frames.append({"type": "model", "model": str(data["model"])})
        return frames

    if kind == "assistant":
        # Text and thinking stream via content_block_delta; here we surface ONLY
        # tool_use blocks, as DISPLAY-ONLY frames. `parent_tool_use_id` marks a
        # SUB-AGENT (Task/Agent spawn) so the UI can nest it under its card.
        parent = data.get("parent_tool_use_id")
        parent_id = parent if isinstance(parent, str) else ""
        message = data.get("message") or data
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    frames.append(
                        {
                            "type": "tool_use",
                            "toolId": block.get("id", "") or "",
                            "name": block.get("name", "") or "tool",
                            "inputJson": json.dumps(block.get("input") or {}),
                            "parentToolId": parent_id,
                        }
                    )
                elif block.get("type") == "redacted_thinking":
                    # No thinking_delta to stream — surface a placeholder so the
                    # user knows the model reasoned here.
                    frames.append(
                        {"type": "thinking", "text": "\n[reasoning redacted]\n"}
                    )
        return frames

    if kind == "user":
        # Tool RESULTS come back as a `user` message carrying tool_result blocks.
        parent = data.get("parent_tool_use_id")
        parent_id = parent if isinstance(parent, str) else ""
        message = data.get("message") or data
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    frames.append(
                        {
                            "type": "tool_result",
                            "toolId": block.get("tool_use_id", "") or "",
                            "content": _resolve_tool_result_text(block.get("content")),
                            "isError": bool(block.get("is_error")),
                            "parentToolId": parent_id,
                        }
                    )
        return frames

    if kind == "control_request":
        # The CLI is asking the USER something (AskUserQuestion or a
        # can_use_tool permission prompt). Forward it verbatim — the CLI is
        # BLOCKED on stdin until we reply, so this must reach the live stream.
        frames.append(
            {
                "type": "control_request",
                "requestId": str(data.get("request_id") or ""),
                "request": data.get("request") or {},
            }
        )
        return frames

    if kind == "control_cancel_request":
        frames.append(
            {"type": "control_cancel", "requestId": str(data.get("request_id") or "")}
        )
        return frames

    if kind == "content_block_delta":
        delta = data.get("delta") or {}
        if delta.get("type") == "text_delta" and delta.get("text"):
            frames.append({"type": "text_delta", "text": delta["text"]})
        elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
            frames.append({"type": "thinking", "text": delta["thinking"]})
        return frames

    if kind == "result":
        usage = data.get("usage") or {}
        frame: dict = {
            "type": "done",
            "usage": {
                "input_tokens": usage.get("input_tokens", 0) or 0,
                "output_tokens": usage.get("output_tokens", 0) or 0,
                "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0) or 0,
                "cache_creation_input_tokens": (
                    usage.get("cache_creation_input_tokens", 0) or 0
                ),
            },
            "isError": bool(data.get("is_error")),
        }
        if isinstance(data.get("total_cost_usd"), (int, float)):
            frame["totalCostUsd"] = data["total_cost_usd"]
        if isinstance(data.get("duration_ms"), (int, float)):
            frame["durationMs"] = data["duration_ms"]
        if isinstance(data.get("num_turns"), int):
            frame["numTurns"] = data["num_turns"]
        frames.append(frame)
        return frames

    return frames


# ---------------------------------------------------------------------------
# stdin writes
# ---------------------------------------------------------------------------
def _write_stdin(session: ClaudeSession, payload: dict) -> bool:
    """Write one NDJSON control line. Synchronous so it is safe under cancel."""
    proc = session.proc
    if not _is_alive(proc):
        # A dead/closing child cannot answer; writing would raise or silently
        # vanish, and a late auto-deny must not resurrect a torn-down session.
        return False
    stdin = proc.stdin
    if stdin is None:
        return False
    try:
        stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        return True
    except Exception as exc:  # broken pipe / closing transport
        logger.warning(
            "[Claude] stdin write failed conv=%s: %s", session.conversation_id, exc
        )
        return False


async def _write_stdin_line(session: ClaudeSession, line: str) -> None:
    stdin = session.proc.stdin
    if stdin is None:
        raise RuntimeError("Claude CLI stdin is not available")
    if not line.endswith("\n"):
        line = line + "\n"
    stdin.write(line.encode("utf-8"))
    await stdin.drain()


def _write_control_response(
    session: ClaudeSession, request_id: str, response: dict
) -> bool:
    return _write_stdin(
        session,
        {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response,
            },
        },
    )


def _write_interrupt(session: ClaudeSession) -> bool:
    """Interrupt the running turn over stdin. The child is NOT killed."""
    session.interrupt_seq += 1
    return _write_stdin(
        session,
        {
            "type": "control_request",
            "request_id": f"int_{session.interrupt_seq}",
            "request": {"subtype": "interrupt"},
        },
    )


# ---------------------------------------------------------------------------
# Turn lifecycle
# ---------------------------------------------------------------------------
def _release_idle_waiters(session: ClaudeSession) -> None:
    """Wake every turn parked behind this session, in arrival order."""
    waiters = session.idle_waiters
    session.idle_waiters = []
    for waiter in waiters:
        if not waiter.done():
            waiter.set_result(None)


def _clear_pending_controls(session: ClaudeSession) -> None:
    """Cancel every pending control's auto-deny timer and forget the requests."""
    for entry in list(session.pending_controls.values()):
        task = entry.get("task")
        if task is not None and not task.done():
            task.cancel()
    session.pending_controls.clear()


def _touch_stall(session: ClaudeSession) -> None:
    session.stall_deadline = time.monotonic() + TURN_STALL_S


def _clear_stall(session: ClaudeSession) -> None:
    task = session.stall_task
    session.stall_task = None
    if task is not None and not task.done():
        task.cancel()


def _arm_stall(session: ClaudeSession) -> None:
    _clear_stall(session)
    _touch_stall(session)
    session.stall_task = asyncio.create_task(_stall_watchdog(session))


async def _stall_watchdog(session: ClaudeSession) -> None:
    """
    Inactivity watchdog. Sleeps to the current deadline; every stdout frame
    pushes that deadline out (``_touch_stall``), so a productive long task never
    trips it. Only true upstream silence does — then the wedged turn is
    interrupted and finished so the stream closes and the session goes idle.
    """
    try:
        while True:
            remaining = session.stall_deadline - time.monotonic()
            if remaining <= 0:
                break
            await asyncio.sleep(remaining)
    except asyncio.CancelledError:
        return
    session.stall_task = None
    if not session.busy:
        return
    logger.warning(
        "[Claude] turn STALL self-heal conv=%s (no stdout for %ss while busy)",
        session.conversation_id,
        int(TURN_STALL_S),
    )
    _write_interrupt(session)
    _finish_turn(session, via_close=True, via_stall=True)


def _finish_turn(
    session: ClaudeSession,
    *,
    via_close: bool,
    exit_code: Optional[int] = None,
    via_stall: bool = False,
) -> None:
    """
    End the in-flight turn: optionally emit a synthetic `done` (only when the
    child died or stalled without a `result`), detach the stream, mark idle and
    release the next queued turn. Does NOT kill the child.
    """
    if not session.busy and not via_close:
        return
    _clear_stall(session)
    if via_stall:
        # The turn is being abandoned: drop its bubbles so a late auto-deny can
        # never answer a request that belongs to a turn nobody is watching.
        _clear_pending_controls(session)
        _emit(session, {"type": "error", "message": STALL_MESSAGE})
    if via_close and session.active_queue is not None:
        if exit_code not in (None, 0) and session.stderr.strip():
            _emit(
                session,
                {
                    "type": "error",
                    "message": (
                        f"Claude CLI exited with code {exit_code}: "
                        f"{session.stderr[:500]}"
                    ),
                },
            )
        _emit(session, _synthetic_done(is_error=bool(via_stall or exit_code)))
    queue = session.active_queue
    session.active_queue = None
    session.busy = False
    session.last_activity = time.monotonic()
    # This turn ended WITHOUT consuming a matching `result` (close/stall), so
    # resync the result FIFO — otherwise result_gen lags turn_gen forever and
    # every subsequent result is drained as stale (cascading hangs).
    if via_close:
        session.result_gen = session.turn_gen
    if queue is not None:
        queue.put_nowait(None)
    _release_idle_waiters(session)


def _interrupt_active_turn(session: ClaudeSession, queue: asyncio.Queue) -> None:
    """
    Consumer went away mid-turn (client disconnect): interrupt the CLI but keep
    the child warm for the next turn. Synchronous — it runs while a
    CancelledError/GeneratorExit is in flight, where awaiting is not allowed.
    """
    if session.active_queue is not queue:
        return
    _clear_stall(session)
    # Same reason as the stall path: this turn's bubbles die with it, so their
    # auto-deny timers must not fire into the NEXT turn.
    _clear_pending_controls(session)
    _write_interrupt(session)
    session.active_queue = None
    session.busy = False
    session.last_activity = time.monotonic()
    session.result_gen = session.turn_gen
    _release_idle_waiters(session)


# ---------------------------------------------------------------------------
# stdout / stderr pumps
# ---------------------------------------------------------------------------
async def _handle_control_request(session: ClaudeSession, frame: dict) -> None:
    """
    Route a CLI control_request through the policy hook.

    The hook may return:

    * a control RESPONSE (a dict with ``behavior``) — written straight back to
      the CLI; no frame is emitted, so the user never sees a bubble;
    * a dict with a ``policy`` key — that policy is attached to the emitted C1
      ``control_request`` frame (contract C1's EXTENSION field);
    * ``None`` — the frame is emitted with no policy.

    Anything the user has to answer is registered in ``pending_controls`` and
    auto-denied if it goes unanswered, because the CLI blocks on stdin until it
    gets an answer.
    """
    request = frame.get("request") or {}
    request_id = frame.get("requestId") or ""
    policy: Optional[dict] = None
    hook = session.on_control_request
    if hook is not None and request.get("subtype") == "can_use_tool":
        try:
            # Bounded: the CLI is blocked on stdin until this request is
            # answered, so a hook that never returns would wedge the whole turn.
            # A timeout degrades to "ask the user", never to a silent allow.
            decision = await asyncio.wait_for(
                hook(session, request), CONTROL_HOOK_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            logger.warning(
                "[Claude] control policy hook timed out after %ss conv=%s — asking "
                "the user",
                CONTROL_HOOK_TIMEOUT_S,
                session.conversation_id,
            )
            decision = None
        except Exception:
            logger.exception(
                "[Claude] control policy hook failed conv=%s", session.conversation_id
            )
            decision = None
        if isinstance(decision, dict):
            if "behavior" in decision:
                _write_control_response(session, request_id, decision)
                return
            candidate = decision.get("policy")
            if isinstance(candidate, dict):
                policy = candidate
    if policy is not None:
        frame = {**frame, "policy": policy}
    # The answer has to come back under THIS session's key: a turn can run on a
    # session the request reached through its Claude session id, so the id the
    # browser holds is not always the one pending_controls lives under. Without
    # this an approval was refused (404, or 422 for no id at all) and the CLI
    # stayed blocked until the auto-deny.
    frame = {**frame, "conversationId": session.conversation_id}
    session.pending_controls[request_id] = {
        "request": request,
        "created": time.monotonic(),
        "task": None,
    }
    _emit(session, frame)
    session.pending_controls[request_id]["task"] = asyncio.create_task(
        _auto_deny_later(session, request_id)
    )


async def _auto_deny_later(session: ClaudeSession, request_id: str) -> None:
    try:
        await asyncio.sleep(PENDING_CONTROL_TIMEOUT_S)
    except asyncio.CancelledError:
        return
    if session.pending_controls.pop(request_id, None) is None:
        return
    logger.warning(
        "[Claude] auto-denying unanswered control %s conv=%s",
        request_id,
        session.conversation_id,
    )
    _write_control_response(
        session, request_id, {"behavior": "deny", "message": AUTO_DENY_MESSAGE}
    )


async def handle_stdout_line(session: ClaudeSession, data: Any, raw_line: str) -> None:
    """Route ONE parsed stdout line's frames to the live turn."""
    raw_type = data.get("type") if isinstance(data, dict) else None

    # A control_response FROM the CLI answers a UI-initiated control_request
    # (get_context_usage / set_permission_mode). It belongs to its waiter, not
    # to the turn's stream.
    if raw_type == "control_response":
        response = (data.get("response") or {}) if isinstance(data, dict) else {}
        request_id = response.get("request_id")
        waiter = control_waiters.pop(request_id, None) if request_id else None
        if waiter is not None and not waiter.done():
            waiter.set_result(response)
        return

    inner = data.get("event", data) if raw_type == "stream_event" else data
    inner_type = inner.get("type") if isinstance(inner, dict) else None
    if inner_type in ("result", "error", "assistant", "system"):
        logger.debug("[claude_session] raw %s: %s", inner_type, raw_line[:700])

    for frame in parse_claude_event(data):
        kind = frame["type"]

        if kind == "session_id":
            sid = frame.get("sessionId")
            if sid:
                known_claude_sessions.add(sid)
                session.claude_session_id = sid
                sid_to_conversation[sid] = session.conversation_id
                session.aliased_sids.add(sid)
            _emit(session, frame)
            continue

        if kind == "done":
            # The `done` frame derives from the CLI's `result`, which carries no
            # turn identity. Match it FIFO against the turn generation, and
            # CLAMP so a trailing result can never push the FIFO past the turn
            # counter (that would make the next real result look stale).
            session.result_gen = min(session.result_gen + 1, session.turn_gen)
            if session.busy and session.result_gen == session.turn_gen:
                _emit(session, frame)
                _finish_turn(session, via_close=False)
            else:
                logger.info(
                    "[Claude] draining stale result conv=%s resultGen=%s turnGen=%s "
                    "busy=%s",
                    session.conversation_id,
                    session.result_gen,
                    session.turn_gen,
                    session.busy,
                )
            continue

        if kind == "control_request":
            await _handle_control_request(session, frame)
            continue

        if kind == "control_cancel":
            # The CLI retracted a prompt (already answered / superseded). Drop
            # the pending entry and its auto-deny timer BEFORE telling the UI,
            # so the timer can never answer a request the CLI has withdrawn.
            entry = session.pending_controls.pop(frame.get("requestId", ""), None)
            if entry is not None:
                task = entry.get("task")
                if task is not None and not task.done():
                    task.cancel()
            _emit(session, frame)
            continue

        _emit(session, frame)


async def _read_stdout(session: ClaudeSession, proc: Any) -> None:
    """
    Pump the child's stdout: chunk -> incremental UTF-8 decode -> NDJSON lines.

    Reads in chunks (not ``readline``) so a single oversized JSON line can never
    raise ``LimitOverrunError`` and desynchronize the stream. Every handler
    carries a stale-proc guard so a respawned session's OLD child no-ops.
    """
    stream = proc.stdout
    if stream is None:
        return
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    try:
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                break
            if session.proc is not proc:
                return
            if session.busy:
                _touch_stall(session)
            session.stdout_buf += decoder.decode(chunk)
            while "\n" in session.stdout_buf:
                line, _, rest = session.stdout_buf.partition("\n")
                session.stdout_buf = rest
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                try:
                    await handle_stdout_line(session, data, line)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception(
                        "[Claude] stdout handler threw conv=%s",
                        session.conversation_id,
                    )
    except asyncio.CancelledError:
        return
    if session.proc is not proc:
        return
    await _on_child_closed(session, proc)


async def _read_stderr(session: ClaudeSession, proc: Any) -> None:
    stream = proc.stderr
    if stream is None:
        return
    try:
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                return
            if session.proc is not proc:
                return
            text = chunk.decode("utf-8", errors="replace")
            session.stderr = (session.stderr + text)[-4000:]
    except asyncio.CancelledError:
        return


async def _on_child_closed(session: ClaudeSession, proc: Any) -> None:
    if sessions.get(session.conversation_id) is not session:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=2.0)
    except (asyncio.TimeoutError, ProcessLookupError):
        pass
    code = proc.returncode
    logger.info(
        "[Claude] child closed conv=%s code=%s busy=%s",
        session.conversation_id,
        code,
        session.busy,
    )
    if session.busy:
        _finish_turn(session, via_close=True, exit_code=code)
    await teardown(session.conversation_id, kill=False)


def _attach_readers(session: ClaudeSession) -> None:
    proc = session.proc
    session.reader_task = asyncio.create_task(_read_stdout(session, proc))
    session.stderr_task = asyncio.create_task(_read_stderr(session, proc))


# ---------------------------------------------------------------------------
# Process lifecycle
# ---------------------------------------------------------------------------
async def _spawn_proc(args: list[str]) -> Any:
    argv = build_spawn_argv(args)
    # child_env: the launch token must never reach the CLI, nor the stdio MCP
    # servers it spawns in turn — any of them could forge the backend's header.
    env = child_env()
    env["NO_COLOR"] = "1"
    return await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=STDOUT_LIMIT,
        cwd=str(REPO_ROOT),
        env=env,
    )


async def _kill_proc(proc: Any) -> None:
    """
    Terminate a child and its tree.

    On Windows the child is a ``cmd.exe`` shim that spawns the real CLI (which
    spawns the MCP servers), so only ``taskkill /T /F`` reaches the whole tree.
    """
    if proc is None or proc.returncode is not None:
        return
    try:
        if proc.stdin is not None:
            proc.stdin.close()
    except Exception:
        pass
    if sys.platform == "win32" and proc.pid:
        try:
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(proc.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=child_env(),
            )
            await asyncio.wait_for(killer.wait(), timeout=10.0)
        except (OSError, asyncio.TimeoutError) as exc:
            logger.warning("[Claude] taskkill failed pid=%s: %s", proc.pid, exc)
    else:
        try:
            proc.terminate()
        except ProcessLookupError:
            return
    try:
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (asyncio.TimeoutError, ProcessLookupError):
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass


async def _reap_lru_if_needed() -> None:
    """
    Keep under the live-children cap by reaping the least-recently-used IDLE
    session. Never reaps a busy session — a brief overflow beats killing an
    active turn.
    """
    while len(sessions) >= MAX_SESSIONS:
        oldest: Optional[ClaudeSession] = None
        for candidate in sessions.values():
            if candidate.busy:
                continue
            if oldest is None or candidate.last_activity < oldest.last_activity:
                oldest = candidate
        if oldest is None:
            return
        logger.info(
            "[Claude] LRU-reaping idle session conv=%s (cap %s)",
            oldest.conversation_id,
            MAX_SESSIONS,
        )
        await teardown(oldest.conversation_id, kill=True)


async def spawn(
    conversation_id: str,
    model: str,
    effort: str,
    permission_mode: str,
    claude_session_id: Optional[str] = None,
    *,
    port: int,
    extra_servers: Optional[dict] = None,
    fallback_model: Optional[str] = None,
    use_user_config: bool = False,
    always_allow: tuple[str, ...] = (),
) -> ClaudeSession:
    """Spawn a fresh persistent child for a conversation and register it."""
    await _reap_lru_if_needed()
    relay_id = str(uuid.uuid4())
    mcp_config_path = str(Path(tempfile.gettempdir()) / f"thedaw-mcp-{relay_id}.json")
    # Only resume an id THIS process minted — a stale browser id 404s the turn.
    resume = _is_uuid_like(claude_session_id) and (
        claude_session_id in known_claude_sessions
    )
    args = build_base_args(
        model,
        effort,
        permission_mode,
        fallback_model=fallback_model,
        use_user_config=use_user_config,
    )
    rules_key = permission_rules_key(
        permission_mode, use_user_config=use_user_config, always_allow=always_allow
    )
    try:
        # First, so a failed write leaves nothing else behind to clean up.
        args += _permission_settings_args(
            relay_id,
            permission_mode,
            use_user_config=use_user_config,
            always_allow=always_allow,
        )
    except OSError:
        _unlink_permission_settings(relay_id)
        raise
    mcp_args, written = _mcp_config_args(
        relay_id,
        mcp_config_path,
        port=port,
        extra_servers=extra_servers,
        use_user_config=use_user_config,
    )
    args += mcp_args
    if resume and claude_session_id:
        args += ["--resume", claude_session_id]
    try:
        proc = await _spawn_proc(args)
    except BaseException:
        # No session will exist to own these files, so teardown would never
        # unlink them — every failed (or cancelled) spawn would leak otherwise.
        # BaseException: NotImplementedError (no subprocess support on this
        # loop) and cancellation must clean up exactly like OSError does.
        _unlink_quietly(mcp_config_path)
        _unlink_quietly(_fallback_config_path(relay_id))
        _unlink_permission_settings(relay_id)
        raise
    # Exactly one INFO line per child spawn, emitted once the child exists so it
    # can carry the real pid (the live proof greps for this wording).
    logger.info(
        "[claude_session] spawned persistent child conv=%s pid=%s resume=%s "
        "relay=%s model=%s effort=%s mode=%s user_config=%s",
        conversation_id,
        proc.pid,
        resume,
        relay_id,
        model,
        effort,
        permission_mode,
        use_user_config,
    )
    session = ClaudeSession(
        proc=proc,
        relay_id=relay_id,
        conversation_id=conversation_id,
        model=model,
        effort=effort,
        permission_mode=permission_mode,
        use_user_config=use_user_config,
        permission_rules_key=rules_key,
        claude_session_id=claude_session_id if resume else None,
        mcp_config_path=mcp_config_path,
        mcp_config_written=written,
        mcp_error_pending=not written,
        last_activity=time.monotonic(),
        first_turn_pending=not resume,
    )
    sessions[conversation_id] = session
    if resume and claude_session_id:
        sid_to_conversation[claude_session_id] = conversation_id
        session.aliased_sids.add(claude_session_id)
    _attach_readers(session)
    _ensure_reaper()
    return session


async def _respawn(
    session: ClaudeSession,
    model: str,
    effort: str,
    permission_mode: str,
    fallback_model: Optional[str] = None,
    *,
    port: int,
    extra_servers: Optional[dict] = None,
    use_user_config: bool = False,
    always_allow: tuple[str, ...] = (),
) -> None:
    """
    Respawn a session's child in place (model / effort / permission-mode change,
    or the user switching "Use my Claude settings and MCP servers").

    ``session.proc`` is swapped to the NEW child BEFORE the old one is killed, so
    the old child's late handlers hit the stale-proc guard and no-op. relay_id
    and mcp_config_path are reused, so relay routing survives the swap.

    The permission rules are written for the new mode (see
    ``permission_rules``), and the MCP config is re-written on every respawn:
    a spawn whose config write
    failed gets its relay back as soon as a retry succeeds, and a retry that
    still fails re-arms the "relay unavailable" warning for the new child.
    """
    old_proc = session.proc
    sid = session.claude_session_id
    can_resume = _is_uuid_like(sid) and sid in known_claude_sessions
    args = build_base_args(
        model,
        effort,
        permission_mode,
        fallback_model=fallback_model,
        use_user_config=use_user_config,
    )
    # Raises before anything changed, so the session stays whole on its old
    # child (see the spawn-first note below).
    rules_key = permission_rules_key(
        permission_mode, use_user_config=use_user_config, always_allow=always_allow
    )
    args += _permission_settings_args(
        session.relay_id,
        permission_mode,
        use_user_config=use_user_config,
        always_allow=always_allow,
    )
    mcp_args, written = _mcp_config_args(
        session.relay_id,
        session.mcp_config_path,
        port=port,
        extra_servers=extra_servers,
        use_user_config=use_user_config,
    )
    args += mcp_args
    if can_resume and sid:
        args += ["--resume", sid]
    previous_model = session.model
    previous_effort = session.effort
    # Spawn FIRST: if this raises the session is still whole on its old child,
    # with its readers attached, so a failed respawn cannot strand a session.
    new_proc = await _spawn_proc(args)
    for task in (session.reader_task, session.stderr_task):
        if task is not None and not task.done():
            task.cancel()
    session.proc = new_proc  # swap BEFORE kill
    session.mcp_config_written = written
    session.mcp_error_pending = not written
    # Exactly one INFO line per respawn, emitted once the new child exists so it
    # can carry the real pid (the live proof greps for this wording).
    logger.info(
        "[claude_session] respawned persistent child conv=%s pid=%s resume=%s "
        "relay=%s model=%s->%s effort=%s->%s mode=%s->%s user_config=%s->%s",
        session.conversation_id,
        session.proc.pid,
        can_resume,
        session.relay_id,
        previous_model,
        model,
        previous_effort,
        effort,
        session.permission_mode,
        permission_mode,
        session.use_user_config,
        use_user_config,
    )
    session.model = model
    session.effort = effort
    session.permission_mode = permission_mode
    session.use_user_config = use_user_config
    session.permission_rules_key = rules_key
    session.stdout_buf = ""
    session.stderr = ""
    session.first_turn_pending = not can_resume
    # The old child is about to die; any unconsumed `result` it owed will never
    # increment result_gen, so resync the FIFO for the next turn.
    session.result_gen = session.turn_gen
    _attach_readers(session)
    await _kill_proc(old_proc)


async def resolve_live(
    conversation_id: Optional[str], claude_session_id: Optional[str] = None
) -> Optional[ClaudeSession]:
    """Resolve a LIVE session by conversation id, or by Claude's session id."""
    session: Optional[ClaudeSession] = None
    if conversation_id:
        session = sessions.get(conversation_id)
    if session is None and claude_session_id:
        cid = sid_to_conversation.get(claude_session_id)
        if cid:
            session = sessions.get(cid)
    if session is not None and not _is_alive(session.proc):
        logger.info("[Claude] discarding dead session conv=%s", session.conversation_id)
        await teardown(session.conversation_id, kill=True)
        return None
    return session


async def teardown(conversation_id: str, kill: bool) -> None:
    """
    Fully dispose a session: end any in-flight turn, cancel its tasks,
    (optionally) kill the child, unlink its MCP config and drop every
    registration. Idempotent.
    """
    session = sessions.pop(conversation_id, None)
    if session is None:
        return
    _clear_stall(session)
    _clear_pending_controls(session)
    if session.busy or session.active_queue is not None:
        _finish_turn(session, via_close=True)
    session.busy = False
    _release_idle_waiters(session)
    current = asyncio.current_task()
    for task in (session.reader_task, session.stderr_task):
        if task is not None and task is not current and not task.done():
            task.cancel()
    if kill:
        await _kill_proc(session.proc)
    # This session's runtime temp files: the per-session config, the per-relay
    # fail-closed fallback (present only if a write ever failed) and the
    # permission rules of every mode its children ran in.
    _unlink_quietly(session.mcp_config_path)
    _unlink_quietly(_fallback_config_path(session.relay_id))
    _unlink_permission_settings(session.relay_id)
    for sid in session.aliased_sids:
        sid_to_conversation.pop(sid, None)
    # NOTE: the creation lock is deliberately NOT dropped here — see
    # `_conversation_lock_users`. Its lifetime belongs to the turns using it.
    # Exactly one INFO line per teardown; an unknown conversation returned above
    # without logging (the live proof greps for this wording).
    logger.info(
        "[claude_session] torn down conv=%s kill=%s relay=%s",
        conversation_id,
        kill,
        session.relay_id,
    )


async def kill_all() -> None:
    """Tear every session down (shutdown / test cleanup)."""
    global _reaper_task
    task = _reaper_task
    _reaper_task = None
    if task is not None and not task.done():
        task.cancel()
    # Concurrently: each kill can wait up to ~10s on taskkill, so a sequential
    # sweep of 8 sessions could hold shutdown for over a minute. teardown pops
    # its session before its first await, so concurrent teardowns of different
    # conversations never touch the same entry.
    results = await asyncio.gather(
        *(teardown(cid, kill=True) for cid in list(sessions.keys())),
        return_exceptions=True,
    )
    for result in results:
        if isinstance(result, BaseException):
            logger.warning(
                "[claude_session] teardown failed during kill_all: %r", result
            )
    sessions.clear()
    # Drop every lock no turn is using. A lock held by an in-flight claim (a turn
    # mid-resolve/park/spawn) must SURVIVE: dropping it lets the next turn mint a
    # second lock and spawn a second child for the same conversation — the very
    # orphan the lock exists to prevent — and no re-fetch can rescue a turn that
    # is already inside `async with`. The claim refcount is left intact for the
    # same reason; in-use entries vanish on their own when their last claimant
    # exits. (Unused locks are dropped so none outlive the loop that made them.)
    for conversation_id in list(_conversation_locks):
        if _conversation_lock_users.get(conversation_id, 0) <= 0:
            _conversation_locks.pop(conversation_id, None)


def _ensure_reaper() -> None:
    """Start (or re-bind) the idle reaper on the CURRENT event loop."""
    global _reaper_task
    loop = asyncio.get_running_loop()
    task = _reaper_task
    if task is not None and not task.done():
        try:
            if task.get_loop() is loop:
                return
        except RuntimeError:
            pass
        task.cancel()
    _reaper_task = loop.create_task(_idle_reaper())


async def _idle_reaper() -> None:
    """Kill sessions idle beyond SESSION_IDLE_S. Never reaps a busy one."""
    try:
        while True:
            await asyncio.sleep(REAP_INTERVAL_S)
            now = time.monotonic()
            for conversation_id, session in list(sessions.items()):
                if session.busy:
                    continue
                if now - session.last_activity > SESSION_IDLE_S:
                    logger.info(
                        "[Claude] reaping idle session conv=%s", conversation_id
                    )
                    await teardown(conversation_id, kill=True)
    except asyncio.CancelledError:
        return


# ---------------------------------------------------------------------------
# Control plane (browser -> CLI)
# ---------------------------------------------------------------------------
def answer_control(conversation_id: str, request_id: str, response: dict) -> bool:
    """
    Answer a pending CLI control_request.

    Returns False when the conversation is unknown, or when ``request_id`` is
    not pending for THAT conversation (so a route can answer 404/403).
    """
    session = sessions.get(conversation_id)
    if session is None:
        return False
    entry = session.pending_controls.pop(request_id, None)
    if entry is None:
        return False
    task = entry.get("task")
    if task is not None and not task.done():
        task.cancel()
    return _write_control_response(session, request_id, response)


async def send_control_request(
    conversation_id: str,
    request: dict,
    timeout: float = CONTROL_RESPONSE_TIMEOUT_S,
) -> Optional[dict]:
    """Send a UI-initiated control_request and await the CLI's response."""
    session = sessions.get(conversation_id)
    if session is None:
        return None
    request_id = f"req_{uuid.uuid4().hex[:12]}"
    waiter: asyncio.Future = asyncio.get_running_loop().create_future()
    control_waiters[request_id] = waiter
    payload = {
        "type": "control_request",
        "request_id": request_id,
        "request": request,
    }
    if not _write_stdin(session, payload):
        control_waiters.pop(request_id, None)
        return None
    try:
        return await asyncio.wait_for(waiter, timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        control_waiters.pop(request_id, None)
        return None


def interrupt(conversation_id: str) -> bool:
    """Interrupt the running turn without killing the child."""
    session = sessions.get(conversation_id)
    if session is None:
        return False
    return _write_interrupt(session)


# ---------------------------------------------------------------------------
# One turn
# ---------------------------------------------------------------------------
async def stream_turn(
    conversation_id: str,
    *,
    prompt_ndjson_line: str,
    first_turn_seed: Optional[str] = None,
    model: str,
    effort: str,
    permission_mode: str = "ask",
    claude_session_id: Optional[str] = None,
    port: int,
    extra_servers: Optional[dict] = None,
    on_control_request: Optional[ControlHook] = None,
    fallback_model: Optional[str] = None,
    use_user_config: bool = False,
    always_allow: tuple[str, ...] = (),
) -> AsyncIterator[str]:
    """
    Run ONE chat turn on the conversation's persistent session, yielding SSE
    lines (``data: {...}`` frames and ``: ping`` keepalives) until the turn ends.

    ``prompt_ndjson_line`` is the complete NDJSON user line to write (build it
    with :func:`build_user_ndjson_line`). ``first_turn_seed``, when given, is
    written INSTEAD on the first turn of a fresh (non-resumed) child — that is
    where a caller seeds the system instruction and prior transcript, which a
    warm child already remembers.

    ``use_user_config`` selects the user's own Claude settings and MCP servers
    over the isolated setup (see ``build_base_args`` / ``_mcp_config_args``). It
    is fixed at spawn, so a turn that asks for the other value respawns the
    child, exactly like a model change.

    ``always_allow`` lists the allow rules the user marked "always allow"
    (``permission_rules``). The child is respawned whenever the rules it would
    get now differ from the ones it was given.

    stdin is never closed. The child is never killed here: a consumer that
    disappears mid-turn (client disconnect) interrupts the turn and leaves the
    child warm for the next one.
    """
    conversation_id = (conversation_id or "").strip()
    # Canonicalize the conversation key with NO side effects, so every
    # concurrent turn for this conversation takes the same creation lock below.
    if conversation_id not in sessions and claude_session_id:
        mapped = sid_to_conversation.get(claude_session_id)
        if mapped:
            conversation_id = mapped
    if not conversation_id:
        conversation_id = str(uuid.uuid4())
        logger.info("[claude_session] minted conversationId=%s", conversation_id)
        yield _sse({"type": "conversationId", "conversationId": conversation_id})

    # Resolve-or-create, then claim the turn slot — all under the per-conversation
    # lock, because every step in between (respawn, spawn) awaits. A turn that
    # finds the session busy parks in the FIFO idle-waiter list and re-enters the
    # lock when woken; whoever gets the lock first claims the slot and the rest
    # re-park. Parking happens OUTSIDE the lock so queued turns keep pinging and
    # a third turn is never blocked from even resolving.
    #
    # The claim-phase refcount keeps this conversation's lock alive (and shared)
    # for as long as ANY turn is resolving/parked/claiming, and the lock is
    # re-fetched on every pass so a turn can never hold a stale object.
    session: Optional[ClaudeSession] = None
    queue: Optional[asyncio.Queue] = None
    announced_queue = False
    _enter_claim(conversation_id)
    try:
        while True:
            parked: Optional[tuple[ClaudeSession, asyncio.Future]] = None
            fatal: Optional[str] = None
            # Re-fetched every pass. An uncontended acquire does not yield, and
            # the refcount above guarantees every concurrent turn gets the same
            # object here, so fetch + acquire can never straddle a split.
            lock = _conversation_lock(conversation_id)
            async with lock:
                session = await resolve_live(conversation_id, claude_session_id)
                if session is not None and session.busy:
                    waiter: asyncio.Future = asyncio.get_running_loop().create_future()
                    session.idle_waiters.append(waiter)
                    parked = (session, waiter)
                else:
                    try:
                        # Model / effort / permission-mode / user-config
                        # switch -> respawn.
                        if session is not None and (
                            session.model != model
                            or session.effort != effort
                            or session.permission_mode != permission_mode
                            or session.use_user_config != use_user_config
                            or session.permission_rules_key
                            != permission_rules_key(
                                permission_mode,
                                use_user_config=use_user_config,
                                always_allow=always_allow,
                            )
                        ):
                            await _respawn(
                                session,
                                model,
                                effort,
                                permission_mode,
                                fallback_model,
                                port=port,
                                extra_servers=extra_servers,
                                use_user_config=use_user_config,
                                always_allow=always_allow,
                            )
                        if session is None:
                            session = await spawn(
                                conversation_id,
                                model,
                                effort,
                                permission_mode,
                                claude_session_id,
                                port=port,
                                extra_servers=extra_servers,
                                fallback_model=fallback_model,
                                use_user_config=use_user_config,
                                always_allow=always_allow,
                            )
                    except Exception as exc:
                        # Any failure to start the CLI is a turn error, never an
                        # exception out of the stream: OSError (missing binary),
                        # NotImplementedError (a loop without subprocess
                        # support), etc. CancelledError is BaseException and
                        # still propagates. spawn() already removed its files.
                        logger.warning(
                            "[claude_session] spawn failed conv=%s: %r",
                            conversation_id,
                            exc,
                        )
                        fatal = f"Failed to start Claude CLI: {exc}"
                        session = None
                    if session is not None:
                        if (
                            session.proc is None
                            or session.proc.stdin is None
                            or session.proc.stdout is None
                        ):
                            await teardown(conversation_id, kill=True)
                            fatal = "Failed to capture Claude CLI stdio"
                            session = None
                        else:
                            # Claim the slot with NO await between the busy
                            # check and the claim, so no other turn can take it.
                            session.on_control_request = on_control_request
                            queue = asyncio.Queue()
                            session.active_queue = queue
                            session.busy = True
                            # Open a new turn generation: this turn's trailing
                            # `result` FIFO-matches result_gen == turn_gen; a
                            # stale one from a prior turn is drained.
                            session.turn_gen += 1
                            session.last_activity = time.monotonic()
                            _arm_stall(session)

            if fatal is not None:
                yield _sse({"type": "error", "message": fatal})
                yield _sse(_synthetic_done(is_error=True))
                return
            if parked is None:
                break

            parked_session, waiter = parked
            if not announced_queue:
                announced_queue = True
                yield _sse(
                    {
                        "type": "status",
                        "message": "Queued — finishing the current turn first…",
                    }
                )
            # Keep the SAME waiter (and so the same place in the FIFO) across
            # heartbeats. Re-queueing on every ping would move this turn behind
            # everything that arrived after it.
            try:
                while True:
                    done, _pending = await asyncio.wait({waiter}, timeout=HEARTBEAT_S)
                    if done:
                        break
                    # Self-heal: if the slot went idle or the session was
                    # replaced without anyone waking us, go re-resolve instead of
                    # waiting forever.
                    if (
                        not parked_session.busy
                        or sessions.get(conversation_id) is not parked_session
                    ):
                        break
                    yield _ping()
            finally:
                if waiter in parked_session.idle_waiters:
                    parked_session.idle_waiters.remove(waiter)
                waiter.cancel()
    finally:
        _exit_claim(conversation_id)

    if session.mcp_error_pending:
        # The child was spawned without the relay because its per-session
        # config could not be written (fail-closed, with an empty strict MCP
        # allowlist, when the session is isolated).
        session.mcp_error_pending = False
        yield _sse({"type": "error", "message": MCP_UNAVAILABLE_MESSAGE})

    line = prompt_ndjson_line
    if session.first_turn_pending and first_turn_seed:
        line = first_turn_seed
    session.first_turn_pending = False

    try:
        await _write_stdin_line(session, line)
    except Exception as exc:
        logger.warning(
            "[Claude] failed to write user turn conv=%s: %s", conversation_id, exc
        )
        _clear_stall(session)
        session.active_queue = None
        session.busy = False
        session.result_gen = session.turn_gen
        # Tear down BEFORE any queued turn can run: teardown unregisters the
        # session before its first await and only then wakes the waiters, so a
        # woken turn re-resolves to "no session" and spawns a fresh child. Waking
        # them first (then yielding to the consumer, which in production awaits
        # send() per chunk) let a queued turn claim this dying child and then be
        # killed with it by the teardown below.
        await teardown(conversation_id, kill=True)
        yield _sse(
            {"type": "error", "message": f"Failed to write to Claude CLI: {exc}"}
        )
        yield _sse(_synthetic_done(is_error=True))
        return

    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), HEARTBEAT_S)
            except asyncio.TimeoutError:
                yield _ping()
                continue
            if item is None:
                break
            yield item
    except (asyncio.CancelledError, GeneratorExit):
        logger.info(
            "[Claude] consumer left mid-turn conv=%s — interrupting (child kept)",
            conversation_id,
        )
        _interrupt_active_turn(session, queue)
        raise
