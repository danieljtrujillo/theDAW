# Song sections: the form of a library track

theDAW's section finder reads a library entry on its bar grid (the RHYTHM
map's bars when the track has one, else the analysis beats grouped in fours,
else beats tracked from the mix) and marks where the song changes: a boundary
where the sound is new and where a stretch repeats an earlier one. Each
section gets a repeat letter (A, B, A' for a varied repeat), a role (intro,
verse, chorus, drop, break, bridge, outro), a name and a confidence for the
change into it. The finder runs on numpy + librosa and uses the entry's
separated stems when it has them.

## Where to find it

- **DETAILS, the SECTIONS block.** Select a library entry; the block under
  RHYTHM shows the stored sections as a strip on the song's length and a list:
  letter, name field, role picker, start, bars and confidence. **Find** reads
  the whole song (a few seconds for a three-minute track); **Find again** keeps
  every name and role you set. The status is a dot and one word (None, Reading,
  Finding, Found, Failed).
- **Rename a section:** type in its name field and press Enter (or leave the
  field). The name is saved with the entry and survives another Find. Escape
  puts the stored name back. The role picker saves the same way, and a role
  change updates the entry's shards, so the Shard Index can ask for chorus
  material.
- **EDIT, Add section markers.** Right-click a clip of a library song and pick
  **Add section markers**. A timeline marker lands at each section start the
  clip plays, where the clip plays it (its position, trim and stretch). The
  markers move and split with the clip; a second add replaces them. The
  sections are found first when the song has none.
- **MIDI tab, Form.** The **More** key beside the song field has a **Form**
  entry. The song's sections become section markers on the roll's marker row,
  at the bar line where each starts on the roll's clock, replacing the last
  Form's markers and keeping your own. When the song has a chord track (the
  CHORDS mode of SCORE's play-along), its chords fill the HARMONY row. MATCH
  first puts the roll's bars on the song's.
- **API:** `GET /api/sections/{entry_id}` returns the stored sections
  (`status: pending` until Find has run), `POST /api/sections/{entry_id}/run`
  finds them now, `PATCH /api/sections/{entry_id}/sections/{index}` with a
  body of `{"name": "Chorus 2"}`, `{"role": "chorus"}` or both renames or
  re-roles one section.

## Known limits

- Boundaries sit on the bar grid, so a song without a readable beat gets
  two-second windows and coarse starts.
- A long piece with much variation over-segments: the finder marks more
  boundaries than a listener would name. Rename or re-role the sections you
  keep; a later Find keeps your names.
