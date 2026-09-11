"""Print a rhythm report for audio files — the whole meter map, bar by bar
if asked, so a musician can check the engine against music they know.

    uv run python -m backend.modules.rhythm.report "data/uncanny/master/*.opus"
    uv run python -m backend.modules.rhythm.report song.wav --bars --json out.json
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
import time
from pathlib import Path

from .engine import analyze_file


def _fmt_segment(m: dict) -> str:
    mark = "?" if m.get("uncertain") else " "
    return (
        f" {mark}{m['start_sec']:7.1f}-{m['end_sec']:7.1f}s  {m['time_signature']:<16} "
        f"L={m['beats_per_bar']:<2} bars={m['bars']:<3} bpm={m['bpm']:<7} "
        f"sub={m['subdivision']:<8} conf={m['confidence']:.2f}"
    )


def report(path: Path, *, bars: bool = False) -> dict:
    t0 = time.time()
    r = analyze_file(path)
    took = time.time() - t0
    print(f"\n=== {path.name}  ({r['duration_sec']:.0f}s, analyzed in {took:.1f}s) ===")
    t = r["tempo"]
    if t["bpm"] is None:
        print("  " + r["summary"])
        return r
    print(
        f"tempo {t['bpm']} bpm (global {t['global_bpm']}, range "
        f"{t['range_bpm'][0]}-{t['range_bpm'][1]}, level {t['level']}, "
        f"{'stable' if t['stable'] else 'changes: ' + ', '.join(f'{s["bpm"]}@{s["start_sec"]}s' for s in t['segments'])})"
    )
    print(
        f"beats {len(r['beats'])}  downbeats {len(r['downbeats'])}  bars {len(r['bars'])}"
    )
    print("meter map:")
    for m in r["meter_map"]:
        print(_fmt_segment(m))
    s = r["syncopation"]
    print(
        f"syncopation: LHL mean {s['mean_lhl']:.3f} max {s['max_lhl']:.3f} "
        f"off-beat {s['mean_offbeat_ratio']:.2f} swing {s['swing_ratio']} "
        f"(conf {s['swing_confidence']:.2f}) peak bars {s['peak_bars']}"
    )
    if r["polymeter"]:
        print("polymeter:")
        for p in sorted(r["polymeter"], key=lambda p: -p["confidence"])[:6]:
            print(
                f"  seg {p['segment']:<3} {p['layer']:<10} keeps {p['beats_per_bar']} "
                f"{'+'.join(map(str, p['grouping']))}  {p['relation']}  conf {p['confidence']:.2f}"
            )
    if r["cross_rhythms"]:
        print("cross-rhythms:")
        for c in sorted(r["cross_rhythms"], key=lambda c: -c["strength"])[:6]:
            print(
                f"  seg {c['segment']:<3} {c['ratio']}  {c['bpm']} bpm  strength {c['strength']:.2f}"
            )
    if bars:
        print("bars:")
        for b in r["bars"]:
            sy = b["syncopation"]
            print(
                f"  {b['index']:4d} {b['start_sec']:8.2f}s {b['time_signature']:<12} "
                f"lhl={sy['lhl']:.3f} wnbd={sy['wnbd']:.3f} off={sy['offbeat_ratio']:.2f} n={sy['onsets']}"
            )
    print("summary: " + r["summary"])
    return r


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("paths", nargs="+", help="audio files or globs")
    ap.add_argument("--bars", action="store_true", help="print every bar")
    ap.add_argument("--json", help="write all results to this JSON file")
    args = ap.parse_args(argv)
    files: list[Path] = []
    for p in args.paths:
        hits = glob.glob(p)
        files.extend(Path(h) for h in (hits or [p]))
    results = {}
    for f in files:
        if not f.is_file():
            print(f"skip (not a file): {f}", file=sys.stderr)
            continue
        results[str(f)] = report(f, bars=args.bars)
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=1), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
