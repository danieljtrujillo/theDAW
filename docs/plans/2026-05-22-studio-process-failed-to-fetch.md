# Studio `/api/studio/process` — "Failed to fetch" on large uploads

**Reported symptom (in-app log + browser console):**

```
11:55:09 [studio] Processing: effect=sub_exciter format=wav source=14 - Just Give Up.wav (64324KB)
11:55:10 [studio] Failed to fetch
[vite] connected.
:5173/api/studio/process:1 Failed to load resource: net::ERR_FAILED
```

Source file: ~62.8 MB WAV. Failure occurs ~1 second after submission.
Effect (`sub_exciter`) is a pure-FFmpeg pipeline that does **not** touch the
DiT / SAME models, so model state is not relevant to this failure.

---

## 1. What I verified by reading the code

### 1.1 The endpoint exists and is wired

- [backend/modules/effects/router.py:279-385](../../backend/modules/effects/router.py#L279-L385) defines `@router.post("/process")`.
- [backend/modules/effects/module.json](../../backend/modules/effects/module.json) sets `api_prefix: /api/studio`, so the full path is `/api/studio/process`.
- [backend/modules/loader.py:34-39](../../backend/modules/loader.py#L34-L39) imports the router and calls `app.include_router(router, prefix=prefix)`.
- [backend/server.py:65](../../backend/server.py#L65) runs the loader at module-import time.

The route is reachable; this is not a routing mistake.

### 1.2 The frontend request is well-formed

- [frontend/src/state/studioStore.ts:71-81](../../frontend/src/state/studioStore.ts#L71-L81) builds a `FormData` with fields `audio` (File), `effect`, `params`, `output_format` and POSTs to `/api/studio/process` with no `AbortSignal` and no client-side timeout.
- The `[studio] Processing:` log fires *before* `fetch()` is awaited, so the failure happens during the upload/response phase, not before submission.

### 1.3 The Vite dev-proxy timeouts are disabled

- [frontend/vite.config.ts:23-32](../../frontend/vite.config.ts#L23-L32):
  ```ts
  proxy: {
    '/api': {
      target: 'http://localhost:8600',
      changeOrigin: true,
      timeout: 0,
      proxyTimeout: 0,
    },
  },
  ```
  Both `timeout` and `proxyTimeout` are set to 0. `http-proxy@1.18.1` (the
  copy bundled by vite@6.4.2 in `frontend/node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js`)
  treats `0` as "disabled" for both. The proxy is not the source of the 1-second cutoff.

### 1.4 Starlette does **not** size-limit file parts

`starlette==0.52.1` is installed (`.venv/Lib/site-packages/starlette/formparsers.py`).
Reading the `MultiPartParser` confirms:

- Class default `max_part_size = 1024 * 1024` (1 MB).
- `on_part_data` (lines 160-167) only enforces `max_part_size` for **text fields**
  (`self._current_part.file is None`). File parts are appended to
  `self._file_parts_to_write` and streamed to a `SpooledTemporaryFile` with no size cap.

So the 62 MB upload itself is **not** rejected by Starlette's
`max_part_size`. (The `effect` / `params` / `output_format` text fields are
all well under 1 MB, so they don't trip the limit either.)

### 1.5 The handler streams the upload to disk correctly

[backend/modules/effects/router.py:330-332](../../backend/modules/effects/router.py#L330-L332):

```python
with open(input_path, "wb") as f:
    while chunk := await audio.read(1 << 20):
        f.write(chunk)
```

FFmpeg is launched via `asyncio.create_subprocess_exec` with a 600 s
timeout, and the response is streamed back via `FileResponse(...,
background=cleanup)`. The handler itself does not introduce a 1-second
failure window.

### 1.6 The in-app log store does not persist across reloads

[frontend/src/state/logStore.ts](../../frontend/src/state/logStore.ts) — plain
in-memory zustand, no `persist` middleware, no `console.log` mirror.

This matters because the user sees `[studio] Processing` **and**
`[studio] Failed to fetch` together in the panel. If the page had reloaded
mid-fetch, the `Processing` entry would be gone. Conclusion: **the tab did
not reload** — the `[vite] connected.` line is an HMR reconnect, not a
page navigation. (`hmr` defaults to `false` unless `ENABLE_HMR=true`, but
once HMR is on, a brief drop/reconnect prints exactly this line.)

---

## 2. What `net::ERR_FAILED` + "TypeError: Failed to fetch" mean here

In Chromium, `net::ERR_FAILED` on a POST that never received a response
header maps to one of:

1. **TCP connection refused** — nothing listening on `localhost:8600`, so the
   Vite proxy returns a 500/aborted socket.
2. **TCP connection reset mid-stream** — uvicorn (or the OS) closed the
   socket while the body was still uploading. This is what a backend crash,
   uvicorn worker exit, or process kill looks like from the browser.
3. **Network/abort at the OS layer** — Windows firewall / AV intervening,
   or an `AbortController.abort()`. The frontend code uses neither.

A clean HTTP error (413, 400, 500…) from Starlette/Uvicorn would arrive as
`response.ok === false`, not as `TypeError: Failed to fetch`. So the
**backend never sent response headers** for this request. That rules out
in-handler exceptions (those produce a 500 with a JSON body) and rules out
Starlette's `MultiPartException` (that produces a 400 with a JSON body).

The remaining viable causes are (1), (2), or — less likely — (3).

---

## 3. What I cannot determine without the backend window

The `start-dev.bat` script launches the backend in a separate
`"SA3 Backend"` cmd window
([start-dev.bat:22](../../start-dev.bat#L22)). The decisive piece of
evidence is whatever uvicorn printed in that window between 11:55:09 and
11:55:10. Specifically:

- Is the uvicorn process still alive? (Did `python -m backend.run` exit?)
- Did `[2026-05-22 11:55:0X] [stable-audio-3] WARNING/ERROR` lines appear?
- Did Windows print `MemoryError` / `CUDA out of memory` / `OSError` /
  `ConnectionResetError` near that timestamp?

That window is the single source that distinguishes "backend dead" from
"backend reset the socket" from "everything fine, network glitch."

There is **one strong reason to suspect the backend isn't healthy at all**:
[backend/server.py:66](../../backend/server.py#L66) sets
`DEFAULT_GENERATION_MODEL = "medium"` and [server.py:491-493](../../backend/server.py#L491-L493)
loads it **synchronously inside an async startup hook**:

```python
@app.on_event("startup")
async def load_model():
    _get_or_load_generation_pipeline(DEFAULT_GENERATION_MODEL)
```

On low-VRAM GPUs, the `medium` checkpoint can OOM. If startup raised, uvicorn on
the installed version (`uvicorn>=0.42` per `pyproject.toml`) exits with a
non-zero code and the process is gone — every subsequent `/api/*` request
would hit ECONNREFUSED at the proxy. This is consistent with the
observed 1-second failure, but **I cannot confirm it without seeing the
SA3 Backend console**.

---

## 4. Proposed fixes — only the ones I can justify

I am limiting this section to fixes I can defend from the code I read.
The actual root cause must still be confirmed against the backend window.

### Fix A (high confidence, independent of root cause): change the startup default away from `medium`

**Why:** the user's hardware cannot load `medium` (recorded in
`memory/user_hardware.md`). Even if the current failure isn't startup OOM,
this default is wrong for this machine and will cause the same class of
"all /api/* requests get ERR_FAILED" symptom every time the dev stack
restarts. The studio endpoint doesn't need the generation model at all,
so a failed-or-missing default model should not break it.

**Change** [backend/server.py:66](../../backend/server.py#L66):

```python
DEFAULT_GENERATION_MODEL = "medium"
```

→ keep `"medium"` as the documented preferred default, but make the startup
loader **non-fatal**:

```python
@app.on_event("startup")
async def load_model():
    try:
        _get_or_load_generation_pipeline(DEFAULT_GENERATION_MODEL)
    except Exception as e:
        logger.warning(
            "Default generation model %r failed to load at startup: %s — "
            "the server will run and /api/studio/* + /api/health will still "
            "work; generation endpoints will return 503 until a model is loaded.",
            DEFAULT_GENERATION_MODEL,
            e,
        )

    # ... existing RAG init block unchanged ...
```

Notes:
- The existing `/api/generate*` handlers already gate on `if not pipeline: return 503`, so this change is safe — they keep the same contract.
- This is the minimum change that makes the failure mode visible (a single
  log line) instead of taking down the whole API surface.

### Fix B (high confidence, independent of root cause): bind on `127.0.0.1`, not `0.0.0.0`, for the dev launcher — only if exposing to LAN is not desired

[backend/run.py:12](../../backend/run.py#L12) currently has `host="0.0.0.0"`,
while the Vite proxy targets `http://localhost:8600`. On Windows 11 with
Node ≥17, `localhost` is resolved via the OS resolver and may try `::1`
first; `0.0.0.0` only binds IPv4. Node falls back to IPv4 on its own, so
this *usually* still works, but it adds a measurable connect delay and an
extra failure surface.

If LAN access isn't required (the launcher already exposes a localtunnel
for sharing, so it usually isn't), changing `host="0.0.0.0"` →
`host="127.0.0.1"` removes the IPv6-first stall. This is a one-line change
and I am confident it doesn't break the current dev workflow — but I am
**not** confident it's the cause of this specific failure, so apply only
as cleanup.

### Fix C (high confidence, independent of root cause): teach the studio handler to enforce a sane upload size **before** spooling 60+ MB to disk

Currently the studio handler accepts an unbounded upload. If the real
cause turns out to be RST during a long upload (cause #2 in §2), at least
this guards the handler against accidentally consuming gigabytes of
`%TEMP%` while diagnosing.

Apply at the top of `studio_process` in
[backend/modules/effects/router.py:280](../../backend/modules/effects/router.py#L280):

```python
MAX_STUDIO_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB

content_length = audio.size or 0
if content_length and content_length > MAX_STUDIO_UPLOAD_BYTES:
    raise HTTPException(
        status_code=413,
        detail=f"Audio exceeds {MAX_STUDIO_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
    )
```

`UploadFile.size` is populated by Starlette during spooling, so this
returns 413 cleanly rather than ERR_FAILED. This does not by itself fix
the reported failure (62 MB < 200 MB), but it converts future related
failures into legible HTTP errors instead of dropped sockets.

### Diagnostic step — required before any other fix

Open the **SA3 Backend** cmd window and re-trigger the same upload. The
next status line printed there is the actual answer to "what happened":

- If the window is **gone** or shows a `Traceback` followed by no further
  output → backend crashed (likely the `medium` OOM described above). Fix
  A is the correct response.
- If the window shows `INFO: ... "POST /api/studio/process HTTP/1.1" 4xx/5xx`
  → the handler ran and returned a real HTTP status. The frontend log was
  misleading; check `response.status` and `response.text()` paths in
  [studioStore.ts:83-85](../../frontend/src/state/studioStore.ts#L83-L85).
- If the window shows `ConnectionResetError`, `BrokenPipeError`, or
  `RuntimeError: Event loop is closed` near the timestamp → the connection
  was killed from outside (AV, firewall, or a sync block in the event loop).

I deliberately stop here. I do **not** propose changes to Starlette's
`max_part_size`, the Vite proxy config, uvicorn's body limits, or the
spooled-file path, because none of the verified code paths point to those
as the cause of this specific symptom.
