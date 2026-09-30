/**
 * MixerStrips: the bus rename UI.
 *
 * `editorStore.updateBus` has supported renaming a bus (`{ name }`) since
 * batch 6 (editorStore.ts:831), but nothing in the mixer drawer ever called
 * it — a bus was stuck forever with whatever name `addBus` gave it. This
 * renders `BusNameField` (exported from MixerStrips.tsx) in isolation, so it
 * does not have to stand up the whole drawer's AudioContext-backed strip
 * meters (`ensureStripMeters`/`ensureMeter`) just to prove a rename fires.
 *
 * MixerStrips.tsx's module graph reaches `state/playerStore` (via
 * `state/levelsStore`), which reads `import.meta.env.DEV` at module scope —
 * Vite-only, same wall `PianoRoll.selection.test.ts` and `TakeLanes.test.ts`
 * document for their own components. That guard is itself gated on
 * `typeof window !== 'undefined'`, so importing MixerStrips.tsx BEFORE this
 * file installs the jsdom globals (rather than after, which is the usual
 * order) lets `import.meta.env.DEV` stay unreached: the module loads, and
 * only afterwards does `document`/`window` exist for react-dom to render
 * into. This is the one thing that order buys — it does not change what
 * PianoRoll's own test file already established: a node process has no real
 * `import.meta.env`, so nothing in this graph gets to rely on `DEV` being
 * true or false, only on `window` being absent at import time.
 *
 * Run: `npx tsx src/components/audio/MixerStrips.b12.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  // Imported with NO window/document global yet: `state/playerStore`'s
  // `if (typeof window !== 'undefined' && import.meta.env.DEV)` short-circuits
  // on the first half and never touches the Vite-only second half.
  const { BusNameField } = await import('./MixerStrips.tsx');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'getComputedStyle']) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const doc = dom.window.document;

  const host = doc.getElementById('root')!;
  const root = createRoot(host);

  const renamed: string[] = [];
  await act(async () => {
    root.render(
      React.createElement(BusNameField, {
        busId: 'b1',
        name: 'Drum Bus',
        onRename: (next: string) => renamed.push(next),
      }),
    );
  });

  const input = host.querySelector<HTMLInputElement>('#mixer-bus-name-b1');
  assert.ok(input, 'the bus strip renders a real, id-bearing text input for its name');
  assert.equal(input!.type, 'text');
  assert.equal(input!.value, 'Drum Bus', "the input starts on the bus's current name");

  const label = host.querySelector('label[for="mixer-bus-name-b1"]');
  assert.ok(label, 'a real <label for> gives the input an accessible name (CLAUDE.md rule 3)');
  assert.equal(label!.textContent, 'Bus Drum Bus name');
  assert.ok(label!.className.includes('sr-only'), 'the label is screen-reader only — the input already shows the name');

  // Type a new name through the NATIVE value setter (bypassing React's
  // internal value tracker) and dispatch the native `input` event, exactly
  // what a real keystroke produces.
  const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    nativeSetter.call(input, 'Drums 2');
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });

  assert.deepEqual(renamed, ['Drums 2'], 'typing a new name calls onRename with exactly what was typed');

  // Re-render with the "stored" name (as the real drawer would once
  // updateBus wrote it back) — the input follows the prop, staying
  // controlled rather than drifting from the store.
  await act(async () => {
    root.render(
      React.createElement(BusNameField, {
        busId: 'b1',
        name: 'Drums 2',
        onRename: (next: string) => renamed.push(next),
      }),
    );
  });
  assert.equal(input!.value, 'Drums 2', 'the input reflects the renamed value once the store round-trips it back');

  // Audit round 3, minor #7: `editorStore.updateBus` treats a falsy `name`
  // as "no rename" for the ROUTING GRAPH (editorStore.ts's updateBus:
  // `updates.name ? graphAddBus(...) : s.routing`), but unconditionally
  // spreads `updates` onto the STRIP object regardless — so a blank onRename
  // call would blank the strip while the routing picker kept showing the old
  // name. BusNameField must never call onRename with an empty/whitespace
  // value at all.
  renamed.length = 0;
  await act(async () => {
    nativeSetter.call(input, '');
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(renamed, [], 'an empty value is never written through to the store');
  assert.equal(input!.value, '', 'the field itself is still allowed to go blank while the user is typing');

  await act(async () => {
    nativeSetter.call(input, '   ');
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(renamed, [], 'a whitespace-only value is never written through either');

  // Leaving the field blank (blur) snaps it back to the committed name
  // rather than leaving the strip showing text that was never actually
  // saved. React delegates onBlur off the bubbling 'focusout' event (plain
  // 'blur' does not bubble at all in a real DOM), so that is what a real
  // blur produces and what this dispatches.
  await act(async () => {
    input!.dispatchEvent(new dom.window.Event('focusout', { bubbles: true }));
  });
  assert.equal(input!.value, 'Drums 2', 'blurring an empty field restores the last committed name');
  assert.deepEqual(renamed, [], 'restoring on blur is a local UI correction, not itself a rename');

  // The full name still hovers, the way the old <span title={b.name}> did
  // before it was replaced by an editable field whose title had become
  // "Rename this bus" instead.
  assert.equal(input!.title, 'Drums 2', 'the full (committed) name is still available as a hover tooltip for a truncated strip');

  await act(async () => root.unmount());
  console.log('MixerStrips bus rename UI: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
