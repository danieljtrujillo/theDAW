# Windows Troubleshooting

Common issues and fixes specific to running Stable Audio 3 on Windows.

---

## torchaudio: "Couldn't find appropriate backend"

**Symptom:**
```
RuntimeError: Couldn't find appropriate backend to handle uri output.wav and format None.
```

**Cause:** torchaudio has no audio I/O backend installed. `soundfile` is now a
base dependency, so `uv sync` installs it automatically; this only appears if a
custom or partial environment dropped it.

**Fix:**
```powershell
uv pip install soundfile
```

---

## PyTorch installed without CUDA

**Symptom:**
```python
>>> torch.cuda.is_available()
False
>>> torch.__version__
'2.7.1+cpu'
```

**Cause:** `uv sync` resolved CPU torch instead of the CUDA build. On Windows,
`pyproject.toml` maps torch to the cu128 index automatically, so this usually
means a custom index, an offline cache, or a non-Windows resolution interfered.

**Fix:**
```powershell
uv pip install torch==2.7.1+cu128 torchaudio==2.7.1+cu128 --index-url https://download.pytorch.org/whl/cu128 --reinstall
```

---

## Flash Attention won't install / build fails

**Symptom:** `pip install flash-attn` fails with C++ compilation errors or
missing MSVC/CUDA toolkit.

**Cause:** flash-attn has no official Windows wheels. Building from source
requires Visual Studio Build Tools with MSVC and the matching CUDA toolkit.

**Fix:** Use pre-built wheels. Match your Python version:

| Python | Wheel |
|--------|-------|
| 3.10 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp310-cp310-win_amd64.whl` |
| 3.11 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp311-cp311-win_amd64.whl` |
| 3.12 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp312-cp312-win_amd64.whl` |
| 3.13 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp313-cp313-win_amd64.whl` |

Download from: https://github.com/kingbri1/flash-attention/releases/tag/v2.8.3

```powershell
uv pip install https://github.com/kingbri1/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp310-cp310-win_amd64.whl
```

**Important:** Your PyTorch CUDA version must match the wheel. These wheels
require cu128, so use `torch==2.7.1+cu128`.

---

## HF download hangs / lock file errors

**Symptom:**
```
Still waiting to acquire lock on ...\.cache\huggingface\hub\.locks\models--stabilityai--stable-audio-3-medium\....lock
```

**Cause:** A previous download process crashed or was killed, leaving stale
lock files. Or multiple download processes are running simultaneously.

**Fix:**
1. Kill all Python processes:
   ```powershell
   Get-Process python* | Stop-Process -Force
   ```
2. Delete the lock directory:
   ```powershell
   Remove-Item "$env:USERPROFILE\.cache\huggingface\hub\.locks\models--stabilityai--stable-audio-3-medium" -Recurse -Force
   ```
3. Retry the download (single process only).

---

## winget not found in PowerShell

**Symptom:**
```
winget: The term 'winget' is not recognized
```

**Cause:** winget is installed but not on PATH in your current shell session
(common in VS Code terminals, SSH sessions, etc.).

**Fix:** Use the full path:
```powershell
& "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe" install git-xet
```

---

## git clone of HF repo fails with "Password authentication not supported"

**Symptom:**
```
remote: Password authentication in git is no longer supported.
fatal: Authentication failed
```

**Fix:** Use your HF token as the password. Your token is stored at
`%USERPROFILE%\.cache\huggingface\token`.

Option 1 — Use `hf download` instead (recommended):
```powershell
hf download stabilityai/stable-audio-3-medium
```

Option 2 — Clone with token in URL:
```powershell
git clone https://YOUR_USERNAME:YOUR_HF_TOKEN@huggingface.co/stabilityai/stable-audio-3-medium
```

---

## Output audio is static / glitchy (Medium model)

**Cause:** Flash Attention not installed or not working correctly.

**Verify:**
```powershell
.\.venv\Scripts\python.exe -c "import flash_attn; from flash_attn import flash_attn_func; print('OK:', flash_attn.__version__)"
```

If this errors, reinstall flash-attn (see above).

## `theDAW.bat` fails immediately, or "X is not recognized"

**Cause:** A required tool isn't on PATH. The launcher preflights uv/node/npm and
bootstraps the venv + `node_modules`, but it can't run if those tools are missing.

**Fix by what's reported missing:**

- **`uv`** — install from <https://docs.astral.sh/uv/getting-started/installation/>, then reopen the terminal.
- **`node` / `npm`** — install Node.js **v20.19+ or v22.12+** from <https://nodejs.org/> (npm ships with it). An older Node also makes Vite 7 crash with an opaque error; check `node -v`.
- **`ffmpeg`** — `winget install Gyan.FFmpeg`, or a build from <https://www.gyan.dev/ffmpeg/builds/> with its `bin\` on PATH. The launcher only warns about this one; the servers start, but every audio effect, export, and library ingest fails until FFmpeg is present.
- **`lt` (localtunnel)** — optional. The launcher skips the public tunnel when it's absent; run `npm i -g localtunnel` if you want the shareable link.

After installing a tool, open a NEW terminal so PATH refreshes, then re-run `theDAW.bat`.
