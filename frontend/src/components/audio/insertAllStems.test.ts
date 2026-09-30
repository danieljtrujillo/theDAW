// Run with: npx tsx src/components/audio/insertAllStems.test.ts
/**
 * F14 — "Insert all stems" (the whole group at once, in a folder). Which
 * stems to insert is unchanged (`clipDoubleClick.planStemInsert`); this
 * module covers only what F14 adds: the folder name, and the label/color
 * every new stem track gets, matching the single-stem insert path
 * (`insertStemBesideClip`) so both name tracks the same way.
 */
import assert from 'node:assert/strict';
import { allStemsMenuInfo, stemsFolderName, stemTrackSpecs } from './insertAllStems';

// --- stemsFolderName ---------------------------------------------------------
{
  assert.equal(stemsFolderName('Vocal take 3'), 'Vocal take 3 stems');
  // Blank/whitespace-only labels still get a real folder name.
  assert.equal(stemsFolderName(''), 'Clip stems');
  assert.equal(stemsFolderName('   '), 'Clip stems');
  assert.equal(stemsFolderName('  Lead  '), 'Lead stems');
}

// --- stemTrackSpecs ----------------------------------------------------------
{
  const refs = [{ name: 'vocals' }, { name: 'drums' }, { name: 'weird_stem' }];
  const colors = { vocals: '#f00', drums: '#0f0' };

  const specs = stemTrackSpecs('Song', '#abc', colors, refs);
  assert.deepEqual(specs.map((s) => s.label), ['Song · vocals', 'Song · drums', 'Song · weird_stem']);
  // A known stem name gets its own color...
  assert.equal(specs[0].color, '#f00');
  assert.equal(specs[1].color, '#0f0');
  // ...an unknown one falls back to the clip's own color.
  assert.equal(specs[2].color, '#abc');

  // The original ref rides along unchanged, by reference, so the caller can
  // still reach `ref.url` etc. for the actual fetch/decode.
  assert.equal(specs[0].ref, refs[0]);

  // Order is preserved and the length matches — nothing is dropped or added.
  assert.equal(specs.length, refs.length);

  // Empty input: empty output, no throw.
  assert.deepEqual(stemTrackSpecs('Song', '#abc', colors, []), []);
}

// --- allStemsMenuInfo: gate + label count are the INSERTABLE count ---------
// (audit MINOR #3: an aggregate row (a sum `planStemInsert` drops) must not
// count toward the ">1" gate or the label's number, or the menu offers "All 2
// stems" for a clip that only actually gets ONE new track.)
{
  // No roles at all (an older backend / manifest-less run): every row is
  // inserted as-is, same as `planStemInsert`.
  assert.deepEqual(allStemsMenuInfo([{ name: 'vocals' }, { name: 'drums' }]), {
    offer: true,
    insertCount: 2,
  });
  assert.deepEqual(allStemsMenuInfo([{ name: 'vocals' }]), { offer: false, insertCount: 1 });

  // Two parts + one aggregate sum of them: the sum is not offered for bulk
  // insert, so the count/gate are based on the 2 parts, not all 3 rows.
  const rows = [
    { name: 'vocals', role: 'part' },
    { name: 'accompaniment', role: 'part' },
    { name: 'no_vocals', role: 'aggregate' },
  ];
  assert.deepEqual(allStemsMenuInfo(rows), { offer: true, insertCount: 2 });

  // One part + one aggregate: after the aggregate is dropped, only ONE row
  // would actually land — the bulk "All" item must not be offered (it would
  // duplicate the single-stem row below it).
  const oneRealStem = [
    { name: 'vocals', role: 'part' },
    { name: 'no_vocals', role: 'aggregate' },
  ];
  assert.deepEqual(allStemsMenuInfo(oneRealStem), { offer: false, insertCount: 1 });

  // Every row an aggregate: `planStemInsert`'s "insert nothing" escape hatch
  // keeps all rows rather than reporting zero — the gate follows suit.
  const allAggregate = [
    { name: 'a', role: 'aggregate' },
    { name: 'b', role: 'aggregate' },
  ];
  assert.deepEqual(allStemsMenuInfo(allAggregate), { offer: true, insertCount: 2 });
}

console.log('insertAllStems: ok');
