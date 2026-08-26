# Handoff

Branch: `dev/audit-p0-notation-2026-08`.

Read `docs/IN-THE-WORKS.md` first. It is the ACTIVE QUEUE: what we decided to do next, in priority
order, every item carrying a `file:line` so it can be picked up cold. An item leaves it only when
the user says done or it is verified by build, test, or observed behaviour, and lands in
`docs/CHANGELOG.md` on the way out.

`docs/BACKLOG.md` remains the long-lived inventory: 106 audited items plus user-requested
additions, stable permanent ids, priority and effort on every line. Do not duplicate a BACKLOG id
into IN-THE-WORKS; reference the id.

## Session 2026-08-26 — what just landed

Three audits ran (EDIT tab, Ableton `.als` import, a 7-agent sweep of the other tabs). Findings were
adversarially verified before any fix. Everything shipped is in `docs/CHANGELOG.md`; everything
outstanding is in `docs/IN-THE-WORKS.md`. Headlines:

- EDIT transport no longer dies on clip add/delete, trimmed clips survive a save, Ctrl+D no longer
  corrupts the document, and the coordinate-space bug under the shell's CSS `zoom` is fixed.
- Ableton import: imported media is now allowlisted (nothing played before), saving from Perform no
  longer writes zero clips over the user's file, and `.tasmo` can finally represent a clip grid.
- Perform: per-clip launch, per-track stop, looping, warp, mute/solo/pan, launch quantization, and
  the imported device chains are all live.
- New SWAY tab embedding the SwayCommand cockpit, with Electron kept in lockstep.

**Top of the queue** is the `activeView` cluster (IN-THE-WORKS P0). `activeView` is never written by
the tab bar, so the footer's main action button fires a generation on the EDIT tab, and one
assistant `navigate("train")` turns it into a dead TRAIN button for the rest of the session.

## Video scripts and clip capture

`video-scripts/` is UNTRACKED (gitignored) and holds four scripts plus a capture plan, each with a
rendered PDF. Two are promotional, two are product walkthroughs written as ordered shot lists.
`video-scripts/make-pdfs.mjs` regenerates every PDF from the Markdown.

`video-scripts/CAPTURE-PLAN.md` is the shoot plan. The harness already exists at
`frontend/_capture_clips.mjs` (65 scenes, one warm session, one continuous recording sliced
afterwards). A `SKIP=` env var was added alongside the existing `ONLY=` so the model-dependent
scenes can be excluded without listing the other 58. A scene that throws is logged into
`showcase/clips-recorded/_capture-log.json` and the run continues.

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
  values. Use `frontend/src/lib/canvasScale.ts`, do not redo the arithmetic. This bit the EDIT
  timeline's pointer maths: `clientX` is viewport px while `scrollLeft` is local px, so every seek,
  split point and drag read short. Fixed 2026-08-26; the same trap applies to any new gesture.
- **A message produced is not a message shown.** The commonest defect in this codebase by a wide
  margin. DJ alone builds 15 status/error strings that no component renders; MIX, VJ, Underfit and
  the settings modal all do the same. Before claiming a failure path works, find the component that
  renders it.
- **Dead state is everywhere.** `activeView`, `trainingStore`, `midiIgnoreStore`, the assistant's
  whole approval stack, `djSamplerStore` pad options. A store field with no writer, or an action
  with no caller, reads as a working feature. Grep for the caller before trusting it.
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
