// Run with: npx tsx src/components/layout/score/beatsaber/beatsaberMeta.test.ts
import assert from 'node:assert/strict';
import {
  DIFFICULTY_ORDER,
  levelFolderName,
  orderedDifficulties,
  parseBeatSaberMeta,
  totalNotes,
} from './beatsaberMeta.ts';

// Full metadata as the backend writes it.
{
  const meta = parseBeatSaberMeta(JSON.stringify({
    format: 'beatsaber',
    source: 'e__full__musicxml',
    difficulties: ['Hard', 'Normal'],
    note_counts: { Normal: 120, Hard: 240.0 },
    bpm: 97.5,
    bpm_source: 'analysis',
    version: 2,
    song_ogg: true,
    warning: '',
    parts: ['bass', 'guitar'],
    folder: 'G:\\data\\notation\\beatsaber\\slug__x',
    chart_bpm: 120,
  }));
  assert.equal(meta.format, 'beatsaber');
  assert.equal(meta.source, 'e__full__musicxml');
  assert.deepEqual(meta.difficulties, ['Normal', 'Hard']); // game order, not listed order
  assert.deepEqual(meta.noteCounts, { Normal: 120, Hard: 240 });
  assert.equal(meta.bpm, 97.5);
  assert.equal(meta.bpmSource, 'analysis');
  assert.equal(meta.version, 2);
  assert.equal(meta.songOgg, true);
  assert.equal(meta.warning, '');
  assert.deepEqual(meta.parts, ['bass', 'guitar']);
  assert.equal(meta.folder, 'G:\\data\\notation\\beatsaber\\slug__x');
  assert.equal(meta.chartBpm, 120);
  assert.equal(totalNotes(meta), 360);
  assert.equal(levelFolderName('/x/y/slug__x.beatsaber.zip', meta.folder), 'slug__x');
}

// Missing / malformed metadata never throws and yields safe defaults.
{
  for (const raw of [undefined, null, '', 'not json', '[]', 'null', '42']) {
    const meta = parseBeatSaberMeta(raw);
    assert.deepEqual(meta.difficulties, []);
    assert.deepEqual(meta.noteCounts, {});
    assert.equal(meta.bpm, null);
    assert.equal(meta.bpmSource, '');
    assert.equal(meta.version, 0);
    assert.equal(meta.songOgg, false);
    assert.equal(meta.warning, '');
    assert.deepEqual(meta.parts, []);
    assert.equal(meta.folder, '');
    assert.equal(meta.chartBpm, null);
    assert.equal(totalNotes(meta), 0);
  }
}

// Difficulties fall back to the note_counts keys; bad counts are dropped;
// numeric strings are accepted; unknown difficulty names sort last.
{
  const meta = parseBeatSaberMeta(JSON.stringify({
    note_counts: { ExpertPlus: '12', Easy: 3, Custom: 5, Bogus: 'x' },
    bpm: '90',
    version: '3',
    song_ogg: 'yes',
  }));
  assert.deepEqual(meta.difficulties, ['Easy', 'ExpertPlus', 'Custom']);
  assert.deepEqual(meta.noteCounts, { ExpertPlus: 12, Easy: 3, Custom: 5 });
  assert.equal(meta.bpm, 90);
  assert.equal(meta.version, 3);
  assert.equal(meta.songOgg, false);
}

// orderedDifficulties.
{
  assert.deepEqual(orderedDifficulties(['ExpertPlus', 'Easy', 'Hard', 'Easy']), ['Easy', 'Hard', 'ExpertPlus']);
  assert.deepEqual(orderedDifficulties([]), []);
  assert.deepEqual(orderedDifficulties(['Weird']), ['Weird']);
  assert.deepEqual(DIFFICULTY_ORDER, ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus']);
}

// levelFolderName from the zip path when no folder is recorded.
{
  assert.equal(levelFolderName('G:/a/b/slug__x__full.beatsaber.zip'), 'slug__x__full');
  assert.equal(levelFolderName('C:\\a\\b\\slug.beatsaber.zip'), 'slug');
  assert.equal(levelFolderName('slug.BEATSABER.ZIP'), 'slug');
  assert.equal(levelFolderName('plain.zip'), 'plain');
  assert.equal(levelFolderName('/a/b/slug.beatsaber.zip', '/levels/other/'), 'other');
  assert.equal(levelFolderName('', ''), '');
}

console.log('beatsaberMeta tests passed');
