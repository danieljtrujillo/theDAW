# Notation, Score, Tabs, Arrangements, and Prompt Inference

theDAW turns audio into symbolic music and back: audio → MIDI → sheet music,
guitar/bass tabs, and arrangements, plus an inferred Stable Audio prompt for any
track. The symbolic side lives in the **Score** tab of the bottom panel and the
**Details** panel; the backend is the `notation` and `analysis` modules.

## The Score panel and notation artifacts

Open it from the bottom panel's **Score** tab, or right-click a library track and
choose **Open Score / Notation** (which selects the track and switches to Score).

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

## Exporting scores (ABC, PDF, SVG)

With a MusicXML score selected, the toolbar offers export buttons:

- **ABC** — a compact lead-sheet/folk text format, produced by music21. Always
  available.
- **PDF** and **SVG** — engraved by the MuseScore command-line tool. These appear
  only when MuseScore is installed and detected (set the `MUSESCORE_BIN`
  environment variable to point at it if it is not on PATH). Without MuseScore,
  PDF/SVG are hidden and the action reports that MuseScore is required.

Exports are registered as new notation artifacts and can be downloaded.

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

- `GET /api/notation` — capabilities (music21, MuseScore, formats, tab tunings,
  arrangement styles).
- `GET /api/notation/{entry_id}/artifacts` — list a track's notation artifacts.
- `POST /api/notation/{entry_id}/from-midi/{midi_id}` — MIDI → MusicXML.
- `POST /api/notation/{entry_id}/export` — `{source_artifact_id, format}` where
  format is musicxml/abc/pdf/svg.
- `POST /api/notation/{entry_id}/tabs` — `{source_artifact_id|midi_id, instrument,
  tuning_name, capo, difficulty}` → alphaTex.
- `POST /api/notation/{entry_id}/arrange` — `{style, source_artifact_id |
  source_artifact_ids | midi_id}` → MusicXML.
- `GET /api/notation/file/{artifact_id}` — download an artifact.

Prompt inference (prefix `/api/analysis`):

- `GET /api/analysis/{entry_id}/prompt` — `{prompt_guess, prompt_confidence,
  semantic_tags}`, regenerated from the stored analysis.
