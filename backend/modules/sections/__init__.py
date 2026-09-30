"""Song section finder — a library entry's form on its own bar grid.

``finder`` reads the audio, ``store`` keeps the result per entry with the
user's names, ``service`` ties the two to the library and the Shard Index,
``router`` exposes ``/api/sections``. Runs are coordinated by
``backend.core.pipeline.ensure_sections`` so they wait for stems in flight.
"""
