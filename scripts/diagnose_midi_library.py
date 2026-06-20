"""Read-only MIDI library diagnostics for theDAW.

This script exists so MIDI/library evidence gathering does not depend on fragile
one-line shell quoting. It performs a minimal Standard MIDI File chunk scan and
correlates discovered files with any SQLite `midis` tables found under the repo.

Default behavior is report-only: it never deletes, rewrites, quarantines, or
mutates files/databases.

Usage from the repository root:

    python scripts/diagnose_midi_library.py
    python scripts/diagnose_midi_library.py --json
    python scripts/diagnose_midi_library.py --root data --json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_SCAN_ROOTS = ("data", "frontend", "backend")


@dataclass
class MidiInspection:
    path: str
    bytes: int
    ok: bool = False
    error: str | None = None
    header_len: int | None = None
    format: int | None = None
    declared_tracks: int | None = None
    seen_tracks: int = 0
    division: int | None = None
    failure_offset: int | None = None
    actual_ascii: str | None = None
    actual_hex: str | None = None
    track_length: int | None = None
    remaining: int | None = None
    trailing_bytes: int | None = None
    head_hex: str | None = None


@dataclass
class MidiDbReport:
    db: str
    count: int = 0
    rows_missing_files: list[dict[str, Any]] = field(default_factory=list)
    rows_invalid_files: list[dict[str, Any]] = field(default_factory=list)
    sample: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


def printable_ascii(raw: bytes) -> str:
    return "".join(chr(b) if 32 <= b < 127 else "." for b in raw)


def inspect_midi(path: Path) -> MidiInspection:
    try:
        data = path.read_bytes()
    except OSError as exc:
        return MidiInspection(path=str(path), bytes=0, error=f"read_error: {exc}")

    report = MidiInspection(path=str(path), bytes=len(data))
    if len(data) < 14:
        report.error = "too_short"
        report.head_hex = data[:16].hex(" ")
        return report

    if data[:4] != b"MThd":
        report.error = "missing_MThd"
        report.head_hex = data[:16].hex(" ")
        return report

    header_len = int.from_bytes(data[4:8], "big")
    report.header_len = header_len
    if len(data) < 8 + header_len:
        report.error = "truncated_header"
        return report
    if header_len < 6:
        report.error = "short_header"
        return report

    report.format = int.from_bytes(data[8:10], "big")
    report.declared_tracks = int.from_bytes(data[10:12], "big")
    report.division = int.from_bytes(data[12:14], "big")

    offset = 8 + header_len
    seen = 0
    while seen < report.declared_tracks and offset < len(data):
        marker = data[offset : offset + 4]
        if len(marker) < 4:
            report.error = "truncated_track_marker"
            report.failure_offset = offset
            report.seen_tracks = seen
            return report

        if marker != b"MTrk":
            report.error = "invalid_track_marker"
            report.failure_offset = offset
            report.seen_tracks = seen
            report.actual_ascii = printable_ascii(marker)
            report.actual_hex = marker.hex(" ")
            return report

        if offset + 8 > len(data):
            report.error = "truncated_track_header"
            report.failure_offset = offset
            report.seen_tracks = seen
            return report

        track_len = int.from_bytes(data[offset + 4 : offset + 8], "big")
        offset += 8
        if offset + track_len > len(data):
            report.error = "truncated_track_body"
            report.failure_offset = offset
            report.seen_tracks = seen
            report.track_length = track_len
            report.remaining = len(data) - offset
            return report

        offset += track_len
        seen += 1

    report.seen_tracks = seen
    report.trailing_bytes = len(data) - offset
    report.ok = seen == report.declared_tracks and offset <= len(data)
    if not report.ok and report.error is None:
        report.error = "ended_before_declared_tracks"
    return report


def discover_midi_files(roots: list[Path]) -> list[Path]:
    files: dict[Path, Path] = {}
    for root in roots:
        if not root.exists():
            continue
        for pattern in ("*.mid", "*.midi"):
            for path in root.rglob(pattern):
                files[path.resolve()] = path
    return sorted(files.values(), key=lambda p: str(p).lower())


def discover_databases(root: Path) -> list[Path]:
    return sorted(root.rglob("*.db"), key=lambda p: str(p).lower())


def inspect_midi_databases(
    databases: list[Path], inspections_by_path: dict[str, MidiInspection]
) -> list[MidiDbReport]:
    reports: list[MidiDbReport] = []
    for db_path in databases:
        db_report = MidiDbReport(db=str(db_path))
        try:
            with sqlite3.connect(db_path) as con:
                con.row_factory = sqlite3.Row
                tables = {
                    row[0]
                    for row in con.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                if "midis" not in tables:
                    continue

                rows = list(con.execute("SELECT * FROM midis"))
                db_report.count = len(rows)
                for row in rows[:5]:
                    db_report.sample.append(dict(row))
                for row in rows:
                    row_dict = dict(row)
                    midi_path = Path(str(row_dict.get("midi_path") or ""))
                    if not midi_path.is_file():
                        db_report.rows_missing_files.append(row_dict)
                        continue
                    inspection = inspections_by_path.get(str(midi_path.resolve()))
                    if inspection is None:
                        inspection = inspect_midi(midi_path)
                    if not inspection.ok:
                        db_report.rows_invalid_files.append(
                            {**row_dict, "inspection": asdict(inspection)}
                        )
        except Exception as exc:  # noqa: BLE001 - diagnostic script should continue.
            db_report.error = repr(exc)
        reports.append(db_report)
    return reports


def build_report(repo_root: Path, scan_roots: list[str]) -> dict[str, Any]:
    roots = [(repo_root / item).resolve() for item in scan_roots]
    midi_files = discover_midi_files(roots)
    inspections = [inspect_midi(path) for path in midi_files]
    inspections_by_path = {str(Path(item.path).resolve()): item for item in inspections}
    invalid = [item for item in inspections if not item.ok]
    db_reports = inspect_midi_databases(
        discover_databases(repo_root), inspections_by_path
    )

    return {
        "repo_root": str(repo_root),
        "scan_roots": scan_roots,
        "scanned_midi_files": len(inspections),
        "invalid_midi_files": len(invalid),
        "invalid": [asdict(item) for item in invalid],
        "databases_with_midis": [
            asdict(item) for item in db_reports if item.count or item.error
        ],
    }


def print_text_report(report: dict[str, Any]) -> None:
    print("MIDI library diagnostic report")
    print(f"Repo root: {report['repo_root']}")
    print(f"Scan roots: {', '.join(report['scan_roots'])}")
    print(f"MIDI files scanned: {report['scanned_midi_files']}")
    print(f"Structurally invalid MIDI files: {report['invalid_midi_files']}")

    if report["invalid"]:
        print("\nInvalid MIDI files:")
        for item in report["invalid"]:
            print(
                "- {path} :: {error} at offset {failure_offset} saw {actual_hex}".format(
                    path=item.get("path"),
                    error=item.get("error"),
                    failure_offset=item.get("failure_offset"),
                    actual_hex=item.get("actual_hex"),
                )
            )

    db_reports = report["databases_with_midis"]
    print(f"\nSQLite DBs with midis table: {len(db_reports)}")
    for db in db_reports:
        print(f"- {db['db']} :: rows={db['count']}")
        if db.get("error"):
            print(f"  error: {db['error']}")
        missing = db.get("rows_missing_files") or []
        invalid = db.get("rows_invalid_files") or []
        if missing:
            print(f"  rows pointing to missing files: {len(missing)}")
        if invalid:
            print(f"  rows pointing to invalid files: {len(invalid)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        action="append",
        dest="roots",
        help="Repository-relative root to scan. May be passed multiple times. Defaults to data, frontend, backend.",
    )
    parser.add_argument(
        "--json", action="store_true", help="Print machine-readable JSON."
    )
    args = parser.parse_args()

    repo_root = Path.cwd().resolve()
    report = build_report(repo_root, args.roots or list(DEFAULT_SCAN_ROOTS))
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
