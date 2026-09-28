"""Count the composer style profiles that the music21 corpus can support.

Writes ``backend/modules/composer/styles/<id>.json`` for each composer whose
scores ship in music21's core corpus, through
:func:`backend.modules.composer.profile.extract_profile`. Each JSON lists the
works it was counted from and how they were sampled. The profiles for
composers the corpus does not hold (Brahms, Tchaikovsky, Debussy, Stravinsky,
Bartók) are written by hand from harmony-textbook facts, carry
``"source": "authored"``, and this script never touches them.

Run once from the repo root, then commit the JSON it writes:

    python scripts/build_style_profiles.py            # every extracted style
    python scripts/build_style_profiles.py bach haydn # just these

Pure music21 + numpy, no model and no GPU. The full run reads about ninety
works (at most 96 bars of each) in two to three minutes.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

#: Bars read from each work; a chorale is shorter, a quartet movement longer.
MAX_BARS = 96
#: Every n-th chorale of the 371 in music21's Riemenschneider-numbered list.
CHORALE_STEP = 9


def _chorales() -> tuple[list[str], int, str]:
    from music21 import corpus

    names = list(corpus.chorales.Iterator(returnType="filename"))
    pick = names[::CHORALE_STEP]
    return (
        pick,
        len(names),
        f"every {CHORALE_STEP}th of the {len(names)} chorales in music21's chorale "
        "list (corpus.chorales.Iterator), whole chorales",
    )


def _composer(
    name: str, keep: Callable[[str], bool] | None = None
) -> Callable[[], tuple[list[str], int, str]]:
    def pick() -> tuple[list[str], int, str]:
        from music21 import common, corpus

        root = Path(common.getCorpusFilePath())
        files = sorted(
            Path(p).relative_to(root).as_posix()
            for p in corpus.getComposer(name)
            if str(p).endswith((".mxl", ".xml", ".musicxml"))
        )
        chosen = [f for f in files if keep is None or keep(f)]
        how = (
            f"{len(chosen)} of the {len(files)} MusicXML files under {name}/ in "
            f"music21's core corpus, the first {MAX_BARS} bars of each"
        )
        return chosen, len(files), how

    return pick


def _beethoven(path: str) -> bool:
    # One movement per file (opus 132, 133, 74 and opus 18 nos. 3-5 are
    # whole multi-movement quartets in one file): opus 18 no. 1 and the first
    # movements of the three Razumovsky quartets, opus 59 no. 1 whole.
    return path.startswith(
        ("beethoven/opus18no1/", "beethoven/opus59no1/")
    ) or path in (
        "beethoven/opus59no2/movement1.mxl",
        "beethoven/opus59no3/movement1.mxl",
    )


STYLES: dict[str, dict[str, Any]] = {
    "bach": {
        "name": "Johann Sebastian Bach",
        "era": "Baroque (1685-1750)",
        "works": _chorales,
        "orchestration": "satb_choir",
    },
    "handel": {
        "name": "George Frideric Handel",
        "era": "Baroque (1685-1759)",
        "works": _composer("handel"),
        "orchestration": "voice_and_continuo",
    },
    "haydn": {
        "name": "Joseph Haydn",
        "era": "Classical (1732-1809)",
        "works": _composer("haydn"),
        "orchestration": "string_quartet",
    },
    "mozart": {
        "name": "Wolfgang Amadeus Mozart",
        "era": "Classical (1756-1791)",
        "works": _composer("mozart"),
        "orchestration": "string_quartet",
    },
    "beethoven": {
        "name": "Ludwig van Beethoven",
        "era": "Classical to Romantic (1770-1827)",
        "works": _composer("beethoven", _beethoven),
        "orchestration": "string_quartet",
    },
}


def build(style_id: str, out_dir: Path) -> dict[str, Any]:
    from music21 import corpus

    from backend.modules.composer.profile import extract_profile

    spec = STYLES[style_id]
    works, available, how = spec["works"]()
    started = time.perf_counter()

    def scores():
        for w in works:
            work_id = w.rsplit(".", 1)[0] if w.endswith((".mxl", ".xml")) else w
            yield work_id, corpus.parse(w)

    doc = extract_profile(
        scores(),
        style_id=style_id,
        name=spec["name"],
        era=spec["era"],
        max_bars=MAX_BARS,
        orchestration=spec["orchestration"],
        sample={"available": available, "selection": how},
    )
    doc["basis"] = (
        f"counted by scripts/build_style_profiles.py from {len(works)} public-domain "
        "works in music21's core corpus (listed under works)"
    )
    out = out_dir / f"{style_id}.json"
    out.write_text(
        json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(
        f"{style_id}: {len(works)} works, {doc['sample']['bars']} bars, "
        f"{time.perf_counter() - started:.1f}s -> {out.relative_to(ROOT)}"
    )
    return doc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("styles", nargs="*", help=f"any of {', '.join(STYLES)}")
    args = parser.parse_args(argv)
    unknown = [s for s in args.styles if s not in STYLES]
    if unknown:
        parser.error(f"no extracted style {unknown}; choose from {', '.join(STYLES)}")
    from backend.modules.composer.profile import STYLES_DIR

    STYLES_DIR.mkdir(parents=True, exist_ok=True)
    for style_id in args.styles or list(STYLES):
        build(style_id, STYLES_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
