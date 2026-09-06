# Sing-along and lyrics (SING tab)

The SING tab shows a song's lyrics large and centred, and moves them with the
track line by line and word by word. The words can be timed automatically
against the vocal, stamped by hand while the song plays, or imported from an
LRC file. A pitch lane scores what you sing against the song's melody.

## Where lyrics come from

Every library entry has a **Lyrics** field (Details tab, Catalogue inspector).
Suno imports fill it automatically; files with embedded lyric tags fill it on
import; anything else starts empty. SING reads that field first, then the
analyzer's embedded tags, then `lyrics:` tags. Notes are never used
automatically: when they look like lyrics, SING offers a "Use notes as
lyrics" link instead.

Timed lyrics live in one file per song, `lyrics.json` next to the audio, and
show up in the SCORE tab's artifact list as kind `lyrics`. Saving the timed
document also writes the plain text back into the Lyrics field, so the two
never disagree.

Your words are the reference. Nothing in SING rewrites the text you pasted;
the tools below only add timing to it, or point at words worth checking.

## Getting words in

- **PASTE LYRICS / EDIT** opens a text box. One line per line; `[Chorus]` or
  `(bridge)` on a line of its own becomes a section marker. Lines you did not
  change keep their timings when you apply an edit.
- **IMPORT** takes an LRC or TXT file (or pasted text). Enhanced LRC word tags
  and `[offset:]` are honoured.
- **TRANSCRIBE** asks whisper to write the lyrics from the vocal. Use it when
  there is no lyric sheet at all. The first run installs the whisper sidecar
  into its own environment (a few minutes); the button reads INSTALL
  TRANSCRIPTION until then. Whisper on sung vocals is a draft, not a
  transcript: expect to correct it in EDIT.

## Timing the words: ALIGN

**ALIGN** keeps your words and takes the timing from the vocal.

1. SING finds the cleanest vocal it can: the song's `vocals` stems (lead and
   backing mixed together). When the song has no stems and the stem
   separator is installed, it separates the song first (Demucs, 4 stems, on
   the GPU when there is one). If a separation for that song is already
   running, ALIGN waits for it rather than starting a second one. Without a
   stemmer it isolates the vocal from the mix, which is a much weaker input.
2. A **forced aligner** (Meta's MMS aligner, through torchaudio) places every
   word of your text on the vocal. It never guesses words; it only finds
   where each of your words is sung. Every line and every word gets a start
   time. On a GPU a three-minute song takes a few seconds. The first ALIGN
   downloads the aligner model (1.2 GB, once, into the torch hub cache); the
   status line says so while it happens.
3. The timed document is saved and SING starts following immediately.
4. **Review** (on by default): whisper listens to the same vocal in a
   separate job. Where whisper heard a different word than the one you
   wrote, that word gets an amber wavy underline, and the header counts how
   many words differ. Hover an underlined word to read what whisper heard.
   The underline is a hint to check, not a correction; the timings stay the
   aligner's. Whisper is wrong more often than a lyric sheet on sung vocals,
   so a difference only counts on lines whisper clearly followed, and when
   it could not follow the song at all nothing is flagged and the status
   says "whisper could not follow this vocal".

Words the aligner cannot spell (digits, scripts its romanised alphabet does
not cover) are placed between their neighbours.

The header shows where the words came from (pasted, suno, aligned, tapped,
lrc) and how many words were timed.

**AUTO** in the footer (on by default) runs ALIGN by itself when a song opens
with lyrics but no timings, and picks up an align or review job the import
pipeline already started for that song.

## What happens on import

An imported song with lyric text is aligned in the background right after
its stems, before its MIDI and sheet, so it is ready to sing when you open
it. This is the `lyrics.auto_on_import` setting (on by default). With
`lyrics.auto_transcribe` on (off by default), a song with no lyric text is
transcribed instead. Background jobs wait until the app is idle; opening
the song in SING with AUTO on runs the alignment right away instead, and
the queued job then finds it done.

## Following and tapping

- **FOLLOW** highlights the sounding line and word and keeps it at reading
  height. The scroll glides continuously toward the next line. Scrolling by
  hand parks the auto-scroll for a couple of seconds.
- Click a timed line to seek there.
- **TAP** mode: play the song and press Space (or Enter, or the TAP button)
  when each line starts; the next untimed line is stamped 80 ms before your
  tap. Backspace undoes the last tap. In tap mode every line shows its time
  chip, and every timed line shows −/+ buttons that nudge it 50 ms.
- **OFFSET ms** shifts every lyric: positive shows the words later.
- Timings autosave a moment after each change and when playback pauses.

## Export

EXPORT downloads LRC (line timings), LRC with word tags, or plain TXT. The
song title and the artist from Settings → Notation go into the LRC header.

## Pitch lane

Turn on **PITCH** to see the song's melody (from the vocal analysis; ANALYZE
MELODY runs it when missing) scroll past a playhead. **MIC ON** listens to your
microphone and draws your pitch over the target, green when within 50 cents of
the note (any octave), amber otherwise, with a per-line and total score. Use
headphones: without them the microphone hears the track and scores the song
instead of you. MIC OFFSET compensates the microphone's latency.

## Settings

In `data/settings.json`, section `lyrics`:

| Key | Default | Meaning |
|---|---|---|
| `auto_on_import` | `true` | Align an imported song that has lyric text, right after its stems. |
| `auto_on_generate` | `false` | The same for generated tracks. |
| `auto_transcribe` | `false` | Transcribe a song that has no lyric text instead of skipping it. |
| `language` | `auto` | Whisper language for the background jobs; `auto` detects. |
| `aligner` | `auto` | `mms` forced alignment, `whisper` (match whisper's words to yours, the old way), or `auto` (mms when torchaudio has it). |
| `review` | `true` | Run the whisper review pass after a forced alignment. |

The SING footer's language picker sets the language for the jobs you start
from the tab.

## How the heavy work is scheduled

Stem separation, whisper, the aligner and audio-to-MIDI conversion share one
coordinator. For any one song, each of those runs once at a time: a second
request joins the run in flight instead of starting another process. They
share a single GPU lane, so two models never run on the card together, and
the background queue stays parked while a foreground job holds it. MIDI
conversion waits for a stem separation in flight so the per-stem
conversions see the stems. All of it runs on the GPU when there is one:
Demucs, whisper (`large-v3`, float16), the MMS aligner, basic-pitch (ONNX
Runtime's CUDA provider) and piano transcription. Without a GPU whisper
falls back to the `small` model on the CPU.

## Troubleshooting

- "OTHER TRACK" in the footer: the player holds a different song. Press play
  in SING to load this one.
- TRANSCRIBE / ALIGN say the sidecar is unavailable: run INSTALL TRANSCRIPTION,
  or check the vocal engine's transcription probe at
  `/api/vocal/transcription/probe`.
- Words highlight late or early everywhere: adjust OFFSET ms (or CALIBRATE in
  the SCORE tab, which SING shares).
- Timings land in the wrong verse: the song has no stems and the vocal was
  isolated from the mix. Separate the stems (right-click the track) and ALIGN
  again.
- "whisper could not follow this vocal" after an alignment: the timings are
  fine; only the review had nothing reliable to compare. Heavily effected
  or harmonised vocals do this.
- No pitch drawn: the vocal has not been analyzed yet (ANALYZE MELODY), or the
  microphone permission was refused.
- The processing log says whisper ran on the CPU although the machine has a
  GPU: the sidecar's CUDA libraries did not install. The log line names the
  error; INSTALL TRANSCRIPTION again after fixing it.

## API

```http
GET    /api/lyrics/{entry_id}                the document (derived when nothing is saved)
PUT    /api/lyrics/{entry_id}                save text or lines, offset, language
DELETE /api/lyrics/{entry_id}                delete the timed document
POST   /api/lyrics/{entry_id}/align          {text?, language, isolate, aligner?, review?}
POST   /api/lyrics/{entry_id}/transcribe     {language, isolate, sync_vocal}
GET    /api/lyrics/{entry_id}/job            the align / transcribe / review job running now
GET    /api/lyrics/jobs/{job_id}             job status and result
POST   /api/lyrics/{entry_id}/import         {format: lrc|txt, content}
GET    /api/lyrics/{entry_id}/export?format=lrc|txt&words=0|1
```

`align` and `transcribe` return `{"job": {"id"}, "reused": bool}`; a second
call while a job runs for the entry returns that job.
