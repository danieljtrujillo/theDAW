"""scripts/check_portability.py: one hit and one clean form per pattern, the
allow-comment, and the rule that this repository's own tree is clean.

The checker is the static half of CLAUDE.md hard rule 5. Each fixture is the
smallest source that shows a pattern, given the path of the tree it would live
in (the first path segment selects which patterns apply).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "check_portability", REPO / "scripts" / "check_portability.py"
)
assert _SPEC is not None and _SPEC.loader is not None
check_portability = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = check_portability  # dataclasses look the module up
_SPEC.loader.exec_module(check_portability)

# Spelled in two pieces so this file's own string constants hold no FTS5 SQL.
FTS = "fts" + "5"


def _patterns(source: str, path: str) -> list[str]:
    return [hit.pattern for hit in check_portability.check_source(source, path)]


CASES = [
    # (pattern, path, source with the hit, the form the checker wants)
    (
        "P1",
        "backend/x.py",
        "import subprocess\nflags = subprocess.CREATE_NO_WINDOW\n",
        'import subprocess\nflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)\n',
    ),
    (
        "P2",
        "backend/x.py",
        'def scan(root):\n    return list(root.rglob("*"))\n',
        "def scan(root):\n    return list(walk_files(root))\n",
    ),
    (
        "P2",
        "scripts/x.py",
        "import os\nfor d, dirs, files in os.walk(root):\n    pass\n",
        "import os\nfor d, dirs, files in os.walk(root, followlinks=True):\n    pass\n",
    ),
    (
        "P2",
        "backend/x.py",
        "def size(entry):\n    return entry.is_dir(follow_symlinks=False)\n",
        "def size(entry):\n"
        "    if entry.is_symlink() or entry.is_junction():\n"
        "        return False\n"
        "    return entry.is_dir(follow_symlinks=False)\n",
    ),
    (
        "P3",
        "tests/test_x.py",
        "def link_dir(link, target):\n    link.symlink_to(target)\n",
        "def link_dir(link, target):\n"
        "    try:\n"
        "        link.symlink_to(target)\n"
        "    except OSError:\n"
        "        return False\n"
        "    return True\n",
    ),
    (
        "P3",
        "tests/test_x.py",
        "def make_junction(link, target):\n"
        '    return run(["cmd", "/c", "mklink", "/J", str(link), str(target)])\n',
        "def make_junction(link, target):\n"
        "    if WINDOWS:\n"
        '        return run(["cmd", "/c", "mklink", "/J", str(link), str(target)])\n'
        "    try:\n"
        "        os.symlink(target, link)\n"
        "    except OSError:\n"
        "        return False\n",
    ),
    (
        "P4",
        "tests/test_x.py",
        "def test_size(tmp_path, body):\n"
        '    f = tmp_path / "a.txt"\n'
        "    f.write_text(body)\n"
        "    assert f.stat().st_size == 12\n",
        "def test_size(tmp_path, body):\n"
        '    f = tmp_path / "a.txt"\n'
        '    f.write_text(body, newline="\\n")\n'
        "    assert f.stat().st_size == 12\n",
    ),
    (
        "P5",
        "backend/x.py",
        "def key_of(path):\n    return str(path).lower()\n",
        "import os\ndef key_of(path):\n    return os.path.normcase(str(path))\n",
    ),
    (
        "P5",
        "tests/test_x.py",
        "def test_same(root):\n    assert same_tree(str(root).upper())\n",
        "import os\n"
        "def test_same(root):\n"
        '    assert same_tree(str(root).upper()) is (os.name == "nt")\n',
    ),
    (
        "P6",
        "backend/x.py",
        "import os\ndef alive(pid):\n    os.kill(pid, 0)\n    return True\n",
        "import os\n"
        "def alive(pid):\n"
        "    os.kill(pid, 0)\n"
        "    return not is_zombie(pid)\n",
    ),
    (
        "P6",
        "tests/test_x.py",
        "def test_gone(pid):\n    assert not psutil.pid_exists(pid)\n",
        "def test_gone(pid):\n"
        "    assert not psutil.pid_exists(pid) or (\n"
        "        psutil.Process(pid).status() == psutil.STATUS_ZOMBIE\n"
        "    )\n",
    ),
    (
        "P7",
        "backend/x.py",
        'from pathlib import Path\nROOTS = [Path("C:/Android")]\n',
        "import os\n"
        "from pathlib import Path\n"
        "ROOTS = []\n"
        'if os.name == "nt":\n'
        '    ROOTS.append(Path("C:/Android"))\n',
    ),
    (
        "P8",
        "backend/x.py",
        "import socket\n"
        "probe = socket.socket(socket.AF_INET6)\n"
        'listener.bind(("127.0.0.1", 0))\n',
        'import socket\nlistener.bind(("127.0.0.1", 0))\n',
    ),
    (
        "P8",
        "tests/test_x.py",
        '@pytest.mark.skipif(not has_ipv6(), reason="no IPv6 here")\n'
        "def test_dual_stack():\n    pass\n",
        "def test_dual_stack(fake_socket):\n    pass\n",
    ),
    (
        "P9",
        "backend/x.py",
        f'def build(conn):\n    conn.execute("CREATE VIRTUAL TABLE t USING {FTS}(x)")\n',
        "import sqlite3\n"
        "def build(conn):\n"
        "    try:\n"
        f'        conn.execute("CREATE VIRTUAL TABLE t USING {FTS}(x)")\n'
        "    except sqlite3.OperationalError:\n"
        "        return False\n"
        "    return True\n",
    ),
    (
        "P9",
        "backend/x.py",
        "import sqlite3\n"
        "conn = sqlite3.connect(path)\n"
        "rows = conn.execute(\"SELECT json_extract(meta, '$.a') FROM t\")\n",
        "import sqlite3\n"
        "conn = sqlite3.connect(path)\n"
        "_ensure_json1(conn)\n"
        "rows = conn.execute(\"SELECT json_extract(meta, '$.a') FROM t\")\n",
    ),
    (
        "P10",
        "backend/x.py",
        "import os\nos.rename(src, dst)\n",
        "import os\nos.replace(src, dst)\n",
    ),
    (
        "P10",
        "backend/x.py",
        "def publish(tmp, path):\n"
        "    for attempt in range(12):\n"
        "        try:\n"
        "            os.replace(tmp, path)\n"
        "            return\n"
        "        except PermissionError:\n"
        "            time.sleep(0.02)\n",
        "def publish(tmp, path):\n"
        "    for attempt in range(12):\n"
        "        try:\n"
        "            os.replace(tmp, path)\n"
        "            return\n"
        "        except PermissionError:\n"
        '            if os.name != "nt":\n'
        "                raise\n"
        "            time.sleep(0.02)\n",
    ),
    (
        "P11",
        "tests/test_x.py",
        "def test_windows(monkeypatch):\n"
        '    monkeypatch.setattr(sidecar.sys, "platform", "win32")\n',
        "def test_windows(monkeypatch):\n"
        '    patch_platform(monkeypatch, sidecar, "win32")\n',
    ),
    (
        "P11",
        "tests/test_x.py",
        "def test_fast(elapsed):\n    assert elapsed < 0.5\n",
        "def test_fast(elapsed):\n    assert elapsed < prompt_seconds(0.5)\n",
    ),
    (
        "P11",
        "tests/test_x.py",
        '@pytest.mark.skipif(sys.platform != "win32", reason="Windows")\n'
        "def test_locked():\n    pass\n",
        '@pytest.mark.skipif(sys.platform == "win32", reason="POSIX")\n'
        "def test_moved():\n    pass\n\n\n"
        '@pytest.mark.skipif(sys.platform != "win32", reason="Windows")\n'
        "def test_locked():\n    pass\n",
    ),
]

_IDS = [f"{case[0]}-{index}" for index, case in enumerate(CASES)]


@pytest.mark.parametrize("pattern, path, hit, clean", CASES, ids=_IDS)
def test_each_pattern_is_found_and_its_wanted_form_is_clean(
    pattern: str, path: str, hit: str, clean: str
) -> None:
    assert _patterns(hit, path) == [pattern]
    assert _patterns(clean, path) == []


def test_every_pattern_has_a_fixture() -> None:
    assert {case[0] for case in CASES} == set(check_portability.NAMES)


def test_a_hit_names_the_file_the_line_the_pattern_and_the_fix() -> None:
    source = "import subprocess\n\nflags = subprocess.CREATE_NO_WINDOW\n"
    (hit,) = check_portability.check_source(source, "backend/x.py")
    assert (hit.path, hit.line, hit.pattern) == ("backend/x.py", 3, "P1")
    line = hit.render()
    assert line.startswith("backend/x.py:3: P1 bare-subprocess-flag: ")
    assert 'getattr(subprocess, "CREATE_NO_WINDOW", 0)' in line


def test_the_allow_comment_accepts_a_reviewed_exception() -> None:
    bare = "import subprocess\nflags = subprocess.CREATE_NO_WINDOW"
    assert _patterns(bare + "\n", "backend/x.py") == ["P1"]
    reviewed = bare + "  # portability: inside a win32-only branch\n"
    assert _patterns(reviewed, "backend/x.py") == []
    above = (
        "import subprocess\n"
        "# portability: inside a win32-only branch\n"
        "flags = subprocess.CREATE_NO_WINDOW\n"
    )
    assert _patterns(above, "backend/x.py") == []
    # A reason is required: the bare marker accepts nothing.
    assert _patterns(bare + "  # portability:\n", "backend/x.py") == ["P1"]


def test_a_pattern_applies_only_in_its_trees() -> None:
    scan = 'def files(root):\n    return list(root.rglob("*.py"))\n'
    assert _patterns(scan, "backend/x.py") == ["P2"]
    assert _patterns(scan, "tests/test_x.py") == []
    bound = "def test_fast(elapsed):\n    assert elapsed < 0.5\n"
    assert _patterns(bound, "backend/x.py") == []


def test_a_sort_key_and_a_name_test_are_not_case_fold_keys() -> None:
    source = (
        "def order(paths, binary):\n"
        "    paths.sort(key=lambda p: str(p).lower())\n"
        '    return "musescore" in str(binary).lower()\n'
    )
    assert _patterns(source, "backend/x.py") == []


def test_the_command_line_exits_one_on_a_hit_and_zero_when_clean(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    backend = tmp_path / "backend"
    backend.mkdir()
    (backend / "bad.py").write_bytes(b"import os\nos.rename(a, b)\n")
    assert check_portability.main(["--root", str(tmp_path)]) == 1
    assert (
        "backend/bad.py:2: P10 handle-and-rename-semantics" in capsys.readouterr().out
    )
    (backend / "bad.py").write_bytes(b"import os\nos.replace(a, b)\n")
    assert check_portability.main(["--root", str(tmp_path)]) == 0
    # Named files: only the ones under backend/, scripts/ and tests/ are read.
    (tmp_path / "loose.py").write_bytes(b"import os\nos.rename(a, b)\n")
    assert check_portability.main(["--root", str(tmp_path), "loose.py"]) == 0


def test_this_repository_is_clean() -> None:
    assert check_portability.main([]) == 0
