/**
 * MetronomeVolumeControl — the metronome's level knob.
 *
 * `metronomeStore.setVolume` (metronomeStore.ts:53) had zero callers before
 * this: the click was stuck at its persisted default with no UI to turn it
 * down against the mix. This renders the control in isolation, the same way
 * `MixerStrips.tsx` exports `BusNameField` to avoid standing up the whole
 * footer (playerStore, liveMixer, metronomeStore's own AudioContext wiring)
 * just to prove one control's wiring.
 *
 * `PlayerFooter.tsx` reaches `state/playerStore` (via `state/levelsStore`),
 * which reads `import.meta.env.DEV` at module scope, guarded on
 * `typeof window !== 'undefined'` — same wall MixerStrips.b12.test.tsx and
 * PianoRoll.selection.test.ts document. Importing PlayerFooter.tsx BEFORE
 * this file installs the jsdom globals keeps that guard's first half false,
 * so the Vite-only second half is never reached.
 *
 * Run: `npx tsx src/components/audio/MetronomeVolumeControl.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const { MetronomeVolumeControl, MetronomeLevelPopover, MetronomeToggle, opensLevelPopover } =
    await import('./PlayerFooter.tsx');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'getComputedStyle']) {
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

  const changes: number[] = [];
  // metronomeStore.volume is 0..1 (default 0.7); SlideTrack renders it on the
  // footer's 0..100 scale, same convention as the master Volume control.
  await act(async () => {
    root.render(
      React.createElement(MetronomeVolumeControl, {
        volume: 0.7,
        onChange: (v: number) => changes.push(v),
      }),
    );
  });

  const slider = host.querySelector<HTMLElement>('[role="slider"]');
  assert.ok(slider, 'renders a slider control');
  assert.equal(slider!.getAttribute('aria-label'), 'Metronome volume', 'a custom control gets aria-label, never a wrapping <label> (CLAUDE.md rule 3)');
  assert.equal(doc.querySelector('label[for]'), null, 'no <label for> wraps this custom role="slider" control');

  // The rendered value tracks the store's 0..1 scale, converted to the
  // widget's 0..100 scale — 0.7 -> 70, not 0.7.
  assert.equal(slider!.getAttribute('aria-valuenow'), '70', 'the slider reflects the store volume on its 0-100 scale');
  assert.equal(slider!.getAttribute('aria-valuemin'), '0');
  assert.equal(slider!.getAttribute('aria-valuemax'), '100');

  // ArrowUp bumps the widget's value by one step (1, on the 0-100 scale);
  // the control must hand the STORE's onChange the 0..1 value, not the
  // widget's raw 71.
  await act(async () => {
    slider!.focus();
    slider!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  });
  assert.deepEqual(changes, [0.71], 'ArrowUp calls onChange with the store-scale value, not the widget-scale one');

  // Re-render with the "stored" value (as PlayerFooter would once
  // metronomeStore.setVolume wrote it back) — the slider follows the prop.
  await act(async () => {
    root.render(
      React.createElement(MetronomeVolumeControl, {
        volume: 0.71,
        onChange: (v: number) => changes.push(v),
      }),
    );
  });
  assert.equal(slider!.getAttribute('aria-valuenow'), '71', 'the slider reflects the new store volume once it round-trips back');

  // Volume 0 and 1 round to the ends of the widget's scale, not somewhere off it.
  await act(async () => {
    root.render(React.createElement(MetronomeVolumeControl, { volume: 0, onChange: () => undefined }));
  });
  assert.equal(slider!.getAttribute('aria-valuenow'), '0');
  await act(async () => {
    root.render(React.createElement(MetronomeVolumeControl, { volume: 1, onChange: () => undefined }));
  });
  assert.equal(slider!.getAttribute('aria-valuenow'), '100');

  // Reachability (finding 2, T25b edit B): `MetronomeVolumeControl`'s own
  // PlayerFooter wrapper IS `hidden 2xl:flex` now (960px's own measurements
  // put a second, ungated copy 3.6px onto the transport plate — see
  // PlayerFooter.tsx). The thing that must stay reachable below 2xl is
  // `MetronomeLevelPopover`, the toggle button's second gesture (right-click
  // / Shift+F10 / Menu key) — and unlike a CSS class on a wrapper `<div>`,
  // that reachability is a behaviour to render and observe, not a string to
  // grep for. It is gated purely on the `position` prop, never on viewport
  // width, so it is exercised here exactly as PlayerFooter drives it: null
  // renders nothing, a position renders the same slider `MetronomeVolumeControl`
  // does.
  const host2 = doc.createElement('div');
  doc.body.appendChild(host2);
  const root2 = createRoot(host2);
  let closed = false;
  await act(async () => {
    root2.render(
      React.createElement(MetronomeLevelPopover, {
        position: null,
        onClose: () => { closed = true; },
        volume: 0.7,
        onChange: () => undefined,
      }),
    );
  });
  assert.equal(doc.querySelector('[aria-label="Metronome level and beat"]'), null, 'position=null renders nothing (still closed)');

  await act(async () => {
    root2.render(
      React.createElement(MetronomeLevelPopover, {
        position: { x: 10, y: 20 },
        onClose: () => { closed = true; },
        volume: 0.7,
        onChange: () => undefined,
      }),
    );
  });
  const panel = doc.querySelector('[aria-label="Metronome level and beat"]');
  assert.ok(panel, 'a position opens the popover panel, portaled same as ContextMenu');
  const popoverSlider = panel!.querySelector<HTMLElement>('[role="slider"]');
  assert.ok(popoverSlider, 'the popover hosts the same slider control MetronomeVolumeControl renders');
  assert.equal(popoverSlider!.getAttribute('aria-label'), 'Metronome volume');
  assert.equal(popoverSlider!.getAttribute('aria-valuenow'), '70', 'reflects the volume passed in, same 0-100 scale');

  // The dismiss listeners attach on a deferred macrotask (same reason
  // ContextMenu defers: the opening gesture is still mid-dispatch when the
  // effect first flushes), so the test waits a tick before exercising Escape.
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.ok(closed, 'Escape closes the popover, the same keyboard dismissal ContextMenu documents');

  // `onClose` only notifies the caller; as in real PlayerFooter usage, the
  // caller re-renders with `position: null` to actually unmount the panel —
  // done here so it doesn't linger in the document for later `[aria-label=
  // "Metronome level and beat"]` lookups below.
  await act(async () => {
    root2.render(
      React.createElement(MetronomeLevelPopover, {
        position: null,
        onClose: () => { closed = true; },
        volume: 0.7,
        onChange: () => undefined,
      }),
    );
  });
  assert.equal(doc.querySelector('[aria-label="Metronome level and beat"]'), null, 'position: null unmounts the panel');

  // Finding 1 (T25b edit B re-audit): rolling the wheel over the popover's
  // OWN hosted slider must adjust the value WITHOUT dismissing the panel —
  // the wheel-dismiss guard must contain itself the same way the
  // outside-click guard does.
  const host3 = doc.createElement('div');
  doc.body.appendChild(host3);
  const root3 = createRoot(host3);
  const wheelChanges: number[] = [];
  let wheelClosed = 0;
  await act(async () => {
    root3.render(
      React.createElement(MetronomeLevelPopover, {
        position: { x: 10, y: 20 },
        onClose: () => { wheelClosed += 1; },
        volume: 0.7,
        onChange: (v: number) => wheelChanges.push(v),
      }),
    );
  });
  // Dismiss listeners attach on a deferred macrotask (see above).
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
  const ownSlider = doc.querySelector<HTMLElement>('[aria-label="Metronome level and beat"] [role="slider"]');
  assert.ok(ownSlider, 'the popover renders its hosted slider');
  await act(async () => {
    ownSlider!.focus();
    ownSlider!.dispatchEvent(
      new dom.window.WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }),
    );
  });
  assert.deepEqual(wheelChanges, [0.71], 'a wheel notch over the popover\'s own focused slider still adjusts the level');
  assert.equal(wheelClosed, 0, 'a wheel notch over the popover\'s own hosted slider must NOT dismiss the panel (finding 1)');

  // Wheeling somewhere OUTSIDE the panel must still dismiss it, same as
  // outside-click / Escape — the guard only contains the panel's own
  // control, it does not disable wheel-dismiss entirely. Dispatched on
  // `doc.body` (a real element under the cursor), not `window` itself — a
  // real browser wheel event's target is always an element, never the
  // window, same as `onDown`'s `e.target` above.
  await act(async () => {
    doc.body.dispatchEvent(
      new dom.window.WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }),
    );
  });
  assert.equal(wheelClosed, 1, 'a wheel notch outside the panel still dismisses it');
  await act(async () => { root3.unmount(); });
  assert.equal(doc.querySelector('[aria-label="Metronome level and beat"]'), null, 'unmounting root3 clears its portaled panel');

  // Finding 2 (T25b edit B re-audit): the predicate that gates the toggle's
  // keyboard opener, tested as its own unit so `MetronomeToggle`'s onKeyDown
  // cannot drift from what is asserted here.
  assert.equal(opensLevelPopover({ key: 'ContextMenu', shiftKey: false }), true, 'the Menu/ContextMenu key opens the level popover');
  assert.equal(opensLevelPopover({ key: 'F10', shiftKey: true }), true, 'Shift+F10 opens the level popover');
  assert.equal(opensLevelPopover({ key: 'F10', shiftKey: false }), false, 'bare F10 (no Shift) does not open the level popover');
  assert.equal(opensLevelPopover({ key: 'Enter', shiftKey: false }), false, 'an unrelated key does not open the level popover');

  // The toggle -> popover wiring itself: `onContextMenu` and the keyboard
  // opener must actually be wired on the rendered toggle button, not merely
  // present in source — the single route to `setVolume` below 1536px, and
  // exactly what the first audit found missing. Each scenario gets its own
  // host/root, unmounted before the next, so opening one popover never
  // leaves state for the next assertion to trip over (no reliance on the
  // deferred-attach Escape/outside-click path to close between scenarios).
  const mountToggle = () => {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    let toggled = 0;
    return { host, root, getToggled: () => toggled, incToggled: () => { toggled += 1; } };
  };

  const t1 = mountToggle();
  await act(async () => {
    t1.root.render(
      React.createElement(MetronomeToggle, {
        metronomeOn: false,
        onToggle: t1.incToggled,
        volume: 0.7,
        onChangeVolume: () => undefined,
      }),
    );
  });
  const toggleBtn1 = t1.host.querySelector<HTMLButtonElement>('button[aria-pressed]');
  assert.ok(toggleBtn1, 'renders the metronome toggle button');
  assert.equal(doc.querySelector('[aria-label="Metronome level and beat"]'), null, 'the level popover starts closed');
  await act(async () => {
    toggleBtn1!.click();
  });
  assert.equal(t1.getToggled(), 1, 'the toggle button still fires onToggle on a plain click');
  await act(async () => {
    toggleBtn1!.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  assert.ok(doc.querySelector('[aria-label="Metronome level and beat"]'), 'onContextMenu is wired on the toggle: right-click opens the level popover');
  await act(async () => { t1.root.unmount(); });

  const t2 = mountToggle();
  await act(async () => {
    t2.root.render(
      React.createElement(MetronomeToggle, {
        metronomeOn: false,
        onToggle: t2.incToggled,
        volume: 0.7,
        onChangeVolume: () => undefined,
      }),
    );
  });
  const toggleBtn2 = t2.host.querySelector<HTMLButtonElement>('button[aria-pressed]');
  await act(async () => {
    toggleBtn2!.focus();
    toggleBtn2!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  });
  assert.ok(doc.querySelector('[aria-label="Metronome level and beat"]'), 'Shift+F10 on the focused toggle opens the level popover');
  await act(async () => { t2.root.unmount(); });

  const t3 = mountToggle();
  await act(async () => {
    t3.root.render(
      React.createElement(MetronomeToggle, {
        metronomeOn: false,
        onToggle: t3.incToggled,
        volume: 0.7,
        onChangeVolume: () => undefined,
      }),
    );
  });
  const toggleBtn3 = t3.host.querySelector<HTMLButtonElement>('button[aria-pressed]');
  await act(async () => {
    toggleBtn3!.focus();
    toggleBtn3!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: false, bubbles: true, cancelable: true }));
  });
  assert.equal(doc.querySelector('[aria-label="Metronome level and beat"]'), null, 'bare F10 on the toggle does not open the level popover');
  await act(async () => { t3.root.unmount(); });

  // The EDIT click's Beat select: the footer's click toggle, wired to the real
  // metronome store as PlayerFooter wires it, opens a popover whose labelled
  // Beat select writes the same clickMode the piano roll's Beat select does, so
  // the EDIT timeline's click counts 7/8 3+2+2 by its groups. Up to afd27bea
  // the footer had no way to choose it.
  {
    const { useMetronomeStore } = await import('../../state/metronomeStore.ts');
    const { barClicks } = await import('../../lib/metronome.ts');
    useMetronomeStore.setState({ clickMode: 'quarter' });
    const Wired: React.FC = () => {
      const s = useMetronomeStore();
      return React.createElement(MetronomeToggle, {
        metronomeOn: s.enabled,
        onToggle: s.toggle,
        volume: s.volume,
        onChangeVolume: s.setVolume,
        clickMode: s.clickMode,
        onChangeClickMode: s.setClickMode,
      });
    };
    const t4 = mountToggle();
    await act(async () => { t4.root.render(React.createElement(Wired)); });
    const btn = t4.host.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    assert.match(btn.getAttribute('aria-label') ?? '', /right-click for level and beat/);
    await act(async () => {
      btn.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const select = doc.getElementById('metronome-click-mode') as HTMLSelectElement | null;
    assert.ok(select, 'the popover has the Beat select');
    assert.equal(select!.name, 'metronomeClickMode');
    assert.equal(doc.querySelector('label[for="metronome-click-mode"]')?.textContent, 'Beat', 'a real <label for>');
    assert.deepEqual([...select!.options].map((o) => o.textContent), ['Quarters', 'Groups', 'Dotted quarters']);
    assert.equal(select!.value, 'quarter');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'group');
      select!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(useMetronomeStore.getState().clickMode, 'group', 'the choice is the shared click mode');
    const clicks = barClicks({ num: 7, den: 8, groups: [3, 2, 2] }, useMetronomeStore.getState().clickMode);
    assert.equal(clicks.length, 3, '7/8 3+2+2 now clicks its three group starts');
    assert.equal((doc.getElementById('metronome-click-mode') as HTMLSelectElement).value, 'group');
    await act(async () => { t4.root.unmount(); });
  }

  console.log('MetronomeVolumeControl: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
