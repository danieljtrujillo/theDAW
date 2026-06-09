# Prompting Guide

This guide describes how text prompts steer theDAW's generative engine. The model conditions on natural-language text through a T5Gemma encoder together with a duration signal, and the prompt combines with init audio, inpaint regions, and Chimera fusion to shape a generation. The sections below cover prompt structure, the signals the model responds to, and style references.

> The in-app assistant indexes this guide. A question such as "how do I prompt for X" in the orb panel returns an answer from here.

---

## 1. How the model reads a prompt

The prompt functions as a description of the desired music, written the way a producer would describe a track to another producer. "Driving synthwave, gated reverb snare, analog bass arpeggio, 110 BPM" produces a usable result. The T5Gemma encoder conditions on meaning rather than isolated keywords, so descriptive phrases outperform a list of bare tags, while dense and compact phrasing outperforms long prose. Duration is a separate control set with the Duration slider, and the model uses it to plan structure and pacing. The interface has a single prompt field with no separate negative slot, so describing the desired trait directly (for example "clean, dry, minimal reverb") steers the result. On RF checkpoints, CFG scale governs how literally the model follows the text.

---

## 2. Prompt anatomy

A strong prompt names some combination of these dimensions. Each prompt uses the dimensions that matter for the intended sound.

| Dimension | Examples |
|---|---|
| **Genre / subgenre** | lo-fi hip hop, liquid drum & bass, dark ambient, bossa nova, UK garage, cinematic trailer |
| **Instrumentation** | Rhodes electric piano, 808 sub bass, fingerpicked nylon guitar, analog Juno pad, brushed drums, string section |
| **Tempo / feel** | 84 BPM, half-time, swung 16ths, four-on-the-floor, rubato, driving |
| **Mood / energy** | melancholic, euphoric, tense, warm and nostalgic, hypnotic, triumphant |
| **Production / mix** | tape saturation, sidechained pump, wide stereo, gritty lo-fi, pristine and modern, vinyl crackle |
| **Structure / motion** | building intro, drop at the halfway point, sparse and minimal, evolving pad |

A common pattern is `<genre>, <key instruments>, <tempo/feel>, <mood>, <production texture>`.

Examples:

- `Lo-fi boom bap, dusty Rhodes chords, vinyl crackle, lazy swung drums, 84 BPM, nostalgic`
- `Liquid drum & bass, lush reverb pads, rolling sub bass, chopped soul vocal, 174 BPM, uplifting`
- `Cinematic orchestral build, low strings, taiko hits, rising tension, percussion entering at the climax`
- `Bossa nova, nylon guitar, soft brushes, upright bass, intimate jazz club, warm`

---

## 3. Conditioning signals beyond text

Text is one of several conditioning inputs in the MAKE tab. The prompt combines with the following signals on the same generation.

- **Init audio (audio-to-audio).** A supplied clip is reinterpreted under the prompt. The clip can be a voice recording from the microphone recorder, an imported file, an item from the media bucket or library, or a pattern rendered to a clip from the piano roll or step sequencer. The init noise level controls how far the result departs from the source, where low values stay close and high values keep only the gist.
- **Inpainting and continuation.** A painted region regenerates under the prompt and the surrounding audio, which suits fills, transitions, and extending a track past its end.
- **Chimera fusion.** Several beat-aligned source clips blend into one generation while the prompt steers the overall character.
- **Duration.** The chosen length shapes arrangement, where short durations yield loops and one-shots and long durations produce intros, development, and endings.

[User Guide](../USER_GUIDE.md) §6 has the full MAKE control reference.

---

## 4. Practical guidance

- Genre and the hook instrument carry the most weight, and the first phrases dominate the result.
- A stated BPM tightens tempo, especially for dance and hip-hop styles.
- Mix descriptors such as "warm tape saturation, wide stereo" change the result as much as the instrument list does.
- A new seed on the same prompt explores a different take, and a locked seed reproduces a take.
- A single changed dimension per iteration (the mood, then the drums) clarifies what each phrase contributes.
- The magic-prompt button seeds an empty field, and the sparkles button sends the text to the assistant for an optimized rewrite.
- A duration that matches the intent produces the cleanest result, since a full arrangement in 8 seconds or a one-shot in 3 minutes works against the model.

---

## 5. Style reference starters

- **Hip-hop and lo-fi:** `Boom bap, chopped jazz sample, dusty drums, sub bass, 90 BPM` · `Lo-fi study beat, Rhodes, rain ambience, soft kick, mellow`
- **Electronic:** `Melodic techno, hypnotic arpeggio, deep kick, analog bass, 124 BPM` · `Future garage, skippy 2-step drums, sub bass, ethereal vocal chops`
- **Cinematic:** `Epic trailer, braams, taiko, choir swells, rising tension` · `Ambient drone, evolving textures, field recording, sparse percussion, meditative`
- **Acoustic and band:** `Indie folk, acoustic guitar, brushed snare, upright bass, intimate` · `Neo-soul, electric piano, syncopated bass, live drums, warm, 78 BPM`
- **World and jazz:** `Bossa nova, nylon guitar, soft percussion, breezy` · `Afrobeat, polyrhythmic percussion, horn stabs, groovy bass, energetic`

---

[model-overview.md](model-overview.md) and [User Guide](../USER_GUIDE.md) §6, §20–§21 cover model sizes, samplers, CFG, and the full parameter set.
