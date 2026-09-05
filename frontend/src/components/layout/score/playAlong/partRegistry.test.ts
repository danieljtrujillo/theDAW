// Run with: npx tsx src/components/layout/score/playAlong/partRegistry.test.ts
import assert from 'node:assert/strict';
import {
  applyInstrumentPreset,
  knownParts,
  parseMusicXmlPartList,
  presetApplied,
  registerParts,
  resetPartRegistry,
  subscribeParts,
} from './partRegistry.ts';
import { usePlayAlongStore } from '../../../../state/playAlongStore.ts';

// parseMusicXmlPartList: names in score order, percussion by MIDI declaration,
// by a percussion clef / unpitched notes in the part body, or by name.
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Bass &amp; Co</part-name></score-part>
    <score-part id="P2"><part-name print-object="no">Kit</part-name>
      <score-instrument id="P2-I1"><instrument-name>Drums</instrument-name></score-instrument>
      <midi-instrument id="P2-I1"><midi-channel>10</midi-channel><midi-unpitched>36</midi-unpitched></midi-instrument>
    </score-part>
    <score-part id="P3"><part-name>full</part-name></score-part>
    <score-part id="P4"><part-name>Percussion 2</part-name></score-part>
    <score-part id="P5"><part-name>Toms</part-name></score-part>
    <score-part id="P6"><part-abbreviation>Vox</part-abbreviation></score-part>
  </part-list>
  <part id="P1"><measure number="1"><attributes><clef><sign>F</sign><line>4</line></clef></attributes></measure></part>
  <part id="P2"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch></note></measure></part>
  <part id="P3"><measure number="1"><attributes><clef><sign>G</sign><line>2</line></clef></attributes></measure></part>
  <part id="P4"><measure number="1"><attributes><clef><sign>G</sign><line>2</line></clef></attributes></measure></part>
  <part id="P5"><measure number="1"><attributes><clef><sign>percussion</sign></clef></attributes><note><unpitched><display-step>F</display-step><display-octave>4</display-octave></unpitched></note></measure></part>
  <part id="P6"><measure number="1"/></part>
</score-partwise>`;
  const parts = parseMusicXmlPartList(xml);
  assert.deepEqual(
    parts.map((p) => p.name),
    ['Bass & Co', 'Kit', 'full', 'Percussion 2', 'Toms', 'Vox'],
  );
  assert.deepEqual(
    parts.map((p) => p.isPercussion),
    [false, true, false, true, true, false],
  );
  assert.deepEqual(parseMusicXmlPartList('<score-partwise/>'), []);
  // A score-part without any name gets a positional label.
  const unnamed = parseMusicXmlPartList('<part-list><score-part id="X"></score-part></part-list>');
  assert.deepEqual(unnamed, [{ name: 'Part 1', isPercussion: false }]);
}

// Registry: register / knownParts / subscribe / preset application.
{
  resetPartRegistry();
  assert.equal(knownParts('a'), null);
  assert.equal(knownParts(null), null);

  const seen: string[] = [];
  const off = subscribeParts((id) => seen.push(id));
  registerParts('a', [{ name: 'full' }, { name: 'bass' }, { name: 'drums', isPercussion: true }, { name: 'piano' }]);
  assert.deepEqual(seen, ['a']);
  // Registering identical parts again does not notify.
  registerParts('a', [{ name: 'full' }, { name: 'bass' }, { name: 'drums', isPercussion: true }, { name: 'piano' }]);
  assert.deepEqual(seen, ['a']);
  assert.deepEqual(knownParts('a')?.map((p) => p.name), ['full', 'bass', 'drums', 'piano']);
  assert.equal(knownParts('a')?.[2].isPercussion, true);
  assert.equal(knownParts('a')?.[0].isPercussion, false);

  // Unknown artifact: nothing written, false returned.
  assert.equal(applyInstrumentPreset('nope', 'drums'), false);
  assert.equal(usePlayAlongStore.getState().partVisibility.nope, undefined);

  // Drums preset: only the percussion part.
  assert.equal(applyInstrumentPreset('a', 'drums'), true);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, false, true, false]);
  assert.equal(presetApplied('a'), 'drums');

  // A manual toggle survives a non-forced re-application of the same preset.
  usePlayAlongStore.getState().togglePart('a', 1);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, true, true, false]);
  assert.equal(applyInstrumentPreset('a', 'drums'), true);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, true, true, false]);

  // ...but not a forced one (the explicit INSTRUMENT change).
  assert.equal(applyInstrumentPreset('a', 'drums', { force: true }), true);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, false, true, false]);

  // Bass preset.
  assert.equal(applyInstrumentPreset('a', 'bass'), true);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, true, false, false]);

  // 'all' without force only marks; with force it restores the default
  // (everything but 'full').
  assert.equal(applyInstrumentPreset('a', 'all'), true);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, true, false, false]);
  assert.equal(presetApplied('a'), 'all');
  assert.equal(applyInstrumentPreset('a', 'all', { force: true }), true);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, true, true, true]);

  // A preset that matches no part falls back to the default visibility.
  assert.equal(applyInstrumentPreset('a', 'strings', { force: true }), true);
  assert.deepEqual(usePlayAlongStore.getState().partVisibility.a, [false, true, true, true]);

  off();
  registerParts('b', [{ name: 'x' }]);
  assert.deepEqual(seen, ['a']);
  resetPartRegistry();
  assert.equal(knownParts('a'), null);
}

console.log('partRegistry tests passed');
