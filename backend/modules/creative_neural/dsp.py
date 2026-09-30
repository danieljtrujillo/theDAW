"""DSP helpers for creative-neural tools.

Pure numpy/scipy/librosa processing — no network, no GPU, no pip installs.
Each function reads from input_path and writes to output_path (WAV) at the
source's bit depth: these are the tools whose whole point is fidelity, and
``sf.write`` on its own would hand every one of them back a PCM_16 file.
"""

from __future__ import annotations

import re

import numpy as np
from pathlib import Path

from backend.lib.audio_depth import write_like_source
from backend.lib.audio_io import load_audio_array


def _read_frames(path: Path) -> tuple[np.ndarray, int]:
    """Decode ``path`` to float32 (frames, channels) through audio_io, which
    falls back to the ffmpeg CLI for anything libsndfile cannot open."""
    data, sr = load_audio_array(path)
    return np.ascontiguousarray(data.T), sr


# ─────────────────────────────────────────────────────────────────────────────
# 1. grainlab — real granular synthesis
# ─────────────────────────────────────────────────────────────────────────────
def grainlab(input_path: Path, output_path: Path, params: dict) -> None:
    """Slice input into grains, scatter, pitch-shift per grain, overlap-add."""
    import librosa

    data, sr = _read_frames(input_path)
    n_channels = data.shape[1]
    n_samples = data.shape[0]

    grain_size_s = params["grainSize"] / 1000.0
    grain_samples = max(int(grain_size_s * sr), 64)
    density = params["density"]  # grains per second
    scatter = params["scatter"]  # 0-1 randomness of start position
    pitch_spread = params["pitchSpread"]  # semitones spread

    duration_s = n_samples / sr
    n_grains = max(int(duration_s * density), 1)

    # output buffer same length as input
    out = np.zeros_like(data)

    rng = np.random.default_rng(42)

    for i in range(n_grains):
        # nominal position — evenly spaced
        nominal = int((i / max(n_grains, 1)) * n_samples)
        # scatter the start position
        offset = int(scatter * n_samples * (rng.random() - 0.5))
        start = np.clip(nominal + offset, 0, max(n_samples - grain_samples, 0))
        end = min(start + grain_samples, n_samples)
        grain = data[start:end].copy()

        if grain.shape[0] < 4:
            continue

        # pitch-shift per grain via resampling
        if abs(pitch_spread) > 0.01:
            shift_st = rng.uniform(-abs(pitch_spread), abs(pitch_spread))
            ratio = 2.0 ** (shift_st / 12.0)
            # per-channel resample
            shifted_channels = []
            for ch in range(n_channels):
                resampled = librosa.resample(
                    grain[:, ch], orig_sr=sr, target_sr=int(sr * ratio)
                )
                # trim or pad to grain_samples
                if len(resampled) > grain_samples:
                    resampled = resampled[:grain_samples]
                elif len(resampled) < grain_samples:
                    resampled = np.pad(resampled, (0, grain_samples - len(resampled)))
                shifted_channels.append(resampled)
            grain = np.column_stack(shifted_channels)

        # Hann window for smooth overlap-add
        win = np.hanning(grain.shape[0])
        for ch in range(n_channels):
            grain[:, ch] *= win

        # place grain into output
        out_start = nominal
        out_end = min(out_start + grain.shape[0], n_samples)
        length = out_end - out_start
        out[out_start:out_end] += grain[:length]

    # normalize to prevent clipping
    peak = np.max(np.abs(out))
    if peak > 0:
        out /= peak
        # match original RMS
        orig_rms = np.sqrt(np.mean(data**2))
        out_rms = np.sqrt(np.mean(out**2))
        if out_rms > 0:
            out *= min(orig_rms / out_rms, 2.0)

    write_like_source(output_path, out, sr, input_path)


# ─────────────────────────────────────────────────────────────────────────────
# 2. voxsynth — vocoder via STFT cross-synthesis
# ─────────────────────────────────────────────────────────────────────────────
def voxsynth(input_path: Path, output_path: Path, params: dict) -> None:
    """Spectral vocoder: modulator envelope from input shapes a noise carrier."""
    data, sr = _read_frames(input_path)
    n_channels = data.shape[1]
    smooth = params["spectralSmooth"]
    mix = params["mix"]

    n_fft = 2048
    hop = n_fft // 4

    rng = np.random.default_rng(0)
    out_channels = []

    for ch in range(n_channels):
        sig = data[:, ch]
        # generate pink noise carrier (1/f spectrum)
        white = rng.standard_normal(len(sig)).astype(np.float32)
        # approximate pink noise via filtering
        # Simple 1/f: accumulate + leaky integrator
        pink = np.zeros_like(white)
        b = [0.049922035, -0.095993537, 0.050612699, -0.004709510]
        a = [1.0, -2.494956002, 2.017265875, -0.522189400]
        from scipy.signal import lfilter

        pink = lfilter(b, a, white).astype(np.float32)
        # normalize pink
        pk = np.max(np.abs(pink))
        if pk > 0:
            pink /= pk

        # STFT of modulator (input) and carrier (noise)
        from scipy.signal import stft as scipy_stft, istft as scipy_istft

        _, _, Zm = scipy_stft(sig, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
        _, _, Zc = scipy_stft(pink, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)

        # modulator envelope (magnitude)
        mod_env = np.abs(Zm)
        # smooth the envelope in frequency
        if smooth > 0.01:
            from scipy.ndimage import uniform_filter1d

            kernel = max(int(smooth * 50), 1)
            mod_env = uniform_filter1d(mod_env, size=kernel, axis=0)

        # cross-synthesis: carrier phase + modulator magnitude
        carrier_phase = np.exp(1j * np.angle(Zc))
        Zout = mod_env * carrier_phase

        _, vocoded = scipy_istft(Zout, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
        vocoded = vocoded[: len(sig)].astype(np.float32)

        # normalize
        pk = np.max(np.abs(vocoded))
        if pk > 0:
            vocoded *= np.max(np.abs(sig)) / pk

        # mix
        result = sig * (1 - mix) + vocoded * mix
        out_channels.append(result)

    out = np.column_stack(out_channels)
    write_like_source(output_path, out, sr, input_path)


# ─────────────────────────────────────────────────────────────────────────────
# 3. spectramorph — STFT freeze/smear
# ─────────────────────────────────────────────────────────────────────────────
def spectramorph(input_path: Path, output_path: Path, params: dict) -> None:
    """STFT freeze/smear: Gaussian blur on magnitude spectrogram, reconstruct."""
    from scipy.signal import stft as scipy_stft, istft as scipy_istft
    from scipy.ndimage import gaussian_filter1d

    data, sr = _read_frames(input_path)
    n_channels = data.shape[1]
    smear_ms = params["smearLength"]
    intensity = params["brushIntensity"]
    mix = params["mix"]

    n_fft = 2048
    hop = n_fft // 4

    # smear sigma in frames
    smear_frames = max((smear_ms / 1000.0) * sr / hop, 0.1)
    sigma = smear_frames * intensity

    out_channels = []
    for ch in range(n_channels):
        sig = data[:, ch]
        _, _, Z = scipy_stft(sig, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)

        mag = np.abs(Z)
        phase = np.angle(Z)

        # Gaussian blur along time axis (axis=1) for freeze/smear
        if sigma > 0.1:
            mag_smeared = gaussian_filter1d(mag, sigma=sigma, axis=1)
        else:
            mag_smeared = mag

        # reconstruct with original phase (keeps some structure)
        Z_out = mag_smeared * np.exp(1j * phase)
        _, reconstructed = scipy_istft(
            Z_out, fs=sr, nperseg=n_fft, noverlap=n_fft - hop
        )
        reconstructed = reconstructed[: len(sig)].astype(np.float32)

        # normalize
        pk = np.max(np.abs(reconstructed))
        if pk > 0:
            reconstructed *= np.max(np.abs(sig)) / pk

        result = sig * (1 - mix) + reconstructed * mix
        out_channels.append(result)

    out = np.column_stack(out_channels)
    write_like_source(output_path, out, sr, input_path)


# ─────────────────────────────────────────────────────────────────────────────
# 4. crossfade_morph — spectral morph toward smeared version
# ─────────────────────────────────────────────────────────────────────────────
def crossfade_morph(input_path: Path, output_path: Path, params: dict) -> None:
    """Single-input spectral morph: blend original STFT with a smeared copy."""
    from scipy.signal import stft as scipy_stft, istft as scipy_istft
    from scipy.ndimage import gaussian_filter1d

    data, sr = _read_frames(input_path)
    n_channels = data.shape[1]
    morph = params["morphPosition"]  # 0=original, 1=fully smeared
    mix = params["mix"]

    n_fft = 2048
    hop = n_fft // 4
    smear_sigma = 20.0  # fixed heavy smear for the target

    out_channels = []
    for ch in range(n_channels):
        sig = data[:, ch]
        _, _, Z = scipy_stft(sig, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)

        mag_orig = np.abs(Z)
        phase = np.angle(Z)

        # heavily smeared magnitude
        mag_smeared = gaussian_filter1d(mag_orig, sigma=smear_sigma, axis=1)
        # also blur in frequency for more dramatic morph
        mag_smeared = gaussian_filter1d(mag_smeared, sigma=5.0, axis=0)

        # interpolate between original and smeared by morphPosition
        mag_out = mag_orig * (1 - morph) + mag_smeared * morph

        Z_out = mag_out * np.exp(1j * phase)
        _, reconstructed = scipy_istft(
            Z_out, fs=sr, nperseg=n_fft, noverlap=n_fft - hop
        )
        reconstructed = reconstructed[: len(sig)].astype(np.float32)

        pk = np.max(np.abs(reconstructed))
        if pk > 0:
            reconstructed *= np.max(np.abs(sig)) / pk

        result = sig * (1 - mix) + reconstructed * mix
        out_channels.append(result)

    out = np.column_stack(out_channels)
    write_like_source(output_path, out, sr, input_path)


# ─────────────────────────────────────────────────────────────────────────────
# 5. tokensynth — synth-preview: ring mod + vibrato + tremolo
# ─────────────────────────────────────────────────────────────────────────────
_NOTE_RE = re.compile(r"\b([a-g])([#b]?)(-?\d)\b")
_PITCH_CLASS = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}


def note_frequency(text: str) -> float | None:
    """The first note name in ``text`` (``A2``, ``c#4``, ``Bb3``) in Hz, or
    None when there is none. A4 = 440 Hz."""
    match = _NOTE_RE.search(text.lower())
    if match is None:
        return None
    letter, accidental, octave = match.groups()
    midi = 12 * (int(octave) + 1) + _PITCH_CLASS[letter]
    midi += {"#": 1, "b": -1}.get(accidental, 0)
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def tokensynth_voice(prompt: str) -> dict:
    """Read TokenSynth's prompt into the synth voice it asks for.

    The synth has no text model, so the prompt picks the voice by word: the
    carrier wave (sine, square, saw, triangle), its pitch (a note name such as
    ``C3``; else sub/bass, low/deep or high/lead/bell move the Temp-driven
    pitch by octaves), the LFOs (steady turns them off, wobble triples the
    vibrato, tremolo or pulsing doubles the tremolo rate) and the tone
    (dark or warm rolls off the top, bright or crisp lifts it). With none of
    these words the voice is the plain sine ring-mod the tool has always made.
    """
    words = set(re.findall(r"[a-z0-9]+", prompt.lower()))
    voice = {
        "wave": "sine",
        "freq": note_frequency(prompt),
        "octave_shift": 1.0,
        "vibrato": 1.0,
        "tremolo_rate": 1.0,
        "tremolo_depth": 1.0,
        "tone": "neutral",
    }
    if words & {"square", "pulse", "chip", "chiptune", "8bit"}:
        voice["wave"] = "square"
    elif words & {"saw", "sawtooth", "buzzy", "brass", "supersaw"}:
        voice["wave"] = "saw"
    elif words & {"triangle", "flute", "hollow"}:
        voice["wave"] = "triangle"
    if words & {"sub", "bass"}:
        voice["octave_shift"] = 0.25
    elif words & {"low", "deep"}:
        voice["octave_shift"] = 0.5
    elif words & {"high", "lead", "bell"}:
        voice["octave_shift"] = 2.0
    if words & {"steady", "clean", "still"}:
        voice["vibrato"] = 0.0
        voice["tremolo_depth"] = 0.0
    else:
        if words & {"wobble", "wobbly", "warble", "vibrato"}:
            voice["vibrato"] = 3.0
        if words & {"tremolo", "pulsing", "shimmer", "stutter"}:
            voice["tremolo_rate"] = 2.0
    if words & {"dark", "warm", "mellow", "soft"}:
        voice["tone"] = "dark"
    elif words & {"bright", "crisp", "airy", "sharp"}:
        voice["tone"] = "bright"
    return voice


def _carrier(wave: str, freq: float, t: np.ndarray, sr: int) -> np.ndarray:
    """A band-limited carrier: a sine, or a square, saw or triangle built
    from at most 16 partials, each kept under Nyquist."""
    phase = 2 * np.pi * freq * t
    if wave == "sine":
        return np.sin(phase)
    harmonics = range(1, 17) if wave == "saw" else range(1, 33, 2)
    out = np.zeros_like(t)
    for k in harmonics:
        if k * freq >= sr / 2:
            break
        if wave == "square":
            out += np.sin(k * phase) / k
        elif wave == "saw":
            out += ((-1) ** (k + 1)) * np.sin(k * phase) / k
        else:  # triangle
            out += ((-1) ** ((k - 1) // 2)) * np.sin(k * phase) / (k * k)
    peak = np.max(np.abs(out))
    return out / peak if peak > 0 else out


def _shape_tone(audio: np.ndarray, sr: int, tone: str) -> np.ndarray:
    """dark: a 2 kHz low-pass; bright: the band above 3 kHz lifted by 60 %."""
    if tone == "neutral":
        return audio
    from scipy.signal import butter, sosfilt

    if tone == "dark":
        return sosfilt(butter(2, 2000.0, fs=sr, output="sos"), audio, axis=0)
    high = sosfilt(
        butter(2, 3000.0, btype="highpass", fs=sr, output="sos"), audio, axis=0
    )
    return audio + 0.6 * high


def tokensynth(input_path: Path, output_path: Path, params: dict) -> None:
    """Transform input into a tonal/synth texture via ring mod + LFOs, in the
    voice the prompt names (see ``tokensynth_voice``)."""
    data, sr = _read_frames(input_path)
    n_channels = data.shape[1]
    temperature = params["temperature"]  # 0.1-2.0, drives detune/intensity
    voice = tokensynth_voice(str(params.get("prompt", "")))

    n_samples = data.shape[0]
    # float64: a float32 time base loses the carrier's phase a few minutes in
    # (its step at 300 s is ~30 us, 0.2 rad of a 1 kHz carrier).
    t = np.arange(n_samples, dtype=np.float64) / sr

    # ring modulation — carrier frequency driven by temperature (200-1000 Hz,
    # moved by octaves on request) unless the prompt names a note
    ring_freq = voice["freq"] or (200 + temperature * 400) * voice["octave_shift"]
    ring_mod = _carrier(voice["wave"], ring_freq, t, sr)

    # vibrato LFO
    vib_rate = 3 + temperature * 4  # 3-11 Hz
    vib_depth = (0.002 + temperature * 0.005) * voice["vibrato"]  # seconds
    vib_lfo = vib_depth * np.sin(2 * np.pi * vib_rate * t)

    # tremolo LFO
    trem_rate = (2 + temperature * 6) * voice["tremolo_rate"]  # 2-14 Hz
    trem_depth = (0.3 + temperature * 0.3) * voice["tremolo_depth"]  # 0.3-0.9
    tremolo = 1.0 - trem_depth * 0.5 * (1 + np.sin(2 * np.pi * trem_rate * t))

    out_channels = []
    for ch in range(n_channels):
        sig = data[:, ch]

        # apply vibrato via variable delay (interpolated read)
        delay_samples = vib_lfo * sr
        indices = np.arange(n_samples, dtype=np.float64) - delay_samples
        indices = np.clip(indices, 0, n_samples - 1)
        idx_floor = np.floor(indices).astype(int)
        idx_ceil = np.minimum(idx_floor + 1, n_samples - 1)
        frac = indices - idx_floor
        vibrated = sig[idx_floor] * (1 - frac) + sig[idx_ceil] * frac

        # apply ring modulation
        ringed = vibrated * ring_mod

        # apply tremolo
        result = ringed * tremolo

        out_channels.append(result)

    out = _shape_tone(np.column_stack(out_channels), sr, voice["tone"])
    # normalize
    peak = np.max(np.abs(out))
    if peak > 0:
        out *= 0.9 / peak
    write_like_source(output_path, out, sr, input_path)


# ─────────────────────────────────────────────────────────────────────────────
# 6. timbreforge shaping — Structure and Wander, after the ffmpeg shift
# ─────────────────────────────────────────────────────────────────────────────
def _impose_structure(
    source: np.ndarray, shifted: np.ndarray, sr: int, weight: float
) -> np.ndarray:
    """Pull the shifted signal's loudness contour back toward the source's.

    The resample-and-stretch shift keeps the duration but smears the timing
    detail (atempo overlap-adds whole segments, so an attack can double).
    Both signals' 10 ms RMS envelopes are compared and the shifted one is
    scaled by ``(source / shifted) ** weight`` (clamped to +/-18 dB): at 0 the
    shift is untouched, at 1 the result follows the source's dynamics,
    attacks and rhythm exactly. The level is capped at the louder of the two
    inputs' peaks so the correction never adds clipping.
    """
    if weight <= 0.0:
        return shifted
    from scipy.ndimage import uniform_filter1d

    n = min(source.shape[0], shifted.shape[0])
    win = max(int(0.01 * sr), 1)
    env_src = np.sqrt(uniform_filter1d(np.mean(source[:n] ** 2, axis=1), win))
    env_out = np.sqrt(uniform_filter1d(np.mean(shifted[:n] ** 2, axis=1), win))
    # 80 dB under the louder envelope: silence stays silence.
    floor = 1e-4 * max(float(env_src.max()), float(env_out.max()), 1e-12)
    gain = np.clip(((env_src + floor) / (env_out + floor)) ** weight, 0.125, 8.0)
    out = shifted.astype(np.float64)
    out[:n] *= gain[:, None]
    ceiling = max(float(np.max(np.abs(source))), float(np.max(np.abs(shifted))))
    peak = float(np.max(np.abs(out)))
    if peak > ceiling > 0:
        out *= ceiling / peak
    return out


# Wander's deepest drift: a semitone either side of the Timbre setting.
_WANDER_MAX_CENTS = 100.0
# One new random target for the drift about every 0.75 s.
_WANDER_STEP_S = 0.75


def _wander(audio: np.ndarray, sr: int, depth: float, seed: int = 0) -> np.ndarray:
    """Let the shift drift: a slow random pitch-and-formant wobble.

    A smooth random delay curve (a new target every ~0.75 s, cubic between
    them) is read through, which bends pitch and formants together by the
    curve's slope, the same thing the Timbre shift does, so the colour moves
    around its setting. ``depth`` scales the steepest bend to at most
    ``_WANDER_MAX_CENTS``; the delay itself stays bounded, so the timing never
    drifts off the source. The seed is fixed: the same file and settings
    render the same way every time.
    """
    if depth <= 0.0:
        return audio
    from scipy.interpolate import CubicSpline

    n = audio.shape[0]
    if n < 4:
        return audio
    rng = np.random.default_rng(seed)
    n_points = max(int(n / (_WANDER_STEP_S * sr)) + 2, 4)
    knots = np.linspace(0, n - 1, n_points)
    curve = CubicSpline(knots, rng.uniform(-1.0, 1.0, n_points))(np.arange(n))
    slope = float(np.max(np.abs(np.gradient(curve))))
    if slope <= 0:
        return audio
    max_bend = (2.0 ** (_WANDER_MAX_CENTS * depth / 1200.0)) - 1.0
    delay = curve * (max_bend / slope)
    positions = np.clip(np.arange(n) - delay, 0, n - 1)
    grid = np.arange(n)
    return np.column_stack(
        [np.interp(positions, grid, audio[:, ch]) for ch in range(audio.shape[1])]
    )


def timbreforge_shape(
    source_path: Path,
    shifted_path: Path,
    output_path: Path,
    depth_source: Path,
    structure: float,
    wander: float,
) -> None:
    """TimbreForge's Structure and Wander stages, after the ffmpeg shift.

    ``source_path`` and ``shifted_path`` are float WAVs of the source and of
    its shifted render; the result is written at ``depth_source``'s bit depth
    (the upload), so the float intermediates never turn into a 16-bit file.
    """
    source, sr = _read_frames(source_path)
    shifted, shifted_sr = _read_frames(shifted_path)
    if shifted_sr != sr:
        raise RuntimeError(
            f"timbreforge: shifted render came back at {shifted_sr} Hz, source is {sr} Hz"
        )
    out = _impose_structure(source, shifted, sr, structure)
    out = _wander(out, sr, wander)
    write_like_source(output_path, out, sr, depth_source)
