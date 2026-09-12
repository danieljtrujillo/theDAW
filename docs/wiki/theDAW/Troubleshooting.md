# Troubleshooting

**Static glitch output on the Medium model.** Flash Attention is not installed correctly. Verify it with `uv run python -c "from flash_attn import flash_attn_func; import flash_attn; print(flash_attn.__version__)"`, then re-sync it with `uv sync --reinstall-package flash-attn`. The wheel has to match **torch 2.14 + CUDA 13**, which is what this project pins; `pyproject.toml` selects the `flash_attn-2.8.3+cu130torch2.14-cp3XX-cp3XX-win_amd64.whl` asset for your Python minor from [mjun0812/flash-attention-prebuild-wheels v0.10.2](https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/tag/v0.10.2). A wheel built for any other torch/CUDA pair will not import.

**"API UNREACHABLE" banner.** The backend is not listening on port 8600. Test it with `curl http://localhost:8600/api/health`. On Windows, `.\theDAW.bat` clears stale processes automatically.

**Out-of-memory on the Medium model.** The Medium pipeline needs roughly 8 GB of VRAM. The `small` model, a shorter `duration`, or freeing competing CUDA processes resolves it.

**Library slow or failing to save.** Confirm the backend is running on port 8600, since the list loads once it reports ready, and free disk space if writes begin to fail.

**Magenta sidecar shows empty `port_src/`.** The upstream engine source is a git submodule. Clone theDAW with `--recurse-submodules`, or for the standalone studio use the [release ZIP](https://github.com/gantasmo/magenta-rt2-nvidia/releases/latest).

[User Guide §23](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#23-troubleshooting) has the full matrix.

---

<p align="center"><a href="Modules-and-Sidecars">&lt; Previous: Modules and Sidecars</a></p>
