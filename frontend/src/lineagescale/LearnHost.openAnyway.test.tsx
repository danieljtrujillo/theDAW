/**
 * LEARN past the classic graph's limit, and with a summary that failed.
 *
 * The sequences the user hit: a library past 2,000 linked songs opens LEARN,
 * the Classic tab is disabled, and nothing, not even a remembered choice, can
 * open it; a summary request that fails does the same on a library of any
 * size. These tests mount the real host (jsdom, React), let the summary land
 * or fail, and press the keys a user presses.
 *
 * Run: `npx tsx src/lineagescale/LearnHost.openAnyway.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { LineageSummary, SummaryProbe } from './lineageScaleClient.ts';
import type { LearnViewProps } from './LearnHost.tsx';

const summaryOf = (withLineage: number, fullViewOk: boolean): LineageSummary => ({
  entries: withLineage + 100,
  with_lineage: withLineage,
  standalone: 100,
  links_raw: withLineage * 2,
  links_distinct: withLineage,
  by_kind: { derived_from: withLineage },
  largest_connected: withLineage,
  largest_tree: 12,
  full_view_ok: fullViewOk,
  revision: 1,
});

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'sessionStorage']) {
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
  const { LearnHost } = await import('./LearnHost.tsx');

  // The global the jsdom window was installed as, typed as the DOM it is.
  const doc = document;
  const host = doc.getElementById('root')!;
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  const button = (name: string): HTMLButtonElement | undefined =>
    Array.from(doc.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === name);
  const mounted = () => Array.from(doc.querySelectorAll('[data-view]')).map((el) => el.getAttribute('data-view'));

  const Scale: React.FC<LearnViewProps> = () => <i data-view="scale" />;
  const Classic: React.FC<LearnViewProps> = () => <i data-view="classic" />;

  // ── past the limit: disabled, warned, and one press away ────────────────
  {
    dom.window.sessionStorage.clear();
    const root = createRoot(host);
    const big = summaryOf(173565, false);
    await act(async () =>
      root.render(
        <LearnHost
          visible
          loadSummary={async (): Promise<SummaryProbe> => ({ kind: 'ok', summary: big })}
          scaleView={Scale}
          classicView={Classic}
        />,
      ),
    );
    await settle();
    assert.deepEqual(mounted(), ['scale'], 'the scale view is the default past the limit');
    const classicTab = button('Classic graph')!;
    assert.equal(classicTab.disabled, true, 'the Classic tab is disabled until asked');
    const warning = doc.getElementById('lineage-scale-classic-unavailable');
    assert.ok(warning?.textContent?.includes('173,565 connected songs'), 'with the warning in the library’s numbers');
    const anyway = button('Open anyway');
    assert.ok(anyway, 'and an Open anyway key');
    assert.equal(anyway!.getAttribute('aria-describedby'), 'lineage-scale-classic-unavailable');

    await act(async () => anyway!.click());
    await settle();
    assert.deepEqual(mounted(), ['classic'], 'Open anyway mounts the classic graph');
    assert.equal(button('Classic graph')!.disabled, false);
    assert.equal(button('Classic graph')!.getAttribute('aria-pressed'), 'true');
    assert.ok(doc.getElementById('lineage-scale-classic-unavailable'), 'the warning stays on screen');
    assert.ok(!button('Open anyway'), 'the key has done its job');

    // A tab switch hides and shows the host; the press holds.
    await act(async () =>
      root.render(<LearnHost visible={false} loadSummary={async () => ({ kind: 'ok', summary: big })} scaleView={Scale} classicView={Classic} />),
    );
    await act(async () =>
      root.render(<LearnHost visible loadSummary={async () => ({ kind: 'ok', summary: big })} scaleView={Scale} classicView={Classic} />),
    );
    await settle();
    assert.deepEqual(mounted(), ['classic'], 'the classic graph is still open after a tab switch');

    // Back to the scale view: the Classic tab waits behind Open anyway again.
    await act(async () => button('Lineage')!.click());
    await settle();
    assert.deepEqual(mounted(), ['scale']);
    assert.equal(button('Classic graph')!.disabled, true);
    assert.ok(button('Open anyway'));
    await act(async () => root.unmount());

    // A reload (a fresh mount) with "classic" remembered opens the scale view:
    // the default stays the scale view past the limit.
    dom.window.sessionStorage.setItem('thedaw.learnMode', 'classic');
    const again = createRoot(host);
    await act(async () =>
      again.render(<LearnHost visible loadSummary={async () => ({ kind: 'ok', summary: big })} scaleView={Scale} classicView={Classic} />),
    );
    await settle();
    assert.deepEqual(mounted(), ['scale'], 'a fresh mount past the limit opens the scale view');
    assert.ok(button('Open anyway'), 'with the key still there');
    await act(async () => again.unmount());
  }

  // ── a failed summary: warned, never blocked ──────────────────────────────
  {
    dom.window.sessionStorage.clear();
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <LearnHost
          visible
          loadSummary={async () => {
            throw new Error('HTTP 503');
          }}
          scaleView={Scale}
          classicView={Classic}
        />,
      ),
    );
    await settle();
    assert.deepEqual(mounted(), ['scale'], 'an unknown size opens the scale view');
    assert.ok(doc.body.textContent?.includes('HTTP 503'), 'says what failed');
    assert.ok(button('Retry'), 'with a Retry');
    const classicTab = button('Classic graph')!;
    assert.equal(classicTab.disabled, false, 'and the Classic tab is not blocked');
    assert.ok(
      doc.getElementById('lineage-scale-classic-unavailable')?.textContent?.includes('size is unknown'),
      'it carries the unknown-size warning',
    );
    await act(async () => classicTab.click());
    await settle();
    assert.deepEqual(mounted(), ['classic'], 'pressing it opens the classic graph');
    assert.equal(dom.window.sessionStorage.getItem('thedaw.learnMode'), 'classic', 'and the pick is remembered');
    await act(async () => root.unmount());

    // A reload with "classic" remembered, and the summary failing again (a
    // 503 while the library opens): the scale view opens, the Classic tab is
    // one press away, and the remembered choice alone mounts nothing.
    const again = createRoot(host);
    await act(async () =>
      again.render(
        <LearnHost
          visible
          loadSummary={async () => {
            throw new Error('HTTP 503');
          }}
          scaleView={Scale}
          classicView={Classic}
        />,
      ),
    );
    await settle();
    assert.deepEqual(mounted(), ['scale'], 'a fresh mount on an unknown size opens the scale view');
    assert.equal(button('Classic graph')!.disabled, false, 'with the Classic tab still offered');
    await act(async () => button('Classic graph')!.click());
    await settle();
    assert.deepEqual(mounted(), ['classic'], 'and a press on this mount opens it');
    await act(async () => again.unmount());
  }

  // ── a small library: nothing changed ────────────────────────────────────
  {
    dom.window.sessionStorage.clear();
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <LearnHost visible loadSummary={async () => ({ kind: 'ok', summary: summaryOf(412, true) })} scaleView={Scale} classicView={Classic} />,
      ),
    );
    await settle();
    assert.deepEqual(mounted(), ['classic'], 'the classic graph opens as it always did');
    assert.ok(!button('Open anyway'));
    assert.ok(!doc.getElementById('lineage-scale-classic-unavailable'), 'and there is nothing to warn about');
    await act(async () => root.unmount());
  }

  console.log('LearnHost.openAnyway: all assertions passed');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
