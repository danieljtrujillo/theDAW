# Rhythm analysis — meter maps for music whose meter does not sit still

theDAW's rhythm module reads a track's **tempo curve**, its **beats**, and a
**meter map**: the time signature of every stretch of the song, with the
grouping of an additive meter (7/8 as 2+2+3, 19/16 as 3+3+3+3+3+2+2), the
downbeats and bars that follow from it, per-bar **syncopation**, the **swing
ratio**, **polymeter** (a layer keeping its own bar length against the drums)
and **cross-rhythms** (3:2, 4:3 …). It runs on numpy + librosa, no model, and
works on any file the library can decode — Opus masters included.

It exists because the ordinary analysis assumes ONE tempo and ONE fixed number
of beats per bar for the whole track. Metamorphic music — 4/4 into 7/8 into
5/4, a 13/8 riff, a 23/16 bridge — breaks both assumptions, and a single
"BPM: 129, 4/4" is worse than useless for it.

## Where to find it

- **API:** `GET /api/rhythm/{entry_id}` returns the cached analysis for a
  library entry (`status: pending` until it has run), `POST /api/rhythm/{entry_id}/run`
  runs it now, `POST /api/rhythm/file` with `{"path": …}` analyzes any audio
  file, `GET /api/rhythm/` lists the engine version and features.
- **Report, from a terminal:**
  `uv run python -m backend.modules.rhythm.report "data/uncanny/master/*.opus"`
  prints every track's map; `--bars` prints every bar; `--json out.json` keeps
  the full result.

## How to read a meter map

Each segment line reads like this:

```
  36.7-   71.7s  7/4 (2+2+3)   L=7  bars=11  bpm=131.8  sub=simple  conf=0.17
 ?  0.1-   22.2s  3/4          L=3  bars=16  bpm=129.8  sub=simple  conf=0.05
```

- **L** is the bar length in beats of the grid the segment was read on. At
  the tracked level the time signature is derived from it: with a compound
  subdivision (each beat splitting in three) `L=2` is 6/8 and `L=4` is 12/8;
  a fast odd pulse (over 160 bpm, 5/6/7/9/10/11/12) is written in eighths;
  otherwise the tracked beat is the quarter. At a tatum level L counts
  eighths or sixteenths and the signature is written in them (19/16).
- **(2+2+3)** is the grouping — how the bar's beats bundle into twos and
  threes. It comes from where the accents fall, so 7 as 2+2+3 and 7 as 3+2+2
  are told apart.
- **conf** is a confidence in 0–1. It is calibrated against *coprime* bar
  lengths: 6 against 4 always scores well (both carry the duple alternation)
  and says nothing, so it does not count; 7 against 4 does. On real mixes
  stable readings sit around **0.15–0.4**. Anything under **0.10 is marked
  `?`** — a guess, kept so the map has no holes, and it will flip with the
  smallest change of evidence. Trust the un-marked segments; treat `?` as
  "the accents here fit no bar length well".
- **sub** is `simple` or `compound`. Compound needs onsets on BOTH thirds of
  the beat; swung eighths sit on the second third alone and stay `simple`
  with a swing ratio instead (1.0 straight, 2.0 triplet swing).
- **Syncopation (LHL)** is Longuet-Higgins & Lee on the *low band* — the kick
  and bass pushing against the pulse — because a hat on every beat fills
  every rest in the full mix. WNBD and the off-beat ratio are read on the
  full mix. All per bar, 0–1, with peak bars listed.
- **Polymeter** names a layer (low / mid / high band, or a stem when given)
  that keeps a bar length of its own: `mid keeps 3 (3:4)` is a melody cycling
  in three over 4/4 drums. `displaced:+2` is the same bar, two beats late.
- **Cross-rhythms** are tempogram peaks at non-octave ratios of the tempo
  (3:2 a hemiola, 4:3, 5:4), with strength relative to the tempo's own peak.

The rhythm section sets the bar. When the drums read 4 and the whole mix
reads 12 because a melody cycles in 3, the map says 4/4 and the polymeter
list says the melody keeps 3 — not 12/4.

## Levels: the tracked beat and the tatum

The map is read first at the tracked beat. When that reading is poor (mean
window confidence under 0.35) the engine tries the tatum: the fastest strong
pulse above the beat in the tempogram, hats on eighths or sixteenths, tracked
at hop 128 so a sixteenth's period is not rounded away. A finer level replaces
the tracked one only when it reads an odd bar (an even one is the coarser bar
in more positions) and either reads clearly better or reads a shorter bar
about as well: 13/8 at the quarter is a two-bar 13/4, and the bar is the
shortest cycle that explains the accents. A grid finer than the music is
rejected by an occupancy test: a position is occupied when its onset mass is
1.5x the mass at the midpoints either side, and a grid needs 60 % of its
`level` on each segment names the grid it was read on; `diagnostics.levels` records the grids tried, with rate and acceptance status on each candidate and occupancy, quality, and rejection details when available.

## Known limits

- Groupings of long bars at the eighth level (12/8 read at 200 bpm) flicker
  between 2+3+2+3+2 and 2+2+2+2+2+2 from segment to segment.
- Absolute confidences on a dense mix are lower than on a clean recording;
  read them relative to the track's own best segments.
- A change of meter is placed within about a bar; a two-bar insert inside a
  long window can still be absorbed by its neighbours.

## For whoever works on the engine next

The scoring — which bar length explains the accents — is the *small* part.
Every one of these looked like a scoring problem and was upstream of it, and
each cost real time to find. They apply to any beat-synchronous analysis in
this codebase, not only this module.

1. **librosa's beat tracker locks onto hats.** Onset strength is a *dB flux*:
   an 8 ms broadband hat burst out of silence is a 40 dB step in every mel
   band — the low ones included — while a 60 Hz kick fills two bands. In flux
   terms the hat wins even in the low channel, so the beats sat half a beat
   off the kicks (or two thirds off, on swung hats). Downbeats matched 0 %,
   and every per-beat feature was measured on off-beats. The fix is to track
   on broad flux plus the *low band's power derivative*, then choose the beat
   phase as the fractional offset (twelfths of a beat) with the most
   **low-band power** under the beats, then snap each beat to the local onset
   peak so beats and onsets share one frame grid (`_align_phase`,
   `_snap_to_peaks`).
2. **Frame quantization reads as meter.** A beat is 25.84 frames at 100 bpm
   (hop 512 / 22.05 kHz), so the beat grid drifts against the frame grid with
   a ~6-beat cycle (5.5 at 128 bpm). A *peak* level per beat swings several
   dB with sub-frame alignment, and that swing is periodic: 4/4 read as 6/4 at
   100 bpm, 7 read as 5 at 128. Per-beat evidence must be **integrated**
   (band power summed over the beat's span), which does not care where the
   frames fall; spans start a quarter beat early so a kick a frame either side
   of its beat lands in that beat (`_beat_energies`).
3. **Cosine similarity on centered features is direction-only.** A plain
   beat's centered feature vector is nearly zero, and its *direction* is
   jitter — cosine then reports a periodicity of its own. Use distance.
4. **Z-scoring a flat row inflates jitter to unit variance.** Scale with a
   floored spread (`(x - mean) / (std + floor)`), so a row with no real
   beat-to-beat structure barely counts (`_robust`, `_scale_rows`).
5. **One beat in digital silence is −120 dB** (a trailing beat in the tail, a
   gap) and owns the variance of its whole row, flattening every real
   contrast: a perfect 3-cycle read as effect size 0.15. Floor dB energies at
   60 dB under the row's loudest beat.
6. **`librosa.beat.beat_track(bpm=array)` IS per-frame tempo** — the
   docstring says "multichannel", but `bpm.shape[-1]` may equal the envelope
   length and the DP follows it. The 0 % beat match on a tempo change was the
   phase (item 1), never the tempo.
7. **`onset_strength(S=...)` assumes `n_fft=2048`.** It shifts the envelope
   by `n_fft // (2 * hop)` frames to undo the STFT's centering. With a 512
   window at hop 128 that is 6 frames (35 ms) late against the band power
   from the same STFT, and a beat phase chosen on band power then sits off
   every flux peak. Pass `n_fft`.

Two more that shaped the design: a melody louder than the kick in its own
band drags the composite reading to the lowest common multiple (12 over 4/4
drums with a 3-cycle), so the meter is read on the low band alone first and
the composite only confirms it; and swung eighths satisfy any "thirds carry
the mass" compound rule — compound needs *both* thirds populated.

The synthetic ground truth that caught all of this is `tests/rhythm_synth.py`
(`MeterSegment`: any bar length, grouping, compound, swing, pushed patterns,
a polymeter layer, a cross pulse), driven by `tests/test_rhythm_engine.py`.
When something reads wrong on a real track, build the smallest synthetic
track that shows it before touching a weight.
