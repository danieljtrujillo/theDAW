# Audio I/O: `backend/lib/audio_io.py`

Every audio file theDAW reads or writes goes through one module,
`backend/lib/audio_io.py`. It is libsndfile (through `soundfile`) with the
ffmpeg CLI as a fallback, it is float-native, and it never clamps a float
export.

**The standing rule: never call `torchaudio.load` or `torchaudio.save`.** Not in
backend code, not in a module, not in a snippet in a doc. They do not work in
this environment, and this page explains why so nobody has to rediscover it.

## Why torchaudio is not the answer

From torchaudio 2.9 onward, `load` and `save` decode through **torchcodec**,
which loads FFmpeg's *shared* libraries at import time. No ordinary Windows
ffmpeg install carries them — the winget build and the gyan "essentials" and
"full" builds are all static — so the moment the project moved to torchaudio
2.11, every `torchaudio.load` in the app raised:

```
RuntimeError: Could not load libtorchcodec. ... FFmpeg
```

on the development machine, and would have on every user's. torchcodec is not in
`uv.lock` and is not going in.

`torchaudio.save` had a second problem of its own: it stopped honouring
`encoding` and `bits_per_sample`, so a float export came back requantized —
exactly the loss `backend/lib/audio_depth.py` exists to prevent.

torchaudio is still a dependency, and it is still the right tool for
**transforms** — resample, spectrograms. It is used for nothing else.

## What the module does instead

libsndfile 1.2 reads and writes everything the app produces: WAV at every depth
including float, FLAC, OGG Vorbis and Opus, MP3, AIFF, W64 and CAF. It does it
without clamping, which several tool paths already depend on. The containers it
cannot open — m4a/aac, webm, anything with a video track — are decoded by the
ffmpeg CLI the app already requires, to a float WAV in a temp file, and then
read back through libsndfile.

## The API

```python
from backend.lib.audio_io import load_audio, load_audio_array, save_audio, save_subtype
```

### `load_audio(src, *, format=None) -> (torch.Tensor, int)`

Decodes a path, `bytes`, or a file-like object to a torch tensor shaped
`[channels, frames]` plus the sample rate — the same shape `torchaudio.load`
returned, so a call site swaps one name for another and nothing else.

```python
waveform, sr = load_audio("/path/to/audio.wav")
```

> Watch the order at the pipeline boundary. `load_audio` returns
> `(tensor, sample_rate)`; `StableAudioModel.generate` wants `init_audio` and
> `inpaint_audio` as `(sample_rate, tensor)`. Build the tuple explicitly:
> `init_audio = (sr, waveform)`.

### `load_audio_array(src, *, format=None) -> (np.ndarray, int)`

The same decode without importing torch: a float32 array shaped
`[channels, frames]`. libsndfile first, the ffmpeg CLI for anything it cannot
open. Never clamps. This is what you want in a module that has no other reason
to pull torch in.

### `save_audio(dst, audio, samplerate, *, format=None, subtype=None) -> str | None`

Writes a torch tensor or an ndarray shaped `(channels, frames)` to a path or a
file-like object, and returns the subtype it actually used. A tensor on any
device is accepted; it is detached, moved to CPU and cast to float32 for you. A
1-D input is treated as mono.

`format` is inferred from the destination's extension, and is **required** when
writing to a file-like object, which has no extension to read.

Fixed-point subtypes get a −1..1 clip, because integer PCM wraps rather than
saturates on overflow. Float subtypes deliberately do not: a peak above 0 dBFS
surviving intact is the entire point of asking for float.

### `save_subtype(fmt, wav_bit_depth) -> str | None`

The libsndfile subtype for a generated file at a requested depth. The defaults
encode a real decision:

| Format | `16` | `24` | `32f` |
|---|---|---|---|
| WAV | `PCM_16` | `PCM_24` | `FLOAT` |
| FLAC | `PCM_16` | `PCM_24` | `PCM_24` (FLAC is lossless but never float) |
| OGG / OGA | `VORBIS` | `VORBIS` | `VORBIS` (Vorbis has no PCM word length) |

`PCM_16` stays the default. It halves the on-disk footprint at no perceptible
cost on generative audio, and every finished job also carries its audio
base64-encoded in the `JOBS` dict until it is pruned, so the depth is paid for
twice. `32f` is the escape hatch for output going straight back into a float
session — the EDIT timeline, a VST chain, the Chimera stack — where every
requantization along the way compounds.

## Notes for contributors

- If you find a `torchaudio.load` or `torchaudio.save` anywhere, it is a bug.
  Replace it; do not work around the error.
- The ffmpeg fallback runs with `stdin=subprocess.DEVNULL`. The backend does not
  always own a console, and an inherited handle makes ffmpeg's console reader
  block forever.
- A failed decode with no ffmpeg on PATH raises a `RuntimeError` naming both the
  libsndfile error and the missing binary, so the log says which of the two
  things went wrong.

See also: [Windows troubleshooting](../windows/troubleshooting.md) for the
"Could not load libtorchcodec" entry a user might hit.
