# Chimera — Tempo-Aligned Multi-Init Plan (v2, locked)

Date: 2026-05-24
Status: Approved, awaiting C1 kickoff
Owner: dtrujillostyle@gmail.com

## 1. What Chimera is

Chimera is an additive layer on top of the existing INIT slot in the Generate view. The user can stack multiple audio sources into the INIT field. When more than one source is loaded, a backend module (`/api/chimera/mashup`) detects each source's BPM, time-stretches each (pitch-preserved) to a target BPM, optionally aligns downbeats, and mixes everything into a single WAV that is then used as the init audio for generation.

Nothing existing is removed. The current single-file INIT flow, the existing client-side editor mixdown (`sendSelectionToInit` in `WaveformEditor.tsx`), and the existing Library/Editor right-click "Send to Init" actions all keep working exactly as they do today. Chimera is purely additive.

## 2. Locked decisions

| # | Decision | Detail |
|---|---|---|
| 3A | Backend module | `backend/modules/chimera/`, prefix `/api/chimera` |
| 3B | Per-clip "Noise" semantics | Slider 0.0–1.0, default 0.5. Mirrors the global Init Noise slider direction: higher = less influence. Implemented as `clip_gain = 1 - clip_noise` in the pre-mix, then the mix is RMS-normalized so total energy is stable as clips are added. |
| 3C | Default alignment | Downbeat-aligned. Also ships: `Start`, `Phrase Weave` (smart hybrid). |
| UI label | The slot stays called **INIT**. When the user drops or sends a second clip into it, a sub-affordance reading "**Drop more tracks here for a Chimera**" appears beneath the existing dropzone. |
| Editor preservation | `WaveformEditor.tsx` `sendSelectionToInit` is **not modified**. Its client-side OfflineAudioContext mixdown stays as-is. Chimera is an additional path the user can opt into by stacking clips in INIT. |
| Render trigger | **No auto-render. No preview render. No "Re-render" button.** The Chimera mashup is computed exactly once, server-side, at the moment the user clicks **CREATE** (the generate button). The mashup result is sent into the same generate POST as `init_audio`. |
| Phrase Weave bar count | Default 16 bars, capped at 16, floored at 4 |
| Documentation | This file. |

## 3. The INIT field — UX shape after Chimera lands

The INIT Section keeps its current shape for the first clip. Once anything is loaded, the field expands to reveal a Chimera stack zone:

```
┌─ INIT SIGNAL / CONDITIONING ─────────────────────────────────┐
│  [ existing dashed dropzone — single file behavior unchanged ]│
│  Loaded: file.wav                                  [x]        │
│  [ existing <audio controls> preview ]                        │
│                                                               │
│  ── Chimera stack (only shown when at least one clip loaded)──│
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ● kick_loop.wav   124 BPM   ×1.00   Noise [—■——] Base● │  │
│  │ ● synth_pad.wav   no beat   ×—      Noise [—■——] Base○ │  │
│  │ ● vocal_chop.wav  118 BPM   ×1.05   Noise [—■——] Base○ │  │
│  └────────────────────────────────────────────────────────┘  │
│  [ Drop more tracks here for a Chimera                     ] │
│                                                               │
│  Target BPM: [124 ] (Auto)   Align: [Downbeat ▾]              │
└───────────────────────────────────────────────────────────────┘
```

Rules:

- The first clip uses the existing single-file flow. When a second clip is added, the second clip is the first row of the Chimera stack.
- Adding more clips appends rows. Each row shows: color swatch, label, detected BPM (or "—" / "no beat"), stretch ratio (after target BPM resolved), per-clip **Noise** slider, **Base** radio toggle, remove ✕.
- The dashed "Drop more tracks here for a Chimera" affordance is always present at the bottom of the stack while in stack mode.
- Target BPM defaults to "Auto" (median of detected BPMs).
- Setting **Base** on a row pins target BPM to that row's detected BPM and clears Auto; the BPM number input reflects this and is editable (which clears Base).
- Align mode dropdown: `Start` | `Downbeat` (default) | `Phrase Weave`.
- No re-render button. No mid-stack audio preview. Nothing is rendered until CREATE.

## 4. Send-to-Chimera surfaces

Three surfaces send into the INIT field. All go through one shared client helper `addBlobsToChimera(items)`:

| Surface | Trigger | Behavior |
|---|---|---|
| Library | Right-click on multi-selection → "Send selected to INIT" | Existing single-file fast-path still works for 1 entry; for N>1 entries every entry is pushed into the Chimera stack. |
| Editor | Right-click on multi-selection (existing menu) | **No change** to existing "Send Selection to Init" (client mixdown). **Add** a second menu entry "Send Selection to INIT (stacked)" that pushes each clip individually into the stack so the user can opt into Chimera. |
| Media Bucket | Add multi-select state (single / Ctrl-toggle / Shift-range matching Library). Add right-click context menu with "Send Selected to INIT". | New surface. |
| Direct DnD | Drop OS files or drag rows from Library / Media Bucket / Editor onto the "Drop more tracks here for a Chimera" affordance | Each dropped item becomes a stack row. |

## 5. Per-clip Noise — exact semantics

- UI: slider 0.0–1.0, default 0.5. Tooltip: "Noise: how much this clip's identity dissolves into the mix. Higher = less influence, same direction as the global Init Noise slider."
- Backend: when building the pre-mix, each clip's stretched signal is multiplied by `(1 - clip_noise)`. After summing, the mix is loudness-normalized to a fixed target RMS so adding more clips at noise=0.5 doesn't quietly attenuate the output.
- The existing global Init Noise slider keeps doing exactly what it does today (sets `sigma_max` at sample time on the final mashed mix).
- Two knobs, two stages, same mental model on each.

## 6. Align modes

### Start
All stretched clips placed at t=0. No beat-based shift. Useful for ambient layering where beat phase doesn't matter.

### Downbeat (default)
Each stretched clip is shifted so its first detected downbeat lands at t=0. Audio before that beat is discarded. After alignment, every clip's bar grid starts in phase.

### Phrase Weave (smart hybrid)
1. Stretch all clips to target BPM.
2. Detect onsets + downbeats on the stretched audio.
3. Window length in bars = `min(stretched_duration_in_bars across clips)`, clamped to [4, 16]. Default cap 16.
4. For each clip, pick the highest-energy bar-aligned window of that length (RMS over candidates).
5. Place all windows at t=0. Bar grids align by construction; each clip contributes its musical "meat" instead of an intro or a tail.

## 7. Render trigger — locked

There is **one** Chimera render per generation, and it happens server-side as part of the CREATE flow.

Sequence when CREATE is pressed:

```
Frontend (CREATE handler)
  ├─ If 0 or 1 items in stack: skip Chimera, use initAudioFile as today.
  └─ If ≥2 items in stack:
       1. POST /api/chimera/mashup with all stack blobs, weights, target BPM, base index, align mode.
       2. Receive the mixdown WAV + per-clip metadata.
       3. Replace initAudioFile with the mixdown WAV.
       4. Continue into the existing /api/generate-jobs POST exactly as today.
```

If the Chimera POST fails (toolchain missing, server error, timeout), generation is aborted with an explicit error toast. No silent fallback to the first clip — that would mask a problem the user needs to know about.

## 8. Backend module spec — `backend/modules/chimera/`

```
backend/modules/chimera/
  module.json           { "name": "chimera", "enabled": true,
                          "api_prefix": "/api/chimera", "backend": true }
  router.py             /probe, /mashup
  detect.py             aubio CLI wrappers — BPM + beat positions
  stretch.py            ffmpeg rubberband (fallback: atempo + warning)
  weave.py              Phrase Weave windowing
  mix.py                Per-clip gain, sum, RMS normalize, encode WAV
  config.py             Toolchain probe (cached at module load)
```

### Endpoints

`GET /api/chimera/probe` — returns `{ aubio, ffmpeg, librubberband, versions, install_hint }`. Cheap, used by Settings indicator.

`POST /api/chimera/mashup` — multipart:
- `files: file_0..file_{N-1}` (audio/*)
- `target_bpm`: float or `"auto"`
- `base_index`: int or null (overrides target_bpm)
- `weights`: JSON array of floats (each = `1 - clip_noise`)
- `align_mode`: `"start" | "downbeat" | "weave"`
- `out_sr`: int (default 44100)
- `weave_bars`: int (default 0 = auto)

Pipeline: save uploads to request-scoped tempdir → aubio BPM + beats per clip → resolve target BPM (base_index → target_bpm → median → 120 fallback) → ffmpeg stretch (clamp ratio to [0.5, 2.0]) → align per mode → weighted sum → RMS normalize → encode WAV.

Response JSON:
```
{
  mix_base64, mime, sample_rate, duration_sec,
  target_bpm_used, target_bpm_source: "user" | "base_clip" | "median" | "fallback",
  align_mode_used,
  per_clip: [{
    index, label, detected_bpm,
    beats: [seconds...],
    stretch_ratio, stretched_duration_sec,
    window_start_sec, window_end_sec,
    weight_used,
    note: string | null
  }],
  warnings: [string]
}
```

## 9. Frontend changes

### 9A. State (`generateParamsStore.ts`)

Add `chimera` slice:
```
chimera: {
  clips: Array<{
    id: string,
    blob: Blob,
    mimeType: string,
    label: string,
    detectedBpm?: number | null,
    stretchRatio?: number,
    noise: number,    // 0..1, default 0.5
    isBase: boolean,
  }>,
  targetBpm:  number | 'auto',
  alignMode:  'start' | 'downbeat' | 'weave',
  weaveBars:  number,         // 0 = auto
  lastMeta:   null | response_subset_for_display,
}
```

`initAudioFile` continues to be the single source of truth for what gets uploaded to `/api/generate`. The Chimera POST happens inside the CREATE handler and overwrites `initAudioFile` for the in-flight request.

### 9B. New files

- `frontend/src/lib/chimeraClient.ts` — `addBlobsToChimera`, `renderChimeraOnce`, helpers. Called by every send surface and by the CREATE handler.
- `frontend/src/components/chimera/ChimeraStack.tsx` — the stack UI (rows + drop affordance + Base radio + Noise sliders).
- `frontend/src/components/chimera/ChimeraControls.tsx` — Target BPM input, Align mode dropdown, Weave bars (when mode=weave).

### 9C. Modified files

- `frontend/src/views/GenerateView.tsx` — render `ChimeraStack` + `ChimeraControls` inside the existing INIT Section, below the current dropzone.
- `frontend/src/state/generateStore.ts` — CREATE handler: branch on `chimera.clips.length`; call `renderChimeraOnce()` before submitting `/api/generate-jobs` when stack ≥ 2.
- `frontend/src/views/LibraryView.tsx` — multi-select Send to INIT pushes all selected entries into the Chimera stack.
- `frontend/src/components/layout/MediaBucketView.tsx` — add multi-select state, right-click context menu, "Send Selected to INIT" → `addBlobsToChimera`.
- `frontend/src/components/audio/WaveformEditor.tsx` — **add** a second context-menu entry "Send Selection to INIT (stacked)" that calls `addBlobsToChimera`. **Do not modify** the existing `sendSelectionToInit`.

### 9D. Drag-drop

`ChimeraStack` accepts:
- OS file drops.
- Internal drops from Library rows, Bucket rows, Editor clip drag-source via a session-scoped blob registry referenced by `application/x-stabledaw-audio-ref` JSON envelope.

### 9E. Settings modal

Small additive row: `Chimera toolchain: ● aubio ● ffmpeg ● librubberband`. Click "Install help" → docs section. Driven by `/api/chimera/probe`.

## 10. Edge cases

| Case | Handling |
|---|---|
| Clip with no detected beats | `detected_bpm = null`, ratio=1.0, included as-is, cannot be Base (toggle disabled). |
| All clips have no beats | `target_bpm_source = "fallback"`, target=120, big UI warning. |
| Target BPM = 0 / empty | Treated as Auto. |
| Stretch ratio out of [0.5, 2.0] | Clamped, per-clip `note` returned, UI warning icon. |
| Mixed sample rates / channels | Backend pre-normalizes to 44.1k stereo. |
| Hours-long clip | Phrase Weave windows it. Start/Downbeat modes truncate to max-clip-duration, hard cap 60s. |
| Backend module disabled | Stack UI hides; INIT field reverts to single-file. Multi-select sends fall back to single-file (first selected). |
| ffmpeg without librubberband | atempo fallback, per-clip warning, mashup still works. |
| Chimera POST fails at CREATE | Generation aborted with explicit toast. No silent fallback. |

## 11. Dependencies

- aubio (CLI binary or pip wheel; module probes both at load).
- ffmpeg with `--enable-librubberband`.
- Windows install hint: `ffmpeg-release-full` from gyan.dev (ships librubberband).
- macOS: `brew install ffmpeg aubio`.
- Linux: usually needs static ffmpeg build from BtbN or conda-forge; aubio via apt or pip.
- `docs/windows/setup-guide.md` gets a "Chimera prerequisites" section.

## 12. Chunked rollout

| Chunk | Scope | Validation gate |
|---|---|---|
| C1 | Backend skeleton: `module.json`, `router.py`, `/probe` only | curl returns toolchain status |
| C2 | `detect.py` — aubio BPM + beats with unit tests | pytest on a known 120 BPM stem |
| C3 | `stretch.py` — rubberband + atempo fallback, unit tests | pytest measures output duration ≈ expected |
| C4 | `mix.py` + `/mashup` end-to-end, Start mode only | curl with two stems, listen |
| C5 | Frontend: `chimeraClient.ts`, `chimera` slice, `ChimeraStack` + `ChimeraControls` UI (no Base yet, mode=start fixed) | Drop OS files, see stack, click CREATE, hear result |
| C6 | Base radio + Target BPM input + per-clip Noise sliders | Manual UI test |
| C7 | Downbeat align mode (backend + UI option) | A/B listen vs. Start |
| C8 | Library multi-select Send to INIT routes ≥2 entries into stack | Manual UI test |
| C9 | Editor right-click adds "Send Selection to INIT (stacked)" alongside existing entry | Manual UI test, confirm existing entry untouched |
| C10 | Media Bucket multi-select + right-click Send to INIT | Manual UI test |
| C11 | Internal drag-drop registry (Library / Bucket / Editor → ChimeraStack) | Manual UI test |
| C12 | Phrase Weave mode (backend `weave.py` + UI toggle + `weave_bars`) | A/B listen vs. Downbeat |
| C13 | Settings modal probe indicator + docs update | Visual + docs review |

C1–C7 is MVP. C8–C11 closes "all three send surfaces + DnD." C12–C13 are polish.

## 13. Open questions deferred

These are flagged here so they don't get lost; none block C1.

- Should the Chimera stack also visualize beat markers on the per-row mini-waveform after CREATE returns metadata? (Nice-to-have, can fold into C13.)
- Should the auto-saved library entry tag itself with `source: "chimera"` and store the per-clip metadata for later inspection? (Recommend yes; cheap addition during C5.)
- Per-clip swap order / drag-reorder inside the stack? (Defer until users ask.)
