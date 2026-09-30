"""Permission policy for the Claude Code assistant provider.

Single policy point for the CLI's ``can_use_tool`` control requests. Pure
logic: no filesystem access, no network, no imports from the FastAPI layer.

Requests arrive as ``{tool_name, input, tool_use_id, ...}``. This module
answers three questions about such a request:

* what *kind* of tool is it (``classify``);
* does it touch the assistant's own surface (``self_modify_path``);
* given the user's mode and session state, allow / deny / ask (``decide``).

KNOWN LIMITATION (G5 round 5 item 2, revised G5 batch-11 fixup after audit
round 5 pushback): the no-filesystem invariant above means this module
compares path STRINGS, never the files those strings actually name on disk.
A junction or symlink created inside the repo (e.g. ``C:\\tmp\\x``
junctioned to ``backend``) points a path that reads as completely unrelated
-- ``C:\\tmp\\x\\rag.py`` -- at the real self-surface file, and no
candidate here will ever match a self-surface glob for it. In ``trusted``
mode a ``Bash`` command creating such a junction is itself allowed (no
candidate matches a self-surface glob), after which a ``Write``/``Edit``
through the junction reads as an ordinary, unrelated path and resolves to
``allow``.

This is still deliberately NOT resolved here, but not for the reasons
previously given -- those did not hold up under audit: resolution is only
ever needed for ``edit``-kind candidates (one or two
``file_path``/``notebook_path`` values per request, never the bulk of
traffic), and only on a decision that is about to either block on a human
or perform the write anyway, so a handful of ``realpath`` calls there is
not meaningfully "synchronous disk I/O on the hot path". Nor is a raced
check a reason not to check -- a TOCTOU race beats the current state, which
is a GUARANTEED bypass, not a raced one. The one objection that does hold
is the pure-string contract: this module and its (already extensive) test
suite are deliberately filesystem-free, and resolving here would mean
stubbing the filesystem throughout that suite. The fix is to resolve in
the CALLER instead -- ``assistant_routes.py`` on the Python side,
``claude-bridge.ts`` (around its ``can_use_tool`` dispatch, currently line
829) on the TypeScript side -- and pass an already-resolved
``file_path``/``notebook_path`` in, leaving this module and its test suite
pure. That caller-side resolution is the intended future fix; it has not
been implemented yet.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Mode = Literal["ask", "accept_edits", "readonly", "trusted"]
Kind = Literal["read", "edit", "shell", "agent", "mcp", "other"]
Action = Literal["allow", "deny", "ask"]

MODES: tuple[Mode, ...] = ("ask", "accept_edits", "readonly", "trusted")

READ_TOOLS = {
    "Read",
    "Grep",
    "Glob",
    "LS",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "NotebookRead",
}
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SHELL_TOOLS = {"Bash", "PowerShell"}
AGENT_TOOLS = {"Agent", "Task"}

#: Baseline ``--allowedTools`` list handed to the CLI at spawn time. Ordered,
#: because it becomes argv. Same membership as :data:`READ_TOOLS`.
READ_BASELINE_TOOLS: tuple[str, ...] = (
    "Read",
    "Grep",
    "Glob",
    "LS",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "NotebookRead",
)

#: Paths whose modification changes the assistant's own tool surface.
SELF_SURFACE_GLOBS = [
    "backend/assistant_routes.py",
    "backend/modules/assistant/**",
    "frontend/src/orb-kit/**",
    "backend/rag.py",
]

#: Paths whose modification requires a backend restart to take effect.
BACKEND_RESTART_GLOBS = ["backend/**/*.py"]

#: MCP tool leaf names with one of these prefixes are treated as reads. The
#: trailing boundary keeps ``getaway_write`` / ``listen_and_delete`` out.
_MCP_READ_PREFIX = re.compile(r"^(get|list|read|status|search|find|describe)(?:_|$)")

_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:/")

#: A genuine Windows drive path spelled with backslashes (``C:\proj\...``),
#: used only to exempt such candidates from the shell backslash-as-escape
#: variant in ``_token_variants`` -- see its comment.
_WINDOWS_DRIVE_BACKSLASH = re.compile(r"^[A-Za-z]:\\")

#: Git-Bash / MSYS path form (``/c/Users/...``): a single drive-letter segment
#: right after the root slash. Deliberately narrow -- exactly one letter
#: between the two slashes -- so a real single-letter POSIX directory
#: (``/a/b``, two+ letters) never gets misread as a drive.
_GIT_BASH_DRIVE_PATH = re.compile(r"^/([A-Za-z])/(.*)$")

#: Win32 long-path prefix, ONLY the drive-letter form (``\\?\C:\...`` ->
#: ``//?/C:/...``). Deliberately excludes the UNC (``\\?\UNC\...``) and raw
#: device (``\\?\GLOBALROOT\...``) forms -- see ``_repo_relative``'s comment.
_WIN32_LONG_PATH_DRIVE_PREFIX = re.compile(r"^//\?/[A-Za-z]:/")

# CRITICAL: every mode maps to "default", not to the CLI's own acceptEdits /
# bypassPermissions. A live proof against the installed CLI (2.1.278) showed
# that under "bypassPermissions" and "acceptEdits" the CLI auto-approves
# tools ITSELF and never emits a control_request at all -- so decide() never
# runs, and a self-modify write (which decide() must always turn into "ask",
# in every mode) sails straight through ungoverned. "default" is the only CLI
# mode that asks the host (via --permission-prompt-tool stdio) for EVERY
# tool, which is what lets decide() be the sole authority on the verdict for
# every one of theDAW's four modes. Do not reintroduce acceptEdits/
# bypassPermissions here without re-running that live proof.
_CLI_PERMISSION_MODES: dict[str, str] = {
    "ask": "default",
    "accept_edits": "default",
    "readonly": "default",
    "trusted": "default",
}


@dataclass(frozen=True)
class Decision:
    """The policy verdict for one ``can_use_tool`` request."""

    kind: Kind
    action: Action
    reason: str
    self_modify: bool
    self_modify_path: str | None
    backend_restart: bool


def cli_permission_mode(mode: str) -> str:
    """Map a theDAW permission mode onto the CLI's ``--permission-mode`` value."""
    try:
        return _CLI_PERMISSION_MODES[mode]
    except KeyError:
        raise ValueError(f"unknown permission mode: {mode!r}") from None


def classify(tool_name: str, input: dict) -> Kind:  # noqa: A002 - contract name
    """Return the policy kind for a tool request."""
    del input  # kind depends on the tool name alone today
    name = (tool_name or "").strip()
    if name in READ_TOOLS:
        return "read"
    if name in EDIT_TOOLS:
        return "edit"
    if name in SHELL_TOOLS:
        return "shell"
    if name in AGENT_TOOLS:
        return "agent"
    if name.startswith("mcp__"):
        leaf = name.split("__", 2)[2] if name.count("__") >= 2 else ""
        if _MCP_READ_PREFIX.match(leaf):
            return "read"
        return "mcp"
    return "other"


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    out: list[str] = []
    i = 0
    length = len(pattern)
    while i < length:
        char = pattern[i]
        if char == "*":
            if pattern[i : i + 3] == "**/":
                out.append("(?:[^/]+/)*")
                i += 3
                continue
            if pattern[i : i + 2] == "**":
                # G5 round 6 item 2: a trailing "/**" originally compiled to
                # "/.*" -- which requires a literal "/" after the prefix, so
                # the bare directory itself ("backend/modules/assistant",
                # no trailing slash, e.g. as an `rm -rf` argument) never
                # matched even though every file *inside* it did. Emitting
                # "(?:/.*)?" for a trailing "/**" makes the directory node
                # match too, without changing any other "**" occurrence
                # (mid-pattern "**" still becomes plain ".*").
                if i + 2 == length and out and out[-1] == "/":
                    out.pop()
                    out.append("(?:/.*)?")
                else:
                    out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
            i += 1
            continue
        if char == "?":
            out.append("[^/]")
            i += 1
            continue
        out.append(re.escape(char))
        i += 1
    return re.compile("^" + "".join(out) + "$")


_SELF_SURFACE_RE = [_glob_to_regex(p) for p in SELF_SURFACE_GLOBS]
_BACKEND_RESTART_RE = [_glob_to_regex(p) for p in BACKEND_RESTART_GLOBS]
_SELF_SURFACE_RE_CI = [re.compile(rx.pattern, re.IGNORECASE) for rx in _SELF_SURFACE_RE]
_BACKEND_RESTART_RE_CI = [
    re.compile(rx.pattern, re.IGNORECASE) for rx in _BACKEND_RESTART_RE
]


def _case_insensitive(repo_root: Path) -> bool:
    """Whether the repo lives on a case-insensitive (Windows) filesystem.

    NTFS resolves ``Backend/RAG.py`` to ``backend/rag.py``, so a case-sensitive
    glob match there would let a mixed-case path skip the self-modify bubble.
    A drive-letter root is a Windows path wherever this code happens to run.
    """
    if sys.platform == "win32":
        return True
    root = str(repo_root).replace("\\", "/").rstrip("/") + "/"
    return bool(_WINDOWS_DRIVE.match(root))


def _is_self_surface(rel: str, insensitive: bool) -> bool:
    patterns = _SELF_SURFACE_RE_CI if insensitive else _SELF_SURFACE_RE
    return any(rx.match(rel) for rx in patterns)


def _is_backend_restart(rel: str, insensitive: bool) -> bool:
    patterns = _BACKEND_RESTART_RE_CI if insensitive else _BACKEND_RESTART_RE
    return any(rx.match(rel) for rx in patterns)


# G5 round 3 item 4 (widened by round 4 item 1): a sentinel _repo_relative
# returns for input under any Win32 NT-namespace prefix that ISN'T the plain
# drive-letter `\\?\` form -- a UNC (`\\?\UNC\...`), raw device
# (`\\?\GLOBALROOT\Device\HarddiskVolumeN\...\backend\rag.py`), Win32
# device-namespace (`\\.\C:\...`), or NT-native (`\??\C:\...`) path. The
# item-2 fix correctly stopped treating the UNC/device `\\?\` forms as plain
# repo-relative paths, but returning bare ``None`` for them made ``decide()``
# treat "can't verify" the same as "verified outside the repo", so the
# self-modify rule was skipped and trusted mode fell through to its own
# "allow the rest" rule. Round 4 item 1 (CRITICAL): `\\.\` and `\??\` are two
# OTHER NT-namespace prefixes that ALSO resolve to the real file on this
# machine (verified live for all three forms opening the same file) but were
# never even recognised as Win32-special -- they fell straight through
# `_repo_relative`'s normal absolute-path branch, failed the plain
# root-prefix comparison, and resolved to bare ``None`` -- exactly the same
# silent bypass as the original `\\?\` hole. The sentinel lets ``decide()``
# distinguish "provably outside the repo" (plain ``None``) from "cannot be
# verified either way" (this) and treat the latter as ask, in every mode,
# exactly like an actual self-modify match -- for EVERY NT-namespace form,
# not just one.
AMBIGUOUS_WIN32_PATH = "\x00ambiguous-win32-path\x00"

#: G5 batch-11 (9th audit) item 5: a distinct sentinel for the `cd`
#: short-circuit case (see ``_candidate_paths``' shell branch), so
#: ``decide()`` can report a reason that actually names the cause instead
#: of reusing the Win32-device/UNC wording for an unrelated situation.
AMBIGUOUS_CD_PATH = "\x00ambiguous-cd-path\x00"

#: Matches the NT-native path prefix (``\??\`` -> ``/??/`` after the \ -> /
#: swap). The other ambiguous root shape -- any double-separator root that
#: ISN'T the safe drive-letter long-path form already stripped above -- is
#: caught directly by ``text.startswith("//")`` in ``_repo_relative`` rather
#: than an enumerated prefix list. G5 round 5 item 1: an enumerated list of
#: named prefixes (``\\?\``, ``\\.\``, ``\??\``) missed plain UNC
#: (``\\localhost\C$\...``, ``\\127.0.0.1\C$\...``) entirely -- neither name
#: has an NT-namespace prefix at all, yet both resolve to the identical live
#: file on this machine. One predicate covering every double-separator root
#: replaces a list that has now been proven incomplete twice.
_NT_NATIVE_PREFIX = re.compile(r"^/\?\?/")

#: Drive-relative form (``C:backend\rag.py``, no separator right after the
#: colon). Its target is CWD-dependent, and the CLI's CWD IS the repo root,
#: so it can resolve to a real self-surface file with no path separator ever
#: appearing after the drive letter -- but this module never touches the
#: filesystem to learn the CWD, so it can't be resolved, only flagged.
_DRIVE_RELATIVE = re.compile(r"^[A-Za-z]:(?!/)")

#: A path segment naming a Windows 8.3 short name (``ASSIST~1.PY``,
#: ``_THEDA~4``). ``GetShortPathNameW`` generation is live on this volume
#: (verified), so a short-name segment can resolve to the identical
#: long-name file this module would otherwise match against a self-surface
#: glob -- but expanding it correctly needs ``GetLongPathNameW`` /
#: ``os.path.realpath``, i.e. touching the filesystem, which this module's
#: no-filesystem contract forbids. This is a STRING-ONLY APPROXIMATION: any
#: segment matching the pattern is treated as ambiguous rather than
#: resolved, so a short name can never silently bypass a glob it would
#: expand to match. It cannot tell a short name that expands to something
#: outside the repo from one that expands to something inside it -- both are
#: (safely, over-cautiously) treated as ambiguous.
_SHORT_NAME_SEGMENT = re.compile(r"~\d")


def _normalize_posix(text: str) -> str:
    """Drive-letter-aware equivalent of ``posixpath.normpath`` for a
    forward-slash path.

    G5 batch-11 (8th audit) item 3: ``posixpath.normpath`` has no concept of
    a Windows drive letter, so a ``..`` segment can pop PAST the drive
    itself once it runs out of directories under it --
    ``posixpath.normpath("C:/a/../../backend/rag.py")`` collapses to
    ``"backend/rag.py"`` (the drive segment ``"C:"`` gets treated as just
    another directory and popped by the second ``..``), which then reads as
    an ordinary repo-relative path and produces a false self-modify match
    for a path that never actually resolves inside the repo. Mirrors the
    TypeScript port's ``normalizePosix`` exactly: a leading drive letter is
    split off first and excluded from the segment stack a ``..`` walks, so
    it can never be popped -- extra ``..`` segments past the drive root are
    simply dropped, exactly as Win32 itself clamps at the drive root.
    """
    absolute = text.startswith("/")
    drive = text[:3] if _WINDOWS_DRIVE.match(text) else ""
    body = text[3:] if drive else text
    parts: list[str] = []
    for segment in body.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if parts and parts[-1] != "..":
                parts.pop()
            elif not absolute and not drive:
                parts.append("..")
            continue
        parts.append(segment)
    joined = "/".join(parts)
    if drive:
        return drive + joined
    if absolute:
        return "/" + joined
    return joined or "."


def _repo_relative(raw: str, repo_root: Path) -> str | None:
    """Normalise ``raw`` to a repo-relative POSIX path, ``AMBIGUOUS_WIN32_PATH``
    when it cannot be safely verified either way (see its comment), or
    ``None`` if it is provably outside the repo.

    Pure string work — never touches the filesystem. Handles Windows absolute
    paths, Windows relative paths, POSIX paths, and quoted shell tokens.

    LIMITATION (G5 round 5 item 1, part 4): Windows 8.3 short names
    (``ASSIST~1.PY``) are detected and treated as ``AMBIGUOUS_WIN32_PATH``
    rather than resolved, because resolving one correctly needs
    ``GetLongPathNameW`` / ``os.path.realpath`` -- i.e. touching the
    filesystem -- which this function's contract forbids. See
    ``_SHORT_NAME_SEGMENT``'s comment for the exact trade-off this makes.
    """
    text = (raw or "").strip().strip("\"'").strip()
    if not text:
        return None
    text = text.replace("\\", "/")
    root_slashed = str(repo_root).replace("\\", "/")
    # Win32 long-path prefix `\\?\` becomes `//?/` after the \ -> / swap
    # above; strip it so `\\?\C:\repo\...` resolves the same as a normal
    # `C:\repo\...`. CRITICAL: only when a drive letter immediately follows --
    # `\\?\UNC\evil\share\x.txt` and `\\?\GLOBALROOT\Device\...` are the OTHER
    # two `\\?\` forms Win32 accepts (UNC shares and raw device paths).
    # Stripping those unconditionally turned `//?/UNC/evil/share/x.txt` into
    # `UNC/evil/share/x.txt`, an ordinary-looking repo-relative path that got
    # treated as inside the repo.
    if _WIN32_LONG_PATH_DRIVE_PREFIX.match(text):
        text = text[4:]
    elif text.startswith("//") or _NT_NATIVE_PREFIX.match(text):
        # Left un-stripped: any double-separator or NT-native root other
        # than the safe drive-letter `\\?\` form -- plain UNC
        # (`//server/share/...`, including loopback spellings like
        # `//localhost/C$/...` and `//127.0.0.1/C$/...`), `//./`,
        # `//?/UNC/...`, `//?/GLOBALROOT/...`, `/??/...`. Signal ambiguity
        # distinctly (item 4, widened by round 4 item 1, widened again by
        # round 5 item 1 to a single predicate instead of an enumerated
        # list) rather than resolving it (wrongly) to a clean-looking
        # in-repo relative path or a plain "outside the repo" None.
        return AMBIGUOUS_WIN32_PATH
    elif _DRIVE_RELATIVE.match(text):
        # Drive-relative (`C:backend\rag.py`): CWD-dependent, can't be
        # resolved as string work. See _DRIVE_RELATIVE's comment.
        return AMBIGUOUS_WIN32_PATH
    if _WIN32_LONG_PATH_DRIVE_PREFIX.match(root_slashed):
        root_slashed = root_slashed[4:]
    # Git-Bash / MSYS drive form (`/c/Users/...`) maps onto `C:/...`, but ONLY
    # when the repo root itself is a Windows drive path -- a POSIX repo with a
    # genuine single-letter top-level directory (`/a/backend/rag.py` against
    # root `/a`) must resolve normally, never get reinterpreted as drive `A:`.
    # Both rewrites run BEFORE the repo-root prefix comparison, not after
    # (rewriting post-comparison would let a `//?/` or `/c/...` path slip
    # past the root check it was meant for).
    if _WINDOWS_DRIVE.match(root_slashed):
        git_bash = _GIT_BASH_DRIVE_PATH.match(text)
        if git_bash:
            text = f"{git_bash.group(1).upper()}:/{git_bash.group(2)}"
        elif text.startswith("/"):
            # G5 batch-11 fixup (critical 1): a single-separator-rooted
            # path (backslash-Users-... or forward-slash-Users-... --
            # both become /Users/... after the backslash-to-slash swap
            # above) is relative to the CURRENT DRIVE on Windows, not the
            # filesystem root -- and the CLI's cwd is always repo_root, so
            # the drive is always repo_root's. This is NOT the Git-Bash
            # /c/... form (handled above) and NOT // or /??/ roots (those
            # already returned AMBIGUOUS_WIN32_PATH above). Pure string
            # work: graft repo_root's own drive letter on.
            text = root_slashed[:2] + text
    # G5 round 5 item 1 (parts 3-4): canonicalize each path segment BEFORE
    # the root-prefix comparison and before any glob match, so an evasion
    # riding on a filesystem quirk can't present a path that looks clean to
    # the string-matching code but opens the real self-surface file on disk.
    # A short-name (8.3) segment can't be canonicalized as pure string work
    # (see `_SHORT_NAME_SEGMENT`'s comment) so it short-circuits to
    # AMBIGUOUS_WIN32_PATH instead of being resolved.
    segments = text.split("/")
    if any(_SHORT_NAME_SEGMENT.search(segment) for segment in segments):
        return AMBIGUOUS_WIN32_PATH
    cleaned_segments: list[str] = []
    for index, segment in enumerate(segments):
        # `.` / `..` / empty segments are structural (consumed by the
        # normpath collapse right below) -- not filenames, so they must be
        # left untouched. Stripping trailing dots from `..` would turn it
        # into an empty segment and silently defeat the traversal collapse.
        if segment in ("", ".", ".."):
            cleaned_segments.append(segment)
            continue
        # The drive segment (`C:`) is exempt from ADS truncation -- its
        # colon is the drive separator, not a stream marker.
        if index == 0 and re.match(r"^[A-Za-z]:$", segment):
            cleaned_segments.append(segment)
            continue
        # NTFS Alternate Data Stream: `rag.py::$DATA` opens `rag.py`'s
        # unnamed stream, i.e. `rag.py` itself -- truncate at the first `:`.
        if ":" in segment:
            segment = segment.split(":", 1)[0]
        # NTFS silently strips a trailing `.` or space from a filename, so
        # `rag.py.` and `rag.py ` both name the same file as `rag.py`.
        segment = segment.rstrip(". ")
        cleaned_segments.append(segment)
    text = "/".join(cleaned_segments)
    # Collapse `..` BEFORE the prefix comparison, otherwise
    # `C:/repo/../repo/backend/rag.py` slips past the root check.
    # G5 batch-11 (8th audit) item 3: drive-aware ``_normalize_posix``, not
    # plain ``posixpath.normpath`` -- see its comment for why a bare
    # ``posixpath.normpath`` lets ``..`` pop past a Windows drive letter.
    text = _normalize_posix(text)
    root = _normalize_posix(root_slashed).rstrip("/")

    # G5 round 6 item 4: ``posixpath.normpath`` has no concept of a Windows
    # drive letter, so a path that normalizes down to a bare drive
    # (``"C:"``, no trailing slash -- e.g. raw input ``"/"`` against a
    # drive-letter repo root, grafted to ``"C:/"`` above and then stripped
    # of its trailing slash by normpath) fails ``_WINDOWS_DRIVE`` (which
    # requires the trailing ``/``) and fell through to the plain
    # `else: rel = text` branch below, returning the bogus relative path
    # ``"C:"`` instead of being recognised as a drive root. The TypeScript
    # port's ``normalizePosix`` is drive-letter-aware and already returns
    # ``null`` for the equivalent input -- this match closes that
    # cross-language divergence by routing a bare drive letter through the
    # same absolute-path branch as ``"C:/"``, where it correctly resolves to
    # ``None`` unless the repo root itself IS that bare drive.
    if (
        text.startswith("/")
        or _WINDOWS_DRIVE.match(text)
        or re.match(r"^[A-Za-z]:$", text)
    ):
        if not root:
            return None
        prefix = root + "/"
        if text.lower().startswith(prefix.lower()):
            rel = text[len(prefix) :]
        elif text.lower() == root.lower():
            return None
        else:
            return None
    else:
        rel = text

    rel = _normalize_posix(rel)
    if rel in (".", "") or rel == ".." or rel.startswith("../"):
        return None
    if rel.startswith("/") or _WINDOWS_DRIVE.match(rel):
        return None
    return rel


#: Shell tokens that change the effective working directory of every command
#: that follows them on the same line. G5 round 6 item 1: candidates are
#: resolved against ``repo_root`` only -- the command's own effective cwd is
#: never tracked, so ``cd backend && echo x > rag.py`` builds the candidate
#: ``rag.py`` (never ``backend/rag.py``) and misses the self-surface glob
#: entirely. Correctly tracking the accumulated ``cd``/``pushd`` directory
#: would require actually interpreting the shell grammar (subshells,
#: quoting, ``&&`` vs ``;`` vs newlines, ``cd -``, environment expansion in
#: the target); the auditor named the safer and cheaper alternative and this
#: takes it: any shell command containing a `cd` or `pushd` token is treated
#: as unresolvable and gets the same "ask, always" treatment as a proven
#: self-modify match (see ``AMBIGUOUS_WIN32_PATH`` handling in ``decide()``),
#: rather than attempting -- and risking getting wrong -- a directory-prefix
#: reconstruction.
#:
#: G5 batch-11 (7th audit) items 1/2/6: the original token-based check
#: (``any(token.lower() in {"cd", "pushd"} for token in tokens)``) missed
#: every spelling where the shlex tokenizer glues the directory-change word
#: to adjacent punctuation or quoting -- ``(cd backend; ...)`` tokenizes as
#: ONE token ``(cd`` (never bare ``cd``), and ``bash -c "cd backend && ..."``
#: tokenizes the whole quoted string as ONE token, so ``cd`` never appears as
#: its own token either. Both were proven live to reach and overwrite a
#: seeded ``backend/rag.py``. The fix stops tokenizing for this test entirely
#: and matches case-insensitively against the RAW command string instead, so
#: punctuation and quote characters immediately before/after the word no
#: longer hide it. The set also grows from ``{cd, pushd}`` to every
#: PowerShell equivalent (``popd``, ``chdir``, ``sl``, ``set-location``,
#: ``push-location``, ``pop-location``) -- ``PowerShell`` is a first-class
#: member of ``SHELL_TOOLS`` and all six aliases were proven live to change
#: directory exactly like ``cd``.
#:
#: Item 6: the original rule short-circuited to "ask, always" for ANY
#: ``cd``/``pushd`` command, including read-only ones -- every one of
#: CLAUDE.md's own documented `cd frontend && npm run build`-shaped commands
#: became an undismissable prompt with a misleading reason string.
#:
#: G5 batch-11 (8th audit) item 1, CRITICAL, revised: the fix that followed
#: (scoping the short-circuit to a ``cd`` paired with a "write-shaped"
#: BLACKLIST of tokens) was itself wrong -- the set of programs able to
#: write a file on a filesystem is not enumerable, and the auditor proved
#: live, in trusted mode (the Foundry's default), that a seeded
#: ``backend/rag.py`` is overwritten or destroyed by a heredoc
#: (``python - <<'EOT'``), ``node -e "require('fs').writeFileSync(...)"``,
#: ``perl -i -pe``, ``sed -i.bak`` (the dash-i regex required whitespace/
#: quote/EOL after ``-i``, which ``-i.bak`` does not supply), ``install -m
#: 644 /dev/null rag.py``, ``patch < p.diff``, ``git apply p.diff``,
#: ``tar xf a.tar``, ``gcc -o rag.py x.c``, ``Copy-Item``, ``New-Item
#: -Force`` (the alias ``ni`` was listed, ``new-item`` was not), and
#: ``Remove-Item``/``ri`` (``rm`` was listed, the PowerShell aliases were
#: not) -- none of these are redirects or in the old write-word list, and
#: unbounded others (``unzip``, ``7z x``, ``Move-Item``, ``Rename-Item``,
#: ``curl -o``, ``rsync``, ``shred -u``, any ``npm run build`` that emits
#: into the directory, ...) share the same gap.
#:
#: The short-circuit is inverted to an ALLOWLIST instead: a directory
#: change is ambiguous UNLESS the rest of the command is one of the narrow,
#: explicitly documented CLAUDE.md shapes recognised by
#: ``_is_known_read_only_command`` below. A miss in an allowlist costs one
#: extra "ask" prompt; a miss in a blacklist costs a silent write to the
#: assistant's own policy surface -- the allowlist direction is the only
#: one that is safe by construction.
#: G5 round 13 (12th audit) item 4: an explicit ASCII whitespace class,
#: shared verbatim by both ports, standing in for every ``\s`` in the
#: directory-argument and tail-normalisation regexes below. Python's ``re``
#: and JavaScript's regex engine disagree on which Unicode code points
#: count as ``\s`` -- Python's includes U+0085 (NEXT LINE) but not U+FEFF
#: (BOM/ZWNBSP); JavaScript's includes U+FEFF but not U+0085 -- so a
#: character in that gap flips which side of a match boundary it falls on
#: per engine, and the same command (``npm﻿run lint`` as a `cd` tail;
#: ``cd back\u0085end&&ls`` as a `cd` directory argument) resolved `allow`
#: on one port and `ask` on the other. Restricting the separator set to six
#: characters both engines are guaranteed to treat identically (space, tab,
#: LF, CR, FF, VT) removes the ambiguity by construction instead of by
#: coincidence.
_WS = " \t\n\r\f\v"
_CD_WORDS = (
    "set-location",
    "push-location",
    "pop-location",
    "chdir",
    "pushd",
    "popd",
    "cd",
    "sl",
)
_CD_RAW_RE = re.compile(
    r"(?:^|[\s;&|(){}\"'])\s*(?:" + "|".join(_CD_WORDS) + r")(?=[\s;&|)\"']|$)",
    re.IGNORECASE,
)
#: G5 batch-11 (9th audit) item 3: a `cd`/`pushd`/etc. word with a single
#: directory argument and nothing else on the line -- no `&&`/`;` chaining
#: in a second command. Matched against the whole command, not the raw-word
#: search above, since it must anchor at both ends.
#: G5 batch-11 (10th audit) item 4: the directory argument was `\S+`, which
#: is greedy over non-whitespace and swallows a separator-glued second
#: command whole (`cd backend&&../tools/x.sh`) -- proven live to reach
#: `Trusted mode` allow with no space around `&&`. The directory argument
#: must not itself contain a shell separator/metacharacter, so it is
#: restricted to the same metacharacter-free class used to validate the
#: post-`cd` tail (``_TAIL_METACHAR_RE``'s class, inlined here since this
#: regex is defined above that one).
#: G5 round 13 (12th audit) item 3: NUL (``\x00``) added to the excluded
#: class. Inert on every shell this module targets -- not a separator on
#: bash, cmd, or PowerShell, and Node's ``child_process``/Python's
#: ``subprocess`` both refuse to spawn an argv containing it outright -- so
#: this cannot be reached live. Added anyway so the one code point this
#: class cannot already represent is never silently admitted into a
#: directory argument.
#: G5 round 13 item 4: ``\s`` replaced by the explicit ``_WS`` class -- see
#: its definition above ``_CD_WORDS`` for why.
_CD_BARE_RE = re.compile(
    r"^[" + _WS + r"]*(?:" + "|".join(_CD_WORDS) + r")[" + _WS + r"]+"
    r"[^" + _WS + r";&|<>$`(){}\u2028\u2029\x00]+[" + _WS + r"]*$",
    re.IGNORECASE,
)

#: G5 batch-11 item 1 ("ALSO"): a nested-shell invocation whose argument this
#: module cannot parse at all (``bash -c "..."``, ``sh -c '...'``,
#: ``powershell -Command "..."``, ``cmd /c "..."``) is unconditionally
#: ambiguous -- proven live to reach a seeded self-surface file via a `cd`
#: buried inside the quoted argument that no amount of raw-string matching on
#: the OUTER command can be trusted to fully enumerate. Both the interpreter
#: name and its "run this string" flag must be present together, so common,
#: unrelated flags that happen to also be spelled ``-c`` (``tar -c``,
#: ``gcc -c``, ``grep -c``) are never mistaken for a nested shell.
#: G5 batch-11 (8th audit) item 5 (note, folded in as belt-and-braces): the
#: prefix boundary class previously omitted ``/``, so ``/bin/sh -c '...'``
#: -- the interpreter's absolute-path form -- was invisible to this check
#: even though ``sh`` and its ``-c`` flag were both present. Adding ``/``
#: closes that without risk of reopening any of the verified-clean
#: substrings (none of them are preceded by ``/``).
_SHELL_INTERPRETER_RE = re.compile(
    r"(?:^|[\s;&|(){}\"'/])(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?"
    r"(?=[\s;&|)\"']|$)",
    re.IGNORECASE,
)
_SHELL_DASH_C_RE = re.compile(r"(?:^|\s)(?:-{1,2}(?:c|[Cc]ommand)|/[Cc])(?=[\s=\"']|$)")


def _has_nested_shell(command: str) -> bool:
    return bool(_SHELL_INTERPRETER_RE.search(command)) and bool(
        _SHELL_DASH_C_RE.search(command)
    )


#: G5 batch-11 (8th audit) item 1: the ONLY commands the ``cd`` short-circuit
#: below is allowed to let through without a prompt -- exactly the shapes
#: documented in ``CLAUDE.md`` and nothing more. This is an ALLOWLIST
#: (unlike the write-signal blacklist it replaces): a directory change
#: followed by anything NOT matching one of these narrow tails is treated
#: as ambiguous. ``_CD_TO_SAFE_TAIL_RE`` isolates the text after the first
#: directory-change word and its ``&&``/``;`` separator (mirroring the
#: CLAUDE.md ``cd <dir> && <command>`` shape); ``_KNOWN_READ_ONLY_TAILS``
#: must equal that tail exactly (after whitespace normalisation), so
#: appending anything after a recognised command (``npm run build && rm -rf
#: .``) fails the match and correctly falls through to "ask".
#: G5 round 12 (11th audit) item 1, CRITICAL: the directory argument here
#: was `\S+`, the identical flaw fixed in `_CD_BARE_RE` one round earlier and
#: never carried over to this regex -- greedy over non-whitespace, it
#: swallowed a separator-glued second command whole (`cd backend&&./evil.sh`)
#: so the capture group (intended to be the whole tail) was only the LAST
#: segment, and that segment alone got validated against the allowlist.
#: Proven live: `cd backend&&./evil.sh&&ls` -> allow (tail captured as `ls`)
#: on both ports, writing an arbitrary-execution marker. Restricted to the
#: same metacharacter-free class `_CD_BARE_RE` already uses, so a
#: separator-glued directory argument can never be mistaken for a single
#: token again.
#: G5 round 13 (12th audit) item 3: NUL (``\x00``) added to the excluded
#: class -- same rationale as ``_CD_BARE_RE`` above.
#: G5 round 13 item 4: ``\s`` replaced by the explicit ``_WS`` class -- see
#: its definition above ``_CD_WORDS`` for why.
#: G5 round 13 (12th audit) item 1, MAJOR: the directory argument is now
#: its OWN capture group (group 1), not discarded -- the allowlist below
#: bounded the command STRING but not the CODE THAT RUNS, because nine of
#: the twenty-one literals (``npm``/``npx``/``uv run`` invocations) execute
#: code read from whatever directory this group names, and that directory
#: was never validated: ``cd /tmp/evil && npm run build``, ``cd ../../evil
#: && npx vitest run``, ``cd ~ && npm run build``, ``cd .. && npm run
#: lint``, and their C:/-absolute equivalent were all proven live to reach
#: `Trusted mode` allow and execute attacker-controlled code (a scratch
#: ``package.json``/``conftest.py`` in the target directory). See
#: ``_is_known_read_only_command`` for how the two tail categories now use
#: this group differently.
_CD_TO_SAFE_TAIL_RE = re.compile(
    r"^["
    + _WS
    + r"]*(?:"
    + "|".join(_CD_WORDS)
    + r")["
    + _WS
    + r"]+([^"
    + _WS
    + r";&|<>$`(){}\u2028\u2029\x00]+)["
    + _WS
    + r"]*(?:&&|;)["
    + _WS
    + r"]*(.+?)["
    + _WS
    + r"]*$",
    re.IGNORECASE,
)
#: G5 batch-11 (9th audit) items 1/2: a shell metacharacter anywhere in the
#: tail means the allowlist below cannot be trusted to have parsed the tail
#: as a single command -- ``uv run pytest ; rm -rf .`` and ``npm run
#: lint>rag.py`` would otherwise reach the exact-match check carrying a
#: second command or a glued redirect. Reject the tail outright before
#: attempting the exact-match check.
#: G5 batch-11 (10th audit) item 6: add U+2028/U+2029 (Unicode line/paragraph
#: separators) -- JavaScript treats them as line terminators, which made the
#: TypeScript port's equivalent `.` stop matching across them while Python's
#: `re` (no ``re.UNICODE``-only line-break semantics here) kept matching,
#: so the same tail resolved `allow` on one port and `ask` on the other.
#: Neither character is a shell separator on any of bash/cmd/PowerShell, so
#: adding them here only tightens Python to match TypeScript's stricter
#: behaviour -- it cannot open a new bypass.
_TAIL_METACHAR_RE = re.compile(r"[;&|<>$`(){}\n\r\u2028\u2029]")

#: G5 round 12 (11th audit) items 2/3, CRITICAL, revised approach: eleven
#: rounds of narrowing a per-tool regex (flag allowlists, positional-arg
#: shape rules, ``--output`` negative lookaheads, ...) have proven that
#: modelling a tool's read-only *surface* is not tractable -- every
#: narrowing has left a flag or a subcommand this module did not anticipate.
#: ``uv run pytest``'s flag pattern admitted every output-path-naming pytest
#: option (`--junitxml=`, `--debug=`, `--basetemp=`, `--cov-report=`,
#: `-o cache_dir=`, `-p <plugin>`), proven live to truncate, overwrite, or
#: -- via `--basetemp` -- recursively DELETE ``backend/modules/assistant/``
#: (this policy module's own directory) whenever a collected test uses
#: `tmp_path`/`tmpdir`, which this repo's own suite does. ``uv run ruff
#: check/format --diff``'s trailing-argument tail admitted `-o`/
#: `--output-file`/`--cache-dir`, proven live against the repo's own pinned
#: ruff binary to truncate and rewrite an arbitrary file even with `--diff`
#: present (`--diff` wins over `-o` in ruff's own precedence, but the write
#: to `-o`'s target happens regardless).
#:
#: The fix: stop modelling flags and arguments at all. Every entry below is
#: a COMPLETE, EXACT command string with no argument tail whatsoever -- not
#: a regex over one. A miss (any flag, any argument, any variation) falls
#: through to "ask"; there is no shape for an unanticipated flag to hide in,
#: because no flag is ever parsed. Compared to ``command`` after collapsing
#: internal whitespace and case-folding (so `NPM  RUN   LINT` still matches
#: `npm run lint`) -- no other normalisation, so the string must be the
#: admitted invocation and nothing else.
#:
#: Membership, and the document that prescribes each ONLY from
#: ``CLAUDE.md`` / ``frontend/package.json`` /
#: ``VST-Foundry-UI/VST-UI-FOUNDRY/package.json`` (never guessed):
#: - ``npm run lint`` -- CLAUDE.md ``## Commands`` (``cd frontend && npm run
#:   lint          # tsc --noEmit``) and the Foundry's own ``package.json``
#:   ``"lint": "tsc --noEmit"`` script; both invocations are the identical
#:   read-only typecheck.
#: - ``npm run lint:classes`` -- CLAUDE.md Tailwind section ("Before
#:   finishing ANY task that touched a .tsx/.ts file, run `cd frontend &&
#:   npm run lint:classes`"), backed by ``frontend/package.json``
#:   ``"lint:classes": "node scripts/check-canonical-classes.mjs"`` (reports
#:   only; ``fix:classes`` is the writing counterpart and stays excluded).
#: - ``npm run lint:scripts`` -- ``frontend/package.json``
#:   ``"lint:scripts": "tsc --noEmit -p scripts/tsconfig.json"``, the same
#:   read-only typecheck shape as ``lint``, scoped to ``scripts/``.
#: - ``npm run build`` -- ``frontend/package.json`` ``"build": "vite
#:   build"`` and the Foundry's ``"build": "vite build && esbuild ..."``:
#:   both write only into their own package's ``dist/``, never
#:   self-surface, and neither accepts a trailing argument here to redirect
#:   that output elsewhere.
#: - ``npm test`` -- CLAUDE.md ``## Commands`` (``cd frontend && npm test
#:   # every suite``), backed by ``frontend/package.json`` ``"test": "node
#:   scripts/run-tests.mjs"``, and the Foundry's ``"test": "vitest run"``
#:   (single run, exits; ``test:watch`` -- ``"vitest"`` in watch mode, never
#:   exits -- is deliberately excluded).
#: - ``npm run test:sing`` -- CLAUDE.md ``## Commands`` (``cd frontend &&
#:   npm run test:sing   # one suite``), the one per-suite runner CLAUDE.md
#:   names explicitly; no other ``test:<suite>`` script is admitted as a
#:   pattern (each would need the same explicit naming).
#: - ``npx tsc --noEmit`` / ``npx vitest run`` -- the underlying commands
#:   ``npm run lint`` (Foundry) / ``npm test`` (Foundry) invoke, and named
#:   directly by this ticket's own GATES section for the Foundry app dir.
#: - ``uv run pytest`` -- CLAUDE.md ``## Commands`` (``uv run pytest``).
#: - ``uv run pytest tests/test_inference.py`` -- CLAUDE.md ``## Commands``
#:   ("Run single test file"), an exact literal, not a pattern -- it cannot
#:   be pointed at any other file.
#: - ``uv run pytest --save-audio`` -- CLAUDE.md ``## Commands`` ("Run tests
#:   and save generated audio for inspection").
#: - ``uv run ruff check`` / ``uv run ruff check .`` -- CLAUDE.md ``##
#:   Commands`` and the hard-rule-2 pre-commit checklist. G5 round 13 (12th
#:   audit) item 5: this used to say bare ``ruff check`` (no ``--fix``)
#:   "does not write" -- wrong; by default it writes/updates its own
#:   ``.ruff_cache/`` directory (``ruff clean``, per Ruff's own CLI
#:   reference, astral-sh/ruff docs fetched via GitMCP, exists specifically
#:   to "clear any caches" ruff commands leave behind). The ``allow``
#:   verdict is still correct -- ``.ruff_cache/`` is never a self-surface
#:   glob -- only the stated reason was wrong: this literal is admitted
#:   because it never writes to a REPO SOURCE FILE, and because it is an
#:   exact literal with no argument tail, ``--fix`` can never ride along.
#:   Related, for whoever next edits ``_SAFE_PROJECT_DIRS`` or this set:
#:   ``uv run <anything>`` (not just ``ruff``) performs an implicit project
#:   sync first and can rewrite ``uv.lock``/``.venv/`` -- per HARD RULE 4 in
#:   CLAUDE.md, neither of those may ever be bypassed or auto-resolved by
#:   an agent, but neither is self-surface either, so no verdict here
#:   changes; this is a note for a human, not a bug in this module.
#: - ``uv run ruff format --check`` / ``uv run ruff format --check .`` --
#:   CLAUDE.md ``## Commands`` and hard-rule-2. Bare ``uv run ruff format``
#:   (no ``--check``) is DELIBERATELY excluded: CLAUDE.md's own ``## Ruff
#:   Configuration`` section documents it as the actual reformat command
#:   ("Always run from the repo root ... uv run ruff format ."), which
#:   writes files in place -- including, since ruff's excludes list only
#:   covers ``stable_audio_3/*``, this module's own ``backend/modules/
#:   assistant/`` self-surface.
#: - ``ls`` / ``cat`` -- bare, no arguments: neither can write to anything,
#:   documented as commonly-used read-only shell primitives throughout this
#:   allowlist's history; with no argument tail admitted at all, there is no
#:   flag or redirect for either to carry.
#: - ``git status`` / ``git log`` / ``git diff`` / ``git show`` -- bare, no
#:   arguments: none of the four write to the working tree, and with no
#:   argument tail admitted, `--output`/`--output=` (the proven write
#:   primitive for `diff`/`show`) can never appear.
#:
#: ``pnpm``/``yarn`` equivalents are NOT admitted: CLAUDE.md and both
#: ``package.json`` files document ``npm`` only for this repo: an
#: unrecognised package manager falls through to "ask", which costs one
#: prompt, never a silent write.
#:
#: G5 round 13 (12th audit) item 1, MAJOR: this set used to be flat -- every
#: entry treated identically regardless of the ``cd`` target directory. That
#: bounded the command STRING but not the CODE THAT RUNS: ``ls``/``cat``/the
#: four bare ``git`` read verbs are INERT -- they read, they never execute
#: anything they find in the target directory, so the directory they run in
#: cannot matter. But nine of the entries (every ``npm``/``npx``/``uv run``
#: invocation) EXECUTE code discovered in that directory --
#: ``package.json`` scripts (``npm run build``/``test``/``lint*``), a
#: cwd-discovered test suite and its ``conftest.py`` (``uv run pytest``,
#: ``npx vitest run``), or cwd config plus ``node_modules/.bin`` (``npx tsc
#: --noEmit``) -- and admitting them from ANY directory was proven live:
#: a scratch ``package.json`` with ``"build": "node evil.js"`` under
#: ``/tmp/evil``, ``C:/evil``, ``../../evil``, or ``~`` made
#: ``cd <that dir> && npm run build`` (and the ``test``/``lint*``/``uv run
#: pytest``/``npx vitest run``/``npx tsc --noEmit`` equivalents) reach
#: `Trusted mode` allow and run attacker-controlled code, with the write
#: happening entirely OUTSIDE this module's self-surface/repo-relative path
#: model, so no candidate-path check downstream ever saw it. The set is now
#: split in two: ``_INERT_READ_ONLY_TAILS`` (the four ``ls``/``cat``/``git``
#: shapes) stays admitted from ANY directory -- inertness doesn't depend on
#: location. ``_PROJECT_CODE_READ_ONLY_TAILS`` (the nine code-executing
#: shapes) is admitted ONLY when the captured ``cd`` directory (see
#: ``_CD_TO_SAFE_TAIL_RE`` group 1) is itself an exact literal from a
#: CLOSED set naming this repo's own package/project roots --
#: ``.``/``frontend``/``backend``/``VST-Foundry-UI/VST-UI-FOUNDRY`` -- the
#: only directories CLAUDE.md and the two ``package.json`` files document
#: these commands as being run from. Any other directory, however spelled,
#: falls through to "ask": there is no way to widen the closed set from the
#: command line, because it is never parsed as a pattern.
_INERT_READ_ONLY_TAILS = frozenset(
    tail.lower()
    for tail in (
        "ls",
        "cat",
        "git status",
        "git log",
        "git diff",
        "git show",
    )
)
_PROJECT_CODE_READ_ONLY_TAILS = frozenset(
    tail.lower()
    for tail in (
        "npm run lint",
        "npm run lint:classes",
        "npm run lint:scripts",
        "npm run build",
        "npm test",
        "npm run test:sing",
        "npx tsc --noEmit",
        "npx vitest run",
        "uv run pytest",
        "uv run pytest tests/test_inference.py",
        "uv run pytest --save-audio",
        "uv run ruff check",
        "uv run ruff check .",
        "uv run ruff format --check",
        "uv run ruff format --check .",
    )
)
#: Union of the two sets above -- kept for callers/tests that only care
#: whether a tail is admitted at all, not which category it falls in (the
#: directory restriction is enforced in ``_is_known_read_only_command``,
#: not by set membership here).
_KNOWN_READ_ONLY_TAILS = _INERT_READ_ONLY_TAILS | _PROJECT_CODE_READ_ONLY_TAILS

#: The closed set of ``cd`` target directories a ``_PROJECT_CODE_READ_ONLY_TAILS``
#: entry may be run from -- this repo's own package/project roots, and
#: nothing else. Compared as an exact literal (the directory-argument class
#: already excludes every shell metacharacter, so there is nothing to
#: normalise beyond that): a trailing slash, a different case, or any
#: relative/absolute spelling not listed here falls through to "ask".
_SAFE_PROJECT_DIRS = frozenset(
    (".", "frontend", "backend", "VST-Foundry-UI/VST-UI-FOUNDRY")
)

#: Collapses run of whitespace in a tail to a single space before comparing
#: it against ``_KNOWN_READ_ONLY_TAILS`` -- e.g. ``npm  run   lint`` (extra
#: spaces) still matches ``"npm run lint"``. This is normalisation of
#: whitespace ONLY: it cannot merge two distinct tokens, add a flag, or
#: otherwise widen what the exact-string comparison accepts.
#: G5 round 13 item 4: ``\s`` replaced by the explicit ``_WS`` class -- see
#: its definition above ``_CD_WORDS`` for why.
_WHITESPACE_RUN_RE = re.compile(r"[" + _WS + r"]+")


def _is_known_read_only_command(command: str) -> bool:
    """Whether ``command`` is one of the narrow ``cd <dir> && <tool>``
    shapes documented in ``CLAUDE.md`` / ``package.json`` -- the only
    commands the ``cd`` short-circuit is allowed to let through without a
    prompt. Anything that doesn't equal one of ``_KNOWN_READ_ONLY_TAILS``
    exactly (after whitespace normalisation) resolves to ``False`` and gets
    "ask", never "allow" -- see the item 1 comment above
    ``_CD_TO_SAFE_TAIL_RE`` for why this must be an allowlist, not a
    blacklist, and the comment above ``_PROJECT_CODE_READ_ONLY_TAILS`` for
    why an inert tail is admitted from any directory while a project-code
    tail is admitted only from ``_SAFE_PROJECT_DIRS``.

    G5 round 13 item 4: normalises with ``.lower()`` rather than
    ``.casefold()``. ``casefold()`` performs full Unicode case folding,
    which maps U+017F (LATIN SMALL LETTER LONG S, "ſ") and U+FB00 (LATIN
    SMALL LIGATURE FF, "ﬀ") onto plain ASCII "s" and "ff" -- so
    ``git ſtatus`` and ``git diﬀ`` compared equal to the admitted literals
    here while the TypeScript port's ``toLowerCase()`` (which does not fold
    either character) correctly kept asking, a cross-port divergence.
    ``.lower()`` uses Unicode *simple* case mapping only, which leaves both
    characters unchanged, matching ``toLowerCase()`` by construction.
    """
    match = _CD_TO_SAFE_TAIL_RE.match(command)
    if not match:
        return False
    directory, tail = match.group(1), match.group(2)
    if _TAIL_METACHAR_RE.search(tail):
        return False
    normalized = _WHITESPACE_RUN_RE.sub(" ", tail).strip().lower()
    if normalized in _INERT_READ_ONLY_TAILS:
        return True
    if normalized in _PROJECT_CODE_READ_ONLY_TAILS:
        return directory in _SAFE_PROJECT_DIRS
    return False


#: G5 round 13 (12th audit) item 2, MAJOR (usability, and a security problem
#: per the audit: heavy over-asking trains click-through, and the escape
#: hatch -- "allow Bash for this session" -- is keyed on TOOL NAME, so one
#: approval to silence the noise whitelists every future Bash command for
#: the session). Ten of nineteen over-asks in the audit's 35-command corpus
#: were plain, bare (no ``cd``) invocations of ``ls``/``cat``/``head``/
#: ``wc``/``git status``/``git log``/``git diff``/``git show`` WITH
#: arguments (``ls -la``, ``cat backend/rag.py``, ``git diff HEAD~1``, ...)
#: -- none of which can write. They asked anyway because ``_candidate_paths``
#: treats every token in a shell command as a possible write target
#: regardless of which command it belongs to: naming a self-surface file as
#: a plain READ argument (``cat backend/rag.py``) was indistinguishable from
#: naming it as a WRITE target (``echo x > backend/rag.py``), and
#: ``git diff HEAD~1``'s ``~1`` token was independently flagged
#: ``AMBIGUOUS_WIN32_PATH`` by the unrelated Windows short-name heuristic
#: (``_SHORT_NAME_SEGMENT``) that scans every candidate token.
#:
#: The fix is scoped, not a blanket bypass: it recognises exactly these
#: eight command heads with a trailing argument list built from the SAME
#: metacharacter-free class the ``cd`` directory argument already uses (so
#: a redirect or a second command glued on with a separator, e.g. ``cat
#: rag.py>backend/rag.py`` or ``cat rag.py; rm -rf .``, still contains a
#: rejected character and falls through to the ordinary token scan
#: unchanged), plus the one write primitive that flag surface actually has
#: -- ``--output``/``-o`` on ``git diff``/``git show`` -- excluded by a
#: negative lookahead so ``git diff --output=backend/rag.py HEAD`` can never
#: match as safe. When the whole command matches, NO candidate paths are
#: produced for it at all: none of these eight commands can write to an
#: argument they are given, so there is nothing to compare against the
#: self-surface glob or the ambiguous-Win32-path heuristic, and the command
#: proceeds to ``Trusted mode``'s ordinary allow.
_SAFE_READ_ARG_CLASS = r"[^ \t\n\r\f\v;&|<>$`(){}\u2028\u2029\x00]+"
_SAFE_READ_COMMAND_RE = re.compile(
    r"^[" + _WS + r"]*(?:ls|cat|head|wc|git[" + _WS + r"]+(?:status|log|diff|show))"
    r"(?:[" + _WS + r"]+(?!--output|-o)" + _SAFE_READ_ARG_CLASS + r")*[" + _WS + r"]*$",
    re.IGNORECASE,
)


def _is_safe_read_command(command: str) -> bool:
    """Whether ``command`` is a bare (no ``cd``) invocation of one of the
    eight inert read commands (``ls``/``cat``/``head``/``wc``/``git
    status``/``git log``/``git diff``/``git show``) with only
    metacharacter-free arguments and no ``--output``/``-o`` flag -- see the
    comment above ``_SAFE_READ_COMMAND_RE`` for the full rationale. A
    command matching this can never write to any path it names, so it
    contributes no write-candidate paths at all.
    """
    return bool(_SAFE_READ_COMMAND_RE.match(command))


def _candidate_paths(tool_name: str, input: dict, repo_root: Path) -> list[str]:  # noqa: A002
    """Every repo-relative path this request could write to."""
    kind = classify(tool_name, input)
    raw_values: list[str] = []

    if kind == "edit":
        for key in ("file_path", "notebook_path"):
            value = input.get(key) if isinstance(input, dict) else None
            if isinstance(value, str):
                raw_values.append(value)
    elif kind == "shell":
        command = input.get("command") if isinstance(input, dict) else None
        if isinstance(command, str) and command.strip():
            # G5 round 13 (12th audit) item 2: a bare (no `cd`) invocation of
            # one of the eight inert read commands can never write to any
            # argument it is given -- see the comment above
            # ``_SAFE_READ_COMMAND_RE`` for the full rationale. Checked
            # before the nested-shell/`cd` checks below since none of those
            # can ever apply to a command this narrowly shaped matches
            # anyway (its character class already excludes every shell
            # metacharacter a nested-shell or `cd` chain would need).
            if _is_safe_read_command(command):
                return []
            # G5 batch-11 items 1/2/6: match against the RAW command string,
            # not tokens -- see ``_CD_RAW_RE``'s comment for why the old
            # token-based check missed both paren-glued (`(cd`) and
            # nested-shell (`bash -c "cd ..."`) spellings. A nested shell
            # whose argument this module cannot parse is unconditionally
            # ambiguous; a plain `cd`/`pushd`/etc. is ambiguous UNLESS the
            # rest of the line is one of the narrow, known-read-only shapes
            # from CLAUDE.md (see item 1's comment above
            # ``_is_known_read_only_command``) -- everything else, including
            # every unenumerable way to write a file, asks.
            if _has_nested_shell(command):
                return [AMBIGUOUS_WIN32_PATH]
            # G5 batch-11 (9th audit) item 3: a bare `cd <dir>` with no
            # trailing command carries no write risk at all -- there is
            # nothing after it to be ambiguous about -- so it falls through
            # to the ordinary token-based scan below instead of being
            # treated as unresolvable.
            if _CD_RAW_RE.search(command) and not _CD_BARE_RE.match(command):
                if not _is_known_read_only_command(command):
                    return [AMBIGUOUS_CD_PATH]
            tokens = _shell_tokens(command)
            for token in tokens:
                raw_values.extend(_token_variants(token))

    seen: set[str] = set()
    paths: list[str] = []
    for raw in raw_values:
        rel = _repo_relative(raw, repo_root)
        if rel and rel not in seen:
            seen.add(rel)
            paths.append(rel)
    return paths


# G5 round 6 item 3: comma joins bare-string arguments inside a single
# quoted Python/Node/etc. one-liner (`python -c "open('backend/rag.py','w')"`)
# -- without it, `'backend/rag.py','w'` never splits into its two individual
# string arguments and the embedded comma survives every strip, so the path
# never resolves cleanly.
_SHELL_SEPARATORS = re.compile(r"[;&|(),]+")


def _token_variants(token: str) -> list[str]:
    """Split a shell token into every substring that could name a file.

    Redirects and flag values (``>backend/rag.py``, ``2>>backend/rag.py``,
    ``--output=backend/rag.py``, ``of=backend/rag.py``, ``--out:backend/rag.py``,
    ``<backend/rag.py``) and command separators (``backend/rag.py;``,
    ``backend/rag.py&&ls``, ``>|backend/rag.py``, ``(echo x >backend/rag.py)``)
    glue the path to shell punctuation. The raw token alone never matches a
    glob, so every piece is offered.

    G5 batch-11 item 3 (CRITICAL): ``_repo_relative``'s blanket
    ``text.replace("\\\\", "/")`` reads every backslash as a Windows path
    separator, which is correct for ``Edit``/``Write`` file paths but WRONG
    for a shell command, where a backslash is a POSIX escape character --
    ``echo x > back\\end/rag.py`` opens ``backend/rag.py`` in bash (the
    backslash is consumed, not a separator), while the separator reading
    builds the candidate ``back/end/rag.py``, which matches nothing. Proven
    live to reach and overwrite the seeded file. For SHELL-kind tokens only,
    every candidate here also gets a backslash-REMOVED (escape) variant
    alongside its backslash-as-separator reading; ``Edit``/``Write`` inputs
    never pass through this function, so their separator-only reading is
    unchanged. The escape variant is skipped for a candidate that already
    looks like a genuine Windows drive path (``C:\\...``) -- there, the
    backslashes ARE real path separators, and blindly deleting them would
    collapse ``C:\\proj\\theDAW\\backend\\rag.py`` into the nonsensical,
    drive-relative-looking ``C:projtheDAWbackendrag.py``.
    """
    pieces = [token, *(p for p in _SHELL_SEPARATORS.split(token) if p)]
    variants: list[str] = []
    for piece in pieces:
        candidates = [piece]
        for sep in (">", "=", ":"):
            _head, found, tail = piece.rpartition(sep)
            if found and tail:
                candidates.append(tail)
        stripped = piece.lstrip("<")
        if stripped != piece and stripped:
            candidates.append(stripped)
        for candidate in list(candidates):
            if _WINDOWS_DRIVE_BACKSLASH.match(candidate):
                continue
            no_backslash = candidate.replace("\\", "")
            if no_backslash != candidate and no_backslash:
                candidates.append(no_backslash)
        variants.extend(candidates)
    return list(dict.fromkeys(variants))


def _shell_tokens(command: str) -> list[str]:
    """Whitespace split honouring simple quoting.

    G5 batch-11 item 4: the previous ``shlex.split(..., posix=False)`` (on
    Windows) terminates a token as soon as the quote that OPENED it closes,
    even with no whitespace before the next character, so a
    concatenated-quote spelling like ``"back""end"/rag.py`` came back as
    three separate tokens and needed a bounded-window re-join
    (``_joined_token_windows``, since removed) to reconstruct -- and that
    bound was itself a countable evasion budget: an 8-fragment quote split
    exceeded the window and reached the self-surface file undetected, live.
    Ported directly from the TypeScript ``shellTokens`` in
    ``permissions.ts``, which was already immune (it accumulates across
    quote boundaries instead of terminating at the first close-quote), so
    this closes the gap AND makes the two ports structurally identical
    instead of coincidentally aligned. No quote-stripping bound, so no
    fragment-count budget for an evasion to exceed.
    """
    out: list[str] = []
    current: list[str] = []
    quote: str | None = None
    for char in command:
        if quote:
            if char == quote:
                quote = None
            else:
                current.append(char)
            continue
        if char in ('"', "'"):
            quote = char
            continue
        if char.isspace():
            if current:
                out.append("".join(current))
                current = []
            continue
        current.append(char)
    if current:
        out.append("".join(current))
    return out


def _shortest_self_surface_match(paths: list[str], insensitive: bool) -> str | None:
    """The shortest self-surface match among candidate paths, or ``None``.

    G5 audit item 7: ``_candidate_paths`` can return several variants of the
    SAME token -- e.g. for a glued shell token ``a.py&&ls``, both the raw,
    unsplit piece (``backend/a.py&&ls``, which a trailing ``**`` glob's ``.*``
    happily swallows whole) and the cleanly split one (``backend/a.py``).
    Reporting whichever candidate happens to come first surfaced the raw,
    junk-suffixed string to the user. The shortest match is always the
    cleanly-resolved path -- a raw glued variant is never shorter than its own
    split sub-piece, only longer or equal -- so picking the shortest is a
    safe, order-independent tiebreak.
    """
    best: str | None = None
    for rel in paths:
        if not _is_self_surface(rel, insensitive):
            continue
        if best is None or len(rel) < len(best):
            best = rel
    return best


def self_modify_path(
    tool_name: str,
    input: dict,  # noqa: A002 - contract name
    repo_root: Path,
) -> str | None:
    """Return the repo-relative path of a self-surface write, else ``None``.

    The path keeps the caller's casing so the permission bubble shows what the
    model actually asked to write.
    """
    insensitive = _case_insensitive(repo_root)
    paths = _candidate_paths(tool_name, input, repo_root)
    # G5 round 3 item 4: an ambiguous Win32 UNC/device candidate gets the SAME
    # "is this self-modify?" treatment as a proven match -- this function's
    # only caller must never treat "can't verify" as "verified NOT
    # self-modify."
    if AMBIGUOUS_WIN32_PATH in paths:
        return AMBIGUOUS_WIN32_PATH
    # G5 batch-11 (9th audit) item 5: same "can't verify, treat as if it
    # matched" rule as the Win32 sentinel above, for the `cd` short-circuit.
    if AMBIGUOUS_CD_PATH in paths:
        return AMBIGUOUS_CD_PATH
    return _shortest_self_surface_match(paths, insensitive)


def decide(
    mode: str,
    tool_name: str,
    input: dict,  # noqa: A002 - contract name
    *,
    session_allow: set[str],
    deny_count: int,
    repo_root: Path,
) -> Decision:
    """Apply the C3 rules, in order, to one ``can_use_tool`` request.

    ``deny_count`` is supplied by the caller, keyed on
    ``(tool_name, json.dumps(input, sort_keys=True))``.
    """
    if mode not in _CLI_PERMISSION_MODES:
        raise ValueError(f"unknown permission mode: {mode!r}")

    kind = classify(tool_name, input)
    paths = _candidate_paths(tool_name, input, repo_root)
    insensitive = _case_insensitive(repo_root)
    self_path = _shortest_self_surface_match(paths, insensitive)  # G5 item 7
    backend_restart = any(_is_backend_restart(rel, insensitive) for rel in paths)

    def verdict(action: Action, reason: str) -> Decision:
        return Decision(
            kind=kind,
            action=action,
            reason=reason,
            self_modify=self_path is not None,
            self_modify_path=self_path,
            backend_restart=backend_restart,
        )

    # 1. Read-only mode short-circuits everything, including self-modification.
    if mode == "readonly":
        if kind == "read":
            return verdict("allow", "Read-only mode allows read-only tools")
        return verdict("deny", "Read-only mode")

    # 2. Self-modification always bubbles, and is never remembered.
    if self_path is not None:
        return verdict("ask", f"Modifies the assistant's own surface: {self_path}")

    # 2b. G5 round 3 item 4: a candidate that resolved to AMBIGUOUS_WIN32_PATH
    # (a Win32 UNC or raw device path) can't be proven either in or out of
    # the repo, so it gets the SAME treatment as a known self-modify match --
    # always ask, in every remaining mode -- rather than falling through to
    # trusted's "allow the rest". self_modify/self_modify_path stay
    # False/None on the returned Decision (the real path is truly
    # unknown), but the verdict itself is exactly as cautious as if it had
    # matched.
    #
    # G5 round 5 item 3: this rule sits ABOVE rule 4 (session_allow) and rule
    # 5 (3x-deny auto-deny) DELIBERATELY -- an ambiguous candidate can never
    # be remembered as allowed for the session, and can never auto-deny
    # after three declines either; it re-asks every single time. That is the
    # safe direction (a path this module can't verify must never become a
    # standing "yes" or a silent "no"), not an oversight, even though it
    # means there is no user-reachable way to make the prompt stop for a
    # truly ambiguous path short of it resolving cleanly one way or the
    # other.
    # G5 batch-11 (9th audit) item 5: same treatment as the Win32-ambiguous
    # case above -- always ask, in every remaining mode, never remembered --
    # but with a reason that actually names a `cd` short-circuit instead of
    # reusing the unrelated Win32 device/UNC wording.
    if AMBIGUOUS_CD_PATH in paths:
        return verdict(
            "ask",
            "Command changes directory; target path cannot be resolved",
        )

    if AMBIGUOUS_WIN32_PATH in paths:
        return verdict(
            "ask",
            "Path cannot be verified as outside the assistant's own surface "
            "(Win32 device/UNC form)",
        )

    # 3. Trusted mode allows the rest.
    if mode == "trusted":
        return verdict("allow", "Trusted mode")

    # 4. Explicitly allowed for this session.
    if tool_name in session_allow:
        return verdict("allow", "Allowed for this session")

    # 5. Declined three times for the identical (tool, input).
    if deny_count >= 3:
        return verdict("deny", "declined 3× — not asking again")

    # 6. Accept-edits allows reads and edits that stay inside the repo.
    if mode == "accept_edits":
        if kind == "read":
            return verdict("allow", "Accept-edits mode allows read-only tools")
        if kind == "edit" and paths:
            return verdict("allow", "Accept-edits mode allows edits inside the repo")
        return verdict("ask", "Accept-edits mode asks for this tool")

    # 7. Ask mode: reads are free, everything else bubbles.
    if kind == "read":
        return verdict("allow", "Read-only tool")
    return verdict("ask", "Ask mode requires approval for this tool")
