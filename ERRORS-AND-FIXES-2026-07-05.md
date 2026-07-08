# theDAW error audit and fixes, 2026-07-05

Untracked working document (repo root, not committed). Full repo comb:
4 parallel audit agents (frontend, backend, desktop shell + packaging, config
consistency) plus direct investigation. Every finding below was verified
against the actual code before being accepted; each carries its fix status.

Verification state of the whole working tree after all fixes:
ruff check . PASS, ruff format --check . PASS (repo root, both), frontend tsc
0 errors, electron-ui tsc 0 errors, every touched backend file compiles, and
the new log-ring behavior was exercised functionally (uvicorn capture +
gap-free pagination). Runtime behavior in a PACKAGED build still needs a
rebuilt installer to confirm end to end.

## 1. VJ broken in the Windows exe (user report; ROOT-CAUSED, FIXED)

The exe ships the VJ build and the backend serves it at
http://localhost:8600/vj-app/. Every break was URL composition against the
packaged renderer origin app://. (a custom scheme that cannot serve /vj-app
or carry WebSockets).

1.1 FIXED - VJ iframe URL dead in the exe. VJView resolved '/vj-app/' against
    window.location.origin (= app://.) and the app:// handler only proxied
    /api/*. New frontend/src/lib/backendBase.ts; vjSrc + postMessage origin
    resolve against the backend's real http origin.
1.2 FIXED - ?api= param unusable (app://.); now carries the http base, which
    also makes the VJ app's WebSocket sources (QUEST/STITCH) reachable.
1.3 FIXED - VJ mobile/QR URL was app://<lan-ip>; now always http with the
    right port (8600 in the exe) via lanReachablePort().
1.4 FIXED - Shell Mobile Access link could open a SECOND full copy of the app
    (share URL fell back to app://. when the one-shot lan-ip fetch lost the
    backend-startup race; clicking it opened the whole app in a new window;
    likely the doubled-header sightings in the exe). Fetch now waits for
    backend-ready; fallback is the http base; port fallback fixed.
1.5 FIXED - Electron DEV stack nested the whole app inside the VJ iframe
    (electron.vite.config.ts lacked the /vj-app proxy; Vite SPA-fallback
    served index.html into the iframe; the doubled header in dev). Proxy
    added, matching frontend/vite.config.ts.
1.6 FIXED - app:// handler now proxies /vj-app/* to the backend (electron-ui/
    main/index.ts), so any remaining relative consumer works.
1.7 FIXED - VJ pop-out: isExternal() now treats the backend origin as
    internal, so window.open(vjSrc) opens a real child window with a working
    postMessage handle instead of bouncing to the browser and erroring.

## 2. CRITICAL packaged-app bug found by the audit (FIXED)

2.1 FIXED - Every body-carrying POST/PUT failed in the packaged app.
    electron-ui/main/index.ts app:// /api/* proxy passed a stream body to
    net.fetch without duplex:'half'; the fetch-spec Request constructor
    throws, the request fails with net::ERR_FAILED, renderer sees "Failed to
    fetch". GETs worked, so the app booted and looked healthy. duplex:'half'
    added; both proxy branches also now .catch() into a clean 502 when the
    backend is down. (Verified by cross-reading Electron's net-fetch source;
    needs one packaged-build smoke test of any POST.)

2.2 FIXED - Boot-error bridge class mismatch (bug in the v0.1.2 boot fix):
    Electron main tags failures cls:'err'; the renderer matched only
    'error', so setup failures rendered as info and the error state never
    fired. Renderer accepts both.

2.3 FIXED - Unguarded module-scope fs.mkdirSync + log stream in the Electron
    main crashed the app instantly on read-only mounts (AppImage squashfs,
    running the mac app off the dmg). Now guarded with fallback to the
    per-user logs dir, and stream 'error' events are handled.

2.4 FIXED - runUvSync failures now set a visible "Setup failed" status (the
    spawn still proceeds because uv run can self-heal transient failures; the
    failure is no longer silent).

2.5 FIXED - Quitting mid-first-run orphaned the uv sync child (kept
    downloading, held the venv lock). The child is tracked and killed in
    before-quit; spawnBackend is gated on isQuitting so the quit race can't
    launch an unkillable backend.

## 3. Backend audit (agent; 1 critical, 3 high, 9 medium, 10 low)

3.1 FIXED (critical) - stems sidecar froze the whole event loop: async
    _ensure_client called blocking ensure_running() (dep probe + optional
    15-min install + health polls) directly on the loop; every request
    including /api/health stalled for minutes. Now awaited via
    asyncio.to_thread. Also added: spawn lock (double-spawn race), client
    reset on stop/port change (stale connection-refused client after crash).
3.2 FIXED (high) - VJ static mount decided once at import but routes
    re-evaluated is_static_mode() per request: a dist built mid-session made
    /api/vj/url return a /vj-app/ URL with no mount behind it (404 iframe).
    New static_mount_active() frozen at mount time; router keys off it.
3.3 FIXED (high) - uvicorn error logs (ASGI exception tracebacks) never
    reached the LOG panel: uvicorn's default config sets propagate=False so
    they never hit the root logger. Ring handler now also attaches to the
    "uvicorn" logger. Functionally verified.
3.4 FIXED (high) - Shutdown/Restart buttons orphaned every sidecar (os._exit
    skips atexit; VJ/Foundry node, stems python, questcast, akvj, underfit
    all stayed resident holding ports). New backend/core/teardown.py
    stop_all_sidecars(), called from both the lifespan shutdown and the
    admin exit path.
3.5 FIXED (medium) - `import torchaudio` before the try in the generate job:
    an import failure left the job "queued" forever AND permanently jammed
    the background queue (idle gate never released). Import moved inside.
3.6 FIXED (medium) - failed generations logged nothing (no traceback
    anywhere); now logger.exception with the job id.
3.7 FIXED (medium) - background queue enqueue from threadpool threads raced
    the consumer and could strand a phantom "queued" job blocking that entry
    forever; puts are marshaled via call_soon_threadsafe and jobs register
    only after queueing.
3.8 FIXED (medium) - /api/system-stats and /api/model-info were async but did
    blocking work (first-call torch import ~9.6s, nvidia-smi subprocess every
    poll) on the event loop; both are plain def (threadpool) now.
3.9 FIXED (medium) - stems ensure_running had no lock (double-spawn); see 3.1.
3.10 FIXED (medium) - stems stop() left a stale client; see 3.1.
3.11 FIXED (medium) - VJ npm install ran with no timeout while holding the
    state lock (a hung npm blocked /api/vj/* forever); 600s timeout added,
    output captured to data/logs/vj-sidecar.log. NOTE: foundry/sidecar.py has
    the same pattern and was NOT changed (see section 7).
3.12 FIXED (medium) - a malformed module.json crashed the whole server at
    import (loader parsed outside the try; the enable/disable endpoint
    rewrites these at runtime). Parse moved inside; explicit utf-8.
3.13 FIXED (medium) - module-load log lines never reached the LOG ring (ring
    installed in lifespan, modules load at import). Ring now installs at the
    top of server.py before load_modules; lifespan re-attach kept.
3.14 FIXED (low) - VJ sidecar stdout/stderr went to DEVNULL despite a comment
    claiming capture; both npm install and the dev/preview server now log to
    data/logs/vj-sidecar.log and error messages point at it.
3.15 FIXED (low) - two stale VJ docstrings (nonexistent startup hook;
    /status is documented as spawning via _maybe_auto_spawn).
3.16 FIXED (low) - /api/log cursor skipped records when a burst exceeded one
    page; cursor is now the last returned seq. Verified gap-free.
3.17 FIXED (low) - akvj status() spawned a pyk4a-importing subprocess on
    EVERY UI poll (seconds each); success is now cached.
3.18 FIXED (low) - magenta engine pre-clear failure was logged at DEBUG while
    its failure leads directly to the GPU commit-exhaustion crash it guards
    against; now WARNING.
3.19 FIXED (low) - magenta SIDECAR_URL port parse used rsplit(":") (yields
    "//host" garbage when no port); now urllib urlsplit with 8777 default.
3.20 FIXED (low) - VJ export ffmpeg had no timeout (hung ffmpeg pinned a
    threadpool worker forever); 600s timeout.
3.21 FIXED (low) - kill() without a final wait() left zombies on POSIX in the
    vj, akvj, and questcast sidecars; reaps added.

## 4. Frontend audit (agent)

4.1 FIXED (high) - Library "Download audio" (context menu AND bulk download)
    hit /api/library/{id}/audio, which does not exist (real route:
    /api/library/audio/{id}); every audio download 404'd. Both corrected.
4.2 REFUTED (agent claim, checked against current code) - "SLIDE pop-out
    always popup-blocked in the exe": isExternal() early-returns false for
    non-http URLs, so window.open('') / about:blank is allowed. No change.
4.3 FIXED (medium) - Quest cast preview WebSocket URL used
    window.location.hostname (= '.' under app://), producing ws://.:PORT.
    Now targets localhost under non-http origins.
4.4 NEEDS DECISION - setlistStore.importBundled() GETs /api/library/setlists,
    a route that does not exist anywhere in the backend; the starter-setlists
    feature has never worked and fails silently on every DJ tab mount.
    Options: implement the backend route + ship bundled setlist content, or
    remove the dead call. Not changed (needs your call on the feature).
4.5 FIXED (medium) - "Copy media link" put an app://. URL on the clipboard in
    the exe (useless outside the app); now resolves against the backend http
    base.
4.6 PARTIALLY FIXED (medium, systemic) - native form fields missing id/name/
    label associations: ~93 instances across ~40 files. Fixed the audit's
    concretely cited ones: CatalogueFilterBar (search input + 6 selects, all
    now id+name+aria-label), WaveformEditor marker-rename input,
    vocal2midi AssistantOrb input, SwayPanel's two selects (name added;
    id + sr-only labels already existed). MidiImportPopover was already
    compliant (stale citation). The remaining ~80 need a dedicated mechanical
    sweep touching ~35 files; say the word and it happens as its own pass.
4.7 FIXED (low) - DAW clip import used response.blob() on large media (fails
    outright on a full disk); switched to arrayBuffer + new Blob per the
    repo's own fetchRetry convention. Also fixed a misleading comment citing
    a nonexistent endpoint (tasmoToSession.ts).
Clean: WebSocket clients (xrControl/questMidi/XrBusTester) already app://-
safe; no duplicate React keys; no Tailwind v3 forbidden forms; no interval or
listener leaks; all other ~200 /api/* call sites resolve to real routes.

## 5. Desktop shell + packaging audit (agent)

5.1-5.5 are section 2 items (duplex, cls mismatch, mkdirSync, runUvSync,
    uv-sync orphan).
5.6 FIXED (medium) - install/setup.ps1 Install-Uv reported success even when
    the child powershell failed (only exceptions were caught, exit code never
    checked): the installer loop told the user to re-run forever with a false
    "[OK] uv installed" each pass. $LASTEXITCODE now checked.
5.7 FIXED (medium) - release artifacts depended on the FLOATING head of the
    VJ repo's feat/vj-redesign-vfx branch (fetch-vj-build.mjs + Dockerfile):
    non-reproducible releases, and a merged/deleted branch would break every
    future build including re-cuts of old tags. Both now pin commit
    ff7430b1bf66524cc30e509b56f1e743443798fb (branch head at pin time; bump
    VJ_COMMIT deliberately on VJ updates).
5.8 FIXED (low) - protocol handler rejections now return 502 (section 2.1).
5.9 FIXED (low) - lint.yml comment claimed a pinned checkout while using the
    floating @v5 tag; comment corrected to describe reality.
5.10 FIXED (low) - dead linux/AppImage target removed from electron-builder
    (fetch-runtime-tools exits on linux, no dist:linux script exists, and the
    target could never produce a working artifact; Docker is the linux path).
Clean: wheels chain end to end (all 3 aubio wheels tracked, shipped, hashes
match uv.lock, Docker copies them); every extraResources destination matches
its runtime resolver; theDAW.bat error paths; release.yml artifact plumbing;
single-instance + backend kill chain; WS clients under app://.

## 6. Config/docs consistency audit (agent)

6.1 FIXED (high) - electron-ui/resources/icon.png was gitignored by the
    root *.png rule and NOT tracked, so CI-built installers shipped the
    DEFAULT ELECTRON ICON (local builds masked it because the file exists
    untracked on this machine). .gitignore exception added; the file must be
    git-added with the next commit for the fix to take effect in CI.
6.2 FIXED (low) - lint.yml comment drift (same as 5.9).
Clean: ruff pin in sync (0.15.14 both sites); versions in sync (0.1.2 both);
all 28 RAG DOC_PATHS resolve; USER_GUIDE.md copies byte-identical; ports
agree everywhere (8600/5173/5187/5472); RELEASING.md matches release.yml.
Note: packaged desktop builds log one benign "[RAG] Skipping missing doc:
CLAUDE.md" warning (documented as accepted in backend/rag.py).

## 7. Known issues NOT fixed here, with reasons

- Foundry sidecar npm install has the same no-timeout-under-lock pattern as
  the VJ one (3.11). Left unchanged this pass to keep the churn reviewable;
  same fix applies nearly verbatim.
- ~80 remaining form-field id/name/label instances (4.6): mechanical sweep
  across ~35 files, ready to run as its own pass.
- Bundled setlists endpoint (4.4): needs a product decision.
- backend/core/jobs.py unbounded _jobs dict + dead subscriber machinery, and
  core/sidecar.py GPUSidecar leak-on-timeout: both currently dormant (no live
  callers of the affected paths); flagged, untouched.
- Mac signing/notarization: requires your Apple Developer certificate;
  cannot be done from code alone.
- Blanket Chromium permission grant (main/index.ts:696-697, from the external
  security review): one-line allowlist recommended; left for the next
  Electron-main pass so THIS diff stays focused on breakage. Flag it if you
  want it in now.
- Pyright "code is unreachable" hints in platform-conditional branches
  (sys.platform checks in stems/vj/magenta/akvj sidecars): analyzer artifacts
  of correct cross-platform code, not defects.

## 8. What runtime verification still needs

- A rebuilt Windows exe: VJ tab loads, a generation POST succeeds (2.1), VJ
  pop-out opens as a child window, Mobile Access shows an http LAN URL.
- The LOG panel in VERBOSE showing backend records with [source] tags.
- A packaged first-run with networking blocked: boot screen shows the setup
  error instead of hanging.
- Pinokio reinstall (launcher fix pushed separately to theDAW-Pinokio):
  VJ tab works after install.
