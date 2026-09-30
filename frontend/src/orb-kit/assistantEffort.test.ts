/**
 * The Claude effort level: the option list, the stored value, the label.
 *
 * Ported from the Foundry orb (`src/components/orb/constants.ts` EFFORT_OPTIONS
 * + the `LS_EFFORT` read in AIAssistantOrb.tsx). The rules that matter are the
 * ones a stored value can violate: a key written by an older build, a value
 * hand-edited in devtools, or no storage at all must all land on `max` rather
 * than sending the CLI an effort it will reject.
 *
 *   cd frontend && npx tsx src/orb-kit/assistantEffort.test.ts
 */
import assert from 'node:assert/strict';

// The module reads localStorage at call time, not import time, but the shim has
// to exist before the first call either way — and tsx has no DOM.
const backing = new Map<string, string>();
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => {
            backing.set(k, String(v));
        },
        removeItem: (k: string) => {
            backing.delete(k);
        },
        clear: () => backing.clear(),
        key: (i: number) => Array.from(backing.keys())[i] ?? null,
        get length() {
            return backing.size;
        },
    } as Storage;
}

const {
    ASSISTANT_EFFORT_STORAGE_KEY,
    DEFAULT_ASSISTANT_EFFORT,
    EFFORT_OPTIONS,
    effortLabel,
    normalizeEffort,
    readStoredEffort,
    writeStoredEffort,
} = await import('./assistantEffort.ts');

// ---------------------------------------------------------------------------
// The option list is the backend's contract: low | medium | high | xhigh | max
// ---------------------------------------------------------------------------

assert.deepEqual([...EFFORT_OPTIONS], ['low', 'medium', 'high', 'xhigh', 'max']);
assert.equal(DEFAULT_ASSISTANT_EFFORT, 'max', 'theDAW asks for the most effort by default');
assert.ok(EFFORT_OPTIONS.includes(DEFAULT_ASSISTANT_EFFORT), 'the default must be a real option');
assert.equal(ASSISTANT_EFFORT_STORAGE_KEY, 'thedaw:effort');

// ---------------------------------------------------------------------------
// normalizeEffort — anything that is not one of the five is `max`
// ---------------------------------------------------------------------------

for (const level of EFFORT_OPTIONS) {
    assert.equal(normalizeEffort(level), level, `${level} is passed through untouched`);
}
assert.equal(normalizeEffort('MAX'), 'max', 'case is not a difference');
assert.equal(normalizeEffort('  high  '), 'high', 'surrounding whitespace is not a difference');
assert.equal(normalizeEffort('ultra'), 'max', 'an effort the CLI would reject falls back');
assert.equal(normalizeEffort(''), 'max');
assert.equal(normalizeEffort(null), 'max');
assert.equal(normalizeEffort(undefined), 'max');
assert.equal(normalizeEffort(7), 'max', 'a non-string is not an effort');
assert.equal(normalizeEffort({ effort: 'low' }), 'max');

// ---------------------------------------------------------------------------
// readStoredEffort / writeStoredEffort — the persisted choice
// ---------------------------------------------------------------------------

localStorage.removeItem(ASSISTANT_EFFORT_STORAGE_KEY);
assert.equal(readStoredEffort(), 'max', 'nothing stored yet means the default');

localStorage.setItem(ASSISTANT_EFFORT_STORAGE_KEY, 'low');
assert.equal(readStoredEffort(), 'low');

localStorage.setItem(ASSISTANT_EFFORT_STORAGE_KEY, 'xhigh');
assert.equal(readStoredEffort(), 'xhigh');

localStorage.setItem(ASSISTANT_EFFORT_STORAGE_KEY, 'turbo');
assert.equal(readStoredEffort(), 'max', 'a junk stored value never reaches the request body');

writeStoredEffort('medium');
assert.equal(localStorage.getItem(ASSISTANT_EFFORT_STORAGE_KEY), 'medium');
assert.equal(readStoredEffort(), 'medium', 'what was written is what comes back');

// A storage that throws (private mode, disabled storage) must not take the
// panel down with it — the effort just stops being remembered.
const realStorage = globalThis.localStorage;
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        getItem() {
            throw new Error('storage disabled');
        },
        setItem() {
            throw new Error('storage disabled');
        },
        removeItem() {
            throw new Error('storage disabled');
        },
        clear() {},
        key: () => null,
        length: 0,
    } as unknown as Storage,
});
assert.equal(readStoredEffort(), 'max', 'an unreadable storage reads as the default');
assert.doesNotThrow(() => writeStoredEffort('high'), 'an unwritable storage is not an error');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: realStorage });

// ---------------------------------------------------------------------------
// effortLabel — exactly what the Foundry's <option> shows
// ---------------------------------------------------------------------------

assert.equal(effortLabel('low'), 'Low');
assert.equal(effortLabel('medium'), 'Medium');
assert.equal(effortLabel('high'), 'High');
assert.equal(effortLabel('xhigh'), 'Xhigh');
assert.equal(effortLabel('max'), 'Max');
assert.equal(effortLabel(''), '', 'nothing to capitalise, nothing to crash on');

console.log('assistantEffort: all assertions passed');
