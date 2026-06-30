"""Logic Pro X .logicx package reader.

A .logicx is a macOS package (a directory bundle). The core arrangement
(track layout, MIDI regions, clip timeline positions, per-track effect chains)
lives in a proprietary BINARY ``ProjectData`` blob with no public spec, so it
is NOT recoverable here. What CAN be read reliably:

  - DocumentInfo.plist -> tempo, time signature, sample rate metadata
  - Media/Audio Files/  -> recorded/imported audio (one playable track each)
  - Freeze Files/       -> pre-rendered per-track "freeze" audio
  - Plug-In Settings/   -> plugin folder NAMES (which plugins were used)

Because the timeline position of every region is locked inside ProjectData,
discovered audio is imported as one track per file with ``start_time`` 0; the
real placement on the timeline is unknown. Plugin names are surfaced via
``project.plugins_used`` only -- no fabricated track/device assignments.

For a full arrangement import, users should "Export All Tracks as Audio Files"
from Logic Pro (File -> Export), then import that folder into theDAW.
"""

from __future__ import annotations

import logging
import plistlib
from pathlib import Path

from backend.modules.dawimport.models import DawClip, DawProject, DawTrack

log = logging.getLogger(__name__)

# Audio container formats Logic stores under Media / Freeze Files.
_AUDIO_EXTS = (".aiff", ".aif", ".wav", ".caf", ".mp3", ".m4a", ".flac")

_BINARY_WARNING = (
    "Logic stores arrangement/MIDI/effects in a proprietary binary; only "
    "audio files were recovered. Export tracks as audio for full import."
)


def _read_document_info(contents: Path, daw: DawProject) -> None:
    """Pull tempo / time signature / sample rate from DocumentInfo.plist.

    Guards every field; never raises. The plist key names vary across Logic
    versions, so each lookup is best-effort with sane fallbacks.
    """
    doc_info = contents / "DocumentInfo.plist"
    if not doc_info.is_file():
        return
    try:
        with open(doc_info, "rb") as f:
            plist = plistlib.load(f)
    except Exception as e:
        daw.warnings.append(f"Could not parse DocumentInfo.plist: {e}")
        return

    if not isinstance(plist, dict):
        return

    try:
        if "tempo" in plist and plist["tempo"] is not None:
            tempo = float(plist["tempo"])
            if tempo > 0:
                daw.tempo = tempo
    except (TypeError, ValueError):
        pass

    try:
        if "timeSignatureNumerator" in plist:
            num = int(plist.get("timeSignatureNumerator", 4) or 4)
            den = int(plist.get("timeSignatureDenominator", 4) or 4)
            if num > 0 and den > 0:
                daw.time_signature = (num, den)
    except (TypeError, ValueError):
        pass

    try:
        sr = int(plist.get("sampleRate", 0) or 0)
        if sr > 0:
            daw.sample_rate = sr
    except (TypeError, ValueError):
        pass


def _discover_audio(directory: Path, daw: DawProject, prefix: str = "") -> int:
    """Create one audio DawTrack per audio file found under ``directory``.

    ``start_time`` is 0.0 because the real timeline position lives in the
    proprietary ProjectData blob and cannot be recovered. ``end_time`` is left
    at 0.0 (unknown duration without decoding); downstream mapping can probe
    the file. Returns the number of tracks added.
    """
    if not directory.is_dir():
        return 0

    added = 0
    try:
        files = sorted(directory.rglob("*"))
    except Exception as e:
        daw.warnings.append(f"Could not scan {directory.name}/: {e}")
        return 0

    for audio_file in files:
        try:
            if not audio_file.is_file():
                continue
            if audio_file.suffix.lower() not in _AUDIO_EXTS:
                continue
        except OSError:
            continue

        name = f"{prefix}{audio_file.stem}" if prefix else audio_file.stem
        daw.tracks.append(
            DawTrack(
                name=name,
                type="audio",
                clips=[
                    DawClip(
                        name=audio_file.stem,
                        start_time=0.0,  # timeline position unknown (binary)
                        end_time=0.0,
                        file_path=str(audio_file),
                    )
                ],
            )
        )
        added += 1
    return added


def _discover_plugins(contents: Path, daw: DawProject) -> None:
    """Record plugin folder names under Plug-In Settings/ into plugins_used.

    Only names are captured -- Logic does not expose per-track effect-chain
    order outside the binary ProjectData, so no devices are fabricated.
    """
    plugin_dir = contents / "Plug-In Settings"
    if not plugin_dir.is_dir():
        return
    try:
        for plugin_folder in sorted(plugin_dir.iterdir()):
            try:
                if plugin_folder.is_dir():
                    if plugin_folder.name not in daw.plugins_used:
                        daw.plugins_used.append(plugin_folder.name)
            except OSError:
                continue
    except Exception as e:
        daw.warnings.append(f"Could not scan Plug-In Settings/: {e}")


def parse_logicx(path: str) -> DawProject:
    """Parse a Logic Pro X .logicx package (directory bundle).

    Returns a DawProject populated with:
      - tempo / time signature / sample rate from DocumentInfo.plist
      - one playable audio track per file under Media/Audio Files/ and
        Freeze Files/ (start_time 0; real placement is not recoverable)
      - plugins_used from Plug-In Settings/ folder names

    MIDI notes, clip timeline timing, and per-track effects are intentionally
    NOT produced: Logic keeps them in a proprietary binary blob. A warning to
    that effect is always appended. Never raises on a malformed bundle; issues
    are reported via project.warnings.
    """
    pkg_path = Path(path)
    if not pkg_path.is_dir():
        raise FileNotFoundError(f".logicx package not found: {path}")

    daw = DawProject(source_daw="logic", name=pkg_path.stem)
    daw.warnings.append(_BINARY_WARNING)

    # Logic bundles place everything under Contents/, but some exported
    # variants flatten the structure -- accept either layout.
    contents = pkg_path / "Contents"
    if not contents.is_dir():
        contents = pkg_path

    _read_document_info(contents, daw)

    n_media = _discover_audio(contents / "Media" / "Audio Files", daw)
    # Some projects store recorded audio directly under Media/.
    if n_media == 0:
        n_media = _discover_audio(contents / "Media", daw)

    n_freeze = _discover_audio(contents / "Freeze Files", daw, prefix="[Freeze] ")

    _discover_plugins(contents, daw)

    if n_media == 0 and n_freeze == 0:
        daw.warnings.append(
            "No audio files were found inside the .logicx bundle "
            "(Media/Audio Files/ and Freeze Files/ were empty or absent). "
            "Use 'Export All Tracks as Audio Files' from Logic Pro."
        )

    return daw


def export_hint() -> dict:
    """Return instructions for Logic users who want full arrangement import."""
    return {
        "format": "logicx",
        "limitation": (
            "Logic stores arrangement/MIDI/effects in a proprietary binary; "
            "only metadata + audio files can be recovered."
        ),
        "recommended_workflow": [
            "1. In Logic Pro, go to File -> Export -> All Tracks as Audio Files",
            "2. Choose a location and format (WAV recommended)",
            "3. Import the resulting folder into theDAW via /api/dawimport/detect",
            "4. This gives per-track audio for full arrangement mapping",
        ],
    }
