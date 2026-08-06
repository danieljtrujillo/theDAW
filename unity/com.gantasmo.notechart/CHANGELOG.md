# Changelog

## [0.1.0] - 2026-08-05

- Initial release: `NoteChart` data mirror of the gantasmo.notechart schema
  (schemaVersion 1) with tempo-map conversion in both directions,
  `NoteChartLoader` (TextAsset / StreamingAssets / persistentDataPath / theDAW
  backend, JsonUtility, schema validation, audio fetch), `NoteChartClock`
  (`AudioSettings.dspTime` against a `PlayScheduled` start, count-in, latency
  calibration), `NoteChartSpawner` (merged spawn schedule, pooled glyphs,
  absolute per-frame placement, raw-onset judging), `FlyingNote`, `StaffLayout`,
  `SmuflGlyphs` with a font self-test, and a Build Rig In Scene menu item.
