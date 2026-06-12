import json
import os
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from huggingface_hub import hf_hub_download, try_to_load_from_cache

logger = logging.getLogger(__name__)


# ── Resolution events ────────────────────────────────────────────────────────
# Every model/checkpoint resolution decision is recorded here AND logged to the
# console, so it is always visible exactly where a file came from (local
# folder, HF cache, fresh download) and when a download is about to happen.
# The backend surfaces these events to the UI (/api/model/load response and
# /api/storage/resolution-log).

_RESOLUTION_EVENTS: list[dict] = []
_RESOLUTION_CAP = 200
_resolution_lock = threading.Lock()
_resolution_seq = 0


def note_resolution(
    label: str,
    source: str,
    *,
    path: str | None = None,
    repo_id: str | None = None,
    detail: str | None = None,
    level: int = logging.INFO,
) -> None:
    """Record + log one resolution decision.

    source: 'local-folder' | 'local-checkpoint' | 'hf-cache' |
            'download-start' | 'downloaded' | 'download-needed'
    """
    global _resolution_seq
    parts = [f"model resolve: {label} <- {source}"]
    if path:
        parts.append(path)
    if detail:
        parts.append(f"({detail})")
    logger.log(level, " ".join(parts))
    with _resolution_lock:
        _resolution_seq += 1
        _RESOLUTION_EVENTS.append(
            {
                "seq": _resolution_seq,
                "ts": time.time(),
                "label": label,
                "source": source,
                "path": path,
                "repo_id": repo_id,
                "detail": detail,
            }
        )
        del _RESOLUTION_EVENTS[:-_RESOLUTION_CAP]


def resolution_events(since_seq: int = 0) -> list[dict]:
    with _resolution_lock:
        return [e for e in _RESOLUTION_EVENTS if e["seq"] > since_seq]


def resolution_seq() -> int:
    with _resolution_lock:
        return _resolution_seq


def _resolve_one_file(repo_id: str, filename: str) -> str:
    """Resolve one repo file local-first, recording every step."""
    local = _local_override(repo_id, filename)
    if local is not None:
        note_resolution(
            f"{repo_id}/{filename}", "local-folder", path=local, repo_id=repo_id
        )
        return local
    cached = try_to_load_from_cache(repo_id, filename)
    if isinstance(cached, str):
        note_resolution(
            f"{repo_id}/{filename}", "hf-cache", path=cached, repo_id=repo_id
        )
        return cached
    note_resolution(
        f"{repo_id}/{filename}",
        "download-start",
        repo_id=repo_id,
        detail=f"not in any local folder or the HF cache -> downloading from https://huggingface.co/{repo_id}",
        level=logging.WARNING,
    )
    t0 = time.perf_counter()
    downloaded = hf_hub_download(repo_id=repo_id, filename=filename)
    note_resolution(
        f"{repo_id}/{filename}",
        "downloaded",
        path=downloaded,
        repo_id=repo_id,
        detail=f"{time.perf_counter() - t0:.1f}s",
    )
    return downloaded


def _local_search_dirs() -> list[Path]:
    """Directories to search for locally-cloned model repos, in priority order."""
    dirs: list[Path] = []
    env = os.environ.get("SA3_LOCAL_MODELS_DIR")
    if env:
        dirs.extend(Path(p) for p in env.split(os.pathsep) if p)

    project_root = Path(__file__).resolve().parents[1]
    cfg_file = project_root / "local_models.txt"
    if cfg_file.is_file():
        for line in cfg_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                dirs.append(Path(line))

    default_models_dir = project_root / "models"
    if default_models_dir.is_dir():
        dirs.append(default_models_dir)

    return dirs


def _local_override(repo_id: str, filename: str) -> str | None:
    """Look for a model file below each configured local model directory."""
    repo_name = repo_id.split("/", 1)[-1]
    alt_filenames = [filename]

    if filename == "model_config.json":
        alt_filenames.extend(
            [
                f"{repo_name}-ARC.json",
                f"{repo_name}-RF.json",
                f"{repo_name}.json",
            ]
        )
    elif filename == "model.safetensors":
        alt_filenames.extend(
            [
                f"{repo_name}-ARC.safetensors",
                f"{repo_name}-RF.safetensors",
                f"{repo_name}.safetensors",
            ]
        )

    for base in _local_search_dirs():
        for name in alt_filenames:
            candidate = base / repo_name / name
            if candidate.is_file():
                logger.info("Using local model file: %s", candidate)
                return str(candidate)
    return None


def _is_model_config_json(path: Path) -> bool:
    """Cheap sanity check that a JSON file is a model config, not metadata."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return isinstance(data, dict) and "model_type" in data
    except (OSError, ValueError):
        return False


def resolve_local_checkpoint(
    path_str: str, quiet: bool = False
) -> tuple[str, str] | None:
    """Resolve a user-supplied checkpoint (folder or .safetensors file) to (config, ckpt).

    Accepts either a folder holding a model config JSON plus a .safetensors
    checkpoint, or a direct path to the .safetensors file with the config
    alongside it. Returns None when the layout is missing or ambiguous
    (several checkpoints in one folder and none named model.safetensors).
    ``quiet=True`` skips the resolution-event record (validity probes).
    """
    p = Path(str(path_str)).expanduser()
    if p.is_file() and p.suffix == ".safetensors":
        ckpt = p
        folder = p.parent
    elif p.is_dir():
        folder = p
        preferred = folder / "model.safetensors"
        if preferred.is_file():
            ckpt = preferred
        else:
            candidates = sorted(folder.glob("*.safetensors"))
            if len(candidates) != 1:
                return None
            ckpt = candidates[0]
    else:
        return None

    config_candidates = [
        ckpt.with_suffix(".json"),
        folder / "model_config.json",
        *sorted(folder.glob("*.json")),
    ]
    for candidate in config_candidates:
        if candidate.is_file() and _is_model_config_json(candidate):
            if not quiet:
                note_resolution(
                    str(ckpt.name),
                    "local-checkpoint",
                    path=str(ckpt),
                    detail=f"config {candidate}",
                )
            return str(candidate), str(ckpt)
    return None


def resolve_local_repo_path(repo_id: str, subfolder: str | None = None) -> str | None:
    """Resolve a local repo path from configured search dirs."""
    repo_name = repo_id.split("/", 1)[-1]
    for base in _local_search_dirs():
        candidate = base / repo_name
        if subfolder:
            candidate = candidate / subfolder
        if candidate.is_dir():
            logger.info("Using local repo path: %s", candidate)
            return str(candidate)
    return None


@dataclass(frozen=True)
class ModelConfig:
    repo_id: str
    config_path: str
    ckpt_path: str

    def resolve(self):
        """Return local paths for config + checkpoint, falling back to HF Hub unless local-only is set."""
        local_only = os.environ.get("SA3_LOCAL_ONLY", "0").strip().lower() in {
            "1",
            "true",
            "yes",
        }
        local_config = _local_override(self.repo_id, self.config_path)
        local_ckpt = _local_override(self.repo_id, self.ckpt_path)

        if local_only and (local_config is None or local_ckpt is None):
            note_resolution(
                f"{self.repo_id}",
                "download-needed",
                repo_id=self.repo_id,
                detail="blocked: local-only mode is ON and the files are not on disk",
                level=logging.WARNING,
            )
            raise FileNotFoundError(
                f"SA3_LOCAL_ONLY=1 and local model files were not found for repo {self.repo_id}. "
                f"Expected files: {self.config_path}, {self.ckpt_path}. "
                f"Search dirs: {[str(p) for p in _local_search_dirs()]}"
            )

        if local_config is not None:
            note_resolution(
                f"{self.repo_id}/{self.config_path}",
                "local-folder",
                path=local_config,
                repo_id=self.repo_id,
            )
        else:
            local_config = _resolve_one_file(self.repo_id, self.config_path)

        if local_ckpt is not None:
            note_resolution(
                f"{self.repo_id}/{self.ckpt_path}",
                "local-folder",
                path=local_ckpt,
                repo_id=self.repo_id,
            )
        else:
            local_ckpt = _resolve_one_file(self.repo_id, self.ckpt_path)

        return local_config, local_ckpt


@dataclass(frozen=True)
class AutoencoderModelConfig:
    """Config for a standalone autoencoder HF repo (e.g. stabilityai/SAME-S)."""

    ae_repo_id: str
    ae_config_path: str
    ae_ckpt_path: str
    stable_audio_3: tuple[ModelConfig, ...]

    def resolve(self):
        """Return (config_path, ckpt_path), preferring local/full Stable Audio 3 checkpoints."""
        local_only = os.environ.get("SA3_LOCAL_ONLY", "0").strip().lower() in {
            "1",
            "true",
            "yes",
        }
        local_config = _local_override(self.ae_repo_id, self.ae_config_path)
        local_ckpt = _local_override(self.ae_repo_id, self.ae_ckpt_path)
        if local_config and local_ckpt:
            note_resolution(
                f"{self.ae_repo_id} (config+ckpt)",
                "local-folder",
                path=local_ckpt,
                repo_id=self.ae_repo_id,
            )
            return local_config, local_ckpt

        for fallback in self.stable_audio_3:
            local_fallback_ckpt = _local_override(fallback.repo_id, fallback.ckpt_path)
            cached_config = _local_override(fallback.repo_id, fallback.config_path)
            if cached_config is None:
                cached_config = try_to_load_from_cache(
                    fallback.repo_id, fallback.config_path
                )
            cached_ckpt = local_fallback_ckpt
            if cached_ckpt is None:
                cached_ckpt = try_to_load_from_cache(
                    fallback.repo_id, fallback.ckpt_path
                )
            if isinstance(cached_config, str) and isinstance(cached_ckpt, str):
                note_resolution(
                    f"{self.ae_repo_id} (via full checkpoint {fallback.repo_id})",
                    "local-folder" if local_fallback_ckpt else "hf-cache",
                    path=cached_ckpt,
                    repo_id=fallback.repo_id,
                    detail="autoencoder weights reused from an already-present full checkpoint",
                )
                return cached_config, cached_ckpt

        if local_only:
            note_resolution(
                f"{self.ae_repo_id}",
                "download-needed",
                repo_id=self.ae_repo_id,
                detail="blocked: local-only mode is ON and the files are not on disk",
                level=logging.WARNING,
            )
            raise FileNotFoundError(
                f"SA3_LOCAL_ONLY=1 and local autoencoder files were not found for repo {self.ae_repo_id}. "
                f"Expected files: {self.ae_config_path}, {self.ae_ckpt_path}. "
                f"Search dirs: {[str(p) for p in _local_search_dirs()]}"
            )

        local_config = _resolve_one_file(self.ae_repo_id, self.ae_config_path)
        local_ckpt = _resolve_one_file(self.ae_repo_id, self.ae_ckpt_path)
        return local_config, local_ckpt


rf_models: dict[str, ModelConfig] = {
    "small-rf": ModelConfig(
        "stabilityai/stable-audio-3-small",
        "stable-audio-3-small-RF.json",
        "stable-audio-3-small-RF.safetensors",
    ),
    "medium-rf": ModelConfig(
        "stabilityai/stable-audio-3-medium",
        "stable-audio-3-medium-RF.json",
        "stable-audio-3-medium-RF.safetensors",
    ),
}

arc_models: dict[str, ModelConfig] = {
    "small": ModelConfig(
        "stabilityai/stable-audio-3-small",
        "stable-audio-3-small-ARC.json",
        "stable-audio-3-small-ARC.safetensors",
    ),
    "medium": ModelConfig(
        "stabilityai/stable-audio-3-medium",
        "stable-audio-3-medium-ARC.json",
        "stable-audio-3-medium-ARC.safetensors",
    ),
}

models: dict[str, ModelConfig] = {
    "small-music": ModelConfig(
        "stabilityai/stable-audio-3-small-music",
        "model_config.json",
        "model.safetensors",
    ),
    "small-music-base": ModelConfig(
        "stabilityai/stable-audio-3-small-music-base",
        "model_config.json",
        "model.safetensors",
    ),
    "small-sfx": ModelConfig(
        "stabilityai/stable-audio-3-small-sfx",
        "model_config.json",
        "model.safetensors",
    ),
    "small-sfx-base": ModelConfig(
        "stabilityai/stable-audio-3-small-sfx-base",
        "model_config.json",
        "model.safetensors",
    ),
    "medium-base": ModelConfig(
        "stabilityai/stable-audio-3-medium-base",
        "model_config.json",
        "model.safetensors",
    ),
}

# Stable Audio 3 full-model configs to probe before downloading AE-only repos.
_small_stable_audio_3: tuple[ModelConfig, ...] = (
    arc_models["small"],
    rf_models["small-rf"],
    models["small-music"],
    models["small-sfx"],
)
_medium_stable_audio_3: tuple[ModelConfig, ...] = (
    arc_models["medium"],
    rf_models["medium-rf"],
)

ae_models: dict[str, AutoencoderModelConfig] = {
    "same-s": AutoencoderModelConfig(
        ae_repo_id="stabilityai/SAME-S",
        ae_config_path="SAME-S.json",
        ae_ckpt_path="SAME-S.safetensors",
        stable_audio_3=_small_stable_audio_3,
    ),
    "same-l": AutoencoderModelConfig(
        ae_repo_id="stabilityai/SAME-L",
        ae_config_path="SAME-L.json",
        ae_ckpt_path="SAME-L.safetensors",
        stable_audio_3=_medium_stable_audio_3,
    ),
}

base_models: dict[str, ModelConfig] = {
    k: v for k, v in models.items() if k.endswith("-base")
}

all_models: dict[str, ModelConfig | AutoencoderModelConfig] = {
    **models,
    **rf_models,
    **arc_models,
    **ae_models,
}
