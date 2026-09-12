# Notation, Score, Tabs, Arrangements, and Prompt Inference

theDAW turns audio into symbolic music and back: audio → MIDI → sheet music,
guitar/bass tabs, and arrangements, plus an inferred Stable Audio prompt for any
track. The symbolic side lives in the **Score** tab of the bottom panel and the
**Details** panel; the backend is the `notation` and `analysis` modules.

## The Score panel and notation artifacts

Open it from the bottom panel's **Score** tab, or right-click a library track and
choose **Open Score / Notation** (which selects the track and switches to Score).
The SING tab's **BOTH** layout mounts the same panel, whole, beside the karaoke
lyrics — see [Sing-along and lyrics](sing-along-and-lyrics.md#the-four-layouts).

Every symbolic file a track produces is a *notation artifact* with a kind: `midi`,
`musicxml`, `abc`, `alphatex` (tabs), `pdf`, or `svg`. The left rail of the Score
panel lists them; click one to preview it (MusicXML renders as sheet music,
alphaTex renders as tablature) or use DOWNLOAD to save it. Artifacts are stored
per track under `data/generations/<entry_id>/notation/` and tracked in the
library database, with lineage relations back to their source.

A track needs a MIDI first. Right-click the track and choose **Convert to MIDI**
(audio → MIDI via Basic Pitch, or the piano-specialized engine for piano stems).
Once a MIDI artifact exists, the Score buttons become active.

## Making sheet music (MusicXML)

In the Score panel, **MAKE SHEET** converts the first MIDI artifact to MusicXML
using music21 (it quantizes the rhythm, splits parts, and infers a time
signature). The result renders in the browser as standard notation via
OpenSheetMusicDisplay. MusicXML is the canonical interchange format, so it also
feeds tabs, arrangements, and exports.

## Exporting scores (the EXPORT menu)

With a MusicXML sheet or a MIDI artifact selected, the toolbar's **EXPORT**
button opens a two-column menu: pick a part on the left (**All parts**, then
each part of the sheet in score order), then a format on the right. Every
format works for a single part as well as for the whole sheet: the part is
cut out of the score first and the chosen format is written from that.

- **XML** — the MusicXML sheet itself. For one part, or for a MIDI source, it
  is written as a new MusicXML artifact.
- **XML + PDF PACK** — a zip of the MusicXML plus a PDF engraved on download.
- **PDF** and **SVG** — engraved by the headless OpenSheetMusicDisplay
  renderer, the same engraver the SCORE tab draws with, so the download matches
  the sheet on screen. It needs node and the frontend's dependencies on the
  backend machine. When that renderer is missing, or its render fails, the
  MuseScore command-line tool engraves the same format instead, so either
  engraver produces both. `options.engine` (`osmd` or `musescore`) forces one.
- **ABC** — a compact lead-sheet/folk text format. Always available.
- **NOTECHART** — the Unity flying-notation chart (timecode + spelled notes).
- **BEAT SABER** — opens the Beat Saber export popover (difficulties, BPM
  source, map version, song.ogg, parts to map).

MuseScore is looked for on PATH, at the usual install locations (Program
Files, the per-user Programs folder, the Store alias, scoop and chocolatey on
Windows; `/Applications` on macOS; the snap, flatpak, AppImage and `/opt`
locations on Linux), at the path saved in Settings (the artist button's
**MuseScore** field, with a **BROWSE…** button in the desktop app) and in the
`MUSESCORE_BIN` environment variable. When neither engraver is available, PDF
and SVG stay in the menu, disabled, with the reason as their tooltip, and two
more entries appear: **GET MUSESCORE** opens the MuseScore download page and
**LOCATE MUSESCORE…** lets you point theDAW at an installed copy.

The menu is keyboard-driven: arrows move within a column, Right/Left switch
columns, Enter or Space activates, Escape closes.

Exports are registered as new notation artifacts (a single-part export is
named after its part) and can be downloaded.

## Guitar and bass tabs

The **Tabs** section of the Score panel turns a MIDI into tablature. Choose the
instrument (Guitar or Bass), a tuning (standard, drop D, 7-string, 4- or 5-string
bass), a capo fret, and a difficulty (Easy / Medium / Hard, which caps how high
and wide the fretting goes). Press **MAKE TABS**.

Because the same pitch can be played at several string/fret positions, the
arranger chooses positions with a dynamic-programming pass that minimizes hand
travel, prefers open strings and low frets, and keeps simultaneous notes on
distinct strings. The output is alphaTex, rendered as interactive tablature by
alphaTab. Notes that fall outside the instrument's range are reported as
unplayable rather than forced.

The tab's tick timeline is real wall-clock time: the arranger emits **rests** for
silence, clips a note's written duration back to the next onset when durations
overlap, and always writes an explicit tempo. Without those three, a tab drifted
progressively out of sync with the audio it came from.

> **Re-run older tabs.** Tab artifacts generated before this change lack the rests
> and the tempo directive, so they still drift. Press **MAKE TABS** again to
> regenerate one.

## Following along while it plays

The Score panel follows the audio note by note rather than page by page.

For **sheet music**, the staff strip glides continuously with the playback cursor
instead of jumping a page at a time, and the notehead (or chord) currently under
the cursor is painted in the ink colour. Centering is zoom-aware, so following stays
accurate whatever the shell's zoom. Page-at-a-time movement is still available from
the keyboard and the footer navigation.

Three look settings sit in the play-along footer:

- **NOW** puts the music sounding now at the left third of the pane or at the
  centre. It applies to the views that scroll music past a line — PAGE, STRIP,
  TAB and CHORDS. The HIGHWAY does not have it: there the hit line is fixed by
  the camera (see below).
- **INK** picks the colour of the played notes and the now-line: magenta (the
  default), blue, orange or green. Every ink is a dark colour that stays legible
  on white paper. It repaints the HIGHWAY's strike zone as well, immediately.
- **TRAIL** decides what happens to a note after it sounds. **Hold** (the
  default) keeps every played note in the ink, so the score fills in behind the
  now-line and nothing turns on and off. **Flash** paints only the note that is
  sounding and restores it when the next one sounds. Fast passages under Flash
  blink several times a second, which is why Hold is the default and the
  setting for anyone sensitive to flashing. A seek backwards clears the held
  trail. In the HIGHWAY, Hold keeps a played note in the ink while it fades out
  instead of switching it back to its lane colour.

In **STRIP** the scroll position runs through a smoothing follower: a long note
or a rest, which would otherwise hold the strip still and then jump it, becomes
one steady forward glide, and the strip never moves backwards unless you seek.
The strip also starts *on* the now-line: at the top of the song the first note
sits under the painted line with empty run-up to its left, rather than a third
of a pane past it waiting for playback to catch up. The same is true of the tab
strip.

### The HIGHWAY's strike zone

The HIGHWAY is a 3D lane: notes travel toward you and land on the hit line at
the moment they sound. The hit line is a standing ribbon facing you, over a
bright line on the floor, bracketed by a post on each side. It is drawn in the
INK, and nothing in the lane can bury it — including the note it is marking,
which crosses its band for about 90 ms at the default approach speed and passes
in front of it, not behind.

It sits at roughly two thirds down the pane rather than at the very bottom,
which is what makes a landing readable. A note on the bottom staff line stays
on screen about 180 ms past its hit at approach speed 8, so the ink tint that
marks the hit is really seen; a grand staff's second staff is on screen at all;
and a ledger line below the staff is still in frame when its turn comes. A note
past the line fades out rather than vanishing, at every speed.

**SPEED** (3 to 20, 8 by default) changes how fast notes approach and so how
far ahead of the hit you see them. **NOTATION**, **BLOCKS** and **DRUMS**
switch the presentation.

### Large scores

Engraving a page of sheet music is one long piece of work that the browser has
to do in one go, and it grows with the file: measured at roughly 2.2 seconds
per megabyte of MusicXML. A 4.7 MB seven-part band score is about ten seconds a
pass, and the first open costs two passes, because the auto-fit engraves once to
measure before it engraves to show — twenty seconds with the whole app frozen.

So PAGE asks first. Above 1.5 MB, instead of drawing the score it shows a
**Large score** card that says how many measures and parts it has, how big it
is and about how long engraving will take, and offers two ways forward:

- **OPEN THE STRIP INSTEAD** — the recommended one. The strip follows exactly
  the same music, note for note, and never engraves a page, so it opens
  instantly and stays smooth at any size. Unless you specifically need to read
  the printed page layout, this is the better view for a big score anyway.
- **ENGRAVE IT ANYWAY** — draws it. A yes is remembered for that score for the
  rest of the session, so you are asked once and not on every click. Reloading
  the page asks again.

Smaller scores are never gated, and none of this applies to STRIP, CHORDS or
HIGHWAY, which do not engrave pages at all.

Around that gate, the score panel avoids paying the cost twice: switching
play-along views or SING layouts parks a score rather than tearing it down, the
MusicXML text is not re-fetched on every re-open, and the zoom the auto-fit
worked out is remembered per score and page width, so a browser reload does not
re-fit. A first open is still slower than a later one.

For **tabs**, alphaTab runs in external-media player mode: theDAW's transport is
the clock, and the beat cursor and highlighted elements are driven from it every
frame with the same latency compensation as the sheet cursor. Tabs carry their own
**Follow** toggle. The behavior is feature-detected, so an older alphaTab bundle
degrades to a static tab rather than breaking.

## Arrangements (lead sheet, piano reduction, band score)

The **Arrange** section produces a playable MusicXML arrangement from a track's
MIDI(s). Pick a style and press **ARRANGE**:

- **lead-sheet** — the melody (skyline) with chord symbols above it.
- **piano-reduction** — a two-staff grand staff, split at middle C.
- **simplified** — a single-staff melody only, quantized.
- **band-score** — one staff per separated stem, combined into a full score.

Arrangements render in the same in-browser sheet-music viewer as MAKE SHEET and
are saved as MusicXML artifacts.

## Prompt inference from audio

The **Details** panel infers a Stable Audio-style prompt from a track's analysis.
After a track is analyzed (BPM, key, loudness, pitch), the **PROMPT INFERENCE**
box's **INFER** button generates a one-line prompt plus semantic tags, for
example: "Approximately 118 BPM, in F minor, upbeat, danceable, moody, balanced,
deep, full track, stereo." **USE AS PROMPT** copies it into the MAKE prompt field
so you can regenerate similar audio.

The prompt is deterministic: it is derived from tempo, key/scale, energy
(loudness/RMS), timbre (pitch), length, and channel count, and folds in any
embedded genre/mood tags. A confidence score reflects how much analysis data was
available. Genre/mood/instrument detection via dedicated ML models
(Essentia/MERT/CLAP) is an optional future enricher; the deterministic prompt
always works without it.

## API reference

Notation endpoints (prefix `/api/notation`):

- `GET /api/notation` — capabilities (music21, MuseScore, `osmd_pdf`, formats,
  `engravers` — which of `osmd` / `musescore` can produce `pdf` and `svg`, in
  the order they are tried — tab tunings, arrangement styles). `formats` lists
  `pdf` and `svg` whenever either engraver is present.
- `GET /api/notation/{entry_id}/artifacts` — list a track's notation artifacts.
- `POST /api/notation/{entry_id}/from-midi/{midi_id}` — MIDI → MusicXML.
- `POST /api/notation/{entry_id}/export` — `{source_artifact_id, format, options?}`
  where format is musicxml/abc/pdf/svg/notechart/beatsaber and the source is a
  MusicXML or MIDI artifact. `options.parts` (part indices in score order)
  exports only those parts, for every format; `options.engine` picks the
  engraver for `pdf`/`svg`; the rest of `options` is read by `beatsaber`
  (difficulties, version, bpm_source, include_audio).
- `GET /api/notation/pack/{artifact_id}?parts=0,2` — the MusicXML + PDF zip,
  optionally cut down to those parts.
- `POST /api/notation/{entry_id}/tabs` — `{source_artifact_id|midi_id, instrument,
  tuning_name, capo, difficulty}` → alphaTex.
- `POST /api/notation/{entry_id}/arrange` — `{style, source_artifact_id |
  source_artifact_ids | midi_id}` → MusicXML.
- `GET /api/notation/file/{artifact_id}` — download an artifact.

Prompt inference (prefix `/api/analysis`):

- `GET /api/analysis/{entry_id}/prompt` — `{prompt_guess, prompt_confidence,
  semantic_tags}`, regenerated from the stored analysis.
