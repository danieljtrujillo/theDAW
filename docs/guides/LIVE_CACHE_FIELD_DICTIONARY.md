# Live Cache Field Dictionary

Sampled from `5,000` songs in `cache/main/library_cache_FULLY_ENRICHED_WITH_LINEAGE.json`.
This is the live cache shape, not just the older documented core schema.

Total sampled unique field paths: **468**

## Top-Level Fields

1. `_clip_enriched_at` - Timestamp when this song got clip-detail enrichment.
2. `_enriched_at` - Timestamp when local enrichment was added.
3. `_full_metadata_fetched` - Boolean flag showing whether full metadata was fetched.
4. `_session_id` - Local cached session identifier.
5. `action_config` - UI/action rules object for this song.
6. `age_class` - Derived classification bucket for age.
7. `allow_comments` - Whether comments are allowed.
8. `artist` - Artist label or inferred artist string.
9. `audio_url` - URL to the main audio file.
10. `audio_weight` - Flattened audio influence slider value.
11. `avatar_image_url` - Creator avatar image URL.
12. `badge_names` - Flattened list of badge names for display/search.
13. `batch_index` - Position within a generation batch.
14. `bpm` - Bpm value.
15. `bpm_class` - Derived classification bucket for bpm.
16. `bpm_match_count` - Count of bpm match.
17. `bpm_max` - Bpm max value.
18. `bpm_min` - Bpm min value.
19. `can_remix` - Flattened remix-allowed flag.
20. `cluster_distance` - Cluster distance value.
21. `cluster_id` - ID for cluster.
22. `cluster_label` - Human-readable label for cluster.
23. `comment_count` - Number of comments.
24. `completeness_class` - Derived classification bucket for completeness.
25. `completeness_score` - Numeric score for completeness.
26. `complexity_class` - Derived classification bucket for complexity.
27. `continuation_count` - Count of continuation.
28. `control_sliders` - Grouped generation slider values.
29. `control_sliders.audio_weight` - Audio weight value under `control_sliders`.
30. `control_sliders.style_weight` - Style weight value under `control_sliders`.
31. `control_sliders.weirdness_constraint` - Weirdness constraint value under `control_sliders`.
32. `created_at` - Original creation timestamp.
33. `created_date` - Date value for created.
34. `created_month` - Month value for created.
35. `created_timestamp` - Created timestamp value.
36. `created_year` - Year value for created.
37. `creation_day_of_week` - Creation day of week value.
38. `creation_hour` - Hour-of-day value for creation.
39. `days_since_creation` - Days since creation value.
40. `display_name` - Creator display name.
41. `display_tags` - Display-friendly style tags.
42. `duration` - Flattened duration value.
43. `duration_class` - Derived classification bucket for duration.
44. `duration_seconds` - Duration normalized to seconds.
45. `energy` - Energy value.
46. `energy_class` - Derived classification bucket for energy.
47. `engagement_class` - Derived classification bucket for engagement.
48. `engagement_score` - Numeric score for engagement.
49. `entity_type` - API entity type.
50. `explicit` - Explicit-content flag.
51. `family_tree_size` - Family tree size value.
52. `flag_count` - Number of reports/flags.
53. `generation_depth` - Generation depth value.
54. `generation_type` - Type/category for generation.
55. `genre` - Genre value.
56. `genre_purity` - Genre purity value.
57. `genres` - Genres value.
58. `handle` - Creator handle/username.
59. `has_ancestry` - Boolean flag for whether it has ancestry.
60. `has_hook` - Whether Suno marked a hook.
61. `has_stem` - Flattened has-stems flag.
62. `has_vocal` - Flattened vocals-present flag.
63. `id` - Song ID.
64. `image_large_url` - Large artwork URL.
65. `image_url` - Artwork/thumbnail URL.
66. `instruments` - Instruments value.
67. `is_contest_clip` - Whether it belongs to a contest.
68. `is_continuation` - Boolean flag for whether it is continuation.
69. `is_cover` - Boolean flag for whether it is cover.
70. `is_edit` - Boolean flag for whether it is edit.
71. `is_following_creator` - Whether the active user follows the creator.
72. `is_handle_updated` - Whether the handle was updated from an older value.
73. `is_hidden` - Hidden-visibility flag.
74. `is_instrumental` - Boolean flag for whether it is instrumental.
75. `is_liked` - Whether the active user liked the song.
76. `is_mashup` - Boolean flag for whether it is mashup.
77. `is_original` - Boolean flag for whether it is original.
78. `is_persona_root` - Boolean flag for whether it is persona root.
79. `is_public` - Whether the song is public.
80. `is_remix` - Boolean flag for whether it is remix.
81. `is_stem` - Boolean flag for whether it is stem.
82. `is_trashed` - Whether the song is trashed.
83. `is_upsample` - Boolean flag for whether it is upsample.
84. `is_verified` - Boolean flag for whether it is verified.
85. `key` - Flattened musical key value.
86. `last_updated` - Last local update timestamp.
87. `lyrics` - Flattened lyrics/prompt text.
88. `lyrics_all_tags` - Lyrics all tags value.
89. `lyrics_char_count` - Count of lyrics char.
90. `lyrics_density_class` - Derived classification bucket for lyrics density.
91. `lyrics_has_structure_tags` - Lyrics has structure tags value.
92. `lyrics_is_instrumental` - Lyrics is instrumental value.
93. `lyrics_line_count` - Count of lyrics line.
94. `lyrics_longest_line_chars` - Lyrics longest line chars value.
95. `lyrics_meta_tag_count` - Count of lyrics meta tag.
96. `lyrics_meta_tags` - Lyrics meta tags value.
97. `lyrics_prompt` - Prompt text kept under a lyrics-focused name.
98. `lyrics_repetition_class` - Derived classification bucket for lyrics repetition.
99. `lyrics_repetition_score` - Numeric score for lyrics repetition.
100. `lyrics_section_count` - Count of lyrics section.
101. `lyrics_sentiment_label` - Human-readable label for lyrics sentiment.
102. `lyrics_sentiment_polarity` - Lyrics sentiment polarity value.
103. `lyrics_sentiment_subjectivity` - Lyrics sentiment subjectivity value.
104. `lyrics_structure_tag_count` - Count of lyrics structure tag.
105. `lyrics_structure_tags` - Lyrics structure tags value.
106. `lyrics_unique_words` - Lyrics unique words value.
107. `lyrics_vocabulary_class` - Derived classification bucket for lyrics vocabulary.
108. `lyrics_vocabulary_richness` - Lyrics vocabulary richness value.
109. `lyrics_word_count` - Count of lyrics word.
110. `lyrics_words_per_minute` - Lyrics words per minute value.
111. `major_model_version` - Major model family/version.
112. `model_name` - Exact model name.
113. `model_version` - Normalized model version label.
114. `mood` - Mood value.
115. `moods` - Moods value.
116. `musical_key` - Musical key value.
117. `nearest_neighbors` - Nearest neighbors value.
118. `negative_tags` - Flattened negative/exclusion tags.
119. `parent_id` - Immediate parent song ID.
120. `persona_id` - Flattened persona/voice ID.
121. `play_count` - Play count.
122. `popularity_class` - Derived classification bucket for popularity.
123. `project_id` - Flattened workspace/project ID.
124. `prompt` - Flattened prompt/lyrics text.
125. `prompt_type` - Type/category for prompt.
126. `remaster_chain` - Remaster chain value.
127. `remaster_count` - Count of remaster.
128. `remaster_is_latest` - Remaster is latest value.
129. `remaster_position` - Remaster position value.
130. `remaster_root_id` - ID for remaster root.
131. `rhyme_density` - Rhyme density value.
132. `rhyme_density_class` - Derived classification bucket for rhyme density.
133. `rhyme_scheme` - Rhyme scheme value.
134. `scale` - Scale value.
135. `session_id` - Local session/grouping ID.
136. `session_position` - Session position value.
137. `session_size` - Session size value.
138. `skip_rate` - Skip rate value.
139. `skip_rate_class` - Derived classification bucket for skip rate.
140. `status` - Song generation status.
141. `style` - Flattened style/tags text.
142. `style_prompt` - Style prompt value.
143. `style_prompt_char_count` - Count of style prompt char.
144. `style_prompt_token_count` - Count of style prompt token.
145. `style_prompt_utilization` - Style prompt utilization value.
146. `style_prompt_word_count` - Count of style prompt word.
147. `style_weight` - Flattened style influence slider value.
148. `tags_list` - Tags list value.
149. `task_type` - Normalized task type derived from metadata.
150. `tempo` - Normalized tempo value.
151. `title` - Song title.
152. `title_char_count` - Count of title char.
153. `title_has_version_marker` - Title has version marker value.
154. `title_word_count` - Count of title word.
155. `uniqueness_class` - Derived classification bucket for uniqueness.
156. `upvote_count` - Upvote count.
157. `user_id` - Creator user ID.
158. `video_url` - Video URL.
159. `vocal_type` - Type/category for vocal.
160. `weirdness` - Flattened weirdness slider value.
161. `workspace` - Flattened workspace/project label.
162. `workspace_id` - Flattened workspace/project ID.
163. `workspace_name` - Flattened workspace/project name.

## Action Config

1. `action_config.actions` - List of allowed UI actions for the song.
2. `action_config.actions[].action_type` - Type/category for action.
3. `action_config.actions[].disabled` - Whether this UI action/item should be disabled.
4. `action_config.actions[].visible` - Whether this UI action/item should be visible.

## Media URLs

1. `media_urls` - List of alternate media URL variants.
2. `media_urls[].content_type` - Type/category for content.
3. `media_urls[].delivery` - Delivery type for this media variant.
4. `media_urls[].encoding` - Encoding/format for this media variant.
5. `media_urls[].url` - URL value for this nested media/resource entry.

## Metadata Base

1. `metadata` - Nested raw/near-raw generation metadata.
2. `metadata.artist_clip_id` - ID for artist clip.
3. `metadata.avg_bpm` - Avg bpm value under `metadata`.
4. `metadata.can_publish_with_vocal` - Can publish with vocal value under `metadata`.
5. `metadata.can_remix` - Can remix value under `metadata`.
6. `metadata.continue_at` - Timestamp for continue.
7. `metadata.control_tags` - Control tags value under `metadata`.
8. `metadata.cover_clip_id` - ID for cover clip.
9. `metadata.cover_end_s` - Time/offset in seconds for cover end.
10. `metadata.cover_start_s` - Time/offset in seconds for cover start.
11. `metadata.duration` - Duration value under `metadata`.
12. `metadata.edit_session_id` - ID for edit session.
13. `metadata.edited_clip_id` - ID for edited clip.
14. `metadata.has_stem` - Boolean flag for whether it has stem.
15. `metadata.has_vocal` - Boolean flag for whether it has vocal.
16. `metadata.infill` - Infill value under `metadata`.
17. `metadata.infill_lyrics` - Infill lyrics value under `metadata`.
18. `metadata.is_audio_upload_tos_accepted` - Boolean flag for whether it is audio upload tos accepted.
19. `metadata.is_loudness_under_threshold` - Boolean flag for whether it is loudness under threshold.
20. `metadata.is_mumble` - Boolean flag for whether it is mumble.
21. `metadata.is_remix` - Boolean flag for whether it is remix.
22. `metadata.key` - Key value under `metadata`.
23. `metadata.lyrics_updated` - Lyrics updated value under `metadata`.
24. `metadata.make_instrumental` - Make instrumental value under `metadata`.
25. `metadata.mashup_clip_ids` - Mashup clip ids value under `metadata`.
26. `metadata.max_bpm` - Max bpm value under `metadata`.
27. `metadata.min_bpm` - Min bpm value under `metadata`.
28. `metadata.negative_tags` - Negative tags value under `metadata`.
29. `metadata.normalize_volume` - Normalize volume value under `metadata`.
30. `metadata.overpainting_clip_id` - ID for overpainting clip.
31. `metadata.override_future_clip_id` - ID for override future clip.
32. `metadata.override_future_start_seconds` - Time/offset in seconds for override future start.
33. `metadata.override_history_clip_id` - ID for override history clip.
34. `metadata.override_history_end_seconds` - Time/offset in seconds for override history end.
35. `metadata.persona_id` - ID for persona.
36. `metadata.playlist_clip_ids` - Playlist clip ids value under `metadata`.
37. `metadata.playlist_id` - ID for playlist.
38. `metadata.priority` - Priority value under `metadata`.
39. `metadata.prompt` - Prompt value under `metadata`.
40. `metadata.refund_credits` - Refund credits value under `metadata`.
41. `metadata.show_remix` - Show remix value under `metadata`.
42. `metadata.stem_from_id` - ID for stem from.
43. `metadata.stem_task` - Stem task value under `metadata`.
44. `metadata.stem_type_group_name` - Name for stem type group.
45. `metadata.stem_type_id` - ID for stem type.
46. `metadata.stream` - Stream value under `metadata`.
47. `metadata.studio_project_id` - ID for studio project.
48. `metadata.studio_project_version_id` - ID for studio project version.
49. `metadata.tags` - Tags value under `metadata`.
50. `metadata.task` - Task value under `metadata`.
51. `metadata.type` - Type value under `metadata`.
52. `metadata.underpainting_clip_id` - ID for underpainting clip.
53. `metadata.upsample_clip_id` - ID for upsample clip.
54. `metadata.uses_latest_model` - Uses latest model value under `metadata`.
55. `metadata.variation_category` - Variation category value under `metadata`.
56. `metadata.video_is_stale` - Video is stale value under `metadata`.
57. `metadata.video_upload_height` - Video upload height value under `metadata`.
58. `metadata.video_upload_width` - Video upload width value under `metadata`.

## Metadata Control Sliders

1. `metadata.control_sliders` - Grouped generation slider values.
2. `metadata.control_sliders.audio_weight` - Audio weight value under `metadata.control_sliders`.
3. `metadata.control_sliders.style_weight` - Style weight value under `metadata.control_sliders`.
4. `metadata.control_sliders.weirdness_constraint` - Weirdness constraint value under `metadata.control_sliders`.

## Metadata Concat History

1. `metadata.concat_history` - Edit/generation history entries.
2. `metadata.concat_history[].continue_at` - Timestamp for continue.
3. `metadata.concat_history[].id` - Id value under `metadata.concat_history[]`.
4. `metadata.concat_history[].infill` - Infill value under `metadata.concat_history[]`.
5. `metadata.concat_history[].source` - Source value under `metadata.concat_history[]`.
6. `metadata.concat_history[].type` - Type value under `metadata.concat_history[]`.

## Metadata History

1. `metadata.history` - Edit/generation history entries.
2. `metadata.history[].continue_at` - Timestamp for continue.
3. `metadata.history[].control_tags` - Control tags value under `metadata.history[]`.
4. `metadata.history[].edited_clip_id` - ID for edited clip.
5. `metadata.history[].id` - Id value under `metadata.history[]`.
6. `metadata.history[].include_future_s` - Time/offset in seconds for include future.
7. `metadata.history[].include_history_s` - Time/offset in seconds for include history.
8. `metadata.history[].infill` - Infill value under `metadata.history[]`.
9. `metadata.history[].infill_context_end_s` - Time/offset in seconds for infill context end.
10. `metadata.history[].infill_context_start_s` - Time/offset in seconds for infill context start.
11. `metadata.history[].infill_dur_s` - Time/offset in seconds for infill dur.
12. `metadata.history[].infill_end_s` - Time/offset in seconds for infill end.
13. `metadata.history[].infill_lyrics` - Infill lyrics value under `metadata.history[]`.
14. `metadata.history[].infill_req_duration_s` - Time/offset in seconds for infill req duration.
15. `metadata.history[].infill_start_s` - Time/offset in seconds for infill start.
16. `metadata.history[].lyrics_updated` - Lyrics updated value under `metadata.history[]`.
17. `metadata.history[].source` - Source value under `metadata.history[]`.
18. `metadata.history[].stem_clip_id` - ID for stem clip.
19. `metadata.history[].stem_from_id` - ID for stem from.
20. `metadata.history[].stem_task` - Stem task value under `metadata.history[]`.
21. `metadata.history[].stem_type_group_name` - Name for stem type group.
22. `metadata.history[].stem_type_id` - ID for stem type.
23. `metadata.history[].type` - Type value under `metadata.history[]`.

## Metadata Model Badges

1. `metadata.model_badges` - Badge/style metadata for the model label.
2. `metadata.model_badges.songcard` - Songcard value under `metadata.model_badges`.
3. `metadata.model_badges.songcard.dark` - Dark-theme style configuration.
4. `metadata.model_badges.songcard.dark.background_color` - Color value used for background.
5. `metadata.model_badges.songcard.dark.border_color` - Color value used for border.
6. `metadata.model_badges.songcard.dark.text_color` - Color value used for text.
7. `metadata.model_badges.songcard.display_name` - Name for display.
8. `metadata.model_badges.songcard.light` - Light-theme style configuration.
9. `metadata.model_badges.songcard.light.background_color` - Color value used for background.
10. `metadata.model_badges.songcard.light.border_color` - Color value used for border.
11. `metadata.model_badges.songcard.light.text_color` - Color value used for text.
12. `metadata.model_badges.songrow` - Songrow value under `metadata.model_badges`.
13. `metadata.model_badges.songrow.dark` - Dark-theme style configuration.
14. `metadata.model_badges.songrow.dark.background_color` - Color value used for background.
15. `metadata.model_badges.songrow.dark.border_color` - Color value used for border.
16. `metadata.model_badges.songrow.dark.text_color` - Color value used for text.
17. `metadata.model_badges.songrow.display_name` - Name for display.
18. `metadata.model_badges.songrow.light` - Light-theme style configuration.
19. `metadata.model_badges.songrow.light.background_color` - Color value used for background.
20. `metadata.model_badges.songrow.light.border_color` - Color value used for border.
21. `metadata.model_badges.songrow.light.text_color` - Color value used for text.

## Metadata Secondary Badges

1. `metadata.secondary_badges` - Additional badge metadata.
2. `metadata.secondary_badges[].dark` - Dark-theme style configuration.
3. `metadata.secondary_badges[].dark.background_color` - Color value used for background.
4. `metadata.secondary_badges[].dark.border_color` - Color value used for border.
5. `metadata.secondary_badges[].dark.text_color` - Color value used for text.
6. `metadata.secondary_badges[].display_name` - Name for display.
7. `metadata.secondary_badges[].icon_key` - Icon identifier used by the UI.
8. `metadata.secondary_badges[].light` - Light-theme style configuration.
9. `metadata.secondary_badges[].light.background_color` - Color value used for background.
10. `metadata.secondary_badges[].light.border_color` - Color value used for border.
11. `metadata.secondary_badges[].light.text_color` - Color value used for text.

## Persona

1. `persona` - Nested persona/voice object.
2. `persona.id` - Id value under `persona`.
3. `persona.image_s3_id` - ID for image s3.
4. `persona.is_hidden` - Boolean flag for whether it is hidden.
5. `persona.is_owned` - Boolean flag for whether it is owned.
6. `persona.is_public` - Boolean flag for whether it is public.
7. `persona.is_trashed` - Boolean flag for whether it is trashed.
8. `persona.is_voice_persona` - Boolean flag for whether it is voice persona.
9. `persona.name` - Name value under `persona`.
10. `persona.root_clip_id` - ID for root clip.
11. `persona.user_display_name` - Name for user display.
12. `persona.user_handle` - User handle value under `persona`.
13. `persona.user_image_url` - URL for user image.
14. `persona.user_is_verified` - User is verified value under `persona`.

## Project

1. `project` - Nested workspace/project object.
2. `project.clip_count` - Count of clip.
3. `project.created_at` - Timestamp for created.
4. `project.description` - Description value under `project`.
5. `project.id` - Id value under `project`.
6. `project.is_public` - Boolean flag for whether it is public.
7. `project.is_trashed` - Boolean flag for whether it is trashed.
8. `project.last_updated_clip` - Last updated clip value under `project`.
9. `project.name` - Name value under `project`.
10. `project.shared` - Shared value under `project`.

## Reaction

1. `reaction` - Nested reaction/engagement object.
2. `reaction.clip` - Clip value under `reaction`.
3. `reaction.flagged` - Flagged value under `reaction`.
4. `reaction.play_count` - Count of play.
5. `reaction.reaction_type` - Type/category for reaction.
6. `reaction.skip_count` - Count of skip.
7. `reaction.updated_at` - Timestamp for updated.

## Ownership

1. `ownership` - Nested ownership/access object.
2. `ownership.ownership_reason` - Reason explaining ownership.

## Ancestry

1. `ancestry` - Nested lineage/family-tree object.
2. `ancestry.ancestor_count` - Count of ancestor.
3. `ancestry.ancestors` - Ancestor IDs or ancestor list.
4. `ancestry.children` - Child song IDs or child list.
5. `ancestry.children_count` - Count of children.
6. `ancestry.fetched_at` - Timestamp for fetched.
7. `ancestry.generation` - Generation value under `ancestry`.
8. `ancestry.lineage` - Ordered lineage information for the family tree.
9. `ancestry.lineage[].clip_id` - ID for clip.
10. `ancestry.lineage[].parent_id` - ID for parent.
11. `ancestry.lineage[].relationship` - Relationship value under `ancestry.lineage[]`.
12. `ancestry.parent_id` - ID for parent.

## Parent IDs

1. `parent_ids` - Parent ids value.
2. `parent_ids[].clip_id` - ID for clip.
3. `parent_ids[].parent_id` - ID for parent.
4. `parent_ids[].relationship` - Relationship value under `parent_ids[]`.

## Root ID

1. `root_id` - ID for root.
2. `root_id.clip_id` - ID for clip.
3. `root_id.parent_id` - ID for parent.
4. `root_id.relationship` - Relationship value under `root_id`.

## Ancestors Base

1. `ancestors` - Embedded list of ancestor song snapshots.
2. `ancestors[].allow_comments` - Allow comments value under `ancestors[]`.
3. `ancestors[].audio_url` - URL for audio.
4. `ancestors[].avatar_image_url` - URL for avatar image.
5. `ancestors[].batch_index` - Batch index value under `ancestors[]`.
6. `ancestors[].created_at` - Timestamp for created.
7. `ancestors[].display_name` - Name for display.
8. `ancestors[].display_tags` - Display tags value under `ancestors[]`.
9. `ancestors[].entity_type` - Type/category for entity.
10. `ancestors[].flag_count` - Count of flag.
11. `ancestors[].handle` - Handle value under `ancestors[]`.
12. `ancestors[].has_hook` - Boolean flag for whether it has hook.
13. `ancestors[].id` - Id value under `ancestors[]`.
14. `ancestors[].image_large_url` - URL for image large.
15. `ancestors[].image_url` - URL for image.
16. `ancestors[].is_contest_clip` - Boolean flag for whether it is contest clip.
17. `ancestors[].is_handle_updated` - Boolean flag for whether it is handle updated.
18. `ancestors[].is_hidden` - Boolean flag for whether it is hidden.
19. `ancestors[].is_liked` - Boolean flag for whether it is liked.
20. `ancestors[].is_public` - Boolean flag for whether it is public.
21. `ancestors[].is_trashed` - Boolean flag for whether it is trashed.
22. `ancestors[].major_model_version` - Major model version value under `ancestors[]`.
23. `ancestors[].model_name` - Name for model.
24. `ancestors[].play_count` - Count of play.
25. `ancestors[].status` - Status value under `ancestors[]`.
26. `ancestors[].title` - Title value under `ancestors[]`.
27. `ancestors[].upvote_count` - Count of upvote.
28. `ancestors[].user_id` - ID for user.
29. `ancestors[].video_url` - URL for video.

## Ancestors Metadata

1. `ancestors[].metadata` - Metadata value under `ancestors[]`.
2. `ancestors[].metadata.artist_clip_id` - ID for artist clip.
3. `ancestors[].metadata.can_publish_with_vocal` - Can publish with vocal value under `ancestors[].metadata`.
4. `ancestors[].metadata.can_remix` - Can remix value under `ancestors[].metadata`.
5. `ancestors[].metadata.concat_history` - Edit/generation history entries.
6. `ancestors[].metadata.concat_history[].continue_at` - Timestamp for continue.
7. `ancestors[].metadata.concat_history[].id` - Id value under `ancestors[].metadata.concat_history[]`.
8. `ancestors[].metadata.concat_history[].infill` - Infill value under `ancestors[].metadata.concat_history[]`.
9. `ancestors[].metadata.concat_history[].source` - Source value under `ancestors[].metadata.concat_history[]`.
10. `ancestors[].metadata.concat_history[].type` - Type value under `ancestors[].metadata.concat_history[]`.
11. `ancestors[].metadata.continue_at` - Timestamp for continue.
12. `ancestors[].metadata.control_sliders` - Grouped generation slider values.
13. `ancestors[].metadata.control_sliders.audio_weight` - Audio weight value under `ancestors[].metadata.control_sliders`.
14. `ancestors[].metadata.control_sliders.style_weight` - Style weight value under `ancestors[].metadata.control_sliders`.
15. `ancestors[].metadata.control_sliders.weirdness_constraint` - Weirdness constraint value under `ancestors[].metadata.control_sliders`.
16. `ancestors[].metadata.control_tags` - Control tags value under `ancestors[].metadata`.
17. `ancestors[].metadata.cover_clip_id` - ID for cover clip.
18. `ancestors[].metadata.cover_end_s` - Time/offset in seconds for cover end.
19. `ancestors[].metadata.cover_start_s` - Time/offset in seconds for cover start.
20. `ancestors[].metadata.duration` - Duration value under `ancestors[].metadata`.
21. `ancestors[].metadata.edit_session_id` - ID for edit session.
22. `ancestors[].metadata.edited_clip_id` - ID for edited clip.
23. `ancestors[].metadata.has_vocal` - Boolean flag for whether it has vocal.
24. `ancestors[].metadata.history` - Edit/generation history entries.
25. `ancestors[].metadata.history[].continue_at` - Timestamp for continue.
26. `ancestors[].metadata.history[].control_tags` - Control tags value under `ancestors[].metadata.history[]`.
27. `ancestors[].metadata.history[].edited_clip_id` - ID for edited clip.
28. `ancestors[].metadata.history[].id` - Id value under `ancestors[].metadata.history[]`.
29. `ancestors[].metadata.history[].include_future_s` - Time/offset in seconds for include future.
30. `ancestors[].metadata.history[].include_history_s` - Time/offset in seconds for include history.
31. `ancestors[].metadata.history[].infill` - Infill value under `ancestors[].metadata.history[]`.
32. `ancestors[].metadata.history[].infill_context_end_s` - Time/offset in seconds for infill context end.
33. `ancestors[].metadata.history[].infill_context_start_s` - Time/offset in seconds for infill context start.
34. `ancestors[].metadata.history[].infill_dur_s` - Time/offset in seconds for infill dur.
35. `ancestors[].metadata.history[].infill_end_s` - Time/offset in seconds for infill end.
36. `ancestors[].metadata.history[].infill_lyrics` - Infill lyrics value under `ancestors[].metadata.history[]`.
37. `ancestors[].metadata.history[].infill_start_s` - Time/offset in seconds for infill start.
38. `ancestors[].metadata.history[].lyrics_updated` - Lyrics updated value under `ancestors[].metadata.history[]`.
39. `ancestors[].metadata.history[].source` - Source value under `ancestors[].metadata.history[]`.
40. `ancestors[].metadata.history[].stem_clip_id` - ID for stem clip.
41. `ancestors[].metadata.history[].stem_from_id` - ID for stem from.
42. `ancestors[].metadata.history[].stem_task` - Stem task value under `ancestors[].metadata.history[]`.
43. `ancestors[].metadata.history[].stem_type_group_name` - Name for stem type group.
44. `ancestors[].metadata.history[].stem_type_id` - ID for stem type.
45. `ancestors[].metadata.history[].type` - Type value under `ancestors[].metadata.history[]`.
46. `ancestors[].metadata.infill` - Infill value under `ancestors[].metadata`.
47. `ancestors[].metadata.infill_lyrics` - Infill lyrics value under `ancestors[].metadata`.
48. `ancestors[].metadata.is_audio_upload_tos_accepted` - Boolean flag for whether it is audio upload tos accepted.
49. `ancestors[].metadata.is_loudness_under_threshold` - Boolean flag for whether it is loudness under threshold.
50. `ancestors[].metadata.is_remix` - Boolean flag for whether it is remix.
51. `ancestors[].metadata.lyrics_updated` - Lyrics updated value under `ancestors[].metadata`.
52. `ancestors[].metadata.make_instrumental` - Make instrumental value under `ancestors[].metadata`.
53. `ancestors[].metadata.mashup_clip_ids` - Mashup clip ids value under `ancestors[].metadata`.
54. `ancestors[].metadata.negative_tags` - Negative tags value under `ancestors[].metadata`.
55. `ancestors[].metadata.normalize_volume` - Normalize volume value under `ancestors[].metadata`.
56. `ancestors[].metadata.override_future_clip_id` - ID for override future clip.
57. `ancestors[].metadata.override_future_start_seconds` - Time/offset in seconds for override future start.
58. `ancestors[].metadata.override_history_clip_id` - ID for override history clip.
59. `ancestors[].metadata.override_history_end_seconds` - Time/offset in seconds for override history end.
60. `ancestors[].metadata.persona_id` - ID for persona.
61. `ancestors[].metadata.playlist_id` - ID for playlist.
62. `ancestors[].metadata.priority` - Priority value under `ancestors[].metadata`.
63. `ancestors[].metadata.prompt` - Prompt value under `ancestors[].metadata`.
64. `ancestors[].metadata.refund_credits` - Refund credits value under `ancestors[].metadata`.
65. `ancestors[].metadata.show_remix` - Show remix value under `ancestors[].metadata`.
66. `ancestors[].metadata.stem_from_id` - ID for stem from.
67. `ancestors[].metadata.stem_task` - Stem task value under `ancestors[].metadata`.
68. `ancestors[].metadata.stem_type_group_name` - Name for stem type group.
69. `ancestors[].metadata.stem_type_id` - ID for stem type.
70. `ancestors[].metadata.stream` - Stream value under `ancestors[].metadata`.
71. `ancestors[].metadata.tags` - Tags value under `ancestors[].metadata`.
72. `ancestors[].metadata.task` - Task value under `ancestors[].metadata`.
73. `ancestors[].metadata.type` - Type value under `ancestors[].metadata`.
74. `ancestors[].metadata.underpainting_clip_id` - ID for underpainting clip.
75. `ancestors[].metadata.upsample_clip_id` - ID for upsample clip.
76. `ancestors[].metadata.variation_category` - Variation category value under `ancestors[].metadata`.
77. `ancestors[].metadata.video_is_stale` - Video is stale value under `ancestors[].metadata`.
78. `ancestors[].metadata.video_upload_height` - Video upload height value under `ancestors[].metadata`.
79. `ancestors[].metadata.video_upload_width` - Video upload width value under `ancestors[].metadata`.

## Ancestors Persona

1. `ancestors[].persona` - Persona value under `ancestors[]`.
2. `ancestors[].persona.id` - Id value under `ancestors[].persona`.
3. `ancestors[].persona.image_s3_id` - ID for image s3.
4. `ancestors[].persona.is_hidden` - Boolean flag for whether it is hidden.
5. `ancestors[].persona.is_owned` - Boolean flag for whether it is owned.
6. `ancestors[].persona.is_public` - Boolean flag for whether it is public.
7. `ancestors[].persona.is_trashed` - Boolean flag for whether it is trashed.
8. `ancestors[].persona.name` - Name value under `ancestors[].persona`.
9. `ancestors[].persona.root_clip_id` - ID for root clip.
10. `ancestors[].persona.user_display_name` - Name for user display.
11. `ancestors[].persona.user_handle` - User handle value under `ancestors[].persona`.
12. `ancestors[].persona.user_image_url` - URL for user image.
