"""Build a "track bundle" zip for an entry — everything the dev would
want to take with them: audio, metadata, analysis snapshot, lineage
slice, prompts, stems/, midi/, README.

Streamed on-the-fly via zipfile to avoid materializing a multi-MB zip
in memory first.
"""

from __future__ import annotations

import io
import json
import logging
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

log = logging.getLogger(__name__)


def _safe_zip_name(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in s)[:80] or "entry"


def build_bundle_bytes(
    *,
    entry_id: str,
    record: dict[str, Any],
    audio_path: Optional[Path],
    metadata_path: Optional[Path],
    analysis: Optional[dict[str, Any]],
    stems: Iterable[dict[str, Any]] = (),
    midis: Iterable[dict[str, Any]] = (),
    scores: Iterable[dict[str, Any]] = (),
    lineage_edges: Iterable[dict[str, Any]] = (),
    pdf_renderer: Optional[Callable[[Path, Path], dict[str, Any]]] = None,
    unity_chart: Optional[Path] = None,
    unity_package_dir: Optional[Path] = None,
) -> bytes:
    """Build the zip and return its bytes. Caller streams these to the
    client (FastAPI StreamingResponse or Response with media_type
    application/zip).

    ``pdf_renderer`` is injected rather than imported so this module stays free
    of the notation stack (and stays trivially testable): it takes a MusicXML
    path plus a destination and returns the renderer's ok/error dict. When it is
    given, every sheet in ``scores`` is also engraved to PDF, because a musician
    who downloads a bundle wants something printable without first installing a
    notation editor. ``unity_chart`` and ``unity_package_dir`` add the flying-
    notation chart and its Unity C# package so the zip drops straight into a
    Unity project.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Track audio at the bundle root.
        if audio_path is not None and audio_path.is_file():
            zf.write(audio_path, arcname=audio_path.name)

        # metadata.json — the durable record source.
        if metadata_path is not None and metadata_path.is_file():
            zf.write(metadata_path, arcname="metadata.json")
        else:
            zf.writestr("metadata.json", json.dumps(record, indent=2))

        # Analysis snapshot (per-entry analysis row + ffprobe summary).
        if analysis:
            zf.writestr("analysis.json", json.dumps(analysis, indent=2, default=str))

        # Lineage edges — every relation touching this entry's id.
        lineage_payload = {"entry_id": entry_id, "edges": list(lineage_edges)}
        zf.writestr("lineage.json", json.dumps(lineage_payload, indent=2, default=str))

        # Prompts in a friendlier text format (so the user can grep / cat).
        prompt_lines: list[str] = []
        if record.get("prompt"):
            prompt_lines.append(f"# positive\n{record['prompt']}\n")
        if record.get("negative_prompt"):
            prompt_lines.append(f"# negative\n{record['negative_prompt']}\n")
        embedded = record.get("embedded_tags") or (
            analysis.get("embedded_tags") if analysis else None
        )
        if isinstance(embedded, dict) and embedded:
            prompt_lines.append("# embedded\n")
            for k, v in sorted(embedded.items()):
                prompt_lines.append(f"{k}: {v}\n")
        if prompt_lines:
            zf.writestr("prompts.txt", "".join(prompt_lines))

        # Stems and MIDI files.
        for stem in stems:
            ap = Path(stem.get("audio_path") or "")
            if ap.is_file():
                zf.write(ap, arcname=f"stems/{ap.name}")
        for midi in midis:
            mp = Path(midi.get("midi_path") or "")
            if mp.is_file():
                zf.write(mp, arcname=f"midi/{mp.name}")
        # Score / notation artifacts (sheets, tabs, arrangements, exports).
        # Dedup by filename so multiple DB rows pointing at the same file
        # don't collide in the zip.
        seen_scores: set[str] = set()
        sheet_sources: list[Path] = []
        for score in scores:
            sp = Path(score.get("path") or "")
            if sp.is_file() and sp.name not in seen_scores:
                seen_scores.add(sp.name)
                zf.write(sp, arcname=f"scores/{sp.name}")
                # Sheets AND tabs both engrave to PDF (MusicXML via OSMD,
                # alphaTex via alphaTab), so a downloaded bundle carries a
                # printable copy of every piece of notation it holds.
                if sp.suffix.lower() in (".musicxml", ".xml", ".alphatex"):
                    sheet_sources.append(sp)

        # Engrave a printable PDF for each sheet. A sheet that already shipped
        # as a PDF artifact is skipped rather than re-rendered.
        pdf_count = 0
        if pdf_renderer is not None and sheet_sources:
            with tempfile.TemporaryDirectory() as staging:
                for source in sheet_sources:
                    target_name = f"{source.stem}.pdf"
                    if target_name in seen_scores:
                        continue
                    destination = Path(staging) / target_name
                    try:
                        result = pdf_renderer(source, destination)
                    except Exception as exc:  # noqa: BLE001 - one bad sheet must not lose the bundle
                        log.warning(
                            "bundle: PDF render raised for %s: %s", source.name, exc
                        )
                        continue
                    if not result.get("ok") or not destination.is_file():
                        log.warning(
                            "bundle: PDF render failed for %s: %s",
                            source.name,
                            result.get("error"),
                        )
                        continue
                    seen_scores.add(target_name)
                    zf.write(destination, arcname=f"scores/{target_name}")
                    pdf_count += 1

        # Unity flying-notation payload: the per-track chart plus the C# package
        # that reads it, so the zip drops straight into a Unity project.
        unity_count = 0
        if unity_chart is not None and unity_chart.is_file():
            zf.write(unity_chart, arcname=f"unity/{unity_chart.name}")
            unity_count += 1
        if unity_package_dir is not None and unity_package_dir.is_dir():
            package_root = unity_package_dir.name
            for path in sorted(unity_package_dir.rglob("*")):
                if not path.is_file():
                    continue
                relative_parts = path.relative_to(unity_package_dir).parts
                # A trailing "~" marks a path Unity deliberately ignores, and it
                # is usually on a DIRECTORY (this repo ships a Bridge~), so every
                # segment has to be checked rather than just the file name.
                if any(part.endswith("~") for part in relative_parts):
                    continue
                relative = "/".join(relative_parts)
                zf.write(path, arcname=f"unity/{package_root}/{relative}")
                unity_count += 1

        # README.
        readme_text = _render_readme(
            entry_id=entry_id,
            record=record,
            analysis=analysis,
            stems_count=sum(
                1 for s in stems if Path(s.get("audio_path") or "").is_file()
            ),
            midi_count=sum(
                1 for m in midis if Path(m.get("midi_path") or "").is_file()
            ),
            scores_count=len(seen_scores),
            pdf_count=pdf_count,
            unity_count=unity_count,
        )
        zf.writestr("README.txt", readme_text)

    buf.seek(0)
    return buf.read()


def _render_readme(
    *,
    entry_id: str,
    record: dict[str, Any],
    analysis: Optional[dict[str, Any]],
    stems_count: int,
    midi_count: int,
    scores_count: int = 0,
    pdf_count: int = 0,
    unity_count: int = 0,
) -> str:
    lines: list[str] = []
    lines.append("theDAW Track Bundle")
    lines.append("=" * 60)
    lines.append(f"Entry ID: {entry_id}")
    if record.get("title"):
        lines.append(f"Title:    {record['title']}")
    if record.get("model"):
        lines.append(f"Model:    {record['model']}")
    if record.get("timestamp"):
        lines.append(f"Created:  {record['timestamp']}")
    lines.append("")
    if record.get("prompt"):
        lines.append("Prompt:")
        lines.append(f"  {record['prompt']}")
        lines.append("")
    if analysis:
        lines.append("Analysis:")
        for k in (
            "bpm",
            "key",
            "scale",
            "bars_estimated",
            "pitch_mean_hz",
            "rms_db",
            "genre",
        ):
            v = analysis.get(k)
            if v is None:
                continue
            lines.append(f"  {k}: {v}")
        lines.append("")
    lines.append(f"Stems:  {stems_count}")
    lines.append(f"MIDI:   {midi_count}")
    lines.append(f"Scores: {scores_count}")
    if pdf_count:
        lines.append(f"PDFs:   {pdf_count} (engraved from the sheets in scores/)")
    if unity_count:
        lines.append(f"Unity:  {unity_count} file(s)")
    lines.append("")
    lines.append("Contents:")
    lines.append("  - <audio file>     the track itself")
    lines.append("  - metadata.json    durable backend record")
    lines.append("  - analysis.json    BPM/key/pitch/etc. (if analysis ran)")
    lines.append("  - lineage.json     directed edges (parents + children)")
    lines.append("  - prompts.txt      positive/negative/embedded prompts")
    lines.append("  - stems/           separated stems (if stems ran)")
    lines.append("  - midi/            MIDI transcriptions (if midi ran)")
    lines.append("  - scores/          sheet music / tabs / arrangements (if any)")
    lines.append("                     .musicxml opens in any notation editor;")
    lines.append("                     .pdf is print-ready; .abc is plain text")
    if unity_count:
        lines.append("  - unity/           flying-notation chart + Unity C# package")
        lines.append("                     copy the com.gantasmo.* folder into your")
        lines.append("                     project's Packages/ directory, then point")
        lines.append("                     the spawner at the .notechart.json")
    return "\n".join(lines) + "\n"
