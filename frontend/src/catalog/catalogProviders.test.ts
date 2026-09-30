/**
 * catalogProviders: the ONE provider id, its label and its AI-ness.
 *
 * What it pins:
 *   * PRECEDENCE — a provider the backend detected in the file's own metadata
 *     wins over the model/source derivation, whatever the model says;
 *   * the derivation, for every entry that carries no provider: the same
 *     rules in the same order, and a fallback of 'thedaw' — 'stable-audio' is
 *     claimed only for what theDAW GENERATED ('generate', and a 'studio'
 *     bounce of one), never for a DJ performance set, VJ media, or a source
 *     the rule has never heard of;
 *   * the label the backend sent wins over this file's table (it is the only
 *     name that can be right for a provider the table has never heard of),
 *     while the palette still keys off the id;
 *   * AI-ness is the backend's flag when it sent one, and otherwise true for
 *     every derived engine except an import, 'thedaw' and the unknown bucket.
 *
 *   cd frontend && npx tsx src/catalog/catalogProviders.test.ts
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDER_ORDER,
  entryProviderIsAi,
  entryProviderMeta,
  inferProvider,
  providerBadgeClass,
  providerMeta,
} from './catalogProviders.ts';

// ── the detected provider wins ───────────────────────────────────────────────
{
  assert.equal(
    inferProvider({ provider: 'bandcamp', model: 'suno', source: 'import' }),
    'bandcamp',
    'what the file said beats every derivation rule',
  );
  assert.equal(
    inferProvider({ provider: 'suno', model: 'sa3', source: 'generate' }),
    'suno',
    'including the rule that would have said stable-audio',
  );
  assert.equal(
    inferProvider({ provider: '  udio  ' }),
    'udio',
    'the slug is trimmed…',
  );
  assert.equal(
    inferProvider({ provider: 'Bandcamp' }),
    'Bandcamp',
    '…but never re-cased: the same string goes back to the server as provider=',
  );
}

// ── an absent / empty provider falls through to the derivation ───────────────
{
  for (const [what, value] of [
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
  ] as const) {
    assert.equal(
      inferProvider({ provider: value, model: 'suno' }),
      'suno',
      `a ${what} provider is no provider`,
    );
  }
}

// ── the derivation, rule by rule, unchanged ──────────────────────────────────
{
  assert.equal(inferProvider({ model: 'suno' }), 'suno');
  assert.equal(inferProvider({ model: 'Suno v4.5' }), 'suno', 'matched as a substring, case-free');
  assert.equal(inferProvider({ model: 'magenta-rt' }), 'gemini-magenta');
  assert.equal(inferProvider({ model: 'gemini-music' }), 'gemini-magenta');
  assert.equal(inferProvider({ model: 'udio-130' }), 'udio');
  assert.equal(inferProvider({ model: 'riffusion-fuzz' }), 'riffusion');
  assert.equal(inferProvider({ model: '', source: 'import' }), 'import');
  assert.equal(inferProvider({ model: 'sa3', source: 'generate' }), 'stable-audio');
  assert.equal(inferProvider({ model: 'sa3', source: 'studio' }), 'stable-audio', 'a bounce of one');
  // T13: 'stable-audio' is claimed only for what theDAW generated. Everything
  // else it makes is 'thedaw' — these used to be badged "Stable Audio (AI)".
  assert.equal(inferProvider({ source: 'performance-set' }), 'thedaw', 'a DJ set');
  assert.equal(inferProvider({ source: 'vj' }), 'thedaw', 'VJ media');
  assert.equal(inferProvider({}), 'thedaw', 'the fallback for an entry that says nothing');
  // Order: the model is consulted before the source, so an IMPORTED Suno file
  // whose model says so is Suno, not 'import'.
  assert.equal(inferProvider({ model: 'suno', source: 'import' }), 'suno');
}

// ── a Suno song known only by its `source` ────────────────────────────────────
// The regression: a lineage node carries `source` and nothing else, and a song
// promoted from a Suno cache has a `chirp-*` model, so neither the model string
// nor a wire `provider` says "suno". Both used to fall through to Stable Audio.
{
  assert.equal(inferProvider({ source: 'suno' }), 'suno', 'a lineage node: source only');
  assert.equal(inferProvider({ source: 'SUNO' }), 'suno', 'case-free, like the model arm');
  assert.equal(inferProvider({ model: 'chirp-v4', source: 'suno' }), 'suno', 'a promoted cache song');
  assert.equal(inferProvider({ model: '', source: 'suno' }), 'suno');
  assert.equal(entryProviderMeta({ source: 'suno' }).label, 'Suno');
  assert.equal(entryProviderIsAi({ source: 'suno' }), true);
  // T14: and the model alone is enough, whatever the source says. `chirp` IS
  // Suno's model family -- `chirp-v3`, `chirp-v4`, `chirp-crow`, `chirp-auk`,
  // `chirp-bluejay`, `chirp-fenix` -- so an imported Suno file and a row a
  // writer re-sourced are Suno too. Before T14 these read 'import' and
  // 'stable-audio', and a LEARN landing list badged them "theDAW".
  assert.equal(inferProvider({ model: 'chirp-v4', source: 'import' }), 'suno');
  assert.equal(inferProvider({ model: 'chirp-v4', source: 'generate' }), 'suno');
  assert.equal(inferProvider({ model: 'chirp-crow' }), 'suno', 'the model alone');
}

// ── parity with the backend's fallback (backend/modules/library/db.py, ────────
// `infer_provider`, rules 2-7). The two are separate implementations of ONE
// rule; this table is the same cases the Python parity test walks. If a rule is
// added on one side, this fails until the other side has it.
{
  const cases: Array<[string | null, string | null, string]> = [
    // model,            source,       expected
    ['chirp-v4',         'suno',       'suno'],
    // T14: `chirp` is Suno's model family; the source arm answers the row
    // above, these are the rows that used to fall past it.
    ['chirp-v4',         'generate',   'suno'],
    ['chirp-v4',         'import',     'suno'],
    ['chirp-v4',         '',           'suno'],
    ['chirp-crow',       '',           'suno'],
    ['suno-v3',          'generate',   'suno'],
    ['sunoesque',        'import',     'suno'],
    ['magenta-rt',       'generate',   'gemini-magenta'],
    ['gemini-x',         'import',     'gemini-magenta'],
    ['udio-1',           'import',     'udio'],
    ['Udio v1.5',        'generate',   'udio'],
    // "udio" inside "audio" is not Udio
    ['stable-audio-3-medium', 'generate', 'stable-audio'],
    ['audiocraft',       'import',     'import'],
    ['audio-udio-blend', 'import',     'udio'],
    ['riffusion',        'import',     'riffusion'],
    ['imported',         'import',     'import'],
    [null,               'import',     'import'],
    ['stable-audio-3',   'generate',   'stable-audio'],
    ['sa3',              'generate',   'stable-audio'],
    ['anything',         'studio',     'stable-audio'],
    ['mixdown',          'studio',     'stable-audio'],
    // T13: the last arm is theDAW's own, not Stable Audio.
    ['',                 'performance-set', 'thedaw'],
    [null,               'vj',         'thedaw'],
    ['anything',         '',           'thedaw'],
    [null,               null,         'thedaw'],
  ];
  for (const [model, source, want] of cases) {
    assert.equal(inferProvider({ model, source }), want, `model=${model} source=${source}`);
  }
}

// ── labels ───────────────────────────────────────────────────────────────────
{
  assert.equal(
    entryProviderMeta({ model: 'sa3', source: 'generate' }).label,
    'Stable Audio',
    'the table names a derived id',
  );
  assert.equal(entryProviderMeta({ source: 'performance-set' }).label, 'theDAW', 'and the new one');
  assert.equal(entryProviderMeta({ provider: 'suno' }).label, 'Suno');
  assert.equal(
    entryProviderMeta({ provider: 'suno', providerLabel: 'Suno AI' }).label,
    'Suno AI',
    'the backend’s own name wins over the table',
  );
  assert.equal(
    entryProviderMeta({ provider: 'apple-music' }).label,
    'Apple Music',
    'an unknown id is title-cased rather than left as a slug',
  );
  assert.equal(
    entryProviderMeta({ provider: 'apple-music', providerLabel: '   ' }).label,
    'Apple Music',
    'a blank label is not a label',
  );
  // The table row is shared: re-labelling one entry must not rename Suno for
  // the whole app.
  entryProviderMeta({ provider: 'suno', providerLabel: 'Something Else' });
  assert.equal(providerMeta('suno').label, 'Suno', 'the registry row is never mutated');

  // The palette keys off the id, so a re-labelled Suno is still orange.
  assert.equal(
    providerBadgeClass(inferProvider({ provider: 'suno', providerLabel: 'Suno AI' })),
    providerBadgeClass('suno'),
  );
}

// ── AI-ness ──────────────────────────────────────────────────────────────────
{
  assert.equal(entryProviderIsAi({ provider: 'suno', providerIsAi: true }), true);
  assert.equal(
    entryProviderIsAi({ provider: 'bandcamp', providerIsAi: false }),
    false,
    'a store/host says so and is believed',
  );
  assert.equal(
    entryProviderIsAi({ provider: 'suno', providerIsAi: false }),
    false,
    'the flag wins over the id, both ways',
  );

  // No flag: every derived engine is AI, except these two.
  assert.equal(entryProviderIsAi({ model: 'sa3', source: 'generate' }), true, 'stable-audio');
  assert.equal(
    entryProviderIsAi({ source: 'performance-set' }),
    false,
    'a DJ set was made IN theDAW, not generated by a model',
  );
  assert.equal(entryProviderIsAi({}), false, 'and neither is anything the rule cannot place');
  assert.equal(entryProviderIsAi({ model: 'suno' }), true, 'suno');
  assert.equal(entryProviderIsAi({ model: 'udio-130' }), true, 'udio');
  assert.equal(entryProviderIsAi({ source: 'import', model: '' }), false, 'an import is not AI');
  assert.equal(entryProviderIsAi({ provider: 'unknown' }), false, 'nor is the unknown bucket');
  assert.equal(entryProviderIsAi({ provider: 'Import' }), false, 'case-free on the id');
  assert.equal(
    entryProviderIsAi({ provider: 'bandcamp' }),
    false,
    'a provider this app has never heard of is not CLAIMED to be AI without a flag',
  );
}

// ── the seeded dropdown order ────────────────────────────────────────────────
{
  assert.ok(DEFAULT_PROVIDER_ORDER.includes('stable-audio'));
  assert.ok(DEFAULT_PROVIDER_ORDER.includes('thedaw'));
  assert.ok(DEFAULT_PROVIDER_ORDER.includes('suno'));
  // Every id the derivation can produce is already offered, so a dropdown
  // built from this list plus the loaded rows can never miss one.
  const derivable = [
    inferProvider({ model: 'suno' }),
    inferProvider({ model: 'magenta' }),
    inferProvider({ model: 'udio' }),
    inferProvider({ model: 'riffusion' }),
    inferProvider({ source: 'import', model: '' }),
    inferProvider({}),
  ];
  for (const id of derivable) {
    assert.ok(DEFAULT_PROVIDER_ORDER.includes(id), `${id} is offered up front`);
  }
}

console.log('catalogProviders: one id, one label, one AI flag');

// ── Lyria: badged from the model alone, even under a Google model id ─────────
{
  assert.equal(inferProvider({ model: 'lyria', source: 'generate' }), 'lyria');
  assert.equal(
    inferProvider({ model: 'google/lyria-3-pro-preview', source: 'generate' }),
    'lyria',
    'a Google-prefixed Lyria id is Lyria, not Magenta',
  );
  assert.equal(inferProvider({ model: 'gemini-magenta-rt', source: 'generate' }), 'gemini-magenta');
  assert.equal(entryProviderIsAi({ model: 'lyria', source: 'generate' }), true);
  assert.ok(DEFAULT_PROVIDER_ORDER.includes('lyria'), 'lyria is offered in the default filter list');
}
