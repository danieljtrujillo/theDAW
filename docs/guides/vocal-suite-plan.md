# The vocal suite — plan

What the user asked for, in their words: pitch/tuning correction, harmony and
doubling, better vocal separation, synthesis / voice cloning, **vocoder and
talk-box tools**, harmonies that can be driven **in tandem with synth and synth
bass**, and **analysing a track's spectrum to reproduce the sound of its
harmony** — "kinda like vocoder cloning".

## What already exists, and what these two halves are

Two documents already plan the **model** half and should not be re-planned:

- `docs/guides/theDAW_Vocal_Layer_Implementation_Brief.md` — the vocal-layer
  generation brief: SoulX-Singer, YingMusic, DiffSinger, ACE-Step, RVC / Applio
  / Seed-VC, WhisperX, and the adapter architecture under
  `backend/modules/vocal/`.
- `docs/guides/theDAW_SoulX_Singer_Integration_Guide.md` — the focused SoulX
  SVS/SVC integration.

Between them they cover **synthesis and voice conversion**, and sung harmony as
a *generated layer*. Grep confirms what they do **not** mention anywhere:
`vocoder`, `talk box`, `tuning`, `pitch correction`, `autotune`, `formant`.

That is the gap this plan fills. The distinction matters because the two halves
have opposite properties:

|                   | Model half (already planned) | DSP half (this plan)          |
|-------------------|------------------------------|-------------------------------|
| Produces          | a new performance            | a transform of the take you have |
| Needs             | a multi-GB checkpoint, a sidecar venv, a GPU | numpy/scipy and a good algorithm |
| Latency           | seconds to minutes, a job    | fast enough to preview        |
| Fails by          | not being installed          | sounding wrong                |
| Determinism       | sampled                      | reproducible                  |

The DSP half is the part a producer reaches for constantly, it runs on any
machine, and it is where theDAW currently has nothing.

## The foundation that already exists

`backend/modules/vocal/` is today an **analysis** layer, and it is exactly the
right input for all of this:

- `preprocess/f0_curve.py` — dense per-frame F0 over librosa pyin, with the
  voiced/unvoiced mask
- `preprocess/notes.py` — note segmentation
- `preprocess/segments.py`, `preprocess/isolation.py`
- `schema.py` — the canonical `VocalArtifact` (notes, f0, lyrics, phonemes)
- `convert.py` — lossless notes ↔ MIDI round-trip

Nothing below needs a new analysis stack. It needs a **render** stack that
consumes the artifact.

Also already present and reusable: `signalsmith-stretch` on the frontend (the
repo ships a d.ts for it), `scipy`, `librosa`, `aubio`, `pedalboard` (VST3
hosting), and the SCORE tab's melody, which is a ready-made pitch target.

---

## The five pieces, in the order I would build them

### 1. Tuning / pitch correction

The cheapest real win, and everything after it reuses the machinery.

- Target from one of: a scale/key, the song's chord track (already computed —
  `chordtrack` artifacts exist), or the SCORE melody line.
- `retune_ratio(f0, target)` per frame, with **retune speed** and **strength**
  as the two controls that matter, plus a note-transition time so it can be
  either transparent correction or the hard-snap effect on purpose.
- Formant preservation, on by default: shifting F0 without it is the chipmunk
  sound and is the single most common way this feature disappoints.
- Render with a phase-vocoder / PSOLA path; the artifact's voiced mask decides
  where pitch even means anything, so unvoiced consonants are passed through
  untouched instead of smeared.

**Honest constraint:** transparent correction on a polyphonic or heavily
reverbed take is not achievable with DSP alone. Correct the isolated vocal
stem, not the mix, and say so in the UI.

### 2. Harmony and doubling

- **Doubles**: a copy with small, *independent* random drift in timing
  (±10–25 ms), pitch (±5–15 cents) and formant. Without independent drift per
  copy it is a phase-y chorus, not a double.
- **Harmony voices**: intervals chosen against the chord track so a third is
  diatonic rather than parallel — parallel-major-third harmony is instantly
  wrong on a minor chord, and that one detail is the difference between usable
  and toy.
- Per-voice pan, level, formant shift and delay.
- Reuses the retune engine from (1): a harmony voice is a retune to a different
  target.

### 3. Vocoder and talk box — with the synth as the carrier

This is the piece the user called out and the one with the most reach, because
it connects the vocal to the instruments theDAW already has.

- **Classic vocoder**: N-band filterbank; modulator = voice, carrier = any
  source. Bands (16/24/32), band spacing, attack/release, formant shift,
  sibilance passthrough (an unvoiced-consonant bypass, or it becomes
  unintelligible), and a noise/unvoiced band.
- **The carrier is the point.** The user asked for harmony driven *in tandem
  with synth and synth bass* — so the carrier must be selectable as: an
  existing library stem, a live synth voice from the app, or the harmony stack
  from (2). Vocoding the harmony stack with a synth bass carrier is the sound
  they are describing.
- **Talk box** is a different algorithm and should not be faked with the
  vocoder: model the formant filtering of the vocal tract driven by the carrier
  — an LPC/formant-filter path, not a band-splitter. Ship both and let them be
  chosen; they sound different and producers know which they want.

### 4. Spectral harmony cloning ("vocoder cloning")

The most novel of the five and the one to prototype before promising.

The idea: point at a reference track, analyse what its harmony stack is *doing*
spectrally, and reproduce that character on your own voice.

A defensible decomposition:

1. Isolate the reference's vocal (the stems sidecar).
2. Estimate the **voice count and interval structure** — multi-F0 tracking over
   the harmony region gives which intervals are stacked and how they are
   distributed.
3. Estimate the **spectral envelope / formant signature** and the amount of
   detuning and timing spread between voices.
4. Emit a **harmony preset** — intervals, detune spread, timing spread, formant
   shifts, band character — that drives (2) and (3).

The honest framing: this reproduces the *arrangement and character* of a
harmony, not the singer. Cloning the voice itself is voice conversion and is
already the model half's job (RVC / Seed-VC in the existing brief). Multi-F0 on
a dense stack is genuinely hard; **this should be prototyped and measured before
it is promised in the UI.**

### 5. Better vocal separation

Currently 4-stem Demucs, so "vocals" is one bucket.

- Lead vs backing separation, and de-bleed.
- 6-stem and 12-stem models are already accepted by the stems API
  (`stems must be 2, 4, 6, or 12`) — the plumbing exists, the model choice and
  the UI do not.
- This one has an immediate, measured blocker: see below.

---

## The blocker worth fixing first — measured, not assumed

The stems sidecar venv (`integration-package/backend/.sidecar_venv`) holds
**torch 2.13.0+cpu**. Asked directly, it answers:

```text
sidecar torch : 2.13.0+cpu
cuda built    : None
cuda available: False
device count  : 0
```

Demucs 4.1.0 imports and works, but every separation runs on the CPU while a
CUDA build sits unused in the main venv. Measured on this machine: a **2 min
39 s** track was still separating after **5 min 20 s** (6-stem, hq) — worse
than 2x realtime. The ten-track album is hours, not minutes.

Separation is the front door to (1), (2), (4) and (5). Nothing else in this
plan is worth much if getting a clean vocal stem takes an afternoon, so this is
the highest-value single change in the whole vocal area — and it is independent
of every feature above.

**Already fixed (2026-09-09): the status line was lying about it.** The app is
configured to request `cuda`, and `engine.separate_entry` echoed the *request*
into the progress message, so the UI said `device=cuda` through an entire
CPU-bound separation with nothing to contradict it. The sidecar probe now
reports real capability (`cuda_build`, `cuda_available`, `device_count`) and
`_effective_device_label` reports what will actually run, logging a warning when
CUDA was asked for and is not there:

```text
requested 'cuda' -> 'cpu (cuda unavailable: sidecar torch is 2.13.0+cpu)'
```

That makes the problem visible; it does not make it go away. Putting a CUDA
torch in the sidecar venv is a ~2.5 GB download into a vendored environment and
is the user's call.

---

## Where it lives

Follow the existing brief's architecture rather than inventing a parallel one:
a `render/` layer under `backend/modules/vocal/` consuming the `VocalArtifact`,
with the DSP in pure, testable functions (the way `lyricanalysis/devices.py` is
pure) and the I/O and jobs at the edges. The DSP half needs **no sidecar and no
model download**, which is what lets it ship first and work everywhere.

## Order, and why

1. **GPU for the stems sidecar** — unblocks everything, independent of the rest.
2. **Tuning** — self-contained, immediately useful, builds the retune engine.
3. **Harmony and doubling** — reuses the retune engine; needs the chord track,
   which already exists.
4. **Vocoder and talk box** — reuses the harmony stack as a carrier source; the
   piece that ties the vocal to the synths.
5. **Spectral harmony cloning** — prototype and measure first, promise second.
6. **Lead/backing separation** — model-dependent, best after the GPU work.

Synthesis and voice conversion continue to follow the two existing briefs and
are not re-planned here.
