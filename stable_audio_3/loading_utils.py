import json

import torch
from safetensors import safe_open
from safetensors.torch import load_file

from stable_audio_3.factory import (
    create_autoencoder_from_config,
    create_diffusion_cond_from_config,
)


def _is_weight_norm_residue(key: str) -> bool:
    """A weight_norm-shaped key (legacy weight_g/v OR new parametrizations.
    weight.original0/1) is benignly ignorable when the model has no
    matching layer — that happens when the layer became ``nn.Identity()``
    at the current channel widths, while the checkpoint was saved when
    it was still a weight-normed conv. These are NOT real load failures."""
    return (
        key.endswith(".weight_g")
        or key.endswith(".weight_v")
        or key.endswith(".parametrizations.weight.original0")
        or key.endswith(".parametrizations.weight.original1")
    )


def copy_state_dict(model, state_dict):
    """Load state_dict to model, but only for keys that match exactly.

    Args:
        model (nn.Module): model to load state_dict.
        state_dict (OrderedDict): state_dict to load.
    """
    model_state_dict = model.state_dict()
    state_dict = remap_state_dict_keys(state_dict, model_state_dict)
    ignored_params: list[str] = []
    skipped_weight_norm_residue = 0
    for key in state_dict:
        if (
            key in model_state_dict
            and state_dict[key].shape == model_state_dict[key].shape
            and not any(ignored_key in key for ignored_key in ignored_params)
        ):
            if isinstance(state_dict[key], torch.nn.Parameter):
                # backwards compatibility for serialized parameters
                state_dict[key] = state_dict[key].data
            model_state_dict[key] = state_dict[key]
        elif _is_weight_norm_residue(key) and key not in model_state_dict:
            # Identity-shadowed weight_norm tensor — silently skip. Counted
            # so we surface a single summary line at end of load rather
            # than ~N "Key not found" warnings.
            skipped_weight_norm_residue += 1
        else:
            print(
                f"Key {key} not found in target state_dict or shape mismatch. Skipping."
            )

    if skipped_weight_norm_residue:
        print(
            f"[LOAD] {skipped_weight_norm_residue} weight_norm tensor(s) ignored "
            f"(layer became nn.Identity() at current channel widths — benign)."
        )

    model.load_state_dict(model_state_dict, strict=False)


def load_autoencoder(config_path: str, ckpt_path: str, device: str = "cpu"):
    """Load only the autoencoder from a combined DiT+autoencoder checkpoint.

    For .safetensors checkpoints, only pretransform tensors are read from disk,
    directly onto the target device.
    For .ckpt checkpoints, the full state dict is loaded but the DiT is never instantiated.
    """

    with open(config_path) as f:
        config = json.load(f)

    autoencoder = create_autoencoder_from_config(config["model"], config["sample_rate"])

    # ARC checkpoints store autoencoder weights under pretransform.model.*,
    # RF checkpoints use pretransform.* directly, and standalone AE-only checkpoints
    # (e.g. from stabilityai/SAME-L / SAME-S) have no prefix at all.
    prefix = "pretransform."
    arc_prefix = "pretransform.model."
    if ckpt_path.endswith(".safetensors"):
        with safe_open(ckpt_path, framework="pt", device=device) as f:
            all_keys = list(f.keys())
        if any(k.startswith(arc_prefix) for k in all_keys):
            effective_prefix = arc_prefix
        elif any(k.startswith(prefix) for k in all_keys):
            effective_prefix = prefix
        else:
            effective_prefix = (
                ""  # standalone AE checkpoint — all keys belong to the AE
            )
        with safe_open(ckpt_path, framework="pt", device=device) as f:
            state_dict = {
                k[len(effective_prefix) :]: f.get_tensor(k)
                for k in all_keys
                if k.startswith(effective_prefix)
            }
    else:
        full = torch.load(ckpt_path, map_location=device, weights_only=True)[
            "state_dict"
        ]
        if any(k.startswith(arc_prefix) for k in full):
            effective_prefix = arc_prefix
        elif any(k.startswith(prefix) for k in full):
            effective_prefix = prefix
        else:
            effective_prefix = ""
        state_dict = {
            k[len(effective_prefix) :]: v
            for k, v in full.items()
            if k.startswith(effective_prefix)
        }

    copy_state_dict(autoencoder, state_dict)
    return autoencoder.to(device)


def load_diffusion_cond(
    model_config,
    ckpt_path: str,
    device: str = "cuda",
    model_half: bool = False,
):
    import time as _time

    t0 = _time.perf_counter()
    print("[LOAD] Building model graph from config...")
    model = create_diffusion_cond_from_config(model_config)
    print(f"[LOAD] Loading checkpoint: {ckpt_path}")
    state_dict = load_ckpt_state_dict(ckpt_path)
    print("[LOAD] Applying weights to model...")
    copy_state_dict(model, state_dict)
    # Cast to the target dtype BEFORE moving to the device, so only the
    # fp16 model is transferred to the GPU rather than the full fp32 model.
    # Measured A/B on the medium model: torch-reported peak load allocation
    # is 4.65 GB with this order vs 9.35 GB casting after the move, and the
    # generated audio is bit-identical (max|new-old| = 0.0). fp32->fp16
    # rounds identically on CPU or GPU, so the result is unchanged.
    model.eval().requires_grad_(False)
    if model_half:
        print("[LOAD] Converting to float16 (on CPU, before the device move)...")
        model.to(torch.float16)
    print(f"[LOAD] Moving model to {device}...")
    model.to(device)
    elapsed = _time.perf_counter() - t0
    print(f"[LOAD] Model ready in {elapsed:.1f}s")
    return model


def load_ckpt_state_dict(ckpt_path):
    if ckpt_path.endswith(".safetensors"):
        state_dict = load_file(ckpt_path)
    else:
        state_dict = torch.load(ckpt_path, map_location="cpu", weights_only=True)[
            "state_dict"
        ]

    return state_dict


def remap_state_dict_keys(state_dict, model_state_dict):
    """Remap state_dict keys to match model_state_dict keys.

    Handles:

    1. **weight_norm migration** — legacy ``torch.nn.utils.weight_norm``
       stores parameters as ``<module>.weight_g`` (magnitude) and
       ``<module>.weight_v`` (direction). The new
       ``torch.nn.utils.parametrizations.weight_norm`` stores them as
       ``<module>.parametrizations.weight.original0`` /
       ``original1``. Checkpoints saved with either API now load against
       a model built with either API: we translate either direction so
       whichever side has the legacy form gets rewritten to match the
       model.

    2. **Extra nesting strip** (legacy behavior) — ``pretransform.model.*
       → pretransform.*`` and similar one-level prefix peels.
    """
    remapped = {}
    for key, value in state_dict.items():
        if key in model_state_dict:
            remapped[key] = value
            continue

        # weight_norm legacy → parametrizations
        new_key = None
        if key.endswith(".weight_g"):
            cand = key[: -len(".weight_g")] + ".parametrizations.weight.original0"
            if cand in model_state_dict:
                new_key = cand
        elif key.endswith(".weight_v"):
            cand = key[: -len(".weight_v")] + ".parametrizations.weight.original1"
            if cand in model_state_dict:
                new_key = cand
        # weight_norm parametrizations → legacy (opposite direction)
        elif key.endswith(".parametrizations.weight.original0"):
            cand = key[: -len(".parametrizations.weight.original0")] + ".weight_g"
            if cand in model_state_dict:
                new_key = cand
        elif key.endswith(".parametrizations.weight.original1"):
            cand = key[: -len(".parametrizations.weight.original1")] + ".weight_v"
            if cand in model_state_dict:
                new_key = cand

        if new_key is None:
            # Try stripping one level of nesting from each prefix segment
            parts = key.split(".")
            for i in range(1, len(parts)):
                candidate = ".".join(parts[:i]) + "." + ".".join(parts[i + 1 :])
                if candidate in model_state_dict:
                    new_key = candidate
                    break

        remapped[new_key if new_key is not None else key] = value
    return remapped
