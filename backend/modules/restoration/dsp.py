"""DSP helpers for restoration tools that need numpy/scipy/librosa processing.

These are the "process" mode handlers that read audio → manipulate → write audio,
rather than emitting ffmpeg filter args.

The bodies are plain sync functions on purpose: build_router offloads
non-coroutine handlers to a worker thread via asyncio.to_thread, keeping the
event loop responsive during CPU-bound DSP. ``vocal_isolate`` and
``breath_removal`` additionally keep thin async facades because
``backend.modules.vocal.preprocess.isolation`` awaits those exact names.

Every write goes through ``write_like_source`` rather than ``sf.write``: these
tools are asked to repair a file, not to requantize it, and soundfile's WAV
default is PCM_16 whatever array it is handed.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np

from backend.lib.audio_depth import write_like_source
from backend.lib.audio_io import load_audio_array


def _read_audio(path: Path) -> tuple[np.ndarray, int]:
    """Decode ``path`` through audio_io (libsndfile, then the ffmpeg CLI):
    float32, 1-D for mono and (frames, channels) otherwise."""
    data, sr = _read_channels_first(path)
    return (data if data.ndim == 1 else np.ascontiguousarray(data.T)), sr


def _read_channels_first(path: Path) -> tuple[np.ndarray, int]:
    """As ``_read_audio``, with multichannel audio as (channels, frames)."""
    data, sr = load_audio_array(path)
    return (data[0].copy() if data.shape[0] == 1 else data), sr


def _stft_size(sr: int) -> tuple[int, int]:
    """FFT size and hop for the spectral cleanup stages: ~46 ms windows at
    44.1/48 kHz, doubled at high rates so the frequency resolution holds."""
    n_fft = 2048 if sr <= 50000 else 4096
    return n_fft, n_fft // 4


def _spectral_denoise(signal: np.ndarray, sr: int, amount: float) -> np.ndarray:
    """Spectral-subtraction noise reduction for one channel.

    The noise floor of each bin is its 20th-percentile magnitude over the
    file (the quietest frames hold the noise), median-smoothed across
    frequency so a sustained note, which is narrow in frequency, is not taken
    for noise. ``amount`` scales the over-subtraction (1x to 3x) and the
    deepest cut (0 dB at 0, -30 dB at 1); the gain is averaged over three
    frames so the residue does not turn into musical noise. ``amount <= 0``
    returns the input untouched.
    """
    if amount <= 0.0:
        return signal
    import librosa
    from scipy.ndimage import median_filter, uniform_filter1d

    n_fft, hop = _stft_size(sr)
    spec = librosa.stft(signal, n_fft=n_fft, hop_length=hop)
    mag = np.abs(spec)
    noise = np.percentile(mag, 20, axis=1)
    noise = median_filter(noise, size=31, mode="nearest")[:, None]
    over = 1.0 + 2.0 * amount
    floor = 10.0 ** (-30.0 * amount / 20.0)
    gain = np.clip(1.0 - over * noise / np.maximum(mag, 1e-12), floor, 1.0)
    gain = uniform_filter1d(gain, size=3, axis=1)
    out = librosa.istft(spec * gain, hop_length=hop, length=len(signal))
    return out.astype(np.float32)


# Late reverberation is modelled on a room with this decay time. The
# suppression below only needs its order of magnitude: a real room's tail
# decays at roughly this rate, the direct sound does not.
_DEREVERB_RT60_S = 0.6


def _suppress_late_reverb(signal: np.ndarray, sr: int, amount: float) -> np.ndarray:
    """Statistical late-reverberation suppression for one channel (Lebart,
    Boucher and Denbigh's model).

    The late reverb in a frame is estimated as the power one ~50 ms step
    earlier, decayed by an exponential room tail:
    ``P_late[t] = exp(-2 * delta * T) * P[t - k]`` with
    ``delta = 3 * ln(10) / RT60``. Subtracting that estimate removes the tail
    while the direct sound, which arrives with no matching earlier energy,
    passes. ``amount`` scales the subtraction (0x to 2x) and the deepest cut
    (0 dB at 0, -25 dB at 1). ``amount <= 0`` returns the input untouched.
    """
    if amount <= 0.0:
        return signal
    import librosa
    from scipy.ndimage import uniform_filter1d

    n_fft, hop = _stft_size(sr)
    spec = librosa.stft(signal, n_fft=n_fft, hop_length=hop)
    power = uniform_filter1d(np.abs(spec) ** 2, size=3, axis=1)
    k = max(1, round(0.05 * sr / hop))
    delta = 3.0 * np.log(10.0) / _DEREVERB_RT60_S
    decay = np.exp(-2.0 * delta * k * hop / sr)
    late = np.zeros_like(power)
    late[:, k:] = decay * power[:, :-k]
    floor = 10.0 ** (-25.0 * amount / 20.0)
    power_gain = 1.0 - 2.0 * amount * late / np.maximum(power, 1e-20)
    gain = np.sqrt(np.clip(power_gain, floor**2, 1.0))
    out = librosa.istft(spec * gain, hop_length=hop, length=len(signal))
    return out.astype(np.float32)


def _per_channel(audio: np.ndarray, fn) -> np.ndarray:
    """Apply a one-channel stage to (samples,) or (samples, channels) audio."""
    if audio.ndim == 1:
        return fn(audio)
    return np.column_stack([fn(audio[:, ch]) for ch in range(audio.shape[1])])


def vocal_isolate_sync(input_path: Path, output_path: Path, params: dict) -> None:
    """Mid/side vocal extraction from stereo audio, then cleanup.

    vocals ≈ mid = (L+R)/2  (center channel)
    instrumental ≈ side = (L-R)/2

    processAmount controls wet/dry blend with original. denoiseAmount and
    dereverbAmount run the cleanup on the result: spectral-subtraction
    denoise, then late-reverb suppression. A missing cleanup key means off, so
    ``vocal.preprocess.isolation``, which asks only for the isolation, gets
    exactly that; the tool page always sends both.
    """
    data, sr = _read_audio(input_path)
    denoise = float(params.get("denoiseAmount", 0.0))
    dereverb = float(params.get("dereverbAmount", 0.0))

    def cleanup(channel: np.ndarray) -> np.ndarray:
        return _suppress_late_reverb(
            _spectral_denoise(channel, sr, denoise), sr, dereverb
        )

    # Mono has nothing to separate; the cleanup still applies.
    if data.ndim == 1:
        write_like_source(output_path, _per_channel(data, cleanup), sr, input_path)
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

    # Wet/dry blend with the original front pair. Channels past the first two
    # (a surround upload) pass through; blending them against a two-column
    # extraction was a shape error.
    blended = data.copy()
    blended[:, :2] = wet * extracted + (1.0 - wet) * data[:, :2]

    write_like_source(output_path, _per_channel(blended, cleanup), sr, input_path)


async def vocal_isolate(input_path: Path, output_path: Path, params: dict) -> None:
    """Async facade kept because vocal.preprocess.isolation awaits this name;
    the DSP body runs in a worker thread so the event loop stays live."""
    await asyncio.to_thread(vocal_isolate_sync, input_path, output_path, params)


def stem_separation(input_path: Path, output_path: Path, params: dict) -> None:
    """Harmonic/percussive source separation via librosa HPSS.

    ``stems`` (declared range 2-6) drives two things so every value in the
    range produces a different result: 2 selects the harmonic
    output, 3-6 select the percussive output with the HPSS ``margin``
    scaled up (1.0 at 2 -> 4.0 at 6) for progressively more aggressive,
    less-bleed separation. This is still 2-output HPSS, not N-stem source
    separation — the knob controls output selection + separation strength,
    not a stem count.
    """
    import librosa

    y, sr = _read_channels_first(input_path)

    # (samples,) for mono, (channels, samples) for multi
    was_stereo = y.ndim == 2

    stems_val = int(params.get("stems", 4))
    stems_val = max(2, min(6, stems_val))
    want_harmonic = stems_val == 2
    margin = 1.0 + (stems_val - 2) * 0.75

    def _separate(channel: np.ndarray) -> np.ndarray:
        harmonic, percussive = librosa.effects.hpss(channel, margin=margin)
        return harmonic if want_harmonic else percussive

    if was_stereo:
        # Process each channel independently
        channels = [_separate(y[ch]) for ch in range(y.shape[0])]
        result = np.stack(channels, axis=0)
    else:
        result = _separate(y)

    # write_like_source takes (samples, channels)
    if was_stereo:
        result = result.T
    write_like_source(output_path, result, sr, input_path)


def spectral_repair(input_path: Path, output_path: Path, params: dict) -> None:
    """STFT → median filter on magnitude → ISTFT.

    Removes transient anomalies by smoothing magnitude across time with a
    median filter. Phase is preserved from original.
    """
    import librosa
    from scipy.ndimage import median_filter

    y, sr = _read_channels_first(input_path)
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

    result = result.astype(np.float32)
    write_like_source(output_path, result, sr, input_path)


async def breath_removal(input_path: Path, output_path: Path, params: dict) -> None:
    """Async facade kept because vocal.preprocess.isolation awaits this name;
    the DSP body runs in a worker thread so the event loop stays live."""
    await asyncio.to_thread(breath_removal_sync, input_path, output_path, params)


def _reduce_mouth_clicks(audio: np.ndarray, sr: int, amount: float) -> np.ndarray:
    """Find mouth clicks and take out their high-frequency burst.

    A mouth click is a 1-5 ms broadband transient that stands far above the
    high-frequency level just before and just after it. Each 1 ms frame of the
    signal above 2.5 kHz is compared with the median level 3-9 ms on either
    side; a frame above ``10 - 6 * amount`` times the louder side is a click.
    The comparison against both sides keeps sibilants and fricatives, which
    are long, and the onset of any sustained sound, which has energy after it.
    Inside each click (widened by 1 ms and softened at the edges) ``amount``
    of the high band is removed, so the voiced body under the click stays.
    ``amount <= 0`` returns the input untouched.
    """
    if amount <= 0.0:
        return audio
    from scipy.ndimage import binary_dilation, median_filter, uniform_filter1d
    from scipy.signal import butter, sosfiltfilt

    frame = max(sr // 1000, 1)
    n_frames = audio.shape[0] // frame
    if n_frames < 20:
        return audio

    # Zero-phase, so each click's high band lines up with the click itself.
    sos = butter(4, 2500.0, btype="highpass", fs=sr, output="sos")
    high = sosfiltfilt(sos, audio, axis=0)
    high_mono = high if high.ndim == 1 else high.mean(axis=1)
    frames = high_mono[: n_frames * frame].reshape(n_frames, frame)
    rms = np.sqrt(np.mean(frames**2, axis=1))

    side = median_filter(rms, size=7, mode="nearest")
    before = np.concatenate([np.full(6, side[0]), side[:-6]])
    after = np.concatenate([side[6:], np.full(6, side[-1])])
    context = np.maximum(before, after)
    # Ignore anything 60 dB under the file's peak: that is the noise floor.
    floor = 1e-3 * max(float(np.max(np.abs(audio))), 1e-9)
    clicks = (rms > (10.0 - 6.0 * amount) * context) & (rms > floor)
    if not clicks.any():
        return audio

    clicks = binary_dilation(clicks, iterations=1)
    mask = np.repeat(clicks.astype(np.float32), frame)
    mask = np.pad(mask, (0, audio.shape[0] - mask.shape[0]))
    mask = uniform_filter1d(mask, size=max(frame // 2, 1))
    if audio.ndim == 2:
        mask = mask[:, None]
    return (audio - amount * mask * high).astype(np.float32)


def breath_removal_sync(input_path: Path, output_path: Path, params: dict) -> None:
    """Detect breaths via low-RMS + high spectral centroid, attenuate with
    crossfades; remove mouth clicks first (see ``_reduce_mouth_clicks``).

    Breaths are characterized by: low energy (RMS) relative to speech, and high
    spectral centroid (noisy/aspirated). We detect these segments and attenuate.
    A missing clickReduction key means off, so ``vocal.preprocess.isolation``,
    which asks only for breath removal, gets exactly that; the tool page
    always sends it.
    """
    import librosa

    y, sr = _read_audio(input_path)
    was_stereo = y.ndim == 2

    breath_reduction = float(params.get("breathReduction", 0.8))
    y = _reduce_mouth_clicks(y, sr, float(params.get("clickReduction", 0.0)))

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

    # Apply gain to every channel (a surround file's rear channels breathe too)
    if was_stereo:
        result = y * sample_gain[:, None]
    else:
        result = mono * sample_gain

    result = result.astype(np.float32)
    write_like_source(output_path, result, sr, input_path)
