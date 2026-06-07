# Analyzer — AI-Assisted Audio Analysis & Effect Stack Builder

The analyzer module computes a layered descriptor taxonomy over any audio input and feeds
it to a hybrid recommendation engine (deterministic rules + LLM ranking) that proposes
complete, prioritized effect stacks with evidence, confidence, and alternatives.

## Architecture

```
Audio file
    │
    ▼
┌──────────────────────────────────────────────────┐
│  descriptors.py                                  │
│                                                  │
│  LOW-LEVEL         MID-LEVEL        HIGH-LEVEL   │
│  ─────────         ─────────        ──────────   │
│  RMS / energy      Onset density    Artifact      │
│  Peak / true peak  F0 / voicing     flags         │
│  Crest factor      Chroma / HPCP    Semantic      │
│  LUFS (M/S/I)      Key / mode       priors        │
│  Loudness range    Beat / tempo     Clarity /     │
│  Zero-crossing     Stereo image     harshness /   │
│  Spectral centroid Structural seg   warmth        │
│  Rolloff / BW                       Reference     │
│  Flatness / flux                    deltas        │
│  Band energies                                   │
│  MFCCs                                           │
└───────────────────────┬──────────────────────────┘
                        │ JSON descriptor bundle
                        ▼
┌──────────────────────────────────────────────────┐
│  rules.py — deterministic rule engine            │
│                                                  │
│  Issue detection → candidate actions             │
│  Confidence = evidence × reliability × context   │
│  Conflict resolution / action merging            │
└───────────────────────┬──────────────────────────┘
                        │ candidate actions
                        ▼
┌──────────────────────────────────────────────────┐
│  recommender.py — hybrid ranking                 │
│                                                  │
│  Rule candidates + LLM ranking/explanation       │
│  Calls /api/assistant/chat with descriptor       │
│  bundle (NOT raw audio)                          │
│  Returns decision cards:                         │
│    problem / evidence / action / alts / preview  │
└───────────────────────┬──────────────────────────┘
                        │ decision cards
                        ▼
┌──────────────────────────────────────────────────┐
│  stack_builder.py                                │
│                                                  │
│  Prioritized actions → ordered effect chain      │
│  Source-aware routing (vocal/bus/master/drums)    │
│  Construction order:                             │
│    1. Repair / cleanup                           │
│    2. Corrective tone                            │
│    3. Dynamics control                           │
│    4. Character / saturation                     │
│    5. Spatial / stereo                           │
│    6. Safety / loudness / output                 │
│  Multiple variant stacks:                        │
│    Transparent / Punchy / Loud / Reference       │
└───────────────────────┬──────────────────────────┘
                        │ tool chain + params
                        ▼
             Existing 49-tool backend
             (parametric_eq, multiband_dynamics,
              maximizer, stereo_imager, etc.)
```

## API Endpoints

### `POST /api/edit/analyzer/analyze`
Full descriptor extraction. Returns the complete descriptor bundle as JSON.

**Input:** `audio` (file upload)
**Output:**
```json
{
  "low_level": {
    "rms_db": -18.4,
    "peak_db": -1.2,
    "true_peak_dbtp": -0.8,
    "crest_factor_db": 17.2,
    "lufs_momentary": -16.1,
    "lufs_short_term": -17.3,
    "lufs_integrated": -18.4,
    "loudness_range_lu": 8.2,
    "zero_crossing_rate": 0.12,
    "spectral_centroid_hz": 2340,
    "spectral_rolloff_hz": 8200,
    "spectral_bandwidth_hz": 3100,
    "spectral_flatness": 0.23,
    "spectral_flux_mean": 0.45,
    "band_energies_db": { "sub": -28, "low": -14, "low_mid": -12, "mid": -15, "high_mid": -18, "high": -24, "air": -32 },
    "mfcc_mean": [12.3, -4.1, ...],
    "dc_offset": 0.001
  },
  "mid_level": {
    "onset_density_per_sec": 3.2,
    "transient_class": "moderate",
    "f0_hz": 220,
    "voicing_confidence": 0.85,
    "chroma": [0.8, 0.1, 0.05, ...],
    "key": "A minor",
    "key_confidence": 0.72,
    "tempo_bpm": 120,
    "tempo_confidence": 0.91,
    "beat_positions": [0.5, 1.0, 1.5, ...],
    "stereo_correlation": 0.65,
    "stereo_width": 0.78,
    "mid_side_ratio_db": -3.2
  },
  "high_level": {
    "source_type": "music",
    "source_confidence": 0.95,
    "instrument_priors": { "vocal": 0.7, "drums": 0.5, "bass": 0.4, "guitar": 0.3 },
    "artifact_flags": {
      "clipping": { "detected": true, "severity": 0.3, "locations_sec": [12.4, 45.1] },
      "hum": { "detected": false },
      "noise": { "detected": true, "severity": 0.15 },
      "sibilance": { "detected": true, "severity": 0.4, "center_hz": 7200 },
      "harshness": { "detected": true, "severity": 0.5, "center_hz": 3400 },
      "low_end_bloom": { "detected": false }
    },
    "perceptual": {
      "clarity": 0.6,
      "warmth": 0.4,
      "brightness": 0.7,
      "density": 0.5,
      "boxiness": 0.3
    }
  },
  "duration_sec": 180.5,
  "sample_rate": 44100,
  "channels": 2,
  "bit_depth": 24
}
```

### `POST /api/edit/analyzer/recommend`
Generate decision cards from the descriptor bundle.

**Input:** `audio` (file upload) + optional `target` JSON (platform, reference, intent)
**Output:**
```json
{
  "cards": [
    {
      "id": "harshness_chorus",
      "priority": 1,
      "confidence": 0.82,
      "problem": "High-mid harshness during chorus sections",
      "evidence": "3.4 dB energy excess centered near 3.4 kHz vs reference; vocal classification supports sibilance-adjacent harshness",
      "action": {
        "tool": "parametric_eq",
        "params": { "midFreq": 3400, "midGain": -2.5, "midQ": 2.0 },
        "description": "Dynamic EQ dip at 3.4 kHz, -2.5 dB, Q 2.0"
      },
      "alternatives": [
        { "tool": "harmonic_exciter", "description": "Reduce exciter drive in 2-5 kHz range" },
        { "tool": "multiband_dynamics", "description": "Compress high-mid band with faster release" }
      ],
      "confidence_breakdown": {
        "evidence_quality": 0.9,
        "detector_reliability": 0.85,
        "context_fit": 0.8,
        "consensus": 0.75
      }
    }
  ],
  "summary": "6 issues detected. Primary concerns: harshness, low-end excess, stereo instability.",
  "source_classification": { "type": "music", "subtype": "vocal_mix", "confidence": 0.92 }
}
```

### `POST /api/edit/analyzer/build-stack`
Convert accepted decision cards into an ordered effect chain.

**Input:** `cards` (JSON, the accepted/modified cards) + `variant` (transparent/punchy/loud/reference)
**Output:**
```json
{
  "variant": "transparent",
  "chain": [
    { "tool": "neural_denoise", "params": { "amount": 0.3 }, "stage": "repair" },
    { "tool": "parametric_eq", "params": { "midFreq": 3400, "midGain": -2.5, "midQ": 2.0 }, "stage": "corrective_tone" },
    { "tool": "multiband_dynamics", "params": { "lowThresh": -18, "lowRatio": 2.5 }, "stage": "dynamics" },
    { "tool": "stereo_imager", "params": { "width": 85 }, "stage": "spatial" },
    { "tool": "maximizer", "params": { "ceiling": -1, "targetLUFS": -14 }, "stage": "output" }
  ],
  "confidence": 0.78,
  "explanation": "Transparent variant: minimal corrective EQ, gentle dynamics, conservative loudness target."
}
```

## Files

```
modules/analyzer/
├── module.json          # Module manifest
├── router.py            # FastAPI endpoints: /analyze, /recommend, /build-stack
├── descriptors.py       # Full descriptor taxonomy extraction
├── rules.py             # Deterministic rule engine (issue → candidate actions)
├── recommender.py       # Hybrid ranking: rules + LLM explanation
├── stack_builder.py     # Action list → ordered tool chain
├── presets.py           # Reference profiles (genre targets, platform targets)
└── __init__.py
```

## Descriptor implementation map

| Descriptor | Library | Function | Cost |
|---|---|---|---|
| RMS / energy | numpy | `np.sqrt(np.mean(x**2))` | Low |
| Peak / true peak | numpy + FFmpeg ebur128 | `np.max(np.abs(x))` + loudnorm TP | Low |
| Crest factor | numpy | `peak / rms` | Low |
| LUFS (M/S/I) | pyloudnorm + FFmpeg ebur128 | `pyloudnorm.Meter` + loudnorm JSON | Medium |
| Loudness range | FFmpeg ebur128 | parse LRA from loudnorm output | Medium |
| Zero-crossing rate | librosa | `librosa.feature.zero_crossing_rate` | Low |
| Spectral centroid | librosa | `librosa.feature.spectral_centroid` | Low |
| Spectral rolloff | librosa | `librosa.feature.spectral_rolloff` | Low |
| Spectral bandwidth | librosa | `librosa.feature.spectral_bandwidth` | Low |
| Spectral flatness | librosa | `librosa.feature.spectral_flatness` | Low |
| Spectral flux | librosa | `librosa.onset.onset_strength` | Low |
| Band energies | numpy + scipy | bandpass + RMS per band | Low |
| MFCCs | librosa | `librosa.feature.mfcc` | Medium |
| Onset density | librosa | `librosa.onset.onset_detect` | Medium |
| F0 / voicing | librosa | `librosa.pyin` | Medium |
| Chroma / HPCP | librosa | `librosa.feature.chroma_cqt` | Medium |
| Key / mode | librosa + numpy | chroma → Krumhansl-Schmuckler | Medium |
| Beat / tempo | librosa | `librosa.beat.beat_track` | Medium |
| Stereo correlation | numpy | `np.corrcoef(L, R)` | Low |
| Stereo width | numpy | `rms(side) / rms(mid)` | Low |
| Structural segmentation | librosa | `librosa.segment.agglomerative` | High |
| Artifact: clipping | numpy | `np.sum(np.abs(x) > threshold)` | Low |
| Artifact: hum | scipy | FFT peak detection at 50/60Hz harmonics | Low |
| Artifact: noise | numpy + scipy | spectral flatness in quiet sections | Low |
| Artifact: sibilance | scipy | band energy spikes in 4-10kHz during voiced frames | Medium |
| Artifact: harshness | scipy | persistent 2-5kHz excess vs reference curve | Medium |

## Stack construction order

```
1. Repair / cleanup        → denoise, declip, dehum, declick, breath removal
2. Corrective tone         → parametric EQ, dynamic EQ, match EQ
3. Dynamics control        → multiband dynamics, transient shaper
4. Character / saturation  → exciter, character FX
5. Spatial / stereo        → stereo imager
6. Safety / loudness       → maximizer, smart export
```

## Stack variants

| Variant | Character | Loudness target | Dynamic range | Notes |
|---|---|---|---|---|
| Transparent | Minimal correction only | -16 LUFS | Wide (LRA 10+) | Fewest modules, highest confidence threshold |
| Punchy | Moderate dynamics, transient emphasis | -14 LUFS | Medium (LRA 7-9) | Adds transient shaper, tighter compression |
| Loud | Aggressive dynamics, maximized | -10 LUFS | Narrow (LRA 5-7) | Full chain, aggressive maximizer |
| Reference-matched | Match reference profile exactly | Per reference | Per reference | Uses match EQ + reference deltas |
| Low-latency | Skip offline-only tools | N/A | N/A | Only tools with Web Audio live preview |
