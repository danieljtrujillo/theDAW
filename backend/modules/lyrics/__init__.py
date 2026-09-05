"""Lyrics & sing-along: plain and word-timed lyrics per library song.

The plain text is the entry's user-editable ``lyrics`` field (mirrored into
``metadata.json``); the timed document lives at ``<entry>/lyrics.json`` and is
registered as a notation artifact of kind ``lyrics``. ``schema`` / ``lrc`` /
``align`` / ``derive`` are pure; ``service`` owns the files and the jobs;
``router`` mounts them at ``/api/lyrics`` through the module loader.
"""
