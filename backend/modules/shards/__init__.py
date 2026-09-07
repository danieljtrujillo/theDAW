"""Shard Index — bar/beat-aligned fragments of every library song and stem.

See ``docs/design/loom.md``. ``extract`` cuts and describes, ``service`` ranks
and crops, ``router`` exposes ``/api/shards``. Extraction is coordinated by
``backend.core.pipeline.ensure_shards`` so it de-dupes with stems in flight.
"""
