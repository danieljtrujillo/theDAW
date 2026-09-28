/**
 * Settings → Sound banks and the DownloadDock's sound bank row, driven the way
 * a user meets them.
 *
 *  1. Every bank row shows its licence (name, link, one-line summary) above
 *     its action, and the action names the licence in its accessible
 *     description.
 *  2. A downloadable bank has a Download button that POSTs the bank's
 *     download route and opens the dock; an SFZ bank has no Download button,
 *     only a link to its upstream page.
 *  3. The dock row for a sound bank job carries the licence as a link, and a
 *     failure there is worded for a download site, not Hugging Face.
 *  4. All text in the section and the dock is 12px or larger bold sans.
 *
 * Real components, real React (react-dom/client + act) under jsdom; `fetch`
 * is stubbed and every call recorded.
 *
 * Run: `npx tsx src/components/layout/settings/SoundBanksSection.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="dock"></div></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLAnchorElement', 'HTMLButtonElement',
    'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage',
  ]) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const licence = (name: string) => ({
    name,
    url: `https://licences.test/${encodeURIComponent(name)}`,
    summary: `${name} summary line`,
    spdx: '',
  });
  const banks = [
    {
      id: 'thedaw-orchestra', label: 'theDAW Orchestra', summary: 'CC0 orchestra', format: 'sf3',
      licence: licence('CC0 1.0 Universal'), homepage: 'https://github.com/gantasmo/theDAW/releases',
      credit: 'Versilian', kind: 'download', url: null, size_bytes: null, sha256: null, loadable: true,
      notes: '', tags: [], installed: [], installed_bytes: 0, job_id: null,
    },
    {
      id: 'virtual-playing-orchestra', label: 'Virtual Playing Orchestra 3', summary: 'SFZ orchestra', format: 'sfz',
      licence: licence('Mixed licences'), homepage: 'https://virtualplaying.com/virtual-playing-orchestra/',
      credit: 'Paul Battersby', kind: 'link', url: null, size_bytes: null, sha256: null, loadable: false,
      notes: 'SFZ: load it in an SFZ player.', tags: [], installed: [], installed_bytes: 0, job_id: null,
    },
  ];
  type Call = { url: string; method: string };
  const calls: Call[] = [];
  let jobs: unknown[] = [];
  g.fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    let body: unknown = {};
    if (url === '/api/models/soundbanks') body = { banks };
    else if (url === '/api/models/downloads') body = { jobs };
    else if (url.startsWith('/api/magenta')) body = { jobs: [] };
    else if (method === 'POST') body = { job_id: 'j1', name: 'thedaw-orchestra', status: 'queued' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { SoundBanksSection } = await import('./SoundBanksSection.tsx');
  const { DownloadDock } = await import('../DownloadDock.tsx');
  const { useDownloadStore } = await import('../../../state/downloadStore.ts');

  const doc = dom.window.document;
  const host = doc.getElementById('root')!;
  const root = createRoot(host);
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  await act(async () => {
    root.render(React.createElement(SoundBanksSection));
  });
  await settle();

  // ── 1. the licence is on the row, above the action ─────────────────────
  const rows = Array.from<HTMLElement>(host.querySelectorAll<HTMLElement>('[data-soundbank]'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const lic = row.querySelector<HTMLElement>('[data-soundbank-licence]');
    assert.ok(lic, 'licence line renders');
    const link = lic!.querySelector('a')!;
    assert.match(link.textContent ?? '', /CC0 1.0 Universal|Mixed licences/);
    assert.ok(link.getAttribute('href')?.startsWith('https://licences.test/'));
    assert.match(lic!.textContent ?? '', /summary line/);
    const action = row.querySelector<HTMLElement>('button, a[aria-describedby]')!;
    assert.equal(action.getAttribute('aria-describedby'), lic!.id, 'the action is described by the licence');
    assert.ok(
      lic!.compareDocumentPosition(action) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      'the licence comes before the action',
    );
  }

  // ── 2. download vs link ────────────────────────────────────────────────
  const orchestra = rows.find((r) => r.dataset.soundbank === 'thedaw-orchestra')!;
  const vpo = rows.find((r) => r.dataset.soundbank === 'virtual-playing-orchestra')!;
  assert.equal(vpo.querySelector('button'), null, 'an SFZ bank has no Download button');
  const page = vpo.querySelector<HTMLAnchorElement>('a[aria-label^="Open the"]')!;
  assert.equal(page.getAttribute('href'), 'https://virtualplaying.com/virtual-playing-orchestra/');
  assert.equal(page.getAttribute('target'), '_blank');
  assert.equal(vpo.querySelector('[data-soundbank-state]')!.textContent, 'External');

  const button = orchestra.querySelector<HTMLButtonElement>('button')!;
  assert.equal(button.getAttribute('aria-label'), 'Download theDAW Orchestra, licensed CC0 1.0 Universal');
  assert.equal(orchestra.querySelector('[data-soundbank-state]')!.textContent, 'Available');
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  assert.ok(
    calls.some((c) => c.method === 'POST' && c.url === '/api/models/soundbanks/thedaw-orchestra/download'),
    JSON.stringify(calls),
  );
  assert.equal(useDownloadStore.getState().expanded, true, 'the dock opens on the new job');
  useDownloadStore.getState()._stopPolling();

  // ── 3. the dock row carries the licence; errors are site-worded ────────
  jobs = [
    {
      id: 'j1', name: 'thedaw-orchestra', kind: 'soundbank', repo_id: 'https://github.com/gantasmo/theDAW/releases',
      label: 'theDAW Orchestra', status: 'error', files: [], current_file: -1, dest_dir: '',
      error_detail: '<urlopen error [Errno 11001] getaddrinfo failed>', error_repo_id: null,
      licence: { name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    },
  ];
  await act(async () => {
    await useDownloadStore.getState().refresh();
  });
  const dockHost = doc.getElementById('dock')!;
  const dockRoot = createRoot(dockHost);
  await act(async () => {
    dockRoot.render(React.createElement(DownloadDock));
  });
  await settle();
  const chip = dockHost.querySelector<HTMLAnchorElement>('a[aria-label^="Licence: CC0"]');
  assert.ok(chip, dockHost.innerHTML);
  assert.equal(chip!.getAttribute('href'), 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.ok(dockHost.textContent?.includes("Can't reach the download site"), dockHost.textContent ?? '');
  assert.ok(!/hugging face/i.test(dockHost.textContent ?? ''), 'no Hugging Face advice on a sound bank row');
  assert.equal(orchestra.querySelector('[data-soundbank-state]')!.textContent, 'Failed');

  // ── 4. 12px+ bold sans, no small mono ──────────────────────────────────
  for (const scope of [host, dockHost]) {
    const text = Array.from<HTMLElement>(scope.querySelectorAll<HTMLElement>('span, p, a, button, div'));
    for (const el of text) {
      const cls = el.getAttribute('class') ?? '';
      assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(cls), `small text: ${cls}`);
      assert.ok(!cls.includes('font-mono'), `mono text: ${cls}`);
    }
    for (const el of Array.from<HTMLElement>(scope.querySelectorAll<HTMLElement>('p, button, a'))) {
      const cls = el.getAttribute('class') ?? '';
      if (!cls || !(el.textContent ?? '').trim()) continue;
      assert.ok(/font-(bold|black)/.test(cls), `not bold: ${el.outerHTML.slice(0, 120)}`);
    }
  }

  await act(async () => {
    root.unmount();
    dockRoot.unmount();
  });
  console.log('SoundBanksSection: ok');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
