"""Policy checks for browser-supplied VST3 plugin paths.

``check_plugin_path`` is the one gate every VST route calls before a raw path
from the browser reaches the native host. Every test here monkeypatches
``path_policy.allowed_roots`` to a tmp directory, so nothing depends on what
VST3 folders actually exist on the machine running the suite.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.modules.vst import path_policy, scanner

UNC_PATHS = [
    "\\\\server\\share\\x.vst3",
    "//server/share/x.vst3",
    "\\\\?\\UNC\\server\\share\\x.vst3",
]


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An allowed VST3 root under tmp_path, with no plugin in it yet."""
    allowed = tmp_path / "VST3"
    allowed.mkdir()
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [allowed.resolve()])
    return allowed


def _bundle(root: Path, name: str = "Foo.vst3") -> Path:
    plugin = root / name
    plugin.mkdir()
    return plugin


def test_a_plugin_inside_the_root_is_allowed(root: Path) -> None:
    plugin = _bundle(root)
    assert path_policy.check_plugin_path(str(plugin)) == plugin.resolve()


def test_a_dotdot_escape_is_forbidden(root: Path) -> None:
    escape = str(root / ".." / "Escape.vst3")
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(escape)
    assert exc.value.status == 403


@pytest.mark.parametrize("raw", UNC_PATHS)
def test_unc_paths_are_rejected_without_touching_the_filesystem(
    root: Path, monkeypatch: pytest.MonkeyPatch, raw: str
) -> None:
    def _boom(self: Path, strict: bool = False) -> Path:
        raise AssertionError("resolve() must not run for a network path")

    monkeypatch.setattr(Path, "resolve", _boom)
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(raw)
    assert exc.value.status == 400


def test_a_non_vst3_suffix_is_rejected(root: Path) -> None:
    other = str(root / "Foo.dll")
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(other)
    assert exc.value.status == 400


@pytest.mark.parametrize("raw", ["", "   "])
def test_empty_input_is_rejected(raw: str) -> None:
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(raw)
    assert exc.value.status == 400


@pytest.mark.skipif(os.name == "nt", reason="case-sensitive paths are POSIX")
def test_root_match_is_case_sensitive_off_windows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    allowed = tmp_path / "vst3"
    allowed.mkdir()
    plugin = _bundle(allowed)
    # A root spelled in another case is another directory here, so the plugin
    # lies outside every allowed root.
    monkeypatch.setattr(
        path_policy, "allowed_roots", lambda: [Path(str(allowed).upper())]
    )
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(str(plugin))
    assert exc.value.status == 403


@pytest.mark.skipif(os.name != "nt", reason="case-insensitive paths are Windows")
def test_root_match_is_case_insensitive_on_windows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    allowed = tmp_path / "vst3"
    allowed.mkdir()
    plugin = _bundle(allowed)
    # The configured root is spelled in different case than the plugin's own
    # resolved path; only the comparison is case-insensitive, not the value
    # check_plugin_path hands back.
    monkeypatch.setattr(
        path_policy, "allowed_roots", lambda: [Path(str(allowed).upper())]
    )
    assert path_policy.check_plugin_path(str(plugin)) == plugin.resolve()


def test_the_403_message_names_a_count_never_the_root_or_the_path(root: Path) -> None:
    secret_input = str(root / ".." / "Escape.vst3")
    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(secret_input)
    message = exc.value.message
    assert "1" in message
    assert str(root) not in message
    assert secret_input not in message


# ---------------------------------------------------------------------------
# A plugin linked into a VST3 folder (a symlink or junction to a bundle kept on
# another drive). The scanner lists it under its resolved target, which lies
# outside every root, and this build used to answer 403 when MIX loaded the
# tile the scan had just offered. Each test replays the order the app runs
# things in: the scanner lists the plugin, then a route checks the path it was
# handed, which is the listed path or the one a saved chain carries.
# ---------------------------------------------------------------------------


def _link_dir(link: Path, target: Path) -> None:
    """A directory link the way users make them: a junction on Windows (no
    privilege needed), a symlink elsewhere."""
    try:
        if os.name == "nt":
            import _winapi

            _winapi.CreateJunction(str(target), str(link))
        else:
            link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError) as e:
        pytest.skip(f"this filesystem refuses a directory link: {e}")


def _real_bundle(parent: Path, name: str = "Foo.vst3") -> Path:
    """A Windows/Linux-shaped bundle with its loadable module inside."""
    arch = scanner._arch_dirs()[0]
    bundle = parent / name
    module_dir = bundle / "Contents" / arch
    module_dir.mkdir(parents=True)
    (module_dir / name).write_bytes(b"module")
    return bundle


@pytest.fixture
def scanned_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """One VST3 root the scanner walks and the policy allows, nothing else."""
    allowed = tmp_path / "VST3"
    allowed.mkdir()
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [allowed])
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [allowed.resolve()])
    return allowed


def _listed_paths() -> list[str]:
    return [p.path for p in scanner.scan_vst3_directories()]


@pytest.mark.skipif(
    scanner.platform.system() == "Darwin", reason="a macOS bundle has no inner module"
)
def test_a_bundle_linked_into_the_root_loads_by_the_path_the_scan_lists(
    scanned_root: Path, tmp_path: Path
) -> None:
    elsewhere = tmp_path / "D-drive" / "Plugins"
    elsewhere.mkdir(parents=True)
    bundle = _real_bundle(elsewhere)
    _link_dir(scanned_root / "Foo.vst3", bundle)

    [listed] = _listed_paths()
    # The scan lists the resolved target, outside the root: the path MIX sends
    # back, and the path an effect chain or project saved from this scan holds.
    assert not path_policy.root_contains(scanned_root.resolve(), Path(listed))

    assert path_policy.check_plugin_path(listed) == Path(listed).resolve()


def test_the_path_as_written_under_a_linked_bundle_is_allowed(
    scanned_root: Path, tmp_path: Path
) -> None:
    bundle = _real_bundle(tmp_path / "D-drive")
    _link_dir(scanned_root / "Foo.vst3", bundle)
    arch = scanner._arch_dirs()[0]
    written = scanned_root / "Foo.vst3" / "Contents" / arch / "Foo.vst3"

    assert path_policy.check_plugin_path(str(written)) == written.resolve()
    assert path_policy.check_plugin_path(str(scanned_root / "Foo.vst3")) == (
        bundle.resolve()
    )


@pytest.mark.skipif(
    scanner.platform.system() == "Darwin", reason="a macOS bundle has no inner module"
)
def test_a_plugin_under_a_linked_vendor_folder_loads_by_the_listed_path(
    scanned_root: Path, tmp_path: Path
) -> None:
    vendor = tmp_path / "D-drive" / "Vendor"
    vendor.mkdir(parents=True)
    _real_bundle(vendor, "Bar.vst3")
    _link_dir(scanned_root / "Vendor", vendor)

    [listed] = _listed_paths()
    assert path_policy.check_plugin_path(listed) == Path(listed).resolve()


def test_a_dotdot_out_of_a_linked_bundle_is_still_forbidden(
    scanned_root: Path, tmp_path: Path
) -> None:
    bundle = _real_bundle(tmp_path / "D-drive")
    _link_dir(scanned_root / "Foo.vst3", bundle)
    evil = tmp_path / "outside" / "Evil.vst3"
    evil.parent.mkdir()
    evil.write_bytes(b"not a plugin anyone installed")
    escape = str(scanned_root / "Foo.vst3" / ".." / ".." / "outside" / "Evil.vst3")

    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(escape)
    assert exc.value.status == 403


def test_a_path_no_link_leads_to_is_forbidden_even_with_links_in_the_root(
    scanned_root: Path, tmp_path: Path
) -> None:
    _link_dir(scanned_root / "Foo.vst3", _real_bundle(tmp_path / "D-drive"))
    invented = tmp_path / "Downloads" / "Evil.vst3"
    invented.parent.mkdir()
    invented.write_bytes(b"not a plugin anyone installed")

    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(str(invented))
    assert exc.value.status == 403


def test_a_sibling_of_a_linked_bundle_on_the_other_drive_is_forbidden(
    scanned_root: Path, tmp_path: Path
) -> None:
    """Only what the link points at is trusted, not the folder around it."""
    drive = tmp_path / "D-drive"
    _link_dir(scanned_root / "Foo.vst3", _real_bundle(drive))
    sibling = _real_bundle(drive, "Other.vst3")

    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(str(sibling))
    assert exc.value.status == 403


def test_a_junction_cycle_in_the_root_does_not_hang_the_check(
    scanned_root: Path, tmp_path: Path
) -> None:
    vendor = scanned_root / "Vendor"
    vendor.mkdir()
    _link_dir(vendor / "loop", scanned_root)
    invented = tmp_path / "Downloads" / "Evil.vst3"
    invented.parent.mkdir()
    invented.write_bytes(b"x")

    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(str(invented))
    assert exc.value.status == 403


# ---------------------------------------------------------------------------
# The link walk behind a linked plugin's check. A MIX freeze or bounce posts
# one /process-file per stage and stem, and each post checks the same linked
# plugin; each check walked every VST3 root again.
# ---------------------------------------------------------------------------


def _unlink_dir(link: Path) -> None:
    """Remove a directory link made by ``_link_dir``, never its target."""
    if os.name == "nt":
        os.rmdir(link)
    else:
        link.unlink()


@pytest.fixture
def walks(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """Every root the policy walks, in order."""
    seen: list[Path] = []
    real = path_policy._walk_vst3_paths

    def counting(root: Path) -> list[Path]:
        seen.append(root)
        return real(root)

    monkeypatch.setattr(path_policy, "_walk_vst3_paths", counting)
    return seen


@pytest.mark.skipif(
    scanner.platform.system() == "Darwin", reason="a macOS bundle has no inner module"
)
def test_a_bounce_through_a_linked_plugin_walks_the_roots_once(
    scanned_root: Path, tmp_path: Path, walks: list[Path]
) -> None:
    _link_dir(scanned_root / "Foo.vst3", _real_bundle(tmp_path / "D-drive"))
    [listed] = _listed_paths()

    # Four stages of a chain on two stems: eight checks of the listed path.
    for _hop in range(8):
        assert path_policy.check_plugin_path(listed) == Path(listed).resolve()
    assert len(walks) == 1


@pytest.mark.skipif(
    scanner.platform.system() == "Darwin", reason="a macOS bundle has no inner module"
)
def test_a_link_pointed_elsewhere_stops_vouching_for_its_old_target(
    scanned_root: Path, tmp_path: Path, walks: list[Path]
) -> None:
    old = _real_bundle(tmp_path / "D-drive")
    link = scanned_root / "Foo.vst3"
    _link_dir(link, old)
    [listed] = _listed_paths()
    assert path_policy.check_plugin_path(listed) == Path(listed).resolve()

    # The owner points the link at a new copy; the old folder stays on disk.
    _unlink_dir(link)
    _link_dir(link, _real_bundle(tmp_path / "E-drive"))

    with pytest.raises(path_policy.PluginPathError) as exc:
        path_policy.check_plugin_path(listed)
    assert exc.value.status == 403
    [now_listed] = _listed_paths()
    assert path_policy.check_plugin_path(now_listed) == Path(now_listed).resolve()


@pytest.mark.skipif(
    scanner.platform.system() == "Darwin", reason="a macOS bundle has no inner module"
)
def test_a_plugin_linked_after_a_check_loads_at_once(
    scanned_root: Path, tmp_path: Path, walks: list[Path]
) -> None:
    _link_dir(scanned_root / "Foo.vst3", _real_bundle(tmp_path / "D-drive"))
    [first] = _listed_paths()
    assert path_policy.check_plugin_path(first) == Path(first).resolve()

    _link_dir(scanned_root / "Bar.vst3", _real_bundle(tmp_path / "E-drive", "Bar.vst3"))
    listed = sorted(_listed_paths())
    [second] = [p for p in listed if p != first]
    assert path_policy.check_plugin_path(second) == Path(second).resolve()
    assert len(walks) == 2
