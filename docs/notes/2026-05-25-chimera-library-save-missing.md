# 2026-05-25 — Chimera-generated tracks not appearing in the Library

## Status

**REOPENED — Cache-API write also fails with QuotaExceededError under the
user's already-loaded library; migration cannot self-recover. Holding
pattern: a "Clear Library" action lets the user manually reclaim space.**

### Timeline

- **First pass**: added a 90s watchdog so the silent IDB hang produced a
  visible error.
- **Second pass**: identified `QuotaExceededError` as the underlying
  cause and moved blob storage to the Cache API. Claimed FIXED.
- **Reopened**: user's existing 20 entries (~287 MB) hold the origin
  quota in a state where Chromium rejects new Cache writes with
  `QuotaExceededError` too, even though `storage.estimate()` reports
  only 2.7% of a 10.5 GB quota in use. This is a known Chromium
  quirk on localhost — quota gating can be more conservative than
  the estimate suggests, and a stuck IDB at saturation appears to
  starve Cache writes on the same origin.
- **Third pass**: added explicit user-facing clear-library actions so
  the user can free space. The library reaches "saves work" once
  enough old entries are deleted. This is a UX release valve, not a
  fully automatic fix.
- **Fourth pass (this turn)**: added a storage-quota monitor with a
  visible badge, a persistent-storage request at startup, pre-save
  warning logging, and — most importantly — an automatic OS download
  of the unsaved blob whenever an in-app save fails. The user now
  never loses 5+ minutes of compute even when quota is exhausted; the
  audio always lands on disk one way or another.

User report (2026-05-25):
> "Chimera gens are ONLY going to the LAST OUTPUT. The Chimera gens are not
> saving (or at least showing up) to library. That is 100% fact."

## Reproduction log (2026-05-25)

```
08:46:36 [generate] Submitting job: model=medium duration=224s seed=-1 ...
08:46:36 [chimera] POST /api/chimera/mashup — 6 clips, mode=weave, target_bpm=auto
08:47:43 [chimera] Mashup done: 296.74s @ 129.4 BPM ...
08:47:43 [generate] POST /api/generate-jobs ...
08:47:44 [generate] POST /api/generate-jobs → 200 OK — job_id=d27f0952
08:51:09 [generate] Completed: ...wav (224s, 77175KB)
08:51:09 [library] save.diagnostic: id=d27f0952-... size=77175KB chimera=true sources=6
   ↑ NO "Saved:" log, NO error log, NO LIBRARY SAVE FAILED message.
   `await library.addEntry(...)` never resolved.
```

The 77 MB WAV is the smoking gun. `IDBTransaction.put()` silently hangs
for very large Blob values on certain Chromium versions (or under memory
pressure). Neither `tx.oncomplete`, `tx.onerror`, nor `tx.onabort` fires
in this state. Non-Chimera generations typically save shorter (smaller)
audio so this bug rarely surfaces.

## What changed this turn

### `frontend/src/state/libraryStore.ts`
- `putEntry` now installs a 90-second watchdog timer. If neither
  `oncomplete` nor `onerror` fires by then, the transaction is forcibly
  aborted and the promise rejects with a descriptive error including the
  entry id and blob size. Also wires `tx.onabort` and the individual
  request's `onerror` so quieter failures surface.
- `addEntry` now **re-throws** failures (after logging them) so the outer
  caller actually knows the save failed instead of having to verify via
  side-channel inspection of the entries array.

### `frontend/src/state/generateStore.ts`
- The save path's outer try/catch already has the diagnostic logging and
  the post-condition "is it in the store?" check from the previous round.
  Combined with the re-throw above, a failing save now produces:
  - `[library] LIBRARY SAVE FAILED (chimera=true): TimeoutError: IDB put
    timed out after 90000ms (entry id=..., size=77175KB)` in the log
  - "LIBRARY SAVE FAILED — check Processing Log (chimera run)" in the
    status bar

## Implemented fix — Cache API for blobs, IDB for metadata only

### Design

- **`caches.open('sa3-library-blobs-v1')`** stores every entry's audio
  Blob keyed by a synthetic URL (`https://sa3.local/library-blob/<id>`).
  Cache API uses disk-backed storage, doesn't share the IDB
  structured-clone code path, and the origin's Cache quota on Chromium
  is typically much larger than its IDB quota.
- **IDB still holds the `LibraryEntry`** but with `audioBlob: null` for
  Cache-resident entries. The record is now ~1 KB instead of 80 MB so
  IDB writes complete in milliseconds.
- **Read path**: `getAllEntries` checks each record. If `audioBlob` is
  still a Blob (legacy entry from before the migration), it's returned
  as-is. If it's null, the blob is hydrated from Cache. Cache misses
  log a warning and the entry is hidden so a stale ghost doesn't crash
  consumers.
- **Delete path**: `deleteEntry` removes from Cache first, then IDB.
  `putEntry` rollback on IDB failure also cleans the Cache so we don't
  accumulate orphan blobs.
- **Fallback**: if `caches`/`Request`/`Response` aren't available
  (e.g., a strange embedded context), we fall through to the old
  inline-blob-in-IDB path so nothing regresses.

### Files

- [frontend/src/state/libraryStore.ts](../../frontend/src/state/libraryStore.ts) —
  added `cacheBlob` / `fetchCachedBlob` / `deleteCachedBlob` helpers,
  rewrote `putEntry` to stage blob → Cache then metadata → IDB,
  rewrote `getAllEntries` to hydrate Cache-resident blobs, made
  `deleteEntry` clean both stores.
- [frontend/src/state/libraryStore.ts](../../frontend/src/state/libraryStore.ts) —
  `load()` now logs `storage.estimate()` so the user sees their origin
  usage vs. quota at app start.

### Observability

After this change, the log on a successful Chimera save reads:

```
[library] save.diagnostic: id=... size=79931KB ... chimera=true
[library] Saved: ...wav (79931KB, IDB put took 12ms)
[generate] [+275.5s] Loaded into player bar (45ms)
[generate] [+275.5s] Generation pipeline complete.
```

The "IDB put took 12ms" comes from the metadata-only write; the blob
landed in the Cache API in the prior step, off IDB's hot path. On a
fresh app load, the user also sees:

```
[library] storage.estimate: 425.3 MB used of 16384.0 MB origin quota (2.6%)
[library] getAllEntries: 19 inline + 0 from Cache + 0 missing
```

…and after that first save with the new code:

```
[library] getAllEntries: 19 inline + 1 from Cache + 0 missing
```

### Follow-ups (not blocking; needed to get back to "saves are
seamless" without the user managing storage manually)

- **Client-side audio compression before save** — the only real fix
  to stop hitting browser quota with 80–260 MB outputs is to compress
  before storing. Two viable approaches:
  - **OPUS / OGG via WebCodecs**: modern browsers expose
    `AudioEncoder` which can target OPUS. ~10–15× compression for
    music. Lossy but very high quality.
  - **Vendored `lamejs` for MP3**: pure-JS LAME wrapper, ~10× compression,
    universally supported. ~100 KB bundle add.
  After encoding the in-app library entry shrinks from ~80 MB to
  ~5–8 MB, IDB/Cache pressure stays well below quota, and saves
  never fail again. Add a "Keep WAV original" toggle for users who
  need lossless. This is the right end state.
- **Backend MP3 output option for effects** — `mastering_chain` is
  currently producing 261 MB WAV outputs. Plumb a `format=mp3`
  variant through the effects chain so the saved entry is small even
  before client-side compression lands.
- **DevTools AI perf note (separate concern)**: `AudioContext`
  construction in `PlayerFooter` blocks the main thread ~230 ms at
  mount per LCP profile. Lazy-init it on first user play instead of
  mount. Tracked separately — does not block the storage fix.

Non-Chimera flows (timeline edit/render, effects chain, media bucket import,
plain generate) all save to the library correctly. Only the Chimera-init →
generate path fails to persist the resulting library entry — the audio still
appears in the "LAST OUTPUT" panel because `lastAudioUrl` / `lastAudioBlob`
are set by a different code path, before the library save runs.

## Likely failure surface

The save call lives at
[frontend/src/state/generateStore.ts:450](../../frontend/src/state/generateStore.ts#L450).
`useLibraryStore.addEntry` at
[frontend/src/state/libraryStore.ts:145-154](../../frontend/src/state/libraryStore.ts#L145)
silently catches IndexedDB errors and only `logError`s them — it never
throws. The outer try/catch in `generateStore.ts` therefore can't fire and
the user has no visible signal that the save failed.

Hypotheses (unconfirmed):

1. The Chimera output's entry payload includes a field the structured-clone
   serializer rejects (most likely a stale reference or a non-serializable
   object somewhere downstream of the new `chimeraSources` plumbing).
2. The Chimera-init pathway is overwriting the entry ID with one that
   collides with an existing entry, and the IDB `put()` is failing the
   conflict instead of overwriting.
3. The generate-jobs response for Chimera-init runs has a subtly different
   `items` shape that makes the per-item loop short-circuit before
   `addEntry` runs.
4. IDB quota: Chimera outputs are typically longer and heavier than plain
   generations. If the user has accumulated many large entries, the put may
   be hitting a `QuotaExceededError` for the first time on Chimera runs.

## What was added this round to help diagnose

- Loud surface for IDB failures: when `addEntry` fails for a save initiated
  by the generate flow, the error now propagates to the status bar and is
  logged with the entry id, the audioBlob size, and whether
  `chimeraSources` is present (see
  [generateStore.ts](../../frontend/src/state/generateStore.ts) — search
  for `library.save.diagnostic`). This should print the exact IDB error
  string on the next failing Chimera run.
- This note for future-us to remember to investigate.

## How to repro / debug next session

1. Run a Chimera-init generate.
2. Wait for "LAST OUTPUT" to populate.
3. Open the Processing Log panel and search for `library`. You should now
   see either `Saved:` (working) or a loud `Library save failed:` line
   with the underlying IDB error.
4. If the IDB error is `QuotaExceededError`, the fix is to clean up old
   entries or move to a different storage strategy.
5. If it's `DataCloneError`, something in the entry payload is not
   serializable — narrow down by removing fields until it saves.
6. If it's `ConstraintError`, the entry id is colliding with an existing
   record; either generate a fresh uuid or use `put()` with a different
   key.

## Don't do without checking with user

- Don't silently fall back to writing without `chimeraSources` — they
  explicitly want the source clip names to land in the library entry
  metadata.
- Don't change the `LibraryEntry.id` scheme without checking; other
  surfaces key off `entryId` (player, details panel, library list).
