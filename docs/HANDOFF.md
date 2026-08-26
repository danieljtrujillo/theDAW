# Handoff

Branch: `dev/audit-p0-notation-2026-08`. Read `docs/BACKLOG.md` first. It is the source of truth:
106 audited items plus user-requested additions, stable permanent ids, priority and effort on every
line.

## Where things stand

`docs/BACKLOG.md` P0 section: 7 ticked, 4 open. Ticked means independently verified, not claimed.

Open P0s, in order:

1. `UX-001` Kouhai / Senpai modes for the FOUNDRY. Added 2026-08-08 at the user's request as the top
   item; renamed the same day from Apprentice / Sorcerer; scope corrected the same day to
   Foundry-first. Senpai is the current full Foundry cockpit; Kouhai is a secondary app-like,
   appearance-simplified face of the SAME Foundry with zero functionality removed. Built
   incrementally under live user guidance. A shell-level tab filter was built first, rejected, and
   removed; `uiMode` state in appUiStore remains and feeds the Foundry surface.
2. `FX-001` Character FX knobs send parameter names the backend does not have. File untouched so far.
3. `SEC-001` Partial. The browser vector is closed. A header-less LAN client can still spend the
   Gemini key, and `backend/server.py` still has `allow_origins=["*"]` with `allow_credentials=True`.
4. `PKG-001` Partial. Packaging config is correct, but confirm the shipped tree really contains
   `frontend/scripts/`, its node_modules, and `unity/`.

## Never verified by a human

These exist, compile or lint, and have never been run or looked at:

- Score follow-along playback (`frontend/src/components/layout/scoreTimeMap.ts` + ScoreView).
- The Unity package `unity/com.gantasmo.notechart`. Never opened in Unity.
- The VST3 fixes driven through the MIX UI.
- Notation exports from a packaged build.

Do not mark any of these done without running them.

## Traps worth knowing

- **Never claim a PDF works from its header.** Garbled tab PDFs shipped because only `%PDF-` and the
  page count were checked. Rasterise and look. `uv run --with pypdfium2 python` renders without
  adding a dependency.
- **React 19 StrictMode is on in dev.** It has already caused one shipped bug (a blob URL revoked by
  a cleanup the remount reused). Every effect must survive mount, cleanup, remount.
- **The shell applies CSS `zoom` on `.dense-layout`.** `getBoundingClientRect()` returns scaled
  values. Use `frontend/src/lib/canvasScale.ts`, do not redo the arithmetic.
- **Licences are permissive only.** MIT, BSD, Apache, ISC, OFL. verovio and svglib were removed for
  being LGPL. Do not reintroduce copyleft.
- **Never downgrade a model id, library or API version.** The stack is newer than a model's training
  data, and guessing here has caused real damage.
- **A parameter nothing passes is not done.** `build_bundle_bytes` accepted `pdf_renderer` while the
  caller passed nothing, so bundles shipped without PDFs while looking finished. Grep the call site.

## Gates before any commit

```
uv run ruff check .            # repo root, not a subdirectory
uv run ruff format --check .
cd frontend && npx tsc --noEmit -p tsconfig.json
uv run pytest tests/ -q
```

No AI attribution in commits, PRs or release notes. No emojis. No em dashes in prose.

## Recently landed, so context is fresh

Idle-gate leaks, the blocking model-status probe, path containment on clip-audio, a real ABC writer,
headless PDF for sheets and tabs, on-disk artifact recovery, arrangement and tuning labels, bundle
PDFs plus the Unity payload, EDIT waveform blob-URL fix, canvas scaling, CI running tests, and
MuseScore in the Windows installer.
