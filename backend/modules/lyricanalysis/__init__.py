"""Lyric analysis: the devices a lyric uses, found in its own words.

``phonetics`` is pure — ARPABET pronunciations, syllables, rhyme keys and
phone distances, with the CMU dictionary optional and a letter-to-sound
fallback behind it, so every device detector can ask it for phones without
touching the disk. ``schema`` is pure models. ``service`` owns the files and
the jobs and ``llm`` calls out to the assistant provider; ``router`` mounts
them at ``/api/lyricanalysis`` through the module loader.
"""
