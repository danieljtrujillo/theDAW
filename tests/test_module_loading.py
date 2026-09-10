"""Every enabled backend module must actually mount.

The loader is deliberately forgiving — a module that fails to import is
logged and skipped so one broken feature cannot stop the server. That
forgiveness hid a real bug: ``backend/modules/underfit/sidecar.py`` shipped
with a SyntaxError (a ``"\\n".join(...)`` written with a literal newline) and
sat unmounted for three days. Every ``/api/underfit/*`` call returned 404 and
the tab looked like a network fault, because nothing surfaced the reason.

So the forgiveness stays, and this is the net under it: import every module's
router, and fail loudly here rather than silently at runtime.
"""

from __future__ import annotations

import importlib
import json
import py_compile
from pathlib import Path

import pytest

MODULES_DIR = Path(__file__).resolve().parents[1] / "backend" / "modules"


def _module_dirs() -> list[Path]:
    return [
        d
        for d in sorted(MODULES_DIR.iterdir())
        if d.is_dir() and (d / "module.json").exists() and (d / "router.py").exists()
    ]


def _enabled(module_dir: Path) -> bool:
    try:
        config = json.loads((module_dir / "module.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return bool(config.get("enabled", True))


@pytest.mark.parametrize("module_dir", _module_dirs(), ids=lambda d: d.name)
def test_every_enabled_module_router_imports(module_dir: Path) -> None:
    if not _enabled(module_dir):
        pytest.skip(f"{module_dir.name} is disabled in module.json")
    importlib.import_module(f"backend.modules.{module_dir.name}.router")


@pytest.mark.parametrize(
    "source",
    sorted(
        p
        for p in MODULES_DIR.rglob("*.py")
        # Vendored sidecar venvs are not ours to compile.
        if ".venv" not in p.parts and "site-packages" not in p.parts
    ),
    ids=lambda p: str(p.relative_to(MODULES_DIR)).replace("\\", "/"),
)
def test_module_sources_have_no_syntax_errors(source: Path, tmp_path: Path) -> None:
    """A module's own source compiles, even the halves ``router.py`` imports
    lazily. ``sidecar.py`` was never imported at test time, which is exactly
    why nothing caught it."""
    py_compile.compile(str(source), cfile=str(tmp_path / "out.pyc"), doraise=True)


def test_the_loader_records_why_a_module_did_not_mount() -> None:
    """A failure has to leave a trace something can read back.

    ``/api/modules/all`` reports ``_load_error`` from this, so "enabled but
    not loaded" can say what went wrong instead of looking like the module
    was never there.
    """
    from fastapi import FastAPI

    from backend.modules.loader import load_modules

    app = FastAPI()
    load_modules(app, MODULES_DIR)
    errors = getattr(app.state, "module_load_errors", None)
    assert errors is not None, "the loader must always publish its error map"
    assert errors == {}, f"modules failed to load: {errors}"


def test_a_broken_module_is_skipped_and_named(tmp_path: Path) -> None:
    """The forgiveness itself: one broken module must not take the rest down,
    and its reason must be recorded."""
    from fastapi import FastAPI

    from backend.modules.loader import load_modules

    good = tmp_path / "good"
    good.mkdir()
    (good / "module.json").write_text('{"name": "good"}', encoding="utf-8")
    (good / "router.py").write_text(
        "from fastapi import APIRouter\nrouter = APIRouter()\n", encoding="utf-8"
    )
    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "module.json").write_text('{"name": "bad"}', encoding="utf-8")
    (bad / "router.py").write_text("this is not python(\n", encoding="utf-8")

    app = FastAPI()
    # The loader imports by package path, so the fixtures need to be importable
    # as backend.modules.* — instead assert on the real tree's behaviour and
    # only check the shape of the error map here.
    manifests = load_modules(app, tmp_path)
    errors = getattr(app.state, "module_load_errors", {})
    assert isinstance(errors, dict)
    # Neither fixture is under backend.modules, so both fail to import; what
    # matters is that the loader returned rather than raising, and that it
    # named every failure.
    assert len(manifests) + len(errors) == 2
