# Cline Reconcile + Backend Concurrency Plan — 2026-06-20

Reconciles the uncommitted Cline edits with the pre-existing uncommitted feature
work, and addresses the underlying defect those edits were chasing. Every claim
here was verified empirically during the 2026-06-20 investigation (ran the MIDI
diagnostic over the live corpus, `py_compile`, `tsc --noEmit`, read the actual
fetch and parser paths). Chunks are sized to be done and verified one at a time.

Status tags: **[done]** verified in the working tree; **[ready]** proven and
authorized, not yet applied; **[needs proof]** root cause not yet confirmed to
the bar, investigate before proposing the concrete change.

## Root cause (proven)

The repeated `Add MIDI failed: Invalid MIDI track chunk` was a truncated 200
response, not a malformed file and not parser strictness.

- 333 of 333 on-disk MIDI files are structurally valid (diagnostic run). The
  files are fine.
- `/api/midi/file/{id}` streams raw bytes via `FileResponse`.
- The single-worker backend stalls mid-stream while the GIL is held (model load,
  CPU-bound MIDI transcription, generation), cutting the stream so a partial MIDI
  reaches the parser. Log timestamps line up with "model loading".
- `frontend/src/lib/fetchRetry.ts` (`midiLooksComplete` + retries) already
  detects and rides over this on the client; the backend cause is unaddressed.

The same blocked event loop also explains the startup 502s, the "Failed to
fetch" and "Drop decode failed" entries, and the duplicate stem jobs (the user
re-clicked because nothing responded).

## Chunk 0 — Stems in-flight guard repair — [done]

Cline's `_IN_FLIGHT` guard shipped a SyntaxError (`finally` grafted onto
`_normalize_stem_filenames`, which has no `try` and no `entry_id`), which killed
the whole stems module at import. Repaired in place: the orphan block is removed
and a real `finally` on `separate_entry`'s existing `try/except` clears the
marker on success, failure, and abort. The background-queue dedupe
(`stems:{id}`) stays the primary double-submit guard; the set is the second
layer the review asked to keep.

Verified: `py_compile` clean, `separate_entry` imports, ruff clean.
Next: live test that a real separation runs and that a second separation of the
same entry is correctly skipped while one is active.

## Chunk 1 — Confirm the duplicate-parser cleanup is complete and safe — [ready]

Cline collapsed `frontend/src/utils/midi.ts` into a re-export of `lib/midi`.
It typechecks and the type shapes are identical, so it is low risk, but the
equivalence should be proven over the real corpus before the legacy parser is
considered gone.

- Run `scripts/compare_midi_frontend_parsers.ts` over the 333-file corpus and
  confirm the two parsers agree on every file (closes the question of whether
  anything depended on the old parser's exact behavior).
- Confirm every importer resolves: `PianoRoll.tsx`, `WaveformEditor.tsx`, and a
  grep for `buildMidiFile` / `downloadMidi` consumers (e.g. `StepSequencer`).
- Decide shim versus migration: keep `utils/midi.ts` as a thin shim short term,
  or repoint the two importers at `lib/midi` and delete the shim to satisfy the
  no-duplicate-code rule outright.
- Verify: `tsc --noEmit`, then add a library MIDI to the timeline and confirm it
  lands with the right note count.

## Chunk 2 — Live-verify Cline's frontend behavior edits — [needs proof]

These typecheck but have had no eyes on them. None is trusted until verified live.

- `WaveformEditor.tsx`: `silentWavBlob` placeholder so a large MIDI clip appears
  instantly while the bounce renders async. Confirm the clip is immediately
  editable and the real audio swaps in without a flash or wrong duration.
- `pianoRollStore.ts`: `fitToNotes` on `loadFromClip` sets the visible note
  range and total steps. Confirm the roll opens framed on the notes with no
  clipping.
- `PianoRoll.tsx`: quantize/swing state with batched `replaceAll`, plus
  grid scroll-sync and ctrl-wheel zoom. Confirm timing feel applies in one
  history step and the keyboard column stays aligned while scrolling.
- Verify: run the app, exercise each, watch for regressions and console noise.

## Chunk 3 — Backend concurrency fix at the source — [needs proof]

This is the cause behind the whole symptom cluster. Investigate to the bar
before proposing concrete edits; do not presuppose the fix.

- 3a Map every place the single worker's event loop can block: synchronous model
  load for generation, `convert_entry` (now off-loop via Cline's `to_thread`,
  keep), the chimera mashup path (the log showed 180s+ renders), peak
  extraction, and any sync CPU call inside an async route. Produce the list with
  file:line evidence.
- 3b Prove which of those actually correlate with the observed stalls (startup
  502s during model load; truncated MIDI during model load). Reproduce if
  feasible.
- 3c Move confirmed blockers off the loop (thread/executor for model load, or a
  dedicated worker), and guarantee `/health` and static serving stay responsive
  under load.
- Verify: with a model load in flight, `/health` answers and a MIDI fetch
  completes without truncation; add targeted tests mirroring
  `tests/test_idle_and_workers.py`.

## Chunk 4 — Defense in depth: route all media fetches through the resilient path — [ready]

Ensure every MIDI, stem, and audio byte fetch uses the validated retry helper in
`fetchRetry.ts` rather than a raw `fetch`, so a transient stall degrades to a
retry instead of a parse error. Audit the PianoRoll import path and any
drag-and-drop decode path.

- Verify: `tsc --noEmit`, then a manual add under simulated backend load.

## Chunk 5 — Verification discipline (process) — [ready]

Make the failure mode that produced the stems SyntaxError unrepeatable.

- Standing rule already saved to memory: compile and exercise every touched file
  before calling it done. Backend edits get `py_compile` plus a targeted import
  and `pytest`; frontend edits get `tsc`; the test has to import the changed
  module.
- Consider a lightweight pre-commit or CI gate that imports every
  `backend/modules/*/engine.py` and router, so a non-importing module fails fast.

## Sequencing

Chunk 0 is done. Chunks 1, 4, 5 are ready and low risk. Chunk 2 needs the user's
eyes. Chunk 3 is the highest-value work and starts with investigation, not
edits. Recommended order: live-test Chunk 0, then 1, then 2, then 3 (3a/3b proof
first), with 4 and 5 folded in alongside.
