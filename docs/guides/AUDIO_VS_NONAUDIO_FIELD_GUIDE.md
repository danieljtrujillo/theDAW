# Audio vs Non-Audio Field Guide

This guide groups the live cache fields from `cache/main/library_cache_FULLY_ENRICHED_WITH_LINEAGE.json`
by what they mean for music generation and analysis.

It is based on the sampled live-cache field dictionary in
[LIVE_CACHE_FIELD_DICTIONARY.md](/C:/Users/skream/projects/SunoHarvester/docs/DATA_TRUTH/LIVE_CACHE_FIELD_DICTIONARY.md),
which was generated from `5,000` real songs.

## How to think about this cache

The cache is not just a raw Suno song object.
It contains:

1. Raw or near-raw Suno generation data
2. Flattened duplicates of raw fields for easier search/filtering
3. Local analytics and quality heuristics
4. Lineage and ancestor snapshots
5. Platform, UI, workspace, and cache bookkeeping data

For analysis, the most important distinction is:

1. `audio-relevant fields`
2. `non-audio fields`

Then inside each of those:

1. `direct inputs / controls`
2. `derived signals useful for learning what works`
3. `outcome metrics`
4. `mostly administrative or low-value fields`

## Audio Data

### 1. Direct generation inputs and controls

These are the most important fields if the goal is:

- learn what prompts produce good songs
- learn which settings produce better audio
- rebuild or optimize generation recipes

Use these first:

1. `metadata.prompt`
2. `metadata.tags`
3. `metadata.negative_tags`
4. `metadata.control_tags`
5. `metadata.control_sliders.audio_weight`
6. `metadata.control_sliders.style_weight`
7. `metadata.control_sliders.weirdness_constraint`
8. `metadata.task`
9. `metadata.type`
10. `metadata.make_instrumental`
11. `metadata.infill`
12. `metadata.infill_lyrics`
13. `metadata.can_remix`
14. `metadata.has_vocal`
15. `metadata.has_stem`
16. `metadata.persona_id`
17. `persona.*`
18. `metadata.duration`
19. `metadata.key`
20. `metadata.avg_bpm`
21. `metadata.min_bpm`
22. `metadata.max_bpm`

Why they matter:

1. `metadata.prompt` is the main lyrical/content conditioning input.
2. `metadata.tags` is the main style/genre/production-direction input.
3. `metadata.negative_tags` tells you what the user tried to suppress.
4. `control_sliders.*` are the closest thing to explicit generation knobs.
5. `persona.*` changes voice identity and often strongly affects output character.
6. `task`, `type`, `infill`, `make_instrumental`, `can_remix` define the generation mode.
7. `duration`, `key`, and `bpm` define musical structure and constraints.

### 2. Audio transformation and edit-chain fields

These tell you how a song was created from earlier material.
They are high value if you want to learn iterative workflows rather than one-shot prompting.

Core fields:

1. `metadata.cover_clip_id`
2. `metadata.edited_clip_id`
3. `metadata.upsample_clip_id`
4. `metadata.stem_from_id`
5. `metadata.overpainting_clip_id`
6. `metadata.underpainting_clip_id`
7. `metadata.override_future_clip_id`
8. `metadata.override_history_clip_id`
9. `metadata.override_future_start_seconds`
10. `metadata.override_history_end_seconds`
11. `metadata.continue_at`
12. `metadata.concat_history.*`
13. `metadata.history.*`
14. `parent_id`
15. `parent_ids.*`
16. `root_id.*`
17. `ancestry.*`
18. `ancestors[].metadata.*`

Why they matter:

1. They show whether the result came from a cover, edit, continuation, mashup, upsample, stem workflow, or deeper lineage chain.
2. They let you reconstruct successful multi-step generation recipes.
3. They are often more useful than raw prompts alone when studying high-performing songs.

### 3. Audio/media payload fields

These point to the actual assets you can inspect or re-analyze.

Fields:

1. `audio_url`
2. `video_url`
3. `image_url`
4. `image_large_url`
5. `media_urls[].url`
6. `media_urls[].content_type`
7. `media_urls[].delivery`
8. `media_urls[].encoding`

Why they matter:

1. `audio_url` is the actual source for waveform/audio-feature extraction.
2. `media_urls.*` can expose alternate delivery/format variants.
3. The image/video fields are not audio themselves, but they are part of the song package.

### 4. Derived audio-analysis fields

These are not the original Suno inputs.
They are local analysis outputs or normalized copies.
They are still very useful for finding patterns.

Fields:

1. `genre`
2. `genres`
3. `genre_purity`
4. `mood`
5. `moods`
6. `energy`
7. `vocal_type`
8. `instruments`
9. `tempo`
10. `bpm`
11. `bpm_min`
12. `bpm_max`
13. `musical_key`
14. `key`
15. `scale`
16. `duration`
17. `duration_seconds`
18. `style`
19. `style_prompt`
20. `tags_list`

Why they matter:

1. They make it easier to cluster songs by sound without re-parsing raw prompts every time.
2. They are good feature columns for ranking or nearest-neighbor search.
3. They help separate what a song sounds like from what the user asked for.

### 5. Lyrics and text-analysis fields

These are derived from prompt/lyrics text.
They are audio-relevant because lyric shape often affects song quality and usability.

Fields:

1. `lyrics`
2. `lyrics_prompt`
3. `lyrics_all_tags`
4. `lyrics_char_count`
5. `lyrics_density_class`
6. `lyrics_has_structure_tags`
7. `lyrics_is_instrumental`
8. `lyrics_line_count`
9. `lyrics_longest_line_chars`
10. `lyrics_meta_tag_count`
11. `lyrics_meta_tags`
12. `lyrics_repetition_class`
13. `lyrics_repetition_score`
14. `lyrics_section_count`
15. `lyrics_sentiment_label`
16. `lyrics_sentiment_polarity`
17. `lyrics_sentiment_subjectivity`
18. `lyrics_structure_tag_count`
19. `lyrics_structure_tags`
20. `lyrics_unique_words`
21. `lyrics_vocabulary_class`
22. `lyrics_vocabulary_richness`
23. `lyrics_word_count`
24. `lyrics_words_per_minute`
25. `rhyme_density`
26. `rhyme_density_class`
27. `rhyme_scheme`
28. `prompt`
29. `prompt_type`
30. `style_prompt_char_count`
31. `style_prompt_token_count`
32. `style_prompt_utilization`
33. `style_prompt_word_count`

Why they matter:

1. They help correlate writing style with playback results.
2. They let you study whether structured prompts, sparse prompts, or dense prompts perform better.
3. They are strong candidates for building prompt-quality heuristics.

### 6. Audio-oriented flattened duplicates

These are often copies of raw `metadata.*` fields or simplified aliases.
They are useful for querying, but for correctness prefer the original `metadata.*` value when possible.

Fields:

1. `audio_weight`
2. `style_weight`
3. `weirdness`
4. `control_sliders.*`
5. `can_remix`
6. `has_vocal`
7. `has_stem`
8. `is_remix`
9. `negative_tags`
10. `duration`
11. `prompt`
12. `style`
13. `key`
14. `tempo`
15. `persona_id`

Why they matter:

1. Easier to search and chart
2. Often already normalized
3. Lower effort for analytics pipelines

But:

1. They can drift from the nested source
2. They should be treated as convenience columns, not the canonical payload

## Audio Data That Can Be Used To Generate Better Audio

If the goal is to infer what leads to better generations, these are the highest-value audio groups.

### Tier 1: most actionable

1. `metadata.prompt`
2. `metadata.tags`
3. `metadata.negative_tags`
4. `metadata.control_sliders.*`
5. `persona.*`
6. `metadata.task`
7. `metadata.type`
8. `metadata.duration`
9. `metadata.key`
10. `metadata.avg_bpm`
11. `metadata.history.*`
12. `metadata.concat_history.*`
13. `ancestry.*`
14. `ancestors[].metadata.*`

These are the fields that most directly tell you:

1. what was requested
2. which knobs were used
3. which voice/persona was used
4. what multi-step process produced the result

### Tier 2: strong support signals

1. `genre`
2. `mood`
3. `energy`
4. `vocal_type`
5. `instruments`
6. `lyrics_*`
7. `rhyme_*`
8. `style_prompt*`

These are not generation inputs themselves, but they help explain:

1. what kind of outputs tend to perform best
2. which prompt styles are overrepresented among successful songs
3. how lyrical structure correlates with engagement

## Non-Audio Data

### 1. Outcome and performance signals

These are not generation inputs, but they are extremely important if you want to optimize for better results.

Fields:

1. `play_count`
2. `upvote_count`
3. `reaction.play_count`
4. `reaction.skip_count`
5. `reaction.flagged`
6. `reaction.reaction_type`
7. `skip_rate`
8. `engagement_score`
9. `engagement_class`
10. `popularity_class`
11. `comment_count`
12. `flag_count`

Why they matter:

1. These are the closest things to quality/outcome labels in the cache.
2. They let you rank prompts, personas, BPM ranges, and workflows by results.
3. If you are building “what should I generate more of?” logic, these are your target variables.

### 2. Lineage-scale and iterative-success fields

These are not directly audio features, but they help measure whether iterative workflows improve outputs.

Fields:

1. `generation_depth`
2. `family_tree_size`
3. `continuation_count`
4. `remaster_chain`
5. `remaster_count`
6. `remaster_is_latest`
7. `remaster_position`
8. `remaster_root_id`
9. `is_continuation`
10. `is_cover`
11. `is_edit`
12. `is_mashup`
13. `is_original`
14. `is_stem`
15. `is_upsample`

Why they matter:

1. They show how many rounds of iteration a song went through.
2. They let you test whether “more refinement” actually improves outcomes.
3. They are especially useful when combined with engagement metrics.

### 3. Clustering and similarity fields

These help you group songs and identify good neighborhoods of examples.

Fields:

1. `cluster_id`
2. `cluster_label`
3. `cluster_distance`
4. `nearest_neighbors`
5. `uniqueness_class`
6. `completeness_score`
7. `completeness_class`
8. `complexity_class`

Why they matter:

1. They help identify similar songs that worked well.
2. They support “find more like this” logic.
3. They are useful for mining repeated successful patterns.

### 4. Identity, creator, and social context

These mostly identify who made the song and what account context it lives in.

Fields:

1. `id`
2. `title`
3. `user_id`
4. `display_name`
5. `handle`
6. `avatar_image_url`
7. `artist`
8. `is_following_creator`
9. `is_verified`
10. `is_persona_root`

Why they matter:

1. Useful for grouping songs by creator or voice family
2. Sometimes useful for detecting creator-specific styles
3. Not usually direct optimization levers for better audio

### 5. Workspace and organizational fields

These tell you where the song sits in your project structure.

Fields:

1. `project.*`
2. `workspace`
3. `workspace_id`
4. `workspace_name`
5. `project_id`
6. `session_id`
7. `session_position`
8. `session_size`
9. `_session_id`
10. `batch_index`

Why they matter:

1. Good for grouping by creative session or project
2. Useful for comparing experiments by workspace/session
3. Not direct audio inputs

### 6. Platform, visibility, and moderation fields

These mostly describe publishability or platform state.

Fields:

1. `status`
2. `explicit`
3. `allow_comments`
4. `is_public`
5. `is_hidden`
6. `is_trashed`
7. `is_contest_clip`
8. `has_hook`
9. `action_config.*`

Why they matter:

1. Operationally useful
2. Sometimes related to outcome or workflow
3. Usually not strong drivers for improving audio generation itself

### 7. UI and presentation fields

These mostly exist to support display, filtering, or rendering in the app.

Fields:

1. `display_tags`
2. `badge_names`
3. `metadata.model_badges.*`
4. `metadata.secondary_badges.*`
5. `caption`
6. `image_url`
7. `image_large_url`

Why they matter:

1. Helpful for browsing
2. Low value for model/prompt optimization

### 8. Cache and bookkeeping fields

These are mostly local pipeline or timing fields.

Fields:

1. `_clip_enriched_at`
2. `_enriched_at`
3. `_full_metadata_fetched`
4. `last_updated`
5. `created_at`
6. `created_date`
7. `created_month`
8. `created_timestamp`
9. `created_year`
10. `creation_day_of_week`
11. `creation_hour`
12. `days_since_creation`
13. `age_class`

Why they matter:

1. Useful for freshness and time-based analysis
2. Useful for longitudinal performance studies
3. Not direct generation controls

## Non-Audio Data That Is Useful For Better Audio

These are the non-audio fields that still matter if you want to generate better songs.

### Highest value

1. `play_count`
2. `upvote_count`
3. `reaction.play_count`
4. `reaction.skip_count`
5. `skip_rate`
6. `engagement_score`
7. `popularity_class`
8. `generation_depth`
9. `family_tree_size`
10. `continuation_count`
11. `cluster_id`
12. `nearest_neighbors`

Why:

1. They tell you which songs actually worked better.
2. They let you tie success back to prompts, personas, BPM, key, and workflow.
3. They are the best supervision targets for optimization.

### Medium value

1. `project.*`
2. `workspace*`
3. `session_*`
4. `created_*`
5. `age_class`

Why:

1. They help compare sessions, time periods, and project contexts.
2. They are useful for experiment tracking.

### Low value for optimization

1. `avatar_image_url`
2. `badge_names`
3. `metadata.model_badges.*`
4. `metadata.secondary_badges.*`
5. `action_config.*`
6. visibility flags by themselves

Why:

1. Mostly UI/platform noise
2. Usually not causal for better audio output

## Practical recommendation

If you want to build a “generate better songs” analysis table, split the fields like this:

### Direct controllable inputs

1. `metadata.prompt`
2. `metadata.tags`
3. `metadata.negative_tags`
4. `metadata.control_sliders.*`
5. `persona.*`
6. `metadata.task`
7. `metadata.type`
8. `metadata.make_instrumental`
9. `metadata.duration`
10. `metadata.key`
11. `metadata.avg_bpm`

### Recipe / process history

1. `metadata.history.*`
2. `metadata.concat_history.*`
3. `metadata.cover_clip_id`
4. `metadata.edited_clip_id`
5. `metadata.upsample_clip_id`
6. `metadata.stem_from_id`
7. `ancestry.*`
8. `ancestors[].metadata.*`

### Derived descriptive features

1. `genre`
2. `mood`
3. `energy`
4. `vocal_type`
5. `instruments`
6. `lyrics_*`
7. `rhyme_*`
8. `style_prompt*`

### Outcome labels

1. `play_count`
2. `upvote_count`
3. `reaction.skip_count`
4. `skip_rate`
5. `engagement_score`
6. `popularity_class`

That is the cleanest separation if the goal is:

1. identify what inputs and workflows produce better songs
2. measure what “better” means from actual user behavior
3. feed those insights back into future generations
