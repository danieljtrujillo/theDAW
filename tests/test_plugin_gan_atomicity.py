"""One unreadable .gan must not take out the plugin list — and a rebuild must
never produce one.

Reported as a 500 on ``/api/plugin/list`` while the bundled Ares surface was
being repackaged: ``zipfile.BadZipFile: File is not a zip file``. Two faults met.
``GanFile.save`` deflated straight into ``data/plugins/ares.gan``, so for the
second or so it took to write 1.15 MB the library held a torn file; and
``BadZipFile`` derives from ``Exception``, not ``OSError``, so the
``except (ValueError, OSError)`` that exists to skip an unreadable bundle went
straight past it and the whole endpoint failed for one bad file.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from backend.modules.plugin.gan_file import GanFile
from backend.modules.plugin.owl_import import import_vst_foundry

PROJECT = {
    "canvasWidth": 400,
    "canvasHeight": 300,
    "elements": [
        {
            "id": "k1",
            "name": "Cutoff",
            "type": "Knob",
            "x": 10,
            "y": 20,
            "width": 80,
            "height": 80,
        }
    ],
}


def _package(tmp_path: Path, name: str):
    pj = tmp_path / f"{name}.json"
    pj.write_text(json.dumps(PROJECT), encoding="utf-8")
    return import_vst_foundry(str(pj), name=name)


def test_an_unreadable_gan_reports_itself_as_invalid_not_as_a_zip_error(
    tmp_path: Path,
):
    # The guard around every .gan read is `except (ValueError, OSError)`. What a
    # torn archive actually raises has to land inside it.
    bad = tmp_path / "torn.gan"
    bad.write_bytes(b"PK\x03\x04 and then the writer was still going")
    with pytest.raises(ValueError):
        GanFile.info(str(bad))


def test_the_plugin_list_skips_the_unreadable_one_and_returns_the_rest(
    tmp_path: Path, monkeypatch
):
    from backend.modules.plugin import router

    monkeypatch.setattr(router, "GAN_DIR", tmp_path)
    monkeypatch.setattr(router, "RUNTIME_DIR", tmp_path / "_runtime")
    manifest, assets = _package(tmp_path, "good")
    GanFile.save(manifest, assets, str(tmp_path / "good.gan"))
    (tmp_path / "torn.gan").write_bytes(b"not a zip at all")

    listed = router.list_plugins()["plugins"]
    assert [p["name"] for p in listed] == ["good"], (
        "one bad bundle must cost that bundle, not the endpoint"
    )


def test_a_rebuild_never_shows_a_reader_a_half_written_archive(
    tmp_path: Path, monkeypatch
):
    # The sequence that produced the 500: a /list sweep opening the .gan at the
    # moment a repackage is writing it. Sample the destination from inside the
    # write itself — every look must find the whole previous bundle.
    dest = tmp_path / "plugin.gan"
    GanFile.save(*_package(tmp_path, "v1"), str(dest))

    seen: list[object] = []
    real_writestr = zipfile.ZipFile.writestr

    def spy(self, zinfo_or_arcname, data, *args, **kwargs):
        try:
            seen.append(GanFile.info(str(dest))["name"])
        except Exception as e:  # noqa: BLE001 — the failure IS the finding
            seen.append(e)
        return real_writestr(self, zinfo_or_arcname, data, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "writestr", spy)
    GanFile.save(*_package(tmp_path, "v2"), str(dest))
    monkeypatch.undo()

    assert len(seen) > 1, "the spy has to have sampled the write in progress"
    assert set(seen) == {"v1"}, f"a reader saw the rebuild mid-flight: {seen}"
    assert GanFile.info(str(dest))["name"] == "v2", "and the rebuild still landed"


def test_extracting_a_runtime_leaves_no_scratch_files_behind(tmp_path: Path):
    # The runtime dir is served to the stage iframe as-is; a stray temp file
    # would be served with it.
    gan = tmp_path / "plugin.gan"
    GanFile.save(*_package(tmp_path, "rt"), str(gan))
    out = tmp_path / "runtime"
    GanFile.extract(str(gan), str(out))

    assert (out / "index.html").is_file()
    assert (out / "manifest.json").is_file()
    assert [p.name for p in out.rglob("*") if ".tmp" in p.name] == []
