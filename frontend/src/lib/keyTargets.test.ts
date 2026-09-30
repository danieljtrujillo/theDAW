/**
 * lib/keyTargets — which keys a focused control keeps, and which go to the app.
 *
 * Run: npx tsx src/lib/keyTargets.test.ts
 */
import assert from 'node:assert/strict';

import { keyBelongsToFocusedControl } from './keyTargets.ts';

/** A fake element: `closest` answers for its own tag/attributes only, like a leaf node would. */
function el(tag: string, attrs: Record<string, string> = {}): EventTarget {
  const self = {
    type: attrs.type,
    getAttribute: (n: string) => attrs[n] ?? null,
    closest(selector: string) {
      for (const part of selector.split(',').map((s) => s.trim())) {
        if (part === tag) return self;
        const m = /^\[contenteditable="(.*)"\]$/.exec(part);
        if (m && attrs.contenteditable === m[1]) return self;
      }
      return null;
    },
  };
  return self as unknown as EventTarget;
}
const belongs = (key: string, target: EventTarget | null) => keyBelongsToFocusedControl({ key, target });

/* ── a fader keeps the keys that move it, and nothing else ── */
{
  const fader = el('input', { type: 'range' });
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
    assert.equal(belongs(k, fader), true, `${k} moves the fader`);
  }
  assert.equal(belongs('z', fader), false, 'Ctrl+Z after a fader ride is the APP undo: a slider has no undo of its own');
  assert.equal(belongs(' ', fader), false, 'Space plays, even though the fader still has focus');
  assert.equal(belongs('s', fader), false);
  assert.equal(belongs('Delete', fader), false);
}

/* ── anything the user types into keeps every key ── */
{
  for (const target of [
    el('input', { type: 'text' }),
    el('input', {}), // no type attribute = a text field
    el('input', { type: 'number' }),
    el('input', { type: 'search' }),
    el('textarea'),
    el('select'),
    el('div', { contenteditable: 'true' }),
    el('div', { contenteditable: '' }),
  ]) {
    assert.equal(belongs('z', target), true);
    assert.equal(belongs(' ', target), true);
    assert.equal(belongs('Delete', target), true);
  }
}

/* ── a checkbox keeps Space; a radio keeps Space and the arrows; buttons-as-inputs keep Space/Enter ── */
{
  const box = el('input', { type: 'checkbox' });
  assert.equal(belongs(' ', box), true, 'Space toggles it — it must not ALSO start playback');
  assert.equal(belongs('z', box), false);
  assert.equal(belongs('ArrowDown', box), false);

  const radio = el('input', { type: 'radio' });
  assert.equal(belongs('ArrowDown', radio), true);
  assert.equal(belongs(' ', radio), true);
  assert.equal(belongs('m', radio), false);

  const colour = el('input', { type: 'color' });
  assert.equal(belongs('Enter', colour), true);
  assert.equal(belongs(' ', colour), true);
  assert.equal(belongs('z', colour), false);
}

/* ── not a control at all ── */
{
  assert.equal(belongs('z', el('div')), false);
  assert.equal(belongs('z', el('button')), false, 'a <button> never blocked shortcuts and still does not');
  assert.equal(belongs('z', null), false);
  assert.equal(belongs('z', {} as EventTarget), false, 'a target with no closest() (window, document) is not a control');
}

console.log('keyTargets: ok');
