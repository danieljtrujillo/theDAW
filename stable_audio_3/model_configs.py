import os
from dataclasses import dataclass
from pathlib import Path

from huggingface_hub import hf_hub_download, try_to_load_from_cache


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
                print(f"[stable_audio_3] using local model file: {candidate}")
                return str(candidate)
    return None


def resolve_local_repo_path(repo_id: str, subfolder: str | None = None) -> str | None:
    """Resolve a local repo path from configured search dirs."""
    repo_name = repo_id.split("/", 1)[-1]
    for base in _local_search_dirs():
        candidate = base / repo_name
        if subfolder:
            candidate = candidate / subfolder
        if candidate.is_dir():
            print(f"[stable_audio_3] using local repo path: {candidate}")
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
            raise FileNotFoundError(
                f"SA3_LOCAL_ONLY=1 and local model files were not found for repo {self.repo_id}. "
                f"Expected files: {self.config_path}, {self.ckpt_path}. "
                f"Search dirs: {[str(p) for p in _local_search_dirs()]}"
            )

        if local_config is None:
            local_config = try_to_load_from_cache(self.repo_id, self.config_path)
        if not isinstance(local_config, str):
            local_config = hf_hub_download(repo_id=self.repo_id, filename=self.config_path)

        if local_ckpt is None:
            local_ckpt = try_to_load_from_cache(self.repo_id, self.ckpt_path)
        if not isinstance(local_ckpt, str):
            local_ckpt = hf_hub_download(repo_id=self.repo_id, filename=self.ckpt_path)

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
            return local_config, local_ckpt

        for fallback in self.stable_audio_3:
            try:
                cached_config, cached_ckpt = fallback.resolve()
            except FileNotFoundError:
                continue
            if isinstance(cached_config, str) and isinstance(cached_ckpt, str):
                return cached_config, cached_ckpt

        if local_only:
            raise FileNotFoundError(
                f"SA3_LOCAL_ONLY=1 and local autoencoder files were not found for repo {self.ae_repo_id}. "
                f"Expected files: {self.ae_config_path}, {self.ae_ckpt_path}. "
                f"Search dirs: {[str(p) for p in _local_search_dirs()]}"
            )

        local_config = hf_hub_download(repo_id=self.ae_repo_id, filename=self.ae_config_path)
        local_ckpt = hf_hub_download(repo_id=self.ae_repo_id, filename=self.ae_ckpt_path)
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
