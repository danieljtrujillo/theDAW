# Levels — loudness and metering

The **Levels** tab is the first tab of the lower panel (the meter-gauge icon). It
shows master metering of whatever is currently audible — it taps the shared
master output, so it reflects playback on any tab (MAKE, EDIT, DJ, the Sequencer,
and so on), not just one workspace.

## The views

A row of round buttons switches between six views; the choice, the LUFS target,
and the true-peak ceiling are remembered across restarts.

- **Radial** — the combined circular readout, with spokes for Peak, LUFS, LRA,
  Dynamic Range, Stereo Field, and Bass, and the integrated LUFS in the center.
- **LUFS** — momentary (400 ms), short-term (3 s), and gated integrated loudness
  as bars, with a target line and the loudness range (LRA). Bars turn green near
  the target, amber when quiet, red when over.
- **Peak** — sample peak, true peak (oversampled), and RMS bars, with a ceiling
  line and a live headroom readout.
- **Dynamic Range** — the crest factor (peak minus RMS) as a big number plus a
  scrolling ribbon.
- **Stereo Field** — a goniometer/vectorscope (rotated so mono reads vertical)
  and a correlation strip (+1 = mono-compatible, negative = out of phase).
- **Bass Space** — per-band level at 40 / 80 / 120 / 160 Hz for low-end balance.

## How it works

Loudness is measured to ITU-R BS.1770-4 (K-weighting with the high-shelf
pre-filter + RLB high-pass, gated integrated loudness), true peak is 4x
oversampled, and the DSP runs in one audio worklet fanned non-destructively off
the master — it observes the signal without changing it. If the browser has no
AudioWorklet, the tab falls back to RMS/peak only (the LUFS fields read "—") and
shows an "RMS only" note.

## Targets

The LUFS view offers quick target presets: **-14** (streaming), **-16**, and
**-23** (broadcast). The target line and the color coding follow the selected
value.

## Notes

- Metering starts when the Levels tab is open and stops when you leave it, so the
  integrated LUFS reading restarts each time you open the tab.
- Per-track lane meters and automation-mode controls are planned as a later
  addition; today the tab meters the master output.
