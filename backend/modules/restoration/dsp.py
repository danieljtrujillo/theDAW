"""DSP helpers for restoration tools that need numpy/scipy/librosa processing.

These are the "process" mode handlers that read audio → manipulate → write audio,
rather than emitting ffmpeg filter args.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf


async def vocal_isolate(input_path: Path, output_path: Path, params: dict) -> None:
    """Mid/side vocal extraction from stereo audio.

    vocals ≈ mid = (L+R)/2  (center channel)
    instrumental ≈ side = (L-R)/2

    processAmount controls wet/dry blend with original.
    """
    data, sr = sf.read(str(input_path), dtype="float32")

    # If mono, just copy through — nothing to separate
    if data.ndim == 1:
        sf.write(str(output_path), data, sr)
        return

    left = data[:, 0]
    right = data[:, 1]

    mid = (left + right) / 2.0
    side = (left - right) / 2.0

    output_mode = params.get("output", "vocals")
    wet = float(params.get("processAmount", 0.87))

    if output_mode == "instrumental":
        # Instrumental = side signal, stereo
        extracted = np.column_stack([side, -side])
    else:
        # Vocals = mid signal, mono→stereo
        extracted = np.column_stack([mid, mid])

    # Wet/dry blend with original
    blended = wet * extracted + (1.0 - wet) * data

    # Clip to prevent overflow
    blended = np.clip(blended, -1.0, 1.0)
    sf.write(str(output_path), blended, sr)


async def stem_separation(input_path: Path, output_path: Path, params: dict) -> None:
    """Harmonic/percussive source separation via librosa HPSS.

    Genuine separation algorithm. Default returns percussive stem.
    """
    import librosa

    y, sr = librosa.load(str(input_path), sr=None, mono=False)

    # librosa.load returns (samples,) for mono, (channels, samples) for multi
    was_stereo = y.ndim == 2

    if was_stereo:
        # Process each channel independently
        harmonics = []
        percussives = []
        for ch in range(y.shape[0]):
            h, p = librosa.effects.hpss(y[ch])
            harmonics.append(h)
            percussives.append(p)
        harmonic = np.stack(harmonics, axis=0)
        percussive = np.stack(percussives, axis=0)
    else:
        harmonic, percussive = librosa.effects.hpss(y)

    stems_val = int(params.get("stems", 4))
    # stems param: even → percussive, odd → harmonic (simple toggle)
    # But more useful: default to percussive for separation demo
    # We'll use stems=2 → harmonic, stems=3 → percussive, else percussive
    if stems_val == 2:
        result = harmonic
    else:
        result = percussive

    # Transpose for soundfile (expects samples, channels)
    if was_stereo:
        result = result.T
    sf.write(str(output_path), result, sr)


async def spectral_repair(input_path: Path, output_path: Path, params: dict) -> None:
    """STFT → median filter on magnitude → ISTFT.

    Removes transient anomalies by smoothing magnitude across time with a
    median filter. Phase is preserved from original.
    """
    import librosa
    from scipy.ndimage import median_filter

    y, sr = librosa.load(str(input_path), sr=None, mono=False)
    was_stereo = y.ndim == 2

    attenuation = float(params.get("attenuation", 1.0))
    kernel_size = max(3, int(7 * attenuation))  # 3-7 frames
    # Ensure odd kernel size
    if kernel_size % 2 == 0:
        kernel_size += 1

    def _repair_channel(signal: np.ndarray) -> np.ndarray:
        n_fft = 2048
        hop = 512
        S = librosa.stft(signal, n_fft=n_fft, hop_length=hop)
        mag = np.abs(S)
        phase = np.angle(S)

        # Median filter across time axis (axis=1), preserving frequency structure
        mag_filtered = median_filter(mag, size=(1, kernel_size))

        # Blend filtered with original based on attenuation
        mag_out = attenuation * mag_filtered + (1.0 - attenuation) * mag
        S_out = mag_out * np.exp(1j * phase)
        return librosa.istft(S_out, hop_length=hop, length=len(signal))

    if was_stereo:
        channels = []
        for ch in range(y.shape[0]):
            channels.append(_repair_channel(y[ch]))
        result = np.stack(channels, axis=0).T
    else:
        result = _repair_channel(y)

    result = np.clip(result, -1.0, 1.0).astype(np.float32)
    sf.write(str(output_path), result, sr)


async def breath_removal(input_path: Path, output_path: Path, params: dict) -> None:
    """Detect breaths via low-RMS + high spectral centroid, attenuate with crossfades.

    Breaths are characterized by: low energy (RMS) relative to speech, and high
    spectral centroid (noisy/aspirated). We detect these segments and attenuate.
    """
    import librosa

    y, sr = sf.read(str(input_path), dtype="float32")
    was_stereo = y.ndim == 2

    breath_reduction = float(params.get("breathReduction", 0.8))

    if was_stereo:
        mono = np.mean(y, axis=1)
    else:
        mono = y.copy()

    # Analysis parameters
    frame_length = int(0.03 * sr)  # 30ms frames
    hop_length = frame_length // 2

    # Compute RMS
    rms = librosa.feature.rms(y=mono, frame_length=frame_length, hop_length=hop_length)[
        0
    ]
    # Compute spectral centroid
    centroid = librosa.feature.spectral_centroid(
        y=mono, sr=sr, n_fft=frame_length, hop_length=hop_length
    )[0]

    # Thresholds: breaths are low-RMS, high-centroid
    rms_threshold = np.median(rms) * 0.5  # below half median RMS
    centroid_threshold = np.median(centroid) * 1.3  # above 1.3x median centroid

    # Build per-frame gain mask
    n_frames = len(rms)
    gain = np.ones(n_frames, dtype=np.float32)

    for i in range(n_frames):
        if rms[i] < rms_threshold and centroid[i] > centroid_threshold:
            gain[i] = 1.0 - breath_reduction  # attenuate

    # Smooth gain with a short median + moving average to avoid clicks
    from scipy.ndimage import uniform_filter1d, median_filter as med1d

    gain = med1d(gain, size=5)
    gain = uniform_filter1d(gain, size=7)

    # Expand gain to sample-level with linear interpolation
    frame_times = librosa.frames_to_samples(np.arange(n_frames), hop_length=hop_length)
    sample_gain = np.interp(np.arange(len(mono)), frame_times, gain)

    # Apply gain
    if was_stereo:
        result = y.copy()
        result[:, 0] *= sample_gain
        result[:, 1] *= sample_gain
    else:
        result = mono * sample_gain

    result = np.clip(result, -1.0, 1.0).astype(np.float32)
    sf.write(str(output_path), result, sr)
