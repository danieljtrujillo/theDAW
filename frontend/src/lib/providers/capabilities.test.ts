// capabilities: the provider registry the candidates UI reads to label a set
// and to decide whether 'Generate variations…' is offered for a selection.
// The suite pins:
//  1. the registry's keys are exactly the ProviderId union,
//  2. providerFor/acceptsInput/providersForInput read that registry correctly
//     (including the negative cases — lyria is the one provider with no local
//     input and no variations), and
//  3. paramSummary formats in REGISTRY order (not params-object insertion
//     order) and silently skips keys the candidate doesn't have.
import assert from 'node:assert/strict';
import {
  PROVIDER_CAPABILITIES, providerFor, acceptsInput, providersForInput, paramSummary,
  type ProviderId,
} from './capabilities.ts';

const EXPECTED_IDS: ProviderId[] = ['sa3', 'magenta', 'chimera', 'lyria', 'suno'];

// ── 1. Registry keys match the ProviderId union ─────────────────────────────
{
  assert.deepEqual(Object.keys(PROVIDER_CAPABILITIES).sort(), [...EXPECTED_IDS].sort());
  for (const id of EXPECTED_IDS) {
    const cap = PROVIDER_CAPABILITIES[id];
    assert.ok(cap, `${id} is registered`);
    assert.equal(cap.id, id, `${id} entry's own id field matches its registry key`);
    assert.ok(cap.label.length > 0, `${id} has a human label`);
    assert.ok(Array.isArray(cap.inputs) && cap.inputs.length > 0, `${id} declares at least one input kind`);
    assert.ok(Array.isArray(cap.params), `${id} declares a params array`);
  }
}

// ── 2. providerFor ───────────────────────────────────────────────────────────
{
  assert.equal(providerFor('sa3'), PROVIDER_CAPABILITIES.sa3);
  assert.equal(providerFor('not-a-real-provider'), null);
  assert.equal(providerFor(''), null);
}

// ── 3. acceptsInput ───────────────────────────────────────────────────────────
{
  // sa3 takes a time range of a clip (inpaint) …
  assert.equal(acceptsInput('sa3', 'clip-range'), true);
  // … lyria is an embedded external surface with no local input reference at all.
  assert.equal(acceptsInput('lyria', 'clip-range'), false);
  assert.equal(acceptsInput('lyria', 'none'), true);
  // Unknown provider accepts nothing.
  assert.equal(acceptsInput('not-a-real-provider', 'none'), false);
}

// ── 4. providersForInput ─────────────────────────────────────────────────────
{
  const clipProviders = providersForInput('clip');
  assert.ok(!clipProviders.some((p) => p.id === 'lyria'), "lyria doesn't take a clip input");
  assert.ok(clipProviders.some((p) => p.id === 'sa3'), 'sa3 takes a clip input and supports variations');
  assert.ok(clipProviders.some((p) => p.id === 'magenta'), 'magenta takes a clip input and supports variations');

  // Every entry returned actually declares the requested input AND opts into variations.
  for (const cap of providersForInput('clip-range')) {
    assert.ok(cap.inputs.includes('clip-range'));
    assert.ok(cap.supportsVariations);
  }

  // lyria never supports variations, regardless of kind, since it declares supportsVariations: false.
  assert.ok(!providersForInput('none').some((p) => p.id === 'lyria'));
}

// ── 5. paramSummary ──────────────────────────────────────────────────────────
{
  // Empty candidate params -> nothing to summarise.
  assert.equal(paramSummary('sa3', {}), '');
  // Unknown provider -> nothing to summarise.
  assert.equal(paramSummary('not-a-real-provider', { steps: 8 }), '');

  // Registry order wins over the params object's own (insertion) key order:
  // seed is inserted first here, but sa3's registry lists steps, then cfg, then seed.
  assert.equal(paramSummary('sa3', { seed: 42, steps: 8, cfg: 1 }), 'Steps 8 · CFG 1 · Seed 42');

  // Keys absent from the candidate's params are skipped silently, not rendered
  // as blanks or placeholders — prompt/negativePrompt/model/batch are real sa3
  // params (see capabilities.ts) but are simply not present here.
  assert.equal(paramSummary('sa3', { duration: 12, seed: 7 }), 'Length (s) 12 · Seed 7');
}

console.log('capabilities: ok');
