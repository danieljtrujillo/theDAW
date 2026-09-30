# Reading a lyric: rhyme, sound and literary devices

theDAW reads a lyric back to you. It works out the rhyme scheme, finds the
near rhymes and the multisyllabic ones, marks the assonance, alliteration and
repetition, counts the syllables and the stresses, and paints all of it onto
the words themselves — the same words the karaoke highlights.

Everything on this page except the last family is computed from the words on
your machine. No model, no network, no key. The interpretive half (metaphor,
irony, puns) is an opt-in extra and is clearly marked as such wherever it
appears.

## Where you see it

- **SING → STUDY** puts the analysis beside the karaoke lyrics of the selected
  song. See [Sing-along and lyrics](sing-along-and-lyrics.md#the-four-layouts).
- **The LYRIC tab** puts it beside a draft that belongs to no song at all. See
  [The lyric notebook](lyric-notebook.md).

Both mount the same pane. In SING it reads the song's saved lyrics document
and stores its findings beside the song; in LYRIC it reads the draft you are
typing and stores them beside the draft.

## Running it

Press **ANALYSE** at the right end of the pane's bar (it reads **RE-ANALYSE**
once a document exists; on a narrow pane it is the refresh icon alone). The pass
runs as a job with a progress bar, because it is real CPU work — every word is
turned into phones and compared with its neighbours — and it is never run per
keystroke. A song with no words yet says so and offers nothing to press.

The result is saved next to the song as `lyric_analysis.json` and registered as
a notation artifact of kind `lyricanalysis`, so it survives a restart and two
tabs never analyse the same song twice.

Edit a song's lyrics afterwards and the bar shows an amber **STALE**
badge: the findings are anchored to line and word positions, so once the words
move they point at the wrong places. Re-analyse and it clears. Staleness is
decided by a hash of the lines the analysis actually read, so it also catches
lyrics that were derived rather than saved. In the LYRIC tab, where a pass runs
as you type anyway, the editor's gutter says `estimated` instead until the
analysis catches up with the words.

## What it finds

Findings are grouped into five families. Each family has its own underline
shape wherever a device is painted, so a mark is readable without colour:

| Family | Shape | What it covers |
|---|---|---|
| Rhyme | solid underline | end, internal, leonine, cross-line, multisyllabic, slant, para, identical and eye rhyme |
| Sound | dotted underline | alliteration, assonance, consonance, sibilance, plosives, onomatopoeia |
| Repetition | double underline | anaphora, epistrophe, symploce, anadiplosis, epizeuxis, polyptoton, antimetabole, refrain |
| Structure | dashed underline | enjambment, caesura, meter |
| Meaning | dotted overline | the optional interpretive pass only (see below) |

### Rhyme

| Kind | What it means |
|---|---|
| **end rhyme** | Two line endings that really rhyme. These are what the scheme letters are built from. |
| **internal rhyme** | Two rhyming words inside one line. |
| **leonine rhyme** | A mid-line word rhyming with that same line's ending. |
| **cross-line rhyme** | A mid-line word rhyming with a mid-line word in one of the next two lines. |
| **multisyllabic rhyme** | Two or more syllables matching across a run of words — "riding the" / "hiding the" is found as one rhyme, not as two word pairs. |
| **slant rhyme** | A near miss. Scored, not guessed at: it degrades smoothly instead of disappearing. |
| **pararhyme** | The same consonant frame around a different vowel (read / ride). |
| **identical rhyme** | A word, or its homophone, rhymed with itself. |
| **eye rhyme** | The spelling rhymes and the sound does not (love / move). |

A line ending is compared as a *run* of up to three final words, not only as
its last word, because sung lines rhyme on phrases — "meant it" / "spent it",
"hold on" / "cold dawn". A throwaway ad-lib on the end of a line (", yeah",
", oh") is dropped before matching, so four lines that all trail off the same
way do not come back as AAAA. An unstressed particle is kept, because it is
part of the phrase that rhymes.

Rhyme classes are computed **per section**, so a chorus reads independently of
the verse in front of it. The whole-song scheme reads like `ABAB CDCD EFEF`,
one letter per line, sections separated by spaces.

### Sound, repetition and structure

Sound devices are found from the phones: a repeated word-initial consonant
within three words is alliteration, a repeated non-initial consonant with at
least three carriers is consonance, and a dense enough run of s/z/sh/ch or
p/b/t/d/k/g over a six-word window is sibilance or plosives.

Assonance is not an exact-phone match. It is a run of words ringing on one vowel
**colour**, within a tolerance — so "green / grin" belongs together the way an
ear hears it rather than the way a dictionary spells it. Two rules keep that
honest. Every member of a run is measured against every other member, not just
against the one before it, because chaining neighbour to neighbour lets a run
drift the whole length of the vowel space one comfortable step at a time
("green / grin / grand / grunt" comes out as one run, which is an artefact of
the walk and not a finding). And a run may reach across a line break, but only
so far, so a vowel does not tie the whole song together. A run that rings on
more than one vowel reports both, with how far apart they are.

Repetition is found from the words: lines that open alike (anaphora), close
alike (epistrophe), do both (symploce), hand the last word to the next line
(anadiplosis), repeat a word back to back (epizeuxis), reuse one root in
another form (polyptoton), mirror A B … B A (antimetabole), or repeat a whole
line (refrain).

Structure is enjambment (the sentence runs on past the line break), caesura (a
strong break inside a line) and meter — named only when a line's actual stress
pattern fits a named foot, so you get "iambic tetrameter" when the line really
is one and nothing when it is not.

### Meaning: what is computed, and what is asked for

Most of what a reader calls a double meaning is not interpretive at all. It is a
fact about the language, and the checkable ones are computed on every analysis,
with no model and no key:

- **Homophone play** — two spellings in the lyric that sound identical:
  "sole" / "soul", "their" / "there". The dictionary proves it, so this is the
  strongest finding in the family.
- **Heteronyms** — one spelling with two readings and two meanings: "record",
  "live", "tear". Which one was sung is a choice, and the rhyme depends on it,
  so the fork is worth pointing at.
- **A second sense** — "bars", "hook", "change", "cold". A curated list, because
  there is no machine-readable sense inventory in this repo and a sense count
  invented from spelling would be a lie. A word that recurs is the stronger
  claim (the same word twice, meaning two things, is antanaclasis); a single
  occurrence is a nudge, pitched just below the pane's default confidence floor
  so it only shows when you ask for it.
- **Homophone echo** — a word whose identical-sounding partner is *not* in the
  lyric. The ear cannot tell them apart, so the second reading is available
  whether or not it was meant.

Metaphor, simile, irony, imagery and symbolism are readings, not measurements,
so those are not computed — they are asked for. Open **AI** in the bar, tick
**Read meaning**, and pick a provider and model before you analyse.

The pass uses a key the backend holds: one added in the assistant (click the
orb, open its settings, **Keys**, then **Ingest Keys**) or an environment
variable. Providers are probed in the order Gemini, OpenAI, Anthropic, Grok,
Groq, OpenRouter. With no key, the **AI** panel says so and where to add one,
and it asks the backend again each time it opens. It reads the first 200 lines of the lyric, returns at most 80 findings,
and every one of them is re-validated against the real line and word indices
before it is kept — a model cannot point at a word that is not there. Findings
from the pass carry an `llm` badge and the model's own confidence, never a
rule's.

**Read meaning** starts off every session, because the pass spends your key.
If it fails, the deterministic analysis is still saved and the reason is shown
as "AI: …" rather than being silently reported as "this song has no
metaphors".

## Reading the pane

Under the bar, the pane reads top to bottom:

- **One summary line** — the whole-lyric rhyme scheme, a chip per rhyme class
  (click one to isolate it on the sheet, click it again or **All** to show
  everything), and the line and syllable totals.
- **The shape strip** — one bar per line: its syllable count, how many findings
  it carries and its rhyme class. Click a bar to jump the sheet to that line.
- **The long-range map** — see [The long-range shapes](#the-long-range-shapes).
- **The sheet** — the words themselves with every visible device painted on
  them and the scheme letter down the left. A lyric with several sections heads
  each one with its name, scheme and counts.
- **Findings** — the list, grouped by family and kind, each row with its
  confidence as a bar and a percentage. Click one to open the inspector at the
  bottom and light that finding up on the words.
- **Metrics** — lines, words, syllables, unique words, type/token ratio, rhyme
  density, multisyllabic count, syllables per line, and the guessed count.

A rhyme class is never distinguished by hue alone: the scheme letter carries
the information, and each class also has its own node shape, so the sheet
survives colour blindness and a monochrome screenshot.

The bar across the top of the pane is one row, and it is both the legend and
the filter. On a pane narrower than 1024px the chips, **Sheet**, **Mark** and
**ANALYSE** drop their words and keep their marks and counts.

| Control | What it does |
|---|---|
| The family chips | Show or hide a whole family; each chip wears the family's shape and its count. **MEANING** appears once **AI** is on or the lyric has meaning findings. **Sound is off by default** — alliteration, assonance and consonance fire on most of a lyric by their nature (78% of words carry a mark with every family on, against 48% without), and a highlighter over everything says nothing. |
| **Floor** | The key reads the current floor, e.g. **Floor 50%**. Its panel holds the slider (hide findings the detector is less sure of than this; starts at 50%), how many findings are shown of those found, and the certain/loose key. |
| **Wires** | The key reads the mode or the count, e.g. **Wires near** or **Wires 365**. Its panel sets how much of the wiring is drawn over the sheet — internal, leonine and cross-line rhymes as arcs, which are invisible in a flat list and are the interesting part of a rap lyric. **Near** is the default: connections within two lines. **All** draws every one. **Off** still wires the finding you currently have open, in full. **Web** opens the whole lyric as one chart — see [The web](#the-web) below. |
| **Sheet** | A panel with **A- / A+ / B** (lyric text size and weight, shared with the writing surface) and four switches: **Stress** (one dot per syllable beside each line, filled where the stress falls; off by default, hidden when the pane is narrow), **Tie** (select a word while writing and it lights here; pick one here and the caret lands on it there), **Follow** (scroll this sheet with the song, the way the karaoke does; needs a song playing in SING) and **Karaoke** (underline the same devices on the karaoke words while the song plays; on by default). |
| **Mark** | Mark the lyric yourself — see [Your own marks](#your-own-marks) below. Offered only on a LYRIC-notebook draft. |
| **AI** | The meaning pass: on/off, provider and model — see above. |
| **ANALYSE** | Run the analysis. |

### The long-range shapes

Above the sheet sits a map of the shapes that are too big to see on the words.
Each is one band across the width of the song, with a code, the lines it spans,
and tick marks where it actually lands:

| Code | What it is |
|---|---|
| **RUN** | Consecutive lines all landing on one rhyme. |
| **CHAIN** | One rhyme threaded across a long stretch, gaps included. |
| **CALL** | A rhyme returning after a long gap, or in a later section. |
| **ENDS** | A section tied at both ends: its first line rhymes with its last. |

Click a band to light that shape up on the lyric. Section boundaries are drawn
through the map as faint cuts, so a callback that crosses from verse to chorus
reads as one. The map keeps the long shapes and says how many shorter ones it
left out; all of them are in the findings list either way.

### The web

**WEB** opens the whole lyric as one chart. The sheet draws findings *on* the
words, which is the right place to read them and the wrong place to see the
shape — a callback across three verses is a wire that leaves the top of the
screen. The web is the other view: one node per line, every connection drawn
as an arc, and nothing else on the page.

- **ARC** lays the lines down a vertical spine in reading order and bows each
  connection out to the side. Distance is preserved, so a callback across forty
  lines is a forty-line arc and looks like one.
- **RING** closes that spine into a circle and draws the connections as chords.
  Distance stops being legible and density starts being: a song whose chorus
  answers every verse is a starburst.

It renders to SVG and nothing else — no canvas, no layout library — so the
export *is* the picture on the screen rather than a redraw of it. Export as SVG,
or as PNG rasterised at whatever scale you ask for.

### Your own marks

The engine finds what it can prove. **MARK** is where you say what you hear:
click the words that rhyme — two, three, as many as you like — and name them as
one mark, with a verdict of your own. Your marks are drawn as boxes, never as
another underline, so they never read as something the engine claimed.

Marks are saved against a lyric **document**, which is why the key only
appears on a LYRIC-notebook draft; a song opened from the library has nowhere to
keep them. The engine never writes
to them, so a mark survives a re-analysis unchanged. Spans that name no word in
the document are dropped on save, and the response says how many.

Findings honour their character offsets, so a multisyllabic rhyme marks
"ele|VATION" rather than the whole word. The karaoke overlay stays
word-granular on purpose — it runs every frame — while the sheet, which does
not, is exact.

## What the confidence numbers mean

Every finding carries a number from 0 to 1, shown as a percentage and drawn at
that weight, so a loose finding *looks* loose:

| Reading | Number | Drawn as |
|---|---|---|
| certain | 90% and up | full strength |
| likely | 70–89% | mid |
| loose | below 70% | faint |

For a rhyme, the number is how much of a rhyme the two words actually make. It
is scored across the stressed vowel, the consonants after it, the unstressed
tail, the syllable count and the stress placement, with the vowel weighted
hardest. A perfect rhyme is 1.0. A pair that is close on everything but
identical on nothing comes back as a low-confidence slant rhyme rather than as
nothing at all — that is the whole point of scoring it. Two words that begin
with the same sound are nudged down slightly, because that is closer to hearing
the same sound twice than to hearing a rhyme.

Below roughly 0.5 a pair stops being something a scheme can be built on; below
0.34 it is not called a rhyme at all, though its spelling may still make it an
eye rhyme. Different passes want different certainty: an end rhyme has to reach
0.5, an internal rhyme 0.6, and a cross-line rhyme 0.8, because that one is
comparing across lines and a loose match there is noise.

Findings from the interpretive pass carry the model's own confidence, clamped
to between 5% and 95%: a reading may not be reported as beyond doubt, and a
model may not push one to zero either. A finding that names no number of its own
is filed at 60%. Since nothing from the pass can get past 95%, dragging **FLOOR**
to its top hides the whole pass in one go.

## Where the pronunciations come from

Every phonetic finding rests on knowing how a word sounds, and the answer comes
from one of two places:

- **cmudict** — the CMU Pronouncing Dictionary, about 125,000 entries with real
  stress marks and alternate readings. It ships as a normal dependency, so
  `uv sync` installs it and it is what you will normally be running on.
- **letter-to-sound rules** — a real fallback, not a stub, for everything the
  dictionary does not have. Lyrics are full of slang, names, coinages and
  ad-libs, so this path runs constantly even with the dictionary installed.
- **the Latin reading rules** — for a document whose language is Latin (the
  SING picker, saved on the document). Latin spelling is its pronunciation, so
  no dictionary is needed: the reader syllabifies by the Latin rules, places
  the stress by the penultimate law (a heavy penult takes it, a light one
  passes it to the syllable before), reads the diphthongs `ae oe au eu ei`
  (and `ui` in `cui`, `huic`, `hui` and `cuicumque`), `qu`/`gu`, and
  consonantal `i`/`j` and `u`/`v`, and lets the enclitics `-que -ne -ve` pull
  the stress onto the syllable in front of them. A macron (`ā ē ī ō ū ȳ`) is a
  long vowel and decides where the stress falls; it never changes the vowel's
  colour, so a text with macrons and the same text without them rhyme and
  assonate alike. The church books' acute (`Dóminus`) places the stress
  directly. Capitals, punctuation, hyphens and inscriptional `V` for `u`
  (`POPVLVSQVE`) are read as what they are.

The tooltip on **ANALYSE** / **RE-ANALYSE** says which one actually backed this
analysis: `cmudict`, `rules`, `mixed`, or `latin`.

**Be aware of what this costs when it says `rules`.** The guessed
pronunciations are the weaker half, and they go wrong in both directions: the
rules miss rhymes the dictionary would have found, and they also pair words the
dictionary would have kept apart. Ordinary English is the good case; names,
slang, coinages and anything spelled the way it is sung are the bad ones. So a
lyric analysed mostly by rule should be read as a sketch of its scheme rather
than as a measurement of it — which is why the pronunciation source and the **GUESSED** tile
are on the page at all, and why the discount below exists.

The **GUESSED** metric tile counts the distinct words that had no dictionary
pronunciation, and when it is above zero the pane says in words that the more
of these there are, the softer every rhyme finding above. A guessed word also
discounts the confidence of anything it feeds, by 15% when one side of a pair
was guessed and 25% when both were — but only when a dictionary is actually
installed, because when everything is a guess, discounting everything equally
just slides the whole lyric under your confidence floor and tells you nothing.

In a Latin document the GUESSED tile counts something else: words whose
stress rests on a vowel length the text does not mark. A text with macrons has
none; a plain text has a few, where an open penult could be long or short
(`divisa` without its marks). Nothing is discounted for them, because the
sounds are the spelling's own and only the stress was guessed. Paste the
macrons and the count goes to zero.

A Latin document with its macrons also gets its classical meter: a line that
scans as a dactylic hexameter, an elegiac pentameter or a hendecasyllable is
reported by its quantities (`DDSSDS  — ∪ ∪ | ...`) under **meter**; medieval
rhymed Latin without macrons is reported by its stresses like any other lyric.
Latin's own double meaning, the quantity pun (`malum` evil, `mālum` apple),
is found when both spellings are in the text.

If the tooltip says `rules` and you expected `cmudict`, the dictionary is not
importable in the backend's environment: run `uv sync` and restart the backend.

## Troubleshooting

- **"These lyrics have not been read yet."** Nothing has been analysed for this
  song. Press ANALYSE.
- **"No lyrics here yet."** The song has no words at all. Paste or transcribe
  them in SING first.
- **STALE badge.** The words changed after the analysis ran. Re-analyse.
- **A scheme that looks wrong.** Check the pronunciation source and the GUESSED
  tile first; a lyric full of invented words is being sounded out by rule.
- **Nothing in the findings list.** Either every family is switched off, or the
  floor is above everything found. The list says so and tells you which to
  change.
- **"AI: …"** in amber. The interpretive pass could not run (no key,
  a provider error, an unparseable reply). Everything else on the page is still
  correct.
- **The findings list stops partway.** Each kind lists at most 50 rows and says
  how many more there are; the rest are still painted on the sheet. A hook
  repeated forty times is one finding with a great many spans.

## API

Prefix `/api/lyricanalysis`.

```http
GET    /api/lyricanalysis                    capabilities: the taxonomy, and whether an LLM key exists
POST   /api/lyricanalysis/analyze            {text, language} -> a document, nothing stored
GET    /api/lyricanalysis/{entry_id}         {doc, persisted, stale}
POST   /api/lyricanalysis/{entry_id}/run     {force, llm, provider, model, api_key} -> a job
GET    /api/lyricanalysis/{entry_id}/job     the analysis running for this subject, if any
DELETE /api/lyricanalysis/{entry_id}         delete the stored analysis
GET    /api/lyricanalysis/jobs/{job_id}      job status and result

GET    /api/lyricanalysis/documents/{doc_id}/marks   the writer's own marks on this draft
PUT    /api/lyricanalysis/documents/{doc_id}/marks   replace the whole set
```

A mark is a set of word positions the writer picked by hand, saved with a name
and a verdict. `GET` anchors them onto the words as they are now and names the
ids the lyric has moved out from under; `PUT` replaces the whole set, mints ids
server-side, and drops spans that no longer match a word.

`{entry_id}` is either a library entry or a lyric document id (`lyricdoc_` plus
32 hex characters), so one pane reads a song or a notebook page without knowing
the difference. The notebook's own endpoints are in
[The lyric notebook](lyric-notebook.md#api).

`run` returns `{"ok", "job", "reused"}`; a second call while a job is running
for that subject returns the same job rather than starting another.
