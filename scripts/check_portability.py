#!/usr/bin/env python
"""Find code that behaves one way on Windows and another on Linux or macOS.

theDAW is written on Windows and tested on a Linux runner. Nearly every red
pull request that was not a timing bound came from code or a test that was only
ever run on Windows. This is the static half of CLAUDE.md hard rule 5: it reads
``backend/``, ``scripts/`` and ``tests/`` with ``ast`` and reports each pattern
below with ``file:line``, the pattern id and the form it wants.

    python scripts/check_portability.py            # the whole tree
    python scripts/check_portability.py a.py b.py  # these files only

Exit code 1 on any hit, 0 when clean. A reviewed exception carries
``# portability: <reason>`` on the reported line, on any line of a statement
that spans several, or on a comment line directly above it. Pure standard
library, no configuration, same answer on every platform.

Patterns (trees in brackets):

P1  bare-subprocess-flag [all]  ``subprocess.CREATE_NO_WINDOW`` and the other
    Windows-only names read as a plain attribute. They do not exist on Linux,
    and a test that fakes ``sys.platform`` reaches them there.
P2  link-blind-scan [backend, scripts]  ``Path.rglob``, ``glob("**")`` and
    ``os.walk`` without ``followlinks`` stop at a directory symlink and enter a
    Windows junction; ``is_dir(follow_symlinks=False)`` is True for a junction.
P3  junction-only-link-helper [tests]  a link helper that knows ``mklink /J``
    or ``CreateJunction`` only, or a symlink made with no ``try``.
P4  text-fixture-newline [tests]  ``write_text`` without ``newline="\\n"`` on a
    file whose size or bytes the test then asserts.
P5  case-fold-key [all]  ``.lower()`` on a path as a key (it folds on Linux
    too and merges two folders); a test that asserts two case variants equal
    with no platform rule.
P6  zombie-counted-alive [all]  ``os.kill(pid, 0)``, ``pid_exists``,
    ``is_running`` and ``wait_procs`` report an exited, unreaped process as
    alive on Linux and macOS.
P7  windows-path-outside-guard [backend, scripts]  a drive-letter path,
    ``Program Files`` or ``AppData`` outside a Windows branch.
P8  single-family-bind [all]  a literal one-family ``bind`` beside code that
    reasons about IPv6; a test switched on the runner's IPv6 state.
P9  sqlite-feature-assumption [all]  FTS5 or JSON1 SQL with no probe for a
    SQLite built without it.
P10 handle-and-rename-semantics [backend, scripts]  ``os.rename`` (refuses an
    existing target on Windows, replaces it elsewhere); a retry loop that
    handles ``PermissionError`` only, with no platform rule.
P11 test-only [tests]  (a) patching the global ``sys.platform``; (b) a
    wall-clock bound written as a bare number; (c) a Windows-only skip in a
    file with no test for the other platforms.
"""

from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional

TREES = ("backend", "scripts", "tests")
ALLOW = re.compile(r"#\s*portability:\s*\S")

NAMES = {
    "P1": "bare-subprocess-flag",
    "P2": "link-blind-scan",
    "P3": "junction-only-link-helper",
    "P4": "text-fixture-newline",
    "P5": "case-fold-key",
    "P6": "zombie-counted-alive",
    "P7": "windows-path-outside-guard",
    "P8": "single-family-bind",
    "P9": "sqlite-feature-assumption",
    "P10": "handle-and-rename-semantics",
    "P11": "test-only",
}

_SUBPROCESS_WINDOWS = re.compile(
    r"^(CREATE_[A-Z_]+|DETACHED_PROCESS|STARTUPINFO|STARTF_[A-Z_]+|SW_HIDE"
    r"|[A-Z_]+_PRIORITY_CLASS)$"
)
_PLATFORM_TEST = re.compile(
    r"win32|os\.name|['\"]nt['\"]|windows|platform\.system", re.I
)
_PLATFORM_RULE = re.compile(r"os\.name|sys\.platform|normcase|winerror")
_PATHISH_NAME = re.compile(
    r"(^|_)(path|paths|root|dir|folder|cwd|candidate|binary|file|filename"
    r"|checkout|exe|location|target|dest|src|p|d)($|_)",
    re.I,
)
_PATH_CALLS = ("normpath", "abspath", "realpath", "expanduser", "fspath")
_WINDOWS_LITERAL = re.compile(r"^[A-Za-z]:[\\/]|Program Files")
_BIND_HOSTS = {"127.0.0.1", "0.0.0.0", "::", "::1"}
_FTS5 = re.compile(r"\busing\s+fts5\b", re.I)
_JSON1 = re.compile(r"\bjson_(extract|valid|each|object|array|set)\(")
_WINDOWS_ONLY_SKIP = re.compile(
    r"sys\.platform\s*!=\s*['\"]win32['\"]|os\.name\s*!=\s*['\"]nt['\"]"
)
_POSIX_ONLY_SKIP = re.compile(
    r"sys\.platform\s*==\s*['\"]win32['\"]|os\.name\s*==\s*['\"]nt['\"]"
    r"|sys\.platform\.startswith\(['\"]win"
)
_IPV6_SWITCH = re.compile(r"ipv6|dual_stack|v6only", re.I)
_ELAPSED_NAME = re.compile(r"elapsed|took|_seconds$", re.I)
_ZOMBIE_AWARE = re.compile(r"zombie|has_exited", re.I)


@dataclass(frozen=True)
class Hit:
    path: str
    line: int
    end_line: int
    pattern: str
    message: str
    fix: str

    def render(self) -> str:
        return (
            f"{self.path}:{self.line}: {self.pattern} {NAMES[self.pattern]}: "
            f"{self.message} Fix: {self.fix}"
        )


def _src(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:  # noqa: BLE001 - an odd node is simply not matched
        return ""


class _File:
    """One parsed file plus the lookups every pattern needs."""

    def __init__(self, source: str, rel: str) -> None:
        self.source = source
        self.rel = rel.replace("\\", "/")
        self.tree_name = self.rel.split("/", 1)[0]
        self.lines = source.splitlines()
        self.tree = ast.parse(source)
        self.parent: dict[ast.AST, ast.AST] = {}
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parent[child] = node
        self.hits: list[Hit] = []

    # ---- helpers ----------------------------------------------------------

    def ancestors(self, node: ast.AST) -> Iterator[ast.AST]:
        while node in self.parent:
            node = self.parent[node]
            yield node

    def scope(self, node: ast.AST) -> ast.AST:
        """The enclosing function, or the module."""
        for anc in self.ancestors(node):
            if isinstance(anc, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return anc
        return self.tree

    def statement(self, node: ast.AST) -> ast.AST:
        """The statement a node belongs to (its allow-comment span)."""
        current = node
        while not isinstance(current, ast.stmt) and current in self.parent:
            current = self.parent[current]
        return current

    def add(self, node: ast.AST, pattern: str, message: str, fix: str) -> None:
        line = getattr(node, "lineno", 1)
        stmt = self.statement(node)
        first = min(line, getattr(stmt, "lineno", line))
        last = max(
            getattr(node, "end_lineno", line) or line,
            getattr(stmt, "end_lineno", line) or line,
        )
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            # A decorator hit: the span is the decorator list, not the body.
            last = max(line, stmt.lineno)
        if first > 1 and self.lines[first - 2].lstrip().startswith("#"):
            first -= 1  # a comment line of its own, directly above
        for number in range(first, last + 1):
            if number <= len(self.lines) and ALLOW.search(self.lines[number - 1]):
                return
        self.hits.append(Hit(self.rel, line, last, pattern, message, fix))

    def in_tree(self, *names: str) -> bool:
        return self.tree_name in names


def _is_call_to(node: ast.AST, owner: str, attr: str) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == attr
        and _src(node.func.value) == owner
    )


def _method(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        return node.func.attr
    return None


def _has_keyword(call: ast.Call, name: str) -> bool:
    return any(kw.arg == name for kw in call.keywords)


# ---- P1 ---------------------------------------------------------------------


def _p1(f: _File) -> None:
    for node in ast.walk(f.tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "subprocess"
            and _SUBPROCESS_WINDOWS.match(node.attr)
        ):
            f.add(
                node,
                "P1",
                f"subprocess.{node.attr} exists on Windows only.",
                f'getattr(subprocess, "{node.attr}", 0)',
            )


# ---- P2 ---------------------------------------------------------------------


def _p2(f: _File) -> None:
    if not f.in_tree("backend", "scripts"):
        return
    fix = (
        "backend.lib.fswalk.walk_files(root), or os.walk(root, followlinks=True) "
        "with a visited (st_dev, st_ino) set."
    )
    for node in ast.walk(f.tree):
        if not isinstance(node, ast.Call):
            continue
        name = _method(node)
        if name == "rglob":
            f.add(node, "P2", "rglob stops at a directory symlink.", fix)
        elif (
            name == "glob"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
            and "**" in node.args[0].value
        ):
            f.add(node, "P2", 'glob("**") stops at a directory symlink.', fix)
        elif _is_call_to(node, "os", "walk") and not _has_keyword(node, "followlinks"):
            f.add(
                node,
                "P2",
                "os.walk without followlinks skips a directory symlink and "
                "enters a junction.",
                fix,
            )
        elif name == "is_dir" and any(
            kw.arg == "follow_symlinks"
            and isinstance(kw.value, ast.Constant)
            and kw.value.value is False
            for kw in node.keywords
        ):
            scope = f.scope(node)
            if not any(_method(n) == "is_junction" for n in ast.walk(scope)):
                f.add(
                    node,
                    "P2",
                    "is_dir(follow_symlinks=False) is True for a Windows junction.",
                    "test entry.is_junction() beside entry.is_symlink() in the "
                    "same function.",
                )


# ---- P3 ---------------------------------------------------------------------


def _catches_oserror(handler: ast.ExceptHandler) -> bool:
    if handler.type is None:
        return True
    return bool(re.search(r"OSError|NotImplementedError|Exception", _src(handler.type)))


def _p3(f: _File) -> None:
    if not f.in_tree("tests"):
        return
    junction_scopes: dict[ast.AST, ast.AST] = {}
    symlink_scopes: set[ast.AST] = set()
    for node in ast.walk(f.tree):
        if isinstance(node, ast.Constant) and node.value == "mklink":
            junction_scopes.setdefault(f.scope(node), node)
        elif isinstance(node, ast.Attribute) and node.attr == "CreateJunction":
            junction_scopes.setdefault(f.scope(node), node)
        if not isinstance(node, ast.Call):
            continue
        if _method(node) == "symlink_to" or _is_call_to(node, "os", "symlink"):
            symlink_scopes.add(f.scope(node))
            guarded = False
            child: ast.AST = node
            for anc in f.ancestors(node):
                if isinstance(anc, ast.Try) and child in anc.body:
                    guarded = any(_catches_oserror(h) for h in anc.handlers)
                    if guarded:
                        break
                if isinstance(anc, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    break
                child = anc
            if not guarded:
                f.add(
                    node,
                    "P3",
                    "a symlink made with no try: some filesystems and Windows "
                    "accounts refuse one.",
                    "try: ... except OSError: pytest.skip(...) (or return False).",
                )
    for scope, node in junction_scopes.items():
        if scope not in symlink_scopes:
            f.add(
                node,
                "P3",
                "this link helper makes a Windows junction only, so its tests "
                "never run on Linux.",
                "add the os.symlink branch for the other platforms, skipping "
                "on OSError.",
            )


# ---- P4 ---------------------------------------------------------------------


def _literal_size(node: ast.AST) -> bool:
    """A size or content written into the test itself: a number, bytes,
    ``len(...)`` or ``"...".encode()``. A comparison against bytes read back
    earlier holds on every platform."""
    if isinstance(node, ast.Constant):
        return isinstance(node.value, (int, bytes)) and not isinstance(node.value, bool)
    if isinstance(node, ast.Call):
        return _src(node.func) == "len" or _method(node) == "encode"
    return False


def _p4(f: _File) -> None:
    if not f.in_tree("tests"):
        return
    for scope in ast.walk(f.tree):
        if not isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        writes: dict[str, ast.Call] = {}
        sized: set[str] = set()
        for node in ast.walk(scope):
            if isinstance(node, ast.Call) and _method(node) == "write_text":
                text = node.args[0] if node.args else None
                plain = (
                    isinstance(text, ast.Constant)
                    and isinstance(text.value, str)
                    and "\n" not in text.value
                )
                if not _has_keyword(node, "newline") and not plain:
                    writes.setdefault(_src(node.func.value), node)  # type: ignore[attr-defined]
            if isinstance(node, ast.Compare) and any(
                _literal_size(side) for side in (node.left, *node.comparators)
            ):
                for part in ast.walk(node):
                    if isinstance(part, ast.Attribute) and part.attr == "st_size":
                        inner = part.value
                        if _method(inner) == "stat":
                            sized.add(_src(inner.func.value))  # type: ignore[attr-defined]
                    elif _method(part) == "read_bytes":
                        sized.add(_src(part.func.value))  # type: ignore[attr-defined]
                    elif isinstance(part, ast.Call) and _src(part.func) in (
                        "os.path.getsize",
                        "getsize",
                    ):
                        if part.args:
                            sized.add(_src(part.args[0]))
        for receiver, node in writes.items():
            if receiver in sized:
                f.add(
                    node,
                    "P4",
                    "this text file is written with the platform's newline and "
                    "its size or bytes are asserted.",
                    'write_text(..., newline="\\n") or write_bytes(...).',
                )


# ---- P5 ---------------------------------------------------------------------


def _pathish(node: ast.AST) -> bool:
    """Whether the receiver of ``.lower()`` is a path expression."""
    while True:
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                if func.attr in ("rstrip", "lstrip", "strip"):
                    node = func.value
                    continue
                if func.attr == "replace":
                    args = [
                        a.value
                        for a in node.args
                        if isinstance(a, ast.Constant) and isinstance(a.value, str)
                    ]
                    if "\\" in args and "/" in args:
                        return True
                    node = func.value
                    continue
                if func.attr in ("as_posix", "resolve", "absolute"):
                    return True
                if func.attr in _PATH_CALLS:
                    return True
                return False
            if isinstance(func, ast.Name) and func.id == "str" and len(node.args) == 1:
                arg = node.args[0]
                if isinstance(arg, ast.Name):
                    return bool(_PATHISH_NAME.search(arg.id))
                return _pathish(arg)
            return False
        return False


def _p5(f: _File) -> None:
    for node in ast.walk(f.tree):
        if not isinstance(node, ast.Call):
            continue
        name = _method(node)
        in_tests = f.in_tree("tests")
        wanted = ("lower", "upper", "swapcase") if in_tests else ("lower", "casefold")
        if name not in wanted or node.args:
            continue
        if not _pathish(node.func.value):  # type: ignore[attr-defined]
            continue
        parent = f.parent.get(node)
        if isinstance(parent, ast.Attribute) and parent.attr in (
            "endswith",
            "startswith",
            "find",
            "count",
            "split",
            "rsplit",
        ):
            continue
        if isinstance(parent, ast.Compare) and all(
            isinstance(op, (ast.In, ast.NotIn)) for op in parent.ops
        ):
            continue
        if any(isinstance(a, ast.Lambda) for a in f.ancestors(node)):
            continue  # a sort key orders names, it does not identify them
        if in_tests:
            scope = f.scope(node)
            if _PLATFORM_RULE.search(_src(scope)):
                continue
            f.add(
                node,
                "P5",
                "a case variant of a path is only the same path on Windows.",
                'state the rule: expect equality when os.name == "nt", two '
                "paths elsewhere.",
            )
        else:
            f.add(
                node,
                "P5",
                f".{name}() on a path folds case on Linux and macOS too, where "
                "two case variants are two folders.",
                'os.path.normcase(...), or fold only when os.name == "nt".',
            )


# ---- P6 ---------------------------------------------------------------------


def _p6(f: _File) -> None:
    for node in ast.walk(f.tree):
        if not isinstance(node, ast.Call):
            continue
        name = _method(node)
        probe = None
        if (
            _is_call_to(node, "os", "kill")
            and len(node.args) == 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value == 0
        ):
            probe = "os.kill(pid, 0)"
        elif name in ("pid_exists", "wait_procs", "is_running"):
            probe = name
        if probe is None:
            continue
        scope = f.scope(node)
        aware = False
        for part in ast.walk(scope):
            ident = (
                part.id
                if isinstance(part, ast.Name)
                else part.attr
                if isinstance(part, ast.Attribute)
                else ""
            )
            if ident and _ZOMBIE_AWARE.search(ident):
                aware = True
                break
        if not aware:
            f.add(
                node,
                "P6",
                f"{probe} reports an exited, unreaped process (a zombie) as "
                "alive on Linux and macOS.",
                "count a zombie as gone: backend.lib.procs.is_zombie / wait_gone, "
                "or psutil.STATUS_ZOMBIE, in the same function.",
            )


# ---- P7 ---------------------------------------------------------------------


def _windows_guarded(f: _File, node: ast.AST) -> bool:
    child = node
    for anc in f.ancestors(node):
        if isinstance(anc, (ast.If, ast.IfExp, ast.While)):
            if _PLATFORM_TEST.search(_src(anc.test)):
                return True
        if isinstance(anc, (ast.Assign, ast.AnnAssign)):
            targets = anc.targets if isinstance(anc, ast.Assign) else [anc.target]
            if any("win" in _src(t).lower() for t in targets):
                return True
        if isinstance(anc, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if "win" in anc.name.lower():
                return True
            # An early exit for the other platforms guards what follows it.
            for stmt in anc.body:
                if stmt is child:
                    break
                if (
                    isinstance(stmt, ast.If)
                    and _PLATFORM_TEST.search(_src(stmt.test))
                    and stmt.body
                    and isinstance(stmt.body[-1], (ast.Return, ast.Raise))
                ):
                    return True
        child = anc
    return False


def _p7(f: _File) -> None:
    if not f.in_tree("backend", "scripts"):
        return
    for node in ast.walk(f.tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        value = node.value
        if not (_WINDOWS_LITERAL.search(value) or value == "AppData"):
            continue
        parent = f.parent.get(node)
        if isinstance(parent, ast.Expr):
            continue  # a docstring
        if isinstance(parent, ast.JoinedStr):
            node_for_guard: ast.AST = parent
        else:
            node_for_guard = node
        if _windows_guarded(f, node_for_guard):
            continue
        f.add(
            node,
            "P7",
            "a Windows path outside a Windows branch; on Linux it is a relative "
            "name under the working directory.",
            'put it under if os.name == "nt": (or sys.platform == "win32") and '
            "give the other platforms their own value.",
        )


# ---- P8 ---------------------------------------------------------------------


def _p8(f: _File) -> None:
    if f.in_tree("backend", "scripts") and re.search(r"AF_INET6|IPV6_V6ONLY", f.source):
        for node in ast.walk(f.tree):
            if (
                isinstance(node, ast.Call)
                and _method(node) == "bind"
                and node.args
                and isinstance(node.args[0], ast.Tuple)
                and node.args[0].elts
                and isinstance(node.args[0].elts[0], ast.Constant)
                and node.args[0].elts[0].value in _BIND_HOSTS
            ):
                f.add(
                    node,
                    "P8",
                    "one address family is bound beside code that reasons about "
                    "the other; the result follows the machine's dual-stack "
                    "policy.",
                    "bind both families, or say on this line why one is enough.",
                )
    if f.in_tree("tests"):
        for node in ast.walk(f.tree):
            if (
                isinstance(node, ast.Call)
                and _src(node.func).endswith("skipif")
                and node.args
                and _IPV6_SWITCH.search(_src(node.args[0]))
            ):
                f.add(
                    node,
                    "P8",
                    "this case runs or skips by the runner's IPv6 state, so one "
                    "commit exercises different code per machine.",
                    "assert one family with a fake socket, or say on this line "
                    "which case still runs everywhere.",
                )


# ---- P9 ---------------------------------------------------------------------


def _p9(f: _File) -> None:
    handles_operational = any(
        isinstance(n, ast.ExceptHandler)
        and n.type is not None
        and "OperationalError" in _src(n.type)
        for n in ast.walk(f.tree)
    )
    connects = any(_is_call_to(n, "sqlite3", "connect") for n in ast.walk(f.tree))
    has_json_probe = "ensure_json1" in f.source
    for node in ast.walk(f.tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if isinstance(f.parent.get(node), ast.Expr):
            continue  # a docstring
        if _FTS5.search(node.value) and not handles_operational:
            f.add(
                node,
                "P9",
                "FTS5 is a compile-time SQLite feature and this file has no "
                "probe for a build without it.",
                "try the statement, catch sqlite3.OperationalError and fall "
                "back or skip (backend/modules/library/db.py does).",
            )
        elif (
            f.in_tree("backend", "scripts")
            and connects
            and not has_json_probe
            and _JSON1.search(node.value)
        ):
            f.add(
                node,
                "P9",
                "JSON1 is a compile-time SQLite feature and this file opens a "
                "connection with no probe for a build without it.",
                "call _ensure_json1(conn) from backend/modules/library/db.py "
                "after sqlite3.connect.",
            )


# ---- P10 --------------------------------------------------------------------


def _p10(f: _File) -> None:
    if not f.in_tree("backend", "scripts"):
        return
    for node in ast.walk(f.tree):
        if _is_call_to(node, "os", "rename"):
            f.add(
                node,
                "P10",
                "os.rename refuses an existing target on Windows and replaces "
                "it on Linux and macOS.",
                "os.replace(src, dst), one rule on every platform.",
            )
        if (
            isinstance(node, ast.ExceptHandler)
            and node.type is not None
            and _src(node.type) == "PermissionError"
        ):
            in_loop = False
            for anc in f.ancestors(node):
                if isinstance(anc, (ast.For, ast.While)):
                    in_loop = True
                    break
                if isinstance(anc, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    break
            body = "\n".join(_src(stmt) for stmt in node.body)
            retries = "sleep(" in body
            if in_loop and retries and not _PLATFORM_RULE.search(body):
                f.add(
                    node,
                    "P10",
                    "this retry handles the Windows sharing violation only; off "
                    "Windows a PermissionError is a real fault and the loop "
                    "delays it.",
                    'raise at once when os.name != "nt", retry on Windows.',
                )


# ---- P11 --------------------------------------------------------------------


def _p11(f: _File) -> None:
    if not f.in_tree("tests"):
        return
    skips: list[ast.Call] = []
    has_posix_side = False
    for node in ast.walk(f.tree):
        if isinstance(node, ast.Call):
            func = _src(node.func)
            # (a) the global sys.platform
            if func.endswith("setattr") and len(node.args) >= 2:
                first, second = node.args[0], node.args[1]
                if (
                    isinstance(second, ast.Constant)
                    and second.value == "platform"
                    and re.search(r"(^|\.)sys$", _src(first))
                ):
                    f.add(
                        node,
                        "P11",
                        "this patches the one global sys module, so every "
                        "module reports the fake platform for the test.",
                        "tests.platform_patch.patch_platform(monkeypatch, "
                        "module, platform).",
                    )
            if (
                node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == "sys.platform"
                and re.search(r"setattr$|patch$", func)
            ):
                f.add(
                    node,
                    "P11",
                    "this patches the one global sys module, so every module "
                    "reports the fake platform for the test.",
                    "tests.platform_patch.patch_platform(monkeypatch, module, "
                    "platform).",
                )
            # (c) Windows-only skips
            if func.endswith("skipif") and node.args:
                condition = _src(node.args[0])
                if _WINDOWS_ONLY_SKIP.search(condition):
                    skips.append(node)
                if _POSIX_ONLY_SKIP.search(condition):
                    has_posix_side = True
        # (b) a wall-clock bound as a bare number
        if isinstance(node, ast.Assert):
            for part in ast.walk(node.test):
                if (
                    isinstance(part, ast.Compare)
                    and len(part.ops) == 1
                    and isinstance(part.ops[0], (ast.Lt, ast.LtE))
                    and isinstance(part.left, ast.Name)
                    and _ELAPSED_NAME.search(part.left.id)
                    and isinstance(part.comparators[0], ast.Constant)
                    and isinstance(part.comparators[0].value, (int, float))
                ):
                    f.add(
                        part,
                        "P11",
                        "a wall-clock bound written for this machine; a "
                        "two-vCPU runner exceeds it on one scheduler pause.",
                        "prompt_seconds(<local seconds>) from "
                        "tests/timing_bounds.py; @pytest.mark.timing when the "
                        "bound is the test's only claim.",
                    )
    if not has_posix_side:
        for node in skips:
            f.add(
                node,
                "P11",
                "a Windows-only test in a file with no test for the other "
                "platforms' form of the same behaviour.",
                'add the twin test (skipif sys.platform == "win32"), or say on '
                "this line why there is none.",
            )


CHECKS = (_p1, _p2, _p3, _p4, _p5, _p6, _p7, _p8, _p9, _p10, _p11)


def check_source(source: str, rel_path: str) -> list[Hit]:
    """Every hit in one file's source. ``rel_path`` is repo-relative and its
    first segment (backend, scripts, tests) selects the patterns that apply."""
    f = _File(source, rel_path)
    for check in CHECKS:
        check(f)
    return sorted(f.hits, key=lambda h: (h.line, h.pattern, h.message))


def _files(root: Path, args: list[str]) -> Iterable[Path]:
    if args:
        for arg in args:
            path = Path(arg)
            if not path.is_absolute():
                path = root / path
            if path.suffix != ".py" or not path.is_file():
                continue
            try:
                rel = path.resolve().relative_to(root.resolve())
            except ValueError:
                continue
            if rel.parts and rel.parts[0] in TREES:
                yield path
        return
    for tree in TREES:
        base = root / tree
        if not base.is_dir():
            continue
        # sorted(): one order on every filesystem. The repo's own source tree
        # holds no directory links, so rglob is the right walk here.
        for path in sorted(base.rglob("*.py")):  # portability: repo sources only
            if "__pycache__" not in path.parts:
                yield path


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    root = Path(__file__).resolve().parent.parent
    if argv[:1] == ["--root"]:
        root = Path(argv[1])
        argv = argv[2:]
    hits: list[Hit] = []
    count = 0
    for path in _files(root, argv):
        rel = path.resolve().relative_to(root.resolve()).as_posix()
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            print(f"{rel}: cannot read ({e})", file=sys.stderr)
            return 1
        try:
            hits.extend(check_source(source, rel))
        except SyntaxError as e:
            print(f"{rel}:{e.lineno}: cannot parse ({e.msg})", file=sys.stderr)
            return 1
        count += 1
    for hit in sorted(hits, key=lambda h: (h.path, h.line, h.pattern)):
        print(hit.render())
    if hits:
        print(
            f"\ncheck_portability: {len(hits)} hit(s) in {count} file(s). Fix the "
            "code, or mark a reviewed exception with  # portability: <reason>",
            file=sys.stderr,
        )
        return 1
    print(f"check_portability: {count} file(s) clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
