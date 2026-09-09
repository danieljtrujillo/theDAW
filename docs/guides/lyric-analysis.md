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

Press **ANALYSE** (it reads **RE-ANALYSE** once a document exists). The pass
runs as a job with a progress bar, because it is real CPU work — every word is
turned into phones and compared with its neighbours — and it is never run per
keystroke. A song with no words yet says so and offers nothing to press.

The result is saved next to the song as `lyric_analysis.json` and registered as
a notation artifact of kind `lyricanalysis`, so it survives a restart and two
tabs never analyse the same song twice.

Edit a song's lyrics afterwards and the pane header shows an amber **STALE**
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
within three words is alliteration, a repeated stressed vowel within four is
assonance, a repeated non-initial consonant with at least three carriers is
consonance, and a dense enough run of s/z/sh/ch or p/b/t/d/k/g over a six-word
window is sibilance or plosives.

Repetition is found from the words: lines that open alike (anaphora), close
alike (epistrophe), do both (symploce), hand the last word to the next line
(anadiplosis), repeat a word back to back (epizeuxis), reuse one root in
another form (polyptoton), mirror A B … B A (antimetabole), or repeat a whole
line (refrain).

Structure is enjambment (the sentence runs on past the line break), caesura (a
strong break inside a line) and meter — named only when a line's actual stress
pattern fits a named foot, so you get "iambic tetrameter" when the line really
is one and nothing when it is not.

### Meaning: the optional interpretive pass

Metaphor, simile, irony, imagery, symbolism, puns and double meanings are
readings, not measurements, so they are not computed — they are asked for.
Tick **READ THE MEANING TOO** and pick a provider before you analyse.

The pass uses whatever LLM key the assistant already has (Gemini, OpenAI,
Anthropic, Grok, Groq, OpenRouter, in that probe order); nothing extra to set
up, and the checkbox is disabled with an explanation when no provider has a
key. It reads the first 200 lines of the lyric, returns at most 80 findings,
and every one of them is re-validated against the real line and word indices
before it is kept — a model cannot point at a word that is not there. Findings
from the pass carry an `llm` badge and the model's own confidence, never a
rule's.

The checkbox starts off every session, because the pass spends your key. If it
fails, the deterministic analysis is still saved and the reason is shown as
"meaning pass: …" rather than being silently reported as "this song has no
metaphors".

## Reading the pane

The pane is a stack of sections, read top to bottom:

- **Shape** — one bar per line: its syllable count, how many findings it
  carries and its rhyme class. Click a bar to jump the sheet to that line.
- **The lyric** — the words themselves with every visible device painted on
  them, the scheme letter down the left, and a **CLASSES** row above. Click a
  class to isolate it; click it again to show everything.
- **Findings** — the list, grouped by family and kind, each row with its
  confidence as a bar and a percentage. Click one to open the inspector at the
  bottom and light that finding up on the words.
- **Metrics** — lines, words, syllables, unique words, type/token ratio, rhyme
  density, multisyllabic count, syllables per line, and the guessed count.

A rhyme class is never distinguished by hue alone: the scheme letter carries
the information, and each class also has its own node shape, so the sheet
survives colour blindness and a monochrome screenshot.

The row of controls above the sheet is both the legend and the filter:

| Control | What it does |
|---|---|
| The five family checkboxes | Show or hide a whole family, with its shape and its count beside it. **Sound is off by default** — alliteration, assonance and consonance fire on most of a lyric by their nature (78% of words carry a mark with every family on, against 48% without), and a highlighter over everything says nothing. |
| **FLOOR** | Hide findings the detector is less sure of than this. Starts at 50%. |
| **LINKS** | Draw internal, leonine and cross-line rhymes as arcs over the sheet — they are invisible in a flat list and they are the interesting part of a rap lyric. On by default. |
| **STRESS** | One dot per syllable beside each line, filled where the stress falls. Off by default, and hidden when the pane is narrow. |
| **KARAOKE OVERLAY** | Underline the same devices on the karaoke words while the song plays. On by default. |

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

The badge in the pane header says which one actually backed this analysis:
`cmudict`, `rules`, or `mixed`.

**Be aware of what this costs when it says `rules`.** The guessed
pronunciations are the weaker half, and they go wrong in both directions: the
rules miss rhymes the dictionary would have found, and they also pair words the
dictionary would have kept apart. Ordinary English is the good case; names,
slang, coinages and anything spelled the way it is sung are the bad ones. So a
lyric analysed mostly by rule should be read as a sketch of its scheme rather
than as a measurement of it — which is why the badge and the **GUESSED** tile
are on the page at all, and why the discount below exists.

The **GUESSED** metric tile counts the distinct words that had no dictionary
pronunciation, and when it is above zero the pane says in words that the more
of these there are, the softer every rhyme finding above. A guessed word also
discounts the confidence of anything it feeds, by 15% when one side of a pair
was guessed and 25% when both were — but only when a dictionary is actually
installed, because when everything is a guess, discounting everything equally
just slides the whole lyric under your confidence floor and tells you nothing.

If the badge says `rules` and you expected `cmudict`, the dictionary is not
importable in the backend's environment: run `uv sync` and restart the backend.

## Troubleshooting

- **"These lyrics have not been read yet."** Nothing has been analysed for this
  song. Press ANALYSE.
- **"No lyrics here yet."** The song has no words at all. Paste or transcribe
  them in SING first.
- **STALE badge.** The words changed after the analysis ran. Re-analyse.
- **A scheme that looks wrong.** Check the pronunciation badge and the GUESSED
  tile first; a lyric full of invented words is being sounded out by rule.
- **Nothing in the findings list.** Either every family is switched off, or the
  floor is above everything found. The list says so and tells you which to
  change.
- **"meaning pass: …"** in amber. The interpretive pass could not run (no key,
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
```

`{entry_id}` is either a library entry or a lyric document id (`lyricdoc_` plus
32 hex characters), so one pane reads a song or a notebook page without knowing
the difference. The notebook's own endpoints are in
[The lyric notebook](lyric-notebook.md#api).

`run` returns `{"ok", "job", "reused"}`; a second call while a job is running
for that subject returns the same job rather than starting another.
