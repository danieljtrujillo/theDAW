# theDAW — Magenta RealTime 2 sidecar

theDAW's Magenta features (text→music, MIDI accompaniment, audio-style clone)
call a small GPU sidecar that wraps Google's **magenta-rt 2.0.2** (`MagentaRT2System`).
It runs in **WSL2 on an NVIDIA GPU** (JAX/CUDA); theDAW's backend
(`backend/modules/magenta`) proxies it at `http://localhost:8777`.

`server.py` here supersedes the bundle's text-only `studio_server.py`: it exposes
the model's full conditioning surface (text prompt **+ optional MIDI notes +
optional audio-style clip**) over one `POST /generate`.

The magenta-rt port itself is vendored as the sibling submodule
[`../magenta-rt2-nvidia`](../magenta-rt2-nvidia) (so it comes along on
`git clone --recursive`).

## One-time setup (in WSL2 Ubuntu)

```bash
# 1. magenta-rt + JAX CUDA backend (the port is the sibling submodule)
uv venv ~/mrt2/.venv && source ~/mrt2/.venv/bin/activate
uv pip install "magenta-rt" "jax[cuda12]" numpy
# 2. model assets (MusicCoCa + SpectroStream + checkpoint)
mrt models init
mrt checkpoints download mrt2_small.safetensors
# 3. this sidecar's web deps
uv pip install -r /mnt/<drive>/.../stable-audio-3/sidecars/magenta/requirements.txt
```

## Run

**The normal path is in-app: no terminal.** Picking **Magenta RT2** in the MAKE
Model dropdown calls `POST /api/magenta/engine/start`, which parks the Stable
Audio model in CPU RAM, stops any other MRT2 engine, and spawns this server in
WSL2 (distro from `../magenta-rt2-nvidia/app/.wsl_distro`, venv
`~/mrt2/.venv`, both overridable with `STABLEDAW_MAGENTA_WSL_PY` /
`STABLEDAW_MAGENTA_MODEL`). A pill beside the dropdown tracks LOADING → READY.
Picking a Stable Audio model calls `POST /api/magenta/engine/stop` and restores
Stable Audio to the GPU.

Manual run (debugging, or a remote GPU):

```bash
MRT2_MODEL=mrt2_small python /mnt/<drive>/.../stable-audio-3/sidecars/magenta/server.py
# -> serving http://0.0.0.0:8777   (WSL2 forwards localhost to Windows)
```

`GET /health` reports `{app: "mrt2-extended", ready, model, device}`. theDAW's
probe checks the `app` identity so the bundle's JSON-protocol `studio_server.py`
is never mistaken for this server. Override the URL the backend uses with
`STABLEDAW_MAGENTA_URL`.

`mrt2_base` needs more VRAM than a single consumer GPU — run it on a cloud GPU and
point `STABLEDAW_MAGENTA_URL` at it.
