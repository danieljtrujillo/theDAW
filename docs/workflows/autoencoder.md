# Autoencoder

Stable Audio 3 uses a 44.1k stereo audio autoencoder to compress waveforms into a compact continuous latent representation that the diffusion model operates on. This page covers how to use the autoencoder directly, for encoding individual audio files, decoding latents back to audio, and pre-encoding a dataset for training.

## Encoding audio to latents

```python
from backend.lib.audio_io import load_audio
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")  # "same-s" (small), "same-l" (medium/large)
waveform, sr = load_audio("audio.wav")
latents = ae.encode(waveform, sr)
# → (1, latent_dim, latent_time)
```

> `torchaudio.load` and `torchaudio.save` are not usable in this environment.
> Since 2.9 they decode through torchcodec, which loads FFmpeg's *shared*
> libraries at import — no ordinary Windows ffmpeg build has them — and
> `save` also stopped honouring `encoding` / `bits_per_sample`, so a float
> export came back requantized. `backend/lib/audio_io.py` reads and writes
> through libsndfile (falling back to the ffmpeg CLI for containers libsndfile
> cannot open), never clamps a float subtype, and returns the same
> `(tensor[channels, frames], sample_rate)` shape `torchaudio.load` did.

Resampling, channel conversion, and padding are handled automatically. The latent time dimension is `samples // downsampling_ratio` (4096 for all current models). At 44.1 kHz, 10 seconds of stereo audio produces 216 latent frames, with a latent dimension of 256.

To encode a batch of clips with different lengths in one call:

```python
latents = ae.encode([waveform_a, waveform_b], sr=[44100, 22050])
# → (2, latent_dim, latent_time)
```

## Decoding latents to audio

```python
from backend.lib.audio_io import save_audio
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")
audio_out = ae.decode(latents)
# → (1, 2, samples)

save_audio("reconstructed.wav", audio_out[0].cpu(), ae.sample_rate)
```

## Chunked processing for long audio

For audio that is too long to encode or decode in a single forward pass, pass `chunked=True`. `chunk_size` and `overlap` are both measured in latent frames (not audio samples).

```python
from backend.lib.audio_io import load_audio
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")
waveform, sr = load_audio("audio.wav")

latents = ae.encode(waveform, sr, chunked=True, chunk_size=128, overlap=32)
audio_out = ae.decode(latents, chunked=True, chunk_size=128, overlap=32)
```

The overlap should be at least as large as the model's receptive field. A value of 32 is a reasonable default.

## Saving and loading latents

```python
import numpy as np
import torch
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")

# Save
np.save("latents.npy", latents[0].cpu().numpy())  # (latent_dim, latent_time)

# Load and decode
latent_tensor = torch.from_numpy(np.load("latents.npy")).unsqueeze(0).to(ae.device)
audio_out = ae.decode(latent_tensor)
```

## Pre-encoding a dataset

For LoRA training, if you have a large dataset, it is much faster to pre-encode your dataset once and train from the saved latents. Use the provided script:

```bash
uv run python scripts/pre_encode_dataset.py \
  --model same-s \
  --data_dir ./my_data \
  --output_path ./latents_out \
  --batch_size 1
```

The script expects audio files paired with `.txt` caption files:

```
my_data/
  clip1.wav
  clip1.txt
  clip2.wav
  clip2.txt
```

Each encoded clip is written as a `.npy` latent and a `.json` metadata file. When `--pad` is used, the metadata includes a padding mask tracking the valid audio region:

```
latents_out/
  000000000000.npy
  000000000000.json
  000000000001.npy
  000000000001.json
```

Pass the output directory to `train_lora.py` via `--encoded_dir`. See [LoRA training](lora.md) for the full training workflow.

### Options

| Flag | Default | Description |
|---|---|---|
| `--model` | `same-l` | Autoencoder variant: `same-s` (small), `same-l` (medium/large) |
| `--data_dir` | — | Folder containing audio + `.txt` pairs |
| `--output_path` | — | Where to write `.npy`/`.json` latent pairs |
| `--batch_size` | `1` | Must be `1` for variable-length latents |
| `--sample_size` | `12582912` | Samples to pad/crop to (default ~380s at 44.1kHz)|
| `--model_half` | off | Run the autoencoder in fp16 to reduce memory |
| `--pad` | off | Pad/crop audio to `--sample_size` (required for `--batch_size > 1`) |
