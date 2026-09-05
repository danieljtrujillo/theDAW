"""Render a :class:`Schedule` plus conformed run audio into the un-mastered
stereo OUTPUT timeline (Chimera v2 engine only).

Responsibilities, in order, per run:

* pick the :class:`RunAudio` buffer(s) that match the run's role
  (``full`` for ``full``/``hp`` roles, ``found`` + ``layer`` for a lead with
  stems, ``layer`` only for a support with stems);
* slice the AUDIBLE span ``[output_start - fade_in, output_end + fade_out]``
  out of the run audio via ``t0_sec`` (OUTPUT seconds);
* loudness-normalise the run to its lane target (measured on the NOMINAL
  window only) with the user weight folded in and a +/- 12 dB clamp;
* apply the head / tail envelopes.  Leads at a ``blend`` seam are split at
  ``XOVER_HZ``: the high band gets the L-bar equal-power fade, the low band a
  hard 1-beat "bass swap" centred on the line (with a polarity check against
  the outgoing lead's low band); every other edge is a full-band
  equal-power fade, or a 10 ms guard when there is no tail;
* supports are high-passed (role ``hp``) and ducked by the already-placed
  lead buffer's < 150 Hz envelope.

Contiguous phrases inside one run are untouched samples: no fade, no seam.
The result is truncated to ``total_sec``; master.py handles the timeline
edges.

Timebases: every ``*_sec`` here is OUTPUT seconds unless the name says
otherwise. numpy + scipy.signal + pyloudnorm only; no I/O.
"""

from __future__ import annotations

import logging
import math
from typing import Literal, Optional, TypedDict

import numpy as np
from scipy import signal

from .types import Run, RunAudio, Schedule, Seam

log = logging.getLogger(__name__)


LEAD_LUFS = -16.0
SUPPORT_LUFS = -22.0
GAIN_CLAMP_DB = 12.0
HP_HZ = 150.0
XOVER_HZ = 120.0
DUCK_DEPTH_DB = 3.0

# Click guard applied to a run edge that has no transition tail.
GUARD_SEC = 0.010
# Normalised zero-lag correlation below which the incoming low band is inverted.
POLARITY_THRESHOLD = -0.2
# A run edge within this distance of a seam line belongs to that seam.
SEAM_TOL_SEC = 0.01
# pyloudnorm needs strictly more than one 400 ms block.
MIN_LUFS_SEC = 0.4
# sosfiltfilt padding needs a handful of samples; below this we skip filtering.
_MIN_FILTER_LEN = 64
# Floor for the RMS fallback in measure_lufs (keeps JSON-serialisable floats).
_RMS_FLOOR = 1e-5

BandKind = Literal["hp", "lp"]


class RenderResult(TypedDict):
    audio: np.ndarray  # [N, 2] float32, OUTPUT timeline, exactly total_sec long
    lane_lufs: dict[str, float]  # integrated LUFS of the lead / support buses
    run_gains_db: dict[int, float]  # run_id -> gain applied (dB)
    seams_rendered: int  # seams that shaped at least one run edge
    warnings: list[str]


# --------------------------------------------------------------------------
# primitives
# --------------------------------------------------------------------------


def lr4_sos(fc: float, sr: int, kind: BandKind) -> np.ndarray:
    """Second-order Butterworth SOS; applied zero-phase twice it is an LR4."""
    btype = {"hp": "highpass", "lp": "lowpass"}[kind]
    fc = float(min(max(fc, 1.0), 0.45 * sr))
    return signal.butter(2, fc, btype=btype, fs=sr, output="sos")


def lr4(x: np.ndarray, sr: int, fc: float, kind: BandKind) -> np.ndarray:
    """Zero-phase Linkwitz-Riley 4th order filter along axis 0 (float32 out)."""
    arr = np.asarray(x, dtype=np.float32)
    if arr.shape[0] < _MIN_FILTER_LEN:
        return arr.copy() if kind == "lp" else np.zeros_like(arr)
    y = signal.sosfiltfilt(lr4_sos(fc, sr, kind), arr, axis=0)
    return np.ascontiguousarray(y, dtype=np.float32)


def split_bands(x: np.ndarray, sr: int, fc: float) -> tuple[np.ndarray, np.ndarray]:
    """``(low, high)`` with ``low + high == x`` exactly (high = x - LR4 lowpass;
    the zero-phase LR4 pair sums to unity so this is also the LR4 highpass)."""
    arr = np.asarray(x, dtype=np.float32)
    low = lr4(arr, sr, fc, "lp")
    return low, arr - low


def equal_power(n: int, direction: Literal["in", "out"]) -> np.ndarray:
    """sin / cos quarter-wave envelope of ``n`` samples (float32)."""
    n = int(n)
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    u = (np.arange(n, dtype=np.float64) + 0.5) / n
    env = np.sin(0.5 * math.pi * u) if direction == "in" else np.cos(0.5 * math.pi * u)
    return env.astype(np.float32)


_meters: dict[int, object] = {}


def measure_lufs(x: np.ndarray, sr: int) -> float:
    """Integrated loudness (pyloudnorm) of a mono or [N, C] buffer; falls back
    to ``20 log10(rms) - 3`` when the buffer is < 0.4 s or gated to -inf."""
    a = np.asarray(x, dtype=np.float64)
    if a.ndim == 1:
        a = a[:, None]
    if a.shape[0] > int(MIN_LUFS_SEC * sr):
        try:
            import pyloudnorm as pyln

            meter = _meters.get(int(sr))
            if meter is None:
                meter = pyln.Meter(int(sr))
                _meters[int(sr)] = meter
            v = float(meter.integrated_loudness(a))  # type: ignore[attr-defined]
            if math.isfinite(v):
                return v
        except Exception as e:  # pragma: no cover - defensive
            log.debug("pyloudnorm failed, using RMS fallback: %s", e)
    rms = float(np.sqrt(np.mean(a * a))) if a.size else 0.0
    return 20.0 * math.log10(max(rms, _RMS_FLOOR)) - 3.0


def run_gain_db(measured: float, lane: str, weight: float = 1.0) -> float:
    """Gain (dB) that brings ``measured`` LUFS to the lane target, with the
    user weight folded in and clamped to +/- ``GAIN_CLAMP_DB``."""
    target = LEAD_LUFS if lane == "lead" else SUPPORT_LUFS
    g = target - float(measured) + 20.0 * math.log10(max(0.05, float(weight)))
    return float(max(-GAIN_CLAMP_DB, min(GAIN_CLAMP_DB, g)))


def _one_pole(x: np.ndarray, tau_samples: float) -> np.ndarray:
    a = 1.0 - math.exp(-1.0 / max(tau_samples, 1e-9))
    return signal.lfilter([a], [1.0, -(1.0 - a)], x)


def _hold_release(x: np.ndarray, tau_samples: float) -> np.ndarray:
    """Peak hold with exponential release: ``y[n] = max_k x[n-k] * e^{-k/tau}``,
    vectorised in the log domain (``x >= 0``)."""
    if x.size == 0:
        return x.astype(np.float64)
    c = 1.0 / max(tau_samples, 1e-9)
    n = np.arange(x.size, dtype=np.float64)
    held = np.maximum.accumulate(np.log(x + 1e-12) + c * n) - c * n
    return np.exp(held)


def envelope_low_band(
    x: np.ndarray,
    sr: int,
    fc: float = HP_HZ,
    attack_ms: float = 2.0,
    release_ms: float = 120.0,
) -> np.ndarray:
    """Envelope of the < ``fc`` band: rectified LR4 lowpass -> one-pole attack
    smoothing -> peak hold with exponential release (two passes, asymmetric)."""
    low = lr4(x, sr, fc, "lp")
    mono = low.mean(axis=1) if low.ndim == 2 else low
    rect = np.abs(mono.astype(np.float64))
    if rect.size == 0:
        return np.zeros(0, dtype=np.float32)
    fast = _one_pole(rect, attack_ms * 1e-3 * sr)
    env = _hold_release(np.maximum(fast, 0.0), release_ms * 1e-3 * sr)
    return env.astype(np.float32)


def duck(
    layer: np.ndarray, sidechain_env: np.ndarray, depth_db: float = DUCK_DEPTH_DB
) -> np.ndarray:
    """Attenuate ``layer`` by up to ``depth_db`` where the sidechain envelope
    peaks (``gain = 10 ** (-depth/20 * env / max(env))``)."""
    out = np.array(layer, dtype=np.float32, copy=True)
    env = np.asarray(sidechain_env, dtype=np.float64)
    if env.size == 0 or out.size == 0 or depth_db <= 0:
        return out
    peak = float(env.max())
    if peak <= 0.0:
        return out
    n = min(out.shape[0], env.size)
    gain = (10.0 ** (-(depth_db / 20.0) * (env[:n] / peak))).astype(np.float32)
    if out.ndim == 2:
        out[:n] *= gain[:, None]
    else:
        out[:n] *= gain
    return out


def polarity_flip_needed(out_low: np.ndarray, in_low: np.ndarray) -> bool:
    """True when the zero-lag normalised correlation of the two low bands over
    their overlap is below ``POLARITY_THRESHOLD``."""
    a = np.asarray(out_low, dtype=np.float64)
    b = np.asarray(in_low, dtype=np.float64)
    if a.ndim == 2:
        a = a.mean(axis=1)
    if b.ndim == 2:
        b = b.mean(axis=1)
    n = min(a.size, b.size)
    if n == 0:
        return False
    a, b = a[:n], b[:n]
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na < 1e-6 or nb < 1e-6:
        return False
    return float(np.dot(a, b) / (na * nb)) < POLARITY_THRESHOLD


# --------------------------------------------------------------------------
# timeline rendering
# --------------------------------------------------------------------------


def _as_stereo(audio: np.ndarray) -> np.ndarray:
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 1:
        arr = np.stack([arr, arr], axis=1)
    elif arr.shape[1] == 1:
        arr = np.repeat(arr, 2, axis=1)
    elif arr.shape[1] > 2:
        arr = arr[:, :2]
    return np.ascontiguousarray(arr)


def _select_run_audio(
    run: Run, candidates: list[RunAudio], warnings: list[str]
) -> tuple[list[RunAudio], str]:
    """Pick the buffers a run is rendered from and the effective role.

    ``full``/``hp`` roles want the ``full`` buffer; a lead with a stem role
    wants ``found`` + ``layer``; a support with a stem role wants ``layer``.
    When the preferred kinds are missing the other family is used and the
    role degrades (``stem_layer`` support without stems -> ``hp``)."""
    by_kind: dict[str, list[RunAudio]] = {}
    for ra in candidates:
        by_kind.setdefault(str(ra.get("kind", "full")), []).append(ra)
    role = str(run["role"])
    lane = str(run["lane"])
    rid = run["run_id"]
    stem_role = role in ("stem_found", "stem_layer")
    if not stem_role:
        if by_kind.get("full"):
            return by_kind["full"][:1], role
        stems = by_kind.get("found", []) + by_kind.get("layer", [])
        if stems:
            warnings.append(f"run {rid}: no full-mix audio; summing stem buffers")
            return stems, role
        return [], role
    if lane == "lead":
        stems = by_kind.get("found", []) + by_kind.get("layer", [])
        if stems:
            return stems, role
    else:
        if by_kind.get("layer"):
            return by_kind["layer"][:1], role
    if by_kind.get("full"):
        warnings.append(
            f"run {rid}: stems unavailable for role {role!r}; using the full mix"
        )
        return by_kind["full"][:1], ("full" if lane == "lead" else "hp")
    stems = by_kind.get("found", []) + by_kind.get("layer", [])
    return stems, role


def _seam_at(seams: list[Seam], t: float) -> tuple[Optional[Seam], int]:
    for idx, seam in enumerate(seams):
        if seam.get("kind") not in ("lead_switch", "drop"):
            continue
        if abs(float(seam["sec"]) - t) <= SEAM_TOL_SEC:
            return seam, idx
    return None, -1


def _fade_head(x: np.ndarray, n_fade: int, guard: bool, sr: int) -> None:
    n = x.shape[0]
    if n_fade > 0:
        k = min(n_fade, n)
        x[:k] *= equal_power(n_fade, "in")[:k, None]
    elif guard:
        k = min(int(round(GUARD_SEC * sr)), n)
        if k > 0:
            x[:k] *= np.linspace(0.0, 1.0, k, dtype=np.float32)[:, None]


def _fade_tail(x: np.ndarray, n_fade: int, guard: bool, sr: int) -> None:
    n = x.shape[0]
    if n_fade > 0:
        k = min(n_fade, n)
        x[n - k :] *= equal_power(n_fade, "out")[n_fade - k :, None]
    elif guard:
        k = min(int(round(GUARD_SEC * sr)), n)
        if k > 0:
            x[n - k :] *= np.linspace(1.0, 0.0, k, dtype=np.float32)[:, None]


def _band_switch(
    low: np.ndarray, centre: int, n_beat: int, direction: Literal["in", "out"]
) -> tuple[int, int]:
    """Hard bass swap: a 1-beat equal-power fade centred on ``centre`` with
    the band silenced on the far side. Returns the fade window ``(c0, c1)``."""
    n = low.shape[0]
    n_beat = max(1, int(n_beat))
    c0 = max(0, min(n, centre - n_beat // 2))
    c1 = max(c0, min(n, c0 + n_beat))
    env = equal_power(n_beat, direction)[: c1 - c0, None]
    if direction == "in":
        low[:c0] = 0.0
        low[c0:c1] *= env
    else:
        low[c0:c1] *= env
        low[c1:] = 0.0
    return c0, c1


def render_timeline(
    sched: Schedule,
    run_audio: dict[int, list[RunAudio]],
    sr: int,
    clip_weights: Optional[dict[int, float]] = None,
) -> RenderResult:
    """Mix every run of ``sched`` into one stereo buffer at ``sr``.

    ``run_audio`` maps ``run_id`` to the conformed buffers for that run (one
    ``full`` buffer, or ``found`` / ``layer`` stems). ``clip_weights`` maps
    clip index to the user weight (linear, default 1.0); ``Run.gain_db`` is
    added on top as an extra offset. Leads are placed first (in output
    order) so supports can be ducked against the finished lead bus.
    """
    sr = int(sr)
    total_sec = float(sched["total_sec"])
    bar_sec = float(sched["bar_sec"])
    beat_sec = float(sched["beat_sec"])
    n_total = max(0, int(round(total_sec * sr)))
    n_buf = int(math.ceil((total_sec + max(bar_sec, 0.0)) * sr)) + 1
    n_beat = max(1, int(round(beat_sec * sr)))

    lead_buf = np.zeros((n_buf, 2), dtype=np.float32)
    support_buf = np.zeros((n_buf, 2), dtype=np.float32)
    lead_low_buf = np.zeros((n_buf, 2), dtype=np.float32)
    warnings: list[str] = []
    run_gains: dict[int, float] = {}
    seams_hit: set[int] = set()
    seams = list(sched.get("seams", []))
    weights = clip_weights or {}

    runs = sorted(
        sched["runs"],
        key=lambda r: (
            0 if r["lane"] == "lead" else 1,
            float(r["output_start_sec"]),
            int(r["run_id"]),
        ),
    )

    for run in runs:
        rid = int(run["run_id"])
        lane = str(run["lane"])
        buffers, role = _select_run_audio(run, run_audio.get(rid, []), warnings)
        if not buffers:
            warnings.append(f"run {rid} (clip {run['clip']}): no audio; skipped")
            continue

        out_start = float(run["output_start_sec"])
        out_end = float(run["output_end_sec"])
        fade_in = max(0.0, float(run.get("fade_in_sec", 0.0)))
        fade_out = max(0.0, float(run.get("fade_out_sec", 0.0)))
        aud_start = max(0.0, out_start - fade_in)
        aud_end = out_end + fade_out
        fade_in = out_start - aud_start

        # ---- slice every buffer to the audible span -----------------------
        segs: list[np.ndarray] = []
        seg_p0: list[int] = []
        seg_fade_in: list[float] = []
        seg_fade_out: list[float] = []
        nominal: list[np.ndarray] = []
        for ra in buffers:
            audio = _as_stereo(ra["audio"])
            t0 = float(ra["t0_sec"])
            s0 = int(round((aud_start - t0) * sr))
            s1 = int(round((aud_end - t0) * sr))
            s0c = max(0, min(audio.shape[0], s0))
            s1c = max(0, min(audio.shape[0], s1))
            if s1c <= s0c:
                warnings.append(
                    f"run {rid} (clip {run['clip']}): {ra.get('kind', 'full')} "
                    "buffer does not cover its span; skipped"
                )
                continue
            fi = fade_in - max(0, s0c - s0) / sr
            fo = fade_out - max(0, s1 - s1c) / sr
            if fi < fade_in - 1e-9 or fo < fade_out - 1e-9:
                warnings.append(
                    f"run {rid} (clip {run['clip']}): transition tail clamped "
                    "to the available audio"
                )
            seg = np.array(audio[s0c:s1c], dtype=np.float32, copy=True)
            n0 = max(0, min(seg.shape[0], int(round((out_start - t0) * sr)) - s0c))
            n1 = max(n0, min(seg.shape[0], int(round((out_end - t0) * sr)) - s0c))
            segs.append(seg)
            seg_p0.append(int(round((t0 + s0c / sr) * sr)))
            seg_fade_in.append(max(0.0, fi))
            seg_fade_out.append(max(0.0, fo))
            nominal.append(seg[n0:n1] if n1 > n0 else seg)
        if not segs:
            continue

        # ---- one gain per run, measured on the summed nominal window --------
        n_nom = max(x.shape[0] for x in nominal)
        nom_sum = np.zeros((n_nom, 2), dtype=np.float32)
        for x in nominal:
            nom_sum[: x.shape[0]] += x
        measured = measure_lufs(nom_sum, sr)
        g_db = run_gain_db(measured, lane, float(weights.get(int(run["clip"]), 1.0)))
        g_db += float(run.get("gain_db", 0.0) or 0.0)
        run_gains[rid] = g_db
        g_lin = np.float32(10.0 ** (g_db / 20.0))

        head_seam, head_idx = (
            _seam_at(seams, out_start) if lane == "lead" else (None, -1)
        )
        tail_seam, tail_idx = _seam_at(seams, out_end) if lane == "lead" else (None, -1)

        for seg, p0, fi, fo in zip(segs, seg_p0, seg_fade_in, seg_fade_out):
            seg *= g_lin
            if role == "hp":
                seg = lr4(seg, sr, HP_HZ, "hp")
            n_fi = int(round(fi * sr))
            n_fo = int(round(fo * sr))
            head_guard = p0 > 0
            tail_guard = (p0 + seg.shape[0]) < n_total - 1
            line_head = n_fi  # index of the nominal start inside seg
            line_tail = seg.shape[0] - n_fo  # index of the nominal end
            head_blend = (
                head_seam is not None
                and head_seam.get("transition") == "blend"
                and n_fi > 0
            )
            tail_blend = (
                tail_seam is not None
                and tail_seam.get("transition") == "blend"
                and n_fo > 0
            )
            placed_low: Optional[np.ndarray] = None

            if lane == "lead" and (head_blend or tail_blend):
                low, high = split_bands(seg, sr, XOVER_HZ)
                if head_blend:
                    seams_hit.add(head_idx)
                    _fade_head(high, n_fi, head_guard, sr)
                    c0, c1 = _band_switch(low, line_head, n_beat, "in")
                    out_low = lead_low_buf[p0 + c0 : p0 + c1]
                    if polarity_flip_needed(out_low, low[c0:c1]):
                        low *= -1.0
                        high *= -1.0
                        warnings.append(
                            f"run {rid} (clip {run['clip']}): polarity inverted "
                            f"at {out_start:.2f}s to match the outgoing lead"
                        )
                else:
                    _fade_head(high, n_fi, head_guard, sr)
                    _fade_head(low, n_fi, head_guard, sr)
                if tail_blend:
                    seams_hit.add(tail_idx)
                    _fade_tail(high, n_fo, tail_guard, sr)
                    _band_switch(low, line_tail, n_beat, "out")
                else:
                    _fade_tail(high, n_fo, tail_guard, sr)
                    _fade_tail(low, n_fo, tail_guard, sr)
                seg = low + high
                placed_low = low
            else:
                if head_seam is not None and n_fi > 0:
                    seams_hit.add(head_idx)
                if tail_seam is not None and n_fo > 0:
                    seams_hit.add(tail_idx)
                _fade_head(seg, n_fi, head_guard, sr)
                _fade_tail(seg, n_fo, tail_guard, sr)

            # ---- place ------------------------------------------------------
            q0 = max(0, p0)
            skip = q0 - p0
            q1 = min(n_buf, p0 + seg.shape[0])
            if q1 <= q0:
                continue
            chunk = seg[skip : skip + (q1 - q0)]
            if lane == "lead":
                lead_buf[q0:q1] += chunk
                if placed_low is not None:
                    lead_low_buf[q0:q1] += placed_low[skip : skip + (q1 - q0)]
            else:
                lead_span = lead_buf[q0:q1]
                if float(np.max(np.abs(lead_span))) > 0.0:
                    env = envelope_low_band(lead_span, sr, HP_HZ)
                    chunk = duck(chunk, env, DUCK_DEPTH_DB)
                support_buf[q0:q1] += chunk

    out = np.ascontiguousarray((lead_buf + support_buf)[:n_total], dtype=np.float32)
    lane_lufs = {
        "lead": measure_lufs(lead_buf[:n_total], sr),
        "support": measure_lufs(support_buf[:n_total], sr),
    }
    log.info(
        "render_timeline: %d runs, %d seams shaped, %.2fs, lead %.1f LUFS, "
        "support %.1f LUFS",
        len(runs),
        len(seams_hit),
        total_sec,
        lane_lufs["lead"],
        lane_lufs["support"],
    )
    return {
        "audio": out,
        "lane_lufs": lane_lufs,
        "run_gains_db": run_gains,
        "seams_rendered": len(seams_hit),
        "warnings": warnings,
    }
