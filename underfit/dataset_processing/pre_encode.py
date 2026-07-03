#!/usr/bin/env python3
"""Pre-encode audio files into VAE latents for LoRA finetuning.

Encodes all audio in a directory (recursively) through a model's VAE encoder,
saving raw latents as .npy and metadata as .json. These can be loaded directly
by the training dataloader with pre_encoded=True.

Latents are saved WITHOUT the pretransform scale applied -- the training code
divides by scale itself (see training/diffusion.py line ~486).

Uses all available GPUs automatically. Each GPU encodes a shard of the files
in parallel. The checkpoint is loaded once and pretransform weights are saved
to a temp file so each worker avoids re-reading the full checkpoint.

Output goes to <output_dir>/latents/<model>/<preserved_dir_structure>/ where
each audio file becomes a .npy + .json pair at the same relative path.

Run with --help to see all CLI flags.
"""

import sys
from pathlib import Path as _Path

# This script lives in <repo>/dataset_processing/ but imports from <repo>/underfit/.
# When launched as `python3 dataset_processing/pre_encode.py`, only this script's
# directory is on sys.path — not the repo root. Inject it so `import underfit.*` works.
_REPO_ROOT = _Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import argparse
import gc
import json
import os
import time
import warnings

warnings.filterwarnings("ignore", message=".*weight_norm.*")
warnings.filterwarnings("ignore", message=".*torch.nn.utils.weight_norm.*")
warnings.filterwarnings("ignore", module="audio_metadata")
import numpy as np
import torch
import torch.multiprocessing as mp
import torchaudio
from pathlib import Path
from torch.nn import functional as F

TAG_KEYS = ["title", "artist", "album", "genre", "label", "date", "composer", "bpm"]

# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

import json as _json

_REPO_ROOT = Path(__file__).parent.parent
_DASHBOARD_DIR = _REPO_ROOT / "dashboard"
_MODELS_SHIPPED_DIR = _DASHBOARD_DIR / "models"  # per-model {registry.json, training_template.json}

# Per-instance state — defaults to <repo>/state/.
_STATE_DIR = Path(os.environ.get("UNDERFIT_STATE_DIR", _REPO_ROOT / "state")).expanduser()

# Base-model files. By default lives at STATE_DIR/models, but
# UNDERFIT_MODELS_DIR can relocate (e.g. /content/models on Colab, so model
# files live on local SSD instead of slow Drive). Distinct from per-run
# LoRA training "checkpoints" — those live in RUNS_DIR.
_MODELS_DIR = Path(os.environ.get(
    "UNDERFIT_MODELS_DIR", _STATE_DIR / "models"
)).expanduser()

_path_subs = {"{models_dir}": str(_MODELS_DIR)}

def _resolve(s):
    if not isinstance(s, str):
        return s
    for k, v in _path_subs.items():
        s = s.replace(k, v)
    return s

# MODEL_PATHS[key] -> Path to the per-model dir containing config + ckpt symlinks.
# Defaults to MODELS_DIR/<key>/ unless the JSON overrides via paths.pre_encode_dir.
MODEL_PATHS = {}
MODELS = {}
for _registry_path in sorted(_MODELS_SHIPPED_DIR.glob("*/registry.json")):
    with open(_registry_path) as _f:
        _m = _json.load(_f)
    _key = _m["key"]
    MODELS[_key] = _m.get("description", "")
    _ped = _m.get("paths", {}).get("pre_encode_dir")
    MODEL_PATHS[_key] = Path(_resolve(_ped)) if _ped else (_MODELS_DIR / _key)

MODEL_NAMES = list(MODELS.keys())

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".aiff", ".aif", ".m4a"}
_MIN_AUDIO_SIZE = 4096  # skip files smaller than this (macOS resource forks, corrupt)

# ---------------------------------------------------------------------------
# Interactive prompts (only run in main process)
# ---------------------------------------------------------------------------

def ask_input_dir():
    while True:
        path = input("\nInput directory: ").strip()
        if path and Path(path).expanduser().is_dir():
            return str(Path(path).expanduser().resolve())
        print(f"  Not a directory: {path}")


def ask_model():
    print("\nModels:")
    for i, name in enumerate(MODEL_NAMES, 1):
        print(f"  {i}) {name:16s}  {MODELS[name]}")
    while True:
        try:
            choice = input(f"\nSelect model [1-{len(MODEL_NAMES)}]: ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(MODEL_NAMES):
                return MODEL_NAMES[idx]
        except (ValueError, EOFError):
            pass
        print(f"  Enter 1-{len(MODEL_NAMES)}")

# ---------------------------------------------------------------------------
# Audio discovery
# ---------------------------------------------------------------------------

def find_audio_files(root):
    """Recursively find audio files, sorted by path.

    Skips macOS resource forks (._*) and files too small to be real audio.
    """
    files = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if fn.startswith("._"):
                continue
            fp = Path(dirpath) / fn
            if fp.suffix.lower() in AUDIO_EXTS:
                try:
                    if fp.stat().st_size < _MIN_AUDIO_SIZE:
                        continue
                except OSError:
                    continue
                files.append(fp)
    files.sort()
    return files

def scan_durations(files):
    """Header-only duration scan (torchaudio.info — no decode, fast).

    Returns {str(path): seconds | None}. Files whose header can't be read
    return None; callers MUST treat None conservatively (assume the global
    cap) so a bad header can never cause an under-allocation.
    """
    durs = {}
    for f in files:
        try:
            info = torchaudio.info(str(f))
            if info.num_frames and info.sample_rate:
                durs[str(f)] = info.num_frames / info.sample_rate
            else:
                durs[str(f)] = None
        except Exception:
            durs[str(f)] = None
    return durs

# ---------------------------------------------------------------------------
# Audio loading (used by workers)
# ---------------------------------------------------------------------------

def load_audio(path, target_sr, target_channels, device):
    """Load audio file -> [channels, samples] on device, resampled and channel-matched."""
    audio, sr = torchaudio.load(str(path))

    if sr != target_sr:
        audio = torchaudio.transforms.Resample(sr, target_sr)(audio)

    ch = audio.shape[0]
    if ch < target_channels:
        audio = audio.repeat(target_channels, 1)[:target_channels]
    elif ch > target_channels:
        audio = audio[:target_channels]

    return audio.to(device)

# ---------------------------------------------------------------------------
# ID3/Vorbis tag extraction
# ---------------------------------------------------------------------------

def extract_tags(filepath):
    """Extract tag fields from an audio file.

    Priority:
      1. JSON sidecar ({stem}.json) — richest, custom keys preserved
      2. Plain .txt sidecar ({stem}.txt) — Stable Audio 3 convention
         (https://github.com/Stability-AI/stable-audio-3 scripts/train_lora.py).
         Whole file content (stripped) becomes the "prompt" key.
      3. Embedded ID3 / Vorbis / M4A tags via audio_metadata

    All three forms also accept a sibling directory layout — `<dir>/clip.wav`
    pairs with `<dir>/clip.json` / `<dir>/clip.txt` (same dir) or
    `<parent>/json/clip.json` / `<parent>/txt/clip.txt` (sibling subfolder),
    useful for keeping captions out of the audio folder.

    For JSON sidecars, all string/number values are kept (not just TAG_KEYS),
    so custom keys like 'id' or 'prompt' are preserved in the latent metadata.
    """
    fp = Path(filepath)
    stem = fp.stem
    # 1. JSON sidecar — same dir, then sibling json/ dir
    sidecar_candidates = [
        fp.with_suffix(".json"),
        fp.parent.parent / "json" / (stem + ".json"),
    ]
    for sidecar in sidecar_candidates:
        if sidecar.exists():
            try:
                with open(sidecar) as f:
                    sc = json.load(f)
                tags_out = {k: str(v) for k, v in sc.items()
                            if v and isinstance(v, (str, int, float))}
                if tags_out:
                    return tags_out
            except Exception:
                pass

    # 2. Plain .txt sidecar (SA3 convention) — same dir, then sibling txt/ dir.
    # Whole file content (whitespace-stripped) becomes the "prompt" tag key.
    # Empty file → fall through to embedded tags.
    txt_candidates = [
        fp.with_suffix(".txt"),
        fp.parent.parent / "txt" / (stem + ".txt"),
    ]
    for txt in txt_candidates:
        if txt.exists():
            try:
                content = txt.read_text(encoding="utf-8", errors="replace").strip()
                if content:
                    return {"prompt": content}
            except Exception:
                pass

    # 3. Fall back to embedded tags via audio_metadata (lazy import to avoid SIGSEGV)
    try:
        import audio_metadata
        track_md = audio_metadata.load(str(filepath))
    except Exception:
        return {}

    tags_out = {}
    tags = track_md.get("tags", {})
    for key in TAG_KEYS:
        if key in tags:
            val = tags[key]
            if isinstance(val, (list, tuple)) and len(val) > 0:
                val = str(val[0])
            else:
                val = str(val)
            if val:
                tags_out[key] = val
    return tags_out

# ---------------------------------------------------------------------------
# Worker: encode one shard of files on one GPU
# ---------------------------------------------------------------------------

def _load_and_prepare(fpath, sample_rate, audio_channels, max_samples, device, half):
    """Load one audio file, crop/pad to max_samples. Returns (audio, actual_samples)."""
    audio = load_audio(fpath, sample_rate, audio_channels, device)
    actual_samples = audio.shape[-1]
    if actual_samples > max_samples:
        audio = audio[:, :max_samples]
        actual_samples = max_samples
    if actual_samples < max_samples:
        audio = F.pad(audio, (0, max_samples - actual_samples))
    if half:
        audio = audio.half()
    return audio, actual_samples


def _expand_files_to_tasks(audio_files, input_dir, durations=None):
    """One task per audio file (no splitting). Returns a list of dicts:
        path:     absolute source file path
        src_rel:  relative path under input_dir (for logging)
        out_rel:  relative output path with .npy suffix
        duration: header-scanned duration in seconds (None if unreadable)
    """
    durations = durations or {}
    tasks = []
    for fpath in audio_files:
        fpath = Path(fpath)
        try:
            rel = fpath.relative_to(input_dir)
        except ValueError:
            rel = Path(fpath.name)
        npy_rel = rel.with_suffix(".npy")
        tasks.append({"path": str(fpath), "src_rel": str(rel),
                      "out_rel": str(npy_rel),
                      "duration": durations.get(str(fpath))})
    return tasks


def _build_pretransform(pretransform_config, sample_rate):
    """Build a pretransform via the active backend (sa3 or sat).

    The backend module owns the construction logic — sat has to work
    around a brittle autoencoders→diffusion import; sa3 just delegates to its
    factory. Picked via UNDERFIT_BACKEND env var or auto-detect.
    """
    from underfit.backends import get_backend
    backend = get_backend()
    return backend.build_pretransform(pretransform_config, sample_rate)


def encode_shard(rank, world_size, cfg):
    """Encode files[rank::world_size] on cuda:rank (or cpu), in batches."""
    try:
        _encode_shard_inner(rank, world_size, cfg)
    except Exception as e:
        import traceback
        print(f"\n[gpu:{rank}] FATAL ERROR in encode_shard:", flush=True)
        traceback.print_exc()
        print(flush=True)
        raise

def _encode_shard_inner(rank, world_size, cfg):
    import sys
    print(f"[shard {rank}] _encode_shard_inner START", file=sys.stderr, flush=True)
    device = cfg["device"]
    if device == "cuda":
        device = f"cuda:{rank}"
    elif device.startswith("cuda:"):
        if rank != 0:
            return
    print(f"[shard {rank}] device={device}", file=sys.stderr, flush=True)

    # HARD SAFETY CAP: keep torch's allocator inside real VRAM. Without this,
    # the Windows driver's "sysmem fallback" silently spills GPU overflow into
    # shared system RAM instead of raising OOM — which is how an oversized
    # batch froze/crashed the whole machine rather than erroring. With the cap,
    # overflow raises torch.cuda.OutOfMemoryError, which we catch and back off.
    if device.startswith("cuda"):
        try:
            _cap_idx = int(device.split(":")[1]) if ":" in device else 0
            torch.cuda.set_per_process_memory_fraction(0.90, _cap_idx)
        except Exception:
            pass

    prefix = f"[gpu:{rank}] " if world_size > 1 else ""
    batch_size = cfg.get("batch_size", 1)

    # -- Build pretransform on this device --
    # NOTE: We inline the pretransform construction here instead of calling
    # create_pretransform_from_config, because importing autoencoders.py
    # triggers a circular import chain (autoencoders → diffusion → ...) that
    # segfaults with certain package versions.  pre_encode only needs the
    # encoder/decoder, not the full diffusion model.
    print(f"[shard {rank}] creating pretransform...", file=sys.stderr, flush=True)
    pretransform = _build_pretransform(cfg["pretransform_config"], cfg["sample_rate"])
    print(f"[shard {rank}] pretransform created, loading weights...", file=sys.stderr, flush=True)

    pt_sd = torch.load(cfg["weights_path"], map_location=device, weights_only=True)
    print(f"[shard {rank}] weights loaded ({len(pt_sd)} tensors), applying...", file=sys.stderr, flush=True)
    torch.nn.Module.load_state_dict(pretransform, pt_sd)
    del pt_sd
    print(f"[shard {rank}] moving to {device}...", file=sys.stderr, flush=True)

    pretransform = pretransform.to(device).eval().requires_grad_(False)
    if cfg["half"]:
        pretransform = pretransform.half()

    if rank == 0 or world_size == 1:
        print(f"{prefix}VAE loaded on {device} (batch_size={batch_size})")

    # -- Determine my shard (interleaved for load balance) --
    # Tasks: either one-per-file (no split) or one-per-chunk (when split is enabled).
    # See _expand_files_to_tasks for the schema.
    tasks       = cfg["tasks"]
    input_dir   = Path(cfg["input_dir"])
    latent_root = Path(cfg["latent_root"])
    max_samples = cfg["max_samples"]
    sample_rate = cfg["sample_rate"]
    audio_channels = cfg["audio_channels"]
    total       = len(tasks)

    my_indices = list(range(rank, total, world_size))

    encoded = 0
    skipped = 0
    errors  = 0

    # Filter to only indices that need encoding
    to_encode = []
    for global_idx in my_indices:
        task = tasks[global_idx]
        out_rel = Path(task["out_rel"])
        npy_path  = latent_root / out_rel
        json_path = latent_root / out_rel.with_suffix(".json")
        if npy_path.exists() and json_path.exists() and not cfg["force"]:
            skipped += 1
        else:
            npy_path.parent.mkdir(parents=True, exist_ok=True)
            to_encode.append(global_idx)

    # Process in LENGTH-BUCKETED batches with prefetch (load next bucket while
    # the GPU encodes). Files are sorted longest-first; each bucket pads only
    # to ITS OWN longest member (never the global max), and the bucket's batch
    # size comes from a MEASURED VRAM probe of the longest file — so batch
    # sizing adapts to the real GPU, real model, and real file lengths.
    from concurrent.futures import ThreadPoolExecutor

    ds_ratio = cfg["ds_ratio"]
    _dev_idx = 0
    total_mb = None
    if device.startswith("cuda"):
        _dev_idx = int(device.split(":")[1]) if ":" in device else 0
        total_mb = torch.cuda.get_device_properties(_dev_idx).total_memory / 1024**2

    def _task_dur(gi):
        """Header-scanned duration; None (unreadable) = assume the global cap."""
        d = tasks[gi].get("duration")
        return float(d) if d else (max_samples / sample_rate)

    def _padded_samples(dur_s):
        """Pad target for a bucket: +2%+1s VBR-header margin, aligned UP to
        ds_ratio, never above the global max_samples ceiling."""
        n = int((dur_s * 1.02 + 1.0) * sample_rate)
        n = ((n + ds_ratio - 1) // ds_ratio) * ds_ratio
        return min(n, max_samples)

    def _load_batch(indices, pad_samples):
        """Load a batch of audio tasks padded to this bucket's pad_samples."""
        b_audio, b_meta, b_errors = [], [], 0
        for global_idx in indices:
            task = tasks[global_idx]
            fpath = Path(task["path"])
            src_rel = Path(task["src_rel"])
            try:
                audio, actual_samples = _load_and_prepare(
                    fpath, sample_rate, audio_channels, pad_samples, device, cfg["half"])
                b_audio.append(audio)
                b_meta.append((global_idx, fpath, task, actual_samples))
            except Exception as e:
                b_errors += 1
                tag = f"{prefix}[{global_idx + 1}/{total}]"
                print(f"  {tag} ERROR {src_rel}: {e}")
        return b_audio, b_meta, b_errors

    def _save_results(latents, b_meta, pad_samples):
        nonlocal encoded, errors
        for i, (global_idx, fpath, task, actual_samples) in enumerate(b_meta):
            tag = f"{prefix}[{global_idx + 1}/{total}]"
            out_rel = Path(task["out_rel"])
            try:
                latent_np = latents[i].cpu().float().numpy()  # [D, T_latent]
                latent_len = latent_np.shape[-1]
                duration = actual_samples / sample_rate

                # Padding mask (relative to this bucket's padded length)
                pad_mask = torch.ones(pad_samples, device="cpu")
                if actual_samples < pad_samples:
                    pad_mask[actual_samples:] = 0.0
                pm = F.interpolate(
                    pad_mask.view(1, 1, -1), size=latent_len, mode="nearest"
                ).squeeze()

                npy_path  = latent_root / out_rel
                json_path = latent_root / out_rel.with_suffix(".json")
                np.save(str(npy_path), latent_np)

                tags = extract_tags(fpath)
                meta = {
                    "path": str(fpath),
                    "relpath": str(out_rel),
                    "src_relpath": task["src_rel"],
                    "seconds_total": round(duration, 3),
                    "seconds_start": 0,
                    "audio_samples": actual_samples,
                    "latent_shape": list(latent_np.shape),
                    "padding_mask": pm.int().tolist(),
                }
                meta.update(tags)
                with open(json_path, "w") as f:
                    json.dump(meta, f)

                encoded += 1
                shape_str = "x".join(str(s) for s in latent_np.shape)
                print(f"  {tag} {out_rel}  {duration:.1f}s -> [{shape_str}]")
            except Exception as e:
                errors += 1
                print(f"  {tag} ERROR {out_rel}: {e}")

    def _is_oom(e):
        return isinstance(e, torch.cuda.OutOfMemoryError) or "out of memory" in str(e).lower()

    def _encode_and_save(b_audio, b_meta, label="", list_files=True):
        """Encode a loaded batch; on failure free cache, HALVE, and retry.
        A single file that still fails is logged as an error and skipped —
        cleanly, thanks to the allocator cap (never a machine crash)."""
        nonlocal errors
        if not b_audio:
            return
        pad_samples = b_audio[0].shape[-1]
        use_chunked = pad_samples > 30 * sample_rate
        try:
            audio_batch = torch.stack(b_audio)  # [B, C, pad_samples]
            print(f"{prefix}Encoding {label}: {len(b_meta)} files, "
                  f"shape={list(audio_batch.shape)}, chunked={use_chunked}", flush=True)
            if list_files:
                for _, _, t, _ in b_meta[:20]:
                    print(f"{prefix}  - {t['out_rel']}", flush=True)
                if len(b_meta) > 20:
                    print(f"{prefix}  … and {len(b_meta) - 20} more", flush=True)
            with torch.no_grad():
                latents = pretransform.model.encode_audio(
                    audio_batch, chunked=use_chunked
                )  # [B, D, T_latent]
            del audio_batch
        except Exception as e:
            if device.startswith("cuda"):
                torch.cuda.empty_cache()
            if len(b_audio) == 1:
                global_idx = b_meta[0][0]
                errors += 1
                print(f"  {prefix}[{global_idx + 1}/{total}] ERROR "
                      f"{b_meta[0][2]['out_rel']}: {e}")
                return
            mid = len(b_audio) // 2
            kind = "OOM" if _is_oom(e) else "error"
            print(f"{prefix}{kind} at B={len(b_audio)} — splitting and retrying "
                  f"({mid}+{len(b_audio) - mid})", flush=True)
            a_lo, a_hi = b_audio[:mid], b_audio[mid:]
            m_lo, m_hi = b_meta[:mid], b_meta[mid:]
            del b_audio
            _encode_and_save(a_lo, m_lo, label + " [retry lo]", list_files=False)
            del a_lo
            _encode_and_save(a_hi, m_hi, label + " [retry hi]", list_files=False)
            return
        _save_results(latents, b_meta, pad_samples)
        del latents

    # -- Sort longest-first: the probe measures the WORST case, and later
    #    (shorter) buckets can batch wider.
    to_encode.sort(key=_task_dur, reverse=True)

    baseline_mb = 0.0
    if device.startswith("cuda"):
        torch.cuda.synchronize(_dev_idx)
        baseline_mb = torch.cuda.memory_allocated(_dev_idx) / 1024**2

    per_sec_mb = None  # measured VRAM cost of one second of padded audio
    forced_bs = batch_size if batch_size > 0 else None
    remaining = list(to_encode)

    if remaining and forced_bs is None and device.startswith("cuda"):
        # -- VRAM probe: encode the LONGEST file solo, measure the true peak. --
        probe_idx = remaining.pop(0)
        probe_pad = _padded_samples(_task_dur(probe_idx))
        b_audio, b_meta, load_errors = _load_batch([probe_idx], probe_pad)
        errors += load_errors
        if b_audio:
            torch.cuda.reset_peak_memory_stats(_dev_idx)
            _encode_and_save(b_audio, b_meta, "probe (longest file, B=1)")
            del b_audio, b_meta
            peak_mb = torch.cuda.max_memory_allocated(_dev_idx) / 1024**2
            probe_secs = max(1.0, probe_pad / sample_rate)
            # 1.35x safety on measured cost; 2 MB/s floor avoids div-by-tiny.
            per_sec_mb = max(2.0, (peak_mb - baseline_mb) / probe_secs) * 1.35
            torch.cuda.empty_cache()
            print(f"{prefix}VRAM probe: peak {peak_mb:.0f} MB over "
                  f"{baseline_mb:.0f} MB baseline -> {per_sec_mb:.1f} MB/s "
                  f"per item (incl. safety margin)", flush=True)

    def _bucket_bs(dur_s):
        if forced_bs is not None:
            return forced_bs
        if per_sec_mb is None or total_mb is None:
            return 1  # no measurement -> maximum caution
        # Budget: the 90% allocator cap, minus model baseline, 80% of the rest.
        budget_mb = max(512.0, (total_mb * 0.90 - baseline_mb) * 0.80)
        return max(1, min(64, int(budget_mb / (per_sec_mb * max(dur_s, 10.0)))))

    # -- Form length buckets over the (longest-first) remaining files --
    buckets = []
    i = 0
    while i < len(remaining):
        dur = _task_dur(remaining[i])            # longest file in this bucket
        pad_samples = _padded_samples(dur)
        bs = _bucket_bs(pad_samples / sample_rate)
        buckets.append((remaining[i:i + bs], pad_samples))
        i += bs

    # -- Encode buckets with one-ahead prefetch --
    prefetch_pool = ThreadPoolExecutor(max_workers=1)
    next_future = (prefetch_pool.submit(_load_batch, *buckets[0]) if buckets else None)

    for bi, (bucket_indices, pad_samples) in enumerate(buckets):
        b_audio, b_meta, load_errors = next_future.result()
        errors += load_errors

        if bi + 1 < len(buckets):
            next_future = prefetch_pool.submit(_load_batch, *buckets[bi + 1])
        else:
            next_future = None

        if not b_audio:
            continue
        _encode_and_save(b_audio, b_meta, f"bucket {bi + 1}/{len(buckets)}")
        del b_audio, b_meta

        if device.startswith("cuda"):
            torch.cuda.empty_cache()

    prefetch_pool.shutdown(wait=False)

    # Write per-worker stats so main process can aggregate
    stats = {"encoded": encoded, "skipped": skipped, "errors": errors}
    with open(latent_root / f".stats_{rank}.json", "w") as f:
        json.dump(stats, f)

    if world_size > 1:
        print(f"  {prefix}shard done: {encoded} encoded, {skipped} skipped, {errors} errors")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Pre-warn (and quiet torch's noisy autotune warnings) on pre-Ampere GPUs.
    from underfit.utils import check_attention_compute_capability
    check_attention_compute_capability()

    parser = argparse.ArgumentParser(
        description="Pre-encode audio into VAE latents for LoRA finetuning",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input-dir", "-i", type=str,
                        help="Directory of audio files (searched recursively)")
    parser.add_argument("--model", "-m", type=str, choices=MODEL_NAMES,
                        help="Which model's VAE to encode with")
    parser.add_argument("--output-dir", "-o", type=str, default=".",
                        help="Output root (default: cwd). Latents go to <output>/latents/<model>/...")
    parser.add_argument("--max-duration", type=float, default=None,
                        help="Crop files longer than N seconds (default: model max)")
    parser.add_argument("--device", type=str, default="cuda",
                        help="Device: 'cuda' (all GPUs), 'cuda:0' (specific), 'cpu'")
    parser.add_argument("--num-gpus", type=int, default=None,
                        help="Number of GPUs to use (default: all available)")
    parser.add_argument("--half", action="store_true",
                        help="Encode in float16 (faster, slightly less precise)")
    parser.add_argument("--force", action="store_true",
                        help="Re-encode files that already have latents")
    parser.add_argument("--batch-size", "-b", type=int, default=0,
                        help="Batch size per GPU (0=auto based on VRAM, default: 0)")
    parser.add_argument("--exclude-file", type=str, default=None,
                        help="Path to text file with relpaths to exclude (one per line)")
    args = parser.parse_args()

    # --- Interactive fallbacks ------------------------------------------------

    if not args.input_dir:
        args.input_dir = ask_input_dir()

    input_dir = Path(args.input_dir).expanduser().resolve()
    if not input_dir.is_dir():
        print(f"Error: not a directory: {input_dir}")
        sys.exit(1)

    if not args.model:
        args.model = ask_model()

    model_name = args.model

    # --- Find audio files -----------------------------------------------------

    audio_files = find_audio_files(input_dir)
    if not audio_files:
        print(f"No audio files found in {input_dir}")
        sys.exit(1)

    # Apply exclude list if provided
    if args.exclude_file:
        exclude_path = Path(args.exclude_file)
        if exclude_path.is_file():
            exclude_set = set()
            for line in exclude_path.read_text().splitlines():
                line = line.strip()
                if line:
                    exclude_set.add(line)
            before = len(audio_files)
            audio_files = [f for f in audio_files
                           if str(f.relative_to(input_dir)) not in exclude_set]
            excluded = before - len(audio_files)
            if excluded:
                print(f"Excluded {excluded} file(s) from encode list")
            if not audio_files:
                print("All files excluded — nothing to encode")
                sys.exit(0)

    # --- Output directory -----------------------------------------------------

    output_dir = Path(args.output_dir).expanduser().resolve()
    latent_root = output_dir / "latents" / model_name
    latent_root.mkdir(parents=True, exist_ok=True)

    # --- Determine GPU count --------------------------------------------------

    if args.device == "cpu":
        num_gpus = 1
    elif args.device.startswith("cuda:"):
        num_gpus = 1   # specific GPU requested
    else:
        num_gpus = torch.cuda.device_count()
        if num_gpus == 0:
            print("No CUDA GPUs found, falling back to CPU")
            args.device = "cpu"
            num_gpus = 1

    if args.num_gpus is not None:
        num_gpus = min(args.num_gpus, num_gpus)

    # --- Read config (no model instantiation yet) -----------------------------

    model_dir   = MODEL_PATHS.get(model_name, _MODELS_DIR / model_name)
    # Use the proper-named files directly under base/. The 'config' / 'ckpt'
    # flat-symlinks in model_dir/ go through one extra hop (to base/...), and
    # calling .resolve() on either now walks all the way to the HF cache's
    # content-addressed blob (no extension!) which breaks load_ckpt_state_dict's
    # if-endswith-.safetensors branch.
    config_path = model_dir / "base" / "model_config.json"
    ckpt_path   = model_dir / "base" / "model.safetensors"

    with open(config_path) as f:
        config = json.load(f)

    model_config   = config.get("model", config)
    sample_rate    = config.get("sample_rate",    model_config.get("sample_rate", 44100))
    sample_size    = config.get("sample_size",    model_config.get("sample_size", 0))
    audio_channels = config.get("audio_channels", model_config.get("audio_channels", 2))
    pretransform_config = model_config["pretransform"]

    # Read latent params directly from config (no need to instantiate model)
    pt_inner = pretransform_config.get("config", {})
    ds_ratio   = pt_inner.get("downsampling_ratio", 2048)
    latent_dim = pt_inner.get("latent_dim", 64)
    scale      = pretransform_config.get("scale", 1.0)

    # Max samples — the pad/crop ceiling for batching.
    # Default: the DATASET's real longest file (header scan), capped at 10 min.
    # The old default padded EVERYTHING to a flat 10 minutes, which multiplied
    # VRAM/compute ~2.5x for typical songs and contributed to OOM-crashing the
    # encode. LoRA training random-crops latents at train time regardless.
    durations = scan_durations(audio_files)
    known = [d for d in durations.values() if d]
    if known:
        print(f"\n  Durations:          {min(known):.0f}s min / {max(known):.0f}s max "
              f"({len(known)}/{len(audio_files)} headers read)")
    if args.max_duration is not None:
        max_samples = int(args.max_duration * sample_rate)
        max_samples = (max_samples // ds_ratio) * ds_ratio
    else:
        cap_s = 600.0  # absolute ceiling, as before
        # +2% +1s margin: VBR headers under-report; never crop real audio.
        data_max_s = (max(known) * 1.02 + 1.0) if known else cap_s
        max_samples = int(min(cap_s, data_max_s) * sample_rate)
        max_samples = ((max_samples + ds_ratio - 1) // ds_ratio) * ds_ratio

    # --- Extract pretransform weights once ------------------------------------
    #
    # The full checkpoint can be 2-5 GB. Rather than having each GPU worker
    # re-read it, we extract just the pretransform weights (~100-500 MB) and
    # save them to a temp file that workers load from.

    weights_path = latent_root / ".pretransform_weights.pt"

    print(f"\nModel:  {model_name} ({MODELS[model_name]})")
    print(f"Input:  {input_dir} ({len(audio_files)} audio files)")
    print(f"Output: {latent_root}")
    print(f"GPUs:   {num_gpus}\n")

    print("Extracting pretransform weights from checkpoint...")
    from underfit.utils import load_ckpt_state_dict
    full_sd = load_ckpt_state_dict(str(ckpt_path))

    prefix = "pretransform."
    pt_sd = {k[len(prefix):]: v for k, v in full_sd.items() if k.startswith(prefix)}
    torch.save(pt_sd, str(weights_path))
    print(f"  {len(pt_sd)} tensors saved to {weights_path}")

    del full_sd, pt_sd
    gc.collect()

    print(f"\n  Sample rate:        {sample_rate} Hz")
    print(f"  Audio channels:     {audio_channels}")
    print(f"  Downsampling:       {ds_ratio}x")
    print(f"  Latent dim:         {latent_dim}")
    print(f"  Pretransform scale: {scale}")
    print(f"  Max duration:       {max_samples / sample_rate:.1f}s ({max_samples:,} samples)")
    print()

    # --- Save encoding details ------------------------------------------------

    details = {
        "model": model_name,
        "sample_rate": sample_rate,
        "audio_channels": audio_channels,
        "downsampling_ratio": ds_ratio,
        "latent_dim": latent_dim,
        "scale": scale,
        "max_samples": max_samples,
        "input_dir": str(input_dir),
        "num_files": len(audio_files),
        "num_gpus": num_gpus,
        "half": args.half,
    }
    with open(latent_root / "details.json", "w") as f:
        json.dump(details, f, indent=2)

    # --- Determine batch size -------------------------------------------------
    #
    # 0 = auto: the shard worker measures REAL per-item VRAM cost by probing
    # the longest file solo, then sizes each length-bucketed batch from that
    # measured cost. The old formula here never worked: it read a nonexistent
    # attribute (`total_mem`; the real one is `total_memory`), silently fell
    # into a 40 GB fallback, and assumed ~2.5 MB/s per item — which is how a
    # 24 GB card got batch 13 x 600 s and hard-crashed the machine.
    if args.batch_size > 0:
        batch_size = args.batch_size
        print(f"  Batch size:         {batch_size} per GPU (forced)")
    elif args.device == "cpu":
        batch_size = 1
        print("  Batch size:         1 (cpu)")
    else:
        batch_size = 0  # auto — VRAM-probed, length-bucketed in the worker
        print("  Batch size:         auto (VRAM-probed, length-bucketed)")
    print()

    # --- Expand files → tasks (one task per file) ---
    tasks = _expand_files_to_tasks(audio_files, input_dir, durations)
    print(f"  Total encoding tasks: {len(tasks)}")
    print()

    # --- Build shared config for workers --------------------------------------

    cfg = {
        "tasks":              tasks,
        "input_dir":          str(input_dir),
        "latent_root":        str(latent_root),
        "weights_path":       str(weights_path),
        "pretransform_config": pretransform_config,
        "sample_rate":        sample_rate,
        "audio_channels":     audio_channels,
        "ds_ratio":           ds_ratio,
        "max_samples":        max_samples,
        "device":             args.device,
        "half":               args.half,
        "force":              args.force,
        "batch_size":         batch_size,
    }

    # --- Run workers ----------------------------------------------------------

    t0 = time.time()

    if num_gpus == 1:
        print("Encoding...")
        encode_shard(0, 1, cfg)
    else:
        print(f"Encoding across {num_gpus} GPUs...")
        mp.spawn(encode_shard, nprocs=num_gpus, args=(num_gpus, cfg), join=True)

    elapsed = time.time() - t0

    # --- Aggregate stats ------------------------------------------------------

    total_encoded = 0
    total_skipped = 0
    total_errors  = 0

    for rank in range(num_gpus):
        stats_path = latent_root / f".stats_{rank}.json"
        if stats_path.exists():
            with open(stats_path) as f:
                s = json.load(f)
            total_encoded += s["encoded"]
            total_skipped += s["skipped"]
            total_errors  += s["errors"]
            stats_path.unlink()

    # Clean up temp weights
    if weights_path.exists():
        weights_path.unlink()

    # --- Summary --------------------------------------------------------------

    total = len(audio_files)
    mins, secs = divmod(int(elapsed), 60)
    print(f"\nDone in {mins}m{secs:02d}s: "
          f"{total_encoded} encoded, {total_skipped} skipped, "
          f"{total_errors} errors  (of {total})")
    print(f"Output: {latent_root}")


if __name__ == "__main__":
    main()
