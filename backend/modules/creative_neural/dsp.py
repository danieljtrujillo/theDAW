"""DSP helpers for creative-neural tools.

Pure numpy/scipy/librosa processing — no network, no GPU, no pip installs.
Each function reads from input_path and writes to output_path (WAV).
"""

from __future__ import annotations

import numpy as np
import soundfile as sf
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# 1. grainlab — real granular synthesis
# ─────────────────────────────────────────────────────────────────────────────
def grainlab(input_path: Path, output_path: Path, params: dict) -> None:
    """Slice input into grains, scatter, pitch-shift per grain, overlap-add."""
    import librosa

    data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
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
            max(int(grain.shape[0] / ratio), 4)
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

    sf.write(str(output_path), out, sr)


# ─────────────────────────────────────────────────────────────────────────────
# 2. voxsynth — vocoder via STFT cross-synthesis
# ─────────────────────────────────────────────────────────────────────────────
def voxsynth(input_path: Path, output_path: Path, params: dict) -> None:
    """Spectral vocoder: modulator envelope from input shapes a noise carrier."""
    data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
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
    sf.write(str(output_path), out, sr)


# ─────────────────────────────────────────────────────────────────────────────
# 3. spectramorph — STFT freeze/smear
# ─────────────────────────────────────────────────────────────────────────────
def spectramorph(input_path: Path, output_path: Path, params: dict) -> None:
    """STFT freeze/smear: Gaussian blur on magnitude spectrogram, reconstruct."""
    from scipy.signal import stft as scipy_stft, istft as scipy_istft
    from scipy.ndimage import gaussian_filter1d

    data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
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
    sf.write(str(output_path), out, sr)


# ─────────────────────────────────────────────────────────────────────────────
# 4. crossfade_morph — spectral morph toward smeared version
# ─────────────────────────────────────────────────────────────────────────────
def crossfade_morph(input_path: Path, output_path: Path, params: dict) -> None:
    """Single-input spectral morph: blend original STFT with a smeared copy."""
    from scipy.signal import stft as scipy_stft, istft as scipy_istft
    from scipy.ndimage import gaussian_filter1d

    data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
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
    sf.write(str(output_path), out, sr)


# ─────────────────────────────────────────────────────────────────────────────
# 5. tokensynth — synth-preview: ring mod + vibrato + tremolo
# ─────────────────────────────────────────────────────────────────────────────
def tokensynth(input_path: Path, output_path: Path, params: dict) -> None:
    """Transform input into a tonal/synth texture via ring mod + LFOs."""
    data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
    n_channels = data.shape[1]
    temperature = params["temperature"]  # 0.1-2.0, drives detune/intensity

    n_samples = data.shape[0]
    t = np.arange(n_samples, dtype=np.float32) / sr

    # ring modulation — carrier frequency driven by temperature
    ring_freq = 200 + temperature * 400  # 200-1000 Hz
    ring_mod = np.sin(2 * np.pi * ring_freq * t)

    # vibrato LFO
    vib_rate = 3 + temperature * 4  # 3-11 Hz
    vib_depth = 0.002 + temperature * 0.005  # subtle pitch wobble in seconds
    vib_lfo = vib_depth * np.sin(2 * np.pi * vib_rate * t)

    # tremolo LFO
    trem_rate = 2 + temperature * 6  # 2-14 Hz
    trem_depth = 0.3 + temperature * 0.3  # 0.3-0.9
    tremolo = 1.0 - trem_depth * 0.5 * (1 + np.sin(2 * np.pi * trem_rate * t))

    out_channels = []
    for ch in range(n_channels):
        sig = data[:, ch]

        # apply vibrato via variable delay (interpolated read)
        delay_samples = vib_lfo * sr
        indices = np.arange(n_samples, dtype=np.float32) - delay_samples
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

    out = np.column_stack(out_channels)
    # normalize
    peak = np.max(np.abs(out))
    if peak > 0:
        out *= 0.9 / peak
    sf.write(str(output_path), out, sr)
