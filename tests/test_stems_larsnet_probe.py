"""GET /api/stems/probe says whether the LARSNET weights are on disk.

The 12-stem mode hands Demucs's drum stem to LARSNET, which loads one
checkpoint per kit part from the paths in its config.yaml. Without them the
run keeps the undivided drum stem, and nothing said so before the run. The
probe reads the config the sidecar loads, and the Settings Stems card shows
the result as a chip.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KIT_PARTS = ("kick", "snare", "toms", "hihat", "cymbals")


def _package(tmp_path: Path, present: tuple[str, ...]) -> Path:
    pkg = tmp_path / "pkg"
    larsnet = pkg / "larsnet"
    larsnet.mkdir(parents=True)
    shutil.copyfile(
        ROOT / "integration-package" / "backend" / "larsnet" / "config.yaml",
        larsnet / "config.yaml",
    )
    (pkg / "run_backend.py").write_text("", encoding="utf-8")
    for part in present:
        weights = (
            larsnet / "pretrained_larsnet_models" / part / f"pretrained_{part}_unet.pth"
        )
        weights.parent.mkdir(parents=True)
        weights.write_bytes(b"\x00" * 64)
    return pkg


def _probe(monkeypatch, pkg: Path) -> dict:
    from backend.modules.stems.sidecar import probe

    monkeypatch.setenv("theDAW_STEMS_PACKAGE", str(pkg))
    monkeypatch.setenv("theDAW_STEMS_PYTHON", str(pkg / "no-python.exe"))
    return probe()


def test_the_probe_reports_larsnet_weights_present(monkeypatch, tmp_path: Path):
    out = _probe(monkeypatch, _package(tmp_path, KIT_PARTS))
    lars = out["larsnet"]
    assert lars["ok"] is True
    assert out["larsnet_weights_ok"] is True
    assert lars["missing"] == []
    assert set(lars["weights"]) == set(KIT_PARTS)
    assert all(w["present"] for w in lars["weights"].values())


def test_the_probe_names_the_missing_larsnet_weights(monkeypatch, tmp_path: Path):
    out = _probe(monkeypatch, _package(tmp_path, ("kick", "snare", "hihat")))
    lars = out["larsnet"]
    assert lars["ok"] is False
    assert out["larsnet_weights_ok"] is False
    assert lars["missing"] == ["toms", "cymbals"]
    assert lars["state"] == "missing"
    assert lars["weights"]["toms"]["path"].endswith("pretrained_toms_unet.pth")


def test_the_probe_reports_weights_still_packed_in_their_zip(
    monkeypatch, tmp_path: Path
):
    pkg = _package(tmp_path, ())
    (pkg / "larsnet" / "pretrained_larsnet_models.zip").write_bytes(b"PK")
    lars = _probe(monkeypatch, pkg)["larsnet"]
    assert lars["ok"] is False
    assert lars["state"] == "packed"
    assert lars["zip_present"] is True


def test_the_probe_reports_larsnet_missing_without_the_package(
    monkeypatch, tmp_path: Path
):
    out = _probe(monkeypatch, tmp_path / "nope")
    assert out["package_exists"] is False
    assert out["larsnet"]["ok"] is False
    assert out["larsnet"]["missing"] == list(KIT_PARTS)


def test_the_settings_card_shows_the_larsnet_weights(monkeypatch, tmp_path: Path):
    from backend.modules.storage import router as storage_router

    pkg = _package(tmp_path, ("kick",))
    monkeypatch.setenv("theDAW_STEMS_PACKAGE", str(pkg))
    monkeypatch.setenv("theDAW_STEMS_PYTHON", str(pkg / "no-python.exe"))
    status = storage_router._demucs_provider_status()
    chip = next(m for m in status["models"] if m["id"] == "larsnet-weights")
    assert chip["source"] == "missing"
    assert "snare" in chip["reason"] and "cymbals" in chip["reason"]
