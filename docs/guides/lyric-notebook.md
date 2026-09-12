# The lyric notebook (LYRIC tab)

The LYRIC tab is a notebook. Lyrics written here belong to no song: you open a
blank draft, write, and the analysis reads it beside you as you type. A draft
only becomes a song's lyrics when you say so — and a song's existing lyrics can
be pulled in the other way, to work on without touching the original.

Open it from the bottom panel's **Lyric** tab. Nothing needs to be selected in
the library.

## The layout

The tab is a header row of controls over two columns: the writing surface on
the left, the analysis on the right, with a draggable separator between them.
The writing side starts wider — the analysis is a reference column, the words
are the work. Drag the separator, or focus it and use the arrow keys; the split
is remembered.

The right-hand column is the same pane the SING tab's STUDY layout uses, so
everything in
[Reading a lyric](lyric-analysis.md) applies here unchanged.

## Writing

The editor is a plain text box — your browser's own undo, spellcheck and IME
all behave normally — with a gutter down the left showing, per line:

- the line number,
- the rhyme class letter the analysis gave that line, in that class's colour,
  or a rose `§` where a section marker starts a new section,
- the syllable count.

One line per line. `[Chorus]`, `(bridge)` or anything similar on a line of its
own starts a section, exactly as in SING, and the analysis then reads each
section's scheme independently.

The footer under the editor counts lines, words and syllables, and says whether
the gutter is **analysed** or **estimated**. Estimated means you have typed
past the last analysis: the syllable counts are a quick local guess and the
rhyme letters are held back rather than shown against lines they no longer
describe.

## Two ways the analysis runs

- **As you type.** A pass runs 1.4 seconds after you stop typing. It is the
  deterministic half only, nothing is stored, and it is what keeps the gutter
  and the sheet current. It is debounced on purpose: analysing is real CPU work
  on the backend and must never run per keystroke.
- **On demand.** **ANALYSE** in the pane header runs a full job against the
  saved draft, stores the result beside it, and can carry the optional
  interpretive pass.

## Saving

The draft saves itself 0.7 seconds after you stop typing, and again when you
leave the tab. The footer says `saving`, `unsaved` or `saved`. Every change is
also mirrored into the browser so a reload before the first save comes back to
your words rather than to a blank page.

Drafts live in `data/lyric-documents`, one file each, with their stored
analyses in a subdirectory beside them. They are not library entries and do not
appear in the library.

## The draft controls

| Control | What it does |
|---|---|
| **DRAFT** | The switcher. Each row shows the title, the line count, and whether it is attached to a song. Newest first. |
| **TITLE** | Renames the open draft. Metadata only; it is never a filename. |
| **NEW** | Starts a blank draft. |
| **DUPLICATE** | Copies this draft into a new, unattached one — the way to try a different second verse without losing the first. |
| **DELETE** | Asks once, in place, then deletes for good. |

## Attaching a draft to a song

The second row of the header is the song half. Pick a song in **SONG** — it
starts on the song this draft is already attached to, else the library
selection — and then either direction is one button:

- **IMPORT FROM SONG** starts a *new* draft from that song's existing lyrics.
  The song keeps its own words; you are working on a copy.
- **SAVE TO SONG** writes these words into that song's lyrics, through the same
  path SING's own editor takes, so SING and SCORE pick them up immediately and
  lines you did not change keep the timings they already had. It also remembers
  which song this draft became.

An attached draft shows the song's name in green beside the buttons. It is a
link, not ownership: the draft stays here, stays editable, and editing it later
does not silently rewrite the song. Save again when you want the song updated.
The small unlink button forgets the link and leaves the song with the words it
was given.

## What this is not

The notebook does not time anything. Word and line timings, alignment against
the vocal, tapping and LRC are all in SING, which works on a song's lyrics
document. Write here, save into a song, then time it there.

## API

Prefix `/api/lyricanalysis`. The analysis endpoints are in
[Reading a lyric](lyric-analysis.md#api) and take a document id anywhere they
take an entry id.

```http
GET    /api/lyricanalysis/documents                  the switcher's rows
POST   /api/lyricanalysis/documents                  {title, text, language, entry_id}
POST   /api/lyricanalysis/documents/import           {entry_id, title} — a new draft from a song
GET    /api/lyricanalysis/documents/{doc_id}         the draft
PUT    /api/lyricanalysis/documents/{doc_id}         {title?, text?, language?, entry_id?}
DELETE /api/lyricanalysis/documents/{doc_id}         delete the draft and its analysis
POST   /api/lyricanalysis/documents/{doc_id}/duplicate
POST   /api/lyricanalysis/documents/{doc_id}/attach  {entry_id, write_lyrics}
GET    /api/lyricanalysis/documents/{doc_id}/marks   the writer's own marks
PUT    /api/lyricanalysis/documents/{doc_id}/marks   replace the whole set
```

The two `marks` routes are the writer's hand-made rhyme marks, described in
[Your own marks](lyric-analysis.md#your-own-marks). They live on the document
rather than on the analysis, which is why marking is offered on a draft and not
on a song opened straight from the library.

A document id is `lyricdoc_` plus 32 hex characters, minted by the backend and
never taken from a request. `PUT` sends only the fields that changed; passing
`entry_id` as an empty string detaches the draft from its song.

`theDAW_LYRIC_DOCS_DIR` overrides where drafts are stored.
