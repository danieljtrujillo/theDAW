import assert from 'node:assert/strict';

import { ADVANCED_EFFECT_CATALOG, ADVANCED_EFFECT_CATEGORY_META } from './effectCatalog.ts';
import { EFFECT_DEFAULTS } from './effectChainStore.ts';

const supportedIds = new Set(Object.keys(EFFECT_DEFAULTS));
const catalogIds = Object.values(ADVANCED_EFFECT_CATALOG).flat().map((fx) => fx.id);

assert.ok(catalogIds.length > 0, 'effect catalog should not be empty');
for (const id of catalogIds) {
  assert.ok(supportedIds.has(id), `advanced editor exposes unsupported backend effect: ${id}`);
}

for (const category of ADVANCED_EFFECT_CATEGORY_META) {
  assert.equal(
    category.count,
    ADVANCED_EFFECT_CATALOG[category.id]?.length ?? 0,
    `category count should match catalog length for ${category.id}`,
  );
}

console.log('effect catalog backend parity regression passed');
