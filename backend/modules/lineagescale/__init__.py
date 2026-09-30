"""Lineage that works at 200,000 songs.

``graph.py`` holds the link-role table (which kinds are ancestry, which are a
cross-reference, which are files, and which end of each row is the source)
plus the pure walks: merge duplicate links into one edge, bounded
breadth-first neighbourhood with grouped fans, cycle-safe longest chain,
components. ``router.py`` is the thin read-only layer over the library
database at ``/api/lineage-scale``.

Additive: nothing here changes ``/api/library/_graph/all``, the LEARN tab, or
any existing route.
"""
