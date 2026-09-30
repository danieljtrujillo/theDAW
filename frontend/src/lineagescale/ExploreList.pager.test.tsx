/**
 * ExploreList's page box — when a typed page number is COMMITTED.
 *
 * Typed per keystroke, "12" is a request for page 1 and then page 12: two
 * pages read, the first thrown away, and a list that jumps under the hands of
 * anyone who types the second digit slowly. This renders the list in jsdom and
 * fires real events, because "commits on Enter, not on input" is a statement
 * about events and a static render cannot say it.
 *
 * jsdom harness: the same shape as MetronomeVolumeControl.test.tsx.
 *
 * Run: `npx tsx src/lineagescale/ExploreList.pager.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent',
    'getComputedStyle',
  ]) {
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
  const { ExploreList } = await import('./ExploreList.tsx');
  const doc = dom.window.document;

  const offsets: number[] = [];
  const page = {
    total: 1000, // 20 pages of 50
    offset: 0,
    limit: 50,
    rows: [
      {
        id: 'a',
        title: 'song a',
        model: 'stable-audio',
        source: 'generate',
        duration_sec: 90,
        play_count: 0,
        created_at: 0,
        links: 2,
      },
    ],
  };

  const root = createRoot(doc.getElementById('root')!);
  await act(async () => {
    root.render(
      React.createElement(ExploreList, {
        spec: { list: 'songs', set: 'with_lineage' } as const,
        page,
        loading: false,
        error: null,
        idPrefix: 'lineage-explorer',
        onOffset: (offset: number) => offsets.push(offset),
        onFocus: () => {},
        onCopyId: () => {},
        onOpenFamily: () => {},
      }),
    );
  });

  const input = doc.getElementById('lineage-explorer-page') as HTMLInputElement;
  assert.ok(input, 'the page box is rendered');
  assert.equal(input.value, '1', 'it starts on the page the server answered for');

  const type = async (value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  // Typing changes what the box SHOWS and nothing else.
  await type('1');
  await type('12');
  assert.deepEqual(offsets, [], 'typing does not read a page');
  assert.equal(input.value, '12', 'but the draft is what was typed');

  // Enter commits it.
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
  assert.deepEqual(offsets, [550], 'Enter reads page 12');

  // Leaving the box commits it too.
  await type('3');
  assert.deepEqual(offsets, [550], 'still nothing on a keystroke');
  await act(async () => {
    input.dispatchEvent(new dom.window.Event('focusout', { bubbles: true })); // React's onBlur is delegated focusout
  });
  assert.deepEqual(offsets, [550, 100], 'blur reads page 3');

  // A draft that means nothing commits nothing and snaps back.
  await type('');
  await act(async () => {
    input.dispatchEvent(new dom.window.Event('focusout', { bubbles: true })); // React's onBlur is delegated focusout
  });
  assert.deepEqual(offsets, [550, 100], 'an empty box is not page 1');
  assert.equal(input.value, '1', 'and the box shows where the list actually is');

  // A page past the end lands ON the last page, not on an empty one.
  await type('900');
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
  assert.deepEqual(offsets, [550, 100, 950], 'page 900 of 20 is page 20');

  await act(async () => root.unmount());
  console.log('ExploreList.pager.test.tsx: ok');
}

void main();
