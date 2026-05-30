# theDAW Multi-Select / Mashup / Mobile Access TODO

This task was intentionally split into smaller chunks so low-risk work can land separately from the more complex editor workflow changes.

## Completed in current chunk

- [x] Add a header **Mobile** phone button in `frontend/src/components/layout/Shell.tsx`.
- [x] Add a mobile access modal with a QR code and copyable link.
- [x] Support a persisted external URL override for Cloudflare Tunnel/public links via `localStorage` key `stabledaw.shareUrlOverride`.

## Completed chunk 2: Library multi-select + bulk Send to Init

- [x] Add local multi-select state in `frontend/src/views/LibraryView.tsx`.
- [x] Support Ctrl/Cmd-click additive selection and Shift-click range selection.
- [x] Preserve existing single-entry actions.
- [x] Add right-click context action for selected library entries: **Send selected to Init**.
- [x] Use the safe deterministic behavior for this chunk: send the first selected item to Init and set `initAudioEnabled: true`.

Future enhancement:
- [ ] Mix/render multiple selected library entries into one init WAV before patching `generateParamsStore`.
- [ ] Add multi-download for selected library entries.
- [ ] Add multi-delete for selected library entries with confirmation.

## Completed chunk 3: WaveformEditor multi-select + unified vertical scroll

- [x] Finish integrating existing partial selection helpers in `frontend/src/components/audio/WaveformEditor.tsx`.
- [x] Wire clip click/pointer handlers to modifier-aware clip multi-select.
- [x] Wire track header selection to track multi-select.
- [x] Make delete/duplicate/context actions operate on the selected clip set.
- [x] Add right-click **Send Selection to Init** for selected clips/tracks.
- [x] Refactor editor layout so track controls and track lanes share one vertical scroller.
- [x] Restore missing `Wand2` icon import that broke compilation after Cline session interruptions.

Runtime validation still to do (manual browser pass):
- [ ] Confirm Shift/Ctrl/Cmd selection across clips and tracks.
- [ ] Confirm Delete and Ctrl+D act on the full selection.
- [ ] Confirm right-click → Send Selection to Init produces correct mixed init audio.
- [ ] Confirm mashup rendering applies track volume, pan, mute/solo, and clip fades.
- [ ] Validate drag/move/resize edge cases (multi-clip move now uses stored initial positions).

Future enhancements (carry-over):
- [ ] Mix/render multiple selected library entries into one init WAV before patching `generateParamsStore`.
- [ ] Add multi-download for selected library entries.
- [ ] Add multi-delete for selected library entries with confirmation.

## Validation

`npm run lint` (which is `tsc --noEmit`) now passes cleanly. The previous `trainingStore.ts` `latents_base64` errors were fixed by narrowing the JSON `payload` before access, matching the pattern already used by `parseError` and the decode path.
