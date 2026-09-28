"""Write the string quartet test fixtures from the music21 corpus.

The fixtures are a real multi-part score for the import tests: bars 530-640
of Beethoven's String Quartet in A minor, Op. 132. The slice holds four
parts, four time signatures (4/4, 3/8, 4/4, 3/8), a metronome mark
(andantino, 80) and three tempo words (Andante, Molto Adagio, Andante),
grace notes and trills.

Where the encoding comes from: music21's corpus file beethoven/opus132.mxl
is one of the Project Gutenberg MusicXML scores. music21's About page says
"Project Gutenberg houses public domain music, including the quartets of
Beethoven, Haydn, and Mozart, in musicxml format which we have been able to
include in music21", and the file came into the corpus in music21's commit
e8e460e, "restore Gutenberg files!", with the other Gutenberg quartets. The
composition (1825) and that encoding are in the public domain; the file
embeds no <rights> element, and the slice written here carries none.

Two files are written to ``tests/fixtures/quartet``:

- ``op132_m530-640.mxl``: the slice as compressed MusicXML, for the sheet
  importer (``backend/modules/sheetimport/parser.py``).
- ``op132_m530-640.mid``: the slice as a type-1 MIDI file at 480 PPQ, with each
  part on the registry instrument its name names (violins 40, viola 41, cello
  42), for the roll's MIDI import (``frontend/src/lib/quartetImport.test.ts``).

Run from the repo root: ``python scripts/make_quartet_fixture.py``. The output
is committed; run this again only to change the slice.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

OUT = ROOT / "tests" / "fixtures" / "quartet"
FIRST_BAR = 530
LAST_BAR = 640
STEM = f"op132_m{FIRST_BAR}-{LAST_BAR}"
MIDI_PPQ = 480


def main() -> int:
    from music21 import corpus, defaults, instrument, midi

    from backend.modules.notation.instruments import guess_from_name, to_music21

    score = corpus.parse("beethoven/opus132")
    piece = score.measures(FIRST_BAR, LAST_BAR)
    OUT.mkdir(parents=True, exist_ok=True)
    piece.write("mxl", fp=str(OUT / f"{STEM}.mxl"))

    # The MIDI file: each part on its registry instrument, so the file carries
    # the part's name and General MIDI program as a notation program writes them.
    for part in piece.parts:
        record = guess_from_name(str(part.partName or ""))
        if record is None:
            continue
        name = part.partName
        for old in list(part.recurse().getElementsByClass(instrument.Instrument)):
            old.activeSite.remove(old)
        inst = to_music21(record)
        inst.partName = name
        inst.instrumentName = name
        part.insert(0, inst)
    # music21 writes at its default resolution; the fixture is a 480 PPQ file,
    # the resolution most programs (and the roll before 960) write.
    kept = defaults.ticksPerQuarter
    defaults.ticksPerQuarter = MIDI_PPQ
    try:
        mf = midi.translate.streamToMidiFile(piece)
    finally:
        defaults.ticksPerQuarter = kept
    mf.open(str(OUT / f"{STEM}.mid"), "wb")
    try:
        mf.write()
    finally:
        mf.close()
    for f in sorted(OUT.iterdir()):
        print(f"{f.relative_to(ROOT)}: {f.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
