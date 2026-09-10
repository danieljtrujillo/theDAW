"""A .gan built from a VST Foundry export must carry that export back out.

VST Foundry reopens a .gan losslessly only when source/foundry-project.json is
inside it; otherwise it rebuilds a layout from the manifest, which has no
positions and no artwork. The backend importer always had the project.json in
hand and never embedded it, so every plugin that went project.json -> .gan
reopened as knobs gridded into a corner on a bare canvas.
"""

import json
import zipfile
from pathlib import Path

from backend.modules.plugin.gan_file import GanFile
from backend.modules.plugin.owl_import import import_vst_foundry, source_fingerprint

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
            "min": 0,
            "max": 1,
            "value": 0.5,
        }
    ],
}


def test_an_imported_gan_carries_its_editable_project(tmp_path: Path):
    pj = tmp_path / "project.json"
    raw = json.dumps(PROJECT).encode("utf-8")
    pj.write_bytes(raw)

    manifest, assets = import_vst_foundry(str(pj), name="Round Trip")
    assert assets["source/foundry-project.json"] == raw, (
        "the export must ride along byte-for-byte"
    )

    gan = tmp_path / "round-trip.gan"
    GanFile.save(manifest, assets, str(gan))
    with zipfile.ZipFile(gan) as z:
        assert z.read("source/foundry-project.json") == raw
        # The runtime is untouched by the embed: still an index.html to serve.
        assert "index.html" in z.namelist()


def test_the_fingerprint_moves_with_the_package_format(tmp_path: Path, monkeypatch):
    # An installed bundle is only rebuilt when its fingerprint changes. The
    # format version is part of it, so bumping it is what makes every bundled
    # plugin built before the embed rebuild once and gain the project file.
    from backend.modules.plugin import owl_import

    pj = tmp_path / "project.json"
    pj.write_bytes(json.dumps(PROJECT).encode("utf-8"))
    now = source_fingerprint(str(pj))
    monkeypatch.setattr(
        owl_import, "RUNTIME_TEMPLATE_VERSION", owl_import.RUNTIME_TEMPLATE_VERSION - 1
    )
    before = source_fingerprint(str(pj))
    assert now != before
