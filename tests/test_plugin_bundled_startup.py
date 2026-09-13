"""The bundled plugins have to be there on a machine nobody has clicked on.

The Owl and Ares are composed from in-repo assets by the package endpoints,
and until the startup hook existed nothing called those: a fresh install came
up with an empty PLUGINS shelf and an empty MIX Studio tile. These cover the
three ways that can silently come back -- a packager that raises taking the
other one with it, a listing that answers before the build publishes, and an
extraction that overwrites a live runtime halfway through.
"""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from backend.modules.plugin import router as plugin_router


@pytest.fixture
def runtime_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(plugin_router, "GAN_DIR", tmp_path / "plugins")
    monkeypatch.setattr(plugin_router, "RUNTIME_DIR", tmp_path / "plugins" / "_runtime")
    return tmp_path


@pytest.fixture(autouse=True)
def _reset_bundled_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plugin_router, "_BUNDLED_STARTED", False)
    monkeypatch.setattr(plugin_router, "_BUNDLED_READY", threading.Event())


def _drain() -> None:
    """Wait out the hook's daemon thread (it sets the event when it is done)."""
    assert plugin_router._BUNDLED_READY.wait(30), "bundled build never finished"


def test_a_failing_owl_does_not_stop_ares(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[str] = []

    def _owl() -> dict:
        called.append("owl")
        raise RuntimeError("Owl project asset missing")

    def _ares() -> dict:
        called.append("ares")
        return {"rebuilt": True}

    monkeypatch.setattr(plugin_router, "package_owl", _owl)
    monkeypatch.setattr(plugin_router, "package_ares", _ares)

    plugin_router._build_bundled_plugins()
    _drain()

    assert called == ["owl", "ares"]


def test_the_gate_opens_even_when_both_packagers_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A listing that waits forever is worse than one that lists what is there."""

    def _boom() -> dict:
        raise RuntimeError("no assets in this install")

    monkeypatch.setattr(plugin_router, "package_owl", _boom)
    monkeypatch.setattr(plugin_router, "package_ares", _boom)

    plugin_router._build_bundled_plugins()
    _drain()
    # And a listing returns rather than blocking for the full timeout.
    monkeypatch.setattr(plugin_router, "_BUNDLED_WAIT_SEC", 0.2)
    plugin_router._wait_for_bundled()


def test_listing_waits_for_a_build_in_flight(
    runtime_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The MIX view lists once on mount. If that lands before the build
    publishes, the shelf stays empty until someone reloads."""
    released = threading.Event()

    def _slow_owl() -> dict:
        released.wait(5)
        (plugin_router.GAN_DIR).mkdir(parents=True, exist_ok=True)
        return {"rebuilt": True}

    monkeypatch.setattr(plugin_router, "package_owl", _slow_owl)
    monkeypatch.setattr(plugin_router, "package_ares", lambda: {"rebuilt": False})

    plugin_router._build_bundled_plugins()
    assert not plugin_router._BUNDLED_READY.is_set()

    order: list[str] = []

    def _list() -> None:
        plugin_router.list_plugins()
        order.append("listed")

    t = threading.Thread(target=_list, daemon=True)
    t.start()
    t.join(0.5)
    assert order == [], "the listing answered before the build published"

    released.set()
    t.join(10)
    assert order == ["listed"]


def test_publishing_a_runtime_never_exposes_half_a_tree(
    runtime_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """serve_runtime only checks that index.html exists, so an extraction that
    writes over a live directory can hand the iframe an old document with new
    assets beside it. Publishing swaps whole directories instead."""
    seen: list[str] = []

    def _fake_extract(gan: str, dest: str) -> None:
        # Whatever a build writes, it writes somewhere nothing is serving from.
        seen.append(Path(dest).name)
        d = Path(dest)
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(Path(gan).stem, encoding="utf-8")
        (d / "asset.js").write_text(Path(gan).stem, encoding="utf-8")

    monkeypatch.setattr(plugin_router.GanFile, "extract", staticmethod(_fake_extract))

    first = plugin_router.GAN_DIR / "demo-v1.gan"
    first.parent.mkdir(parents=True, exist_ok=True)
    first.write_text("one", encoding="utf-8")
    plugin_router._publish_runtime(first, "demo")

    active = plugin_router._runtime_dir("demo")
    assert (active / "index.html").read_text(encoding="utf-8") == "demo-v1"

    second = plugin_router.GAN_DIR / "demo-v2.gan"
    second.write_text("two", encoding="utf-8")
    plugin_router._publish_runtime(second, "demo")

    moved = plugin_router._runtime_dir("demo")
    assert moved != active
    # Every file in the published tree comes from the same build.
    assert (moved / "index.html").read_text(encoding="utf-8") == "demo-v2"
    assert (moved / "asset.js").read_text(encoding="utf-8") == "demo-v2"
    # Extraction never targeted the directory being served.
    assert all(name.startswith(".staging-") for name in seen)


def test_a_pre_versioning_runtime_keeps_working(runtime_root: Path) -> None:
    """Installs that predate versioning kept the assets in the plugin's runtime
    root; they must keep serving until the next build replaces them."""
    legacy = plugin_router.RUNTIME_DIR / "old-plugin"
    legacy.mkdir(parents=True)
    (legacy / "index.html").write_text("legacy", encoding="utf-8")

    assert plugin_router._runtime_dir("old-plugin") == legacy
