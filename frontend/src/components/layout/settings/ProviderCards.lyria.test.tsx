/**
 * Settings → Models → Lyria: the key lists, replayed the way a user drives
 * them.
 *
 *  1. The card opens on an older Lyria checkout (one key per provider): the
 *     count line says Lyria uses the first key, and the hint says so too,
 *     rather than promising a failover that checkout does not have.
 *  2. A key the backend refuses (400 for a value under 8 characters) shows
 *     the backend's reason in the alert line, keeps what was typed, and
 *     leaves NO unhandled promise rejection behind. The add path used to
 *     chain `.then()` onto a promise that rethrew, with no catch.
 *  3. A good key is saved with the pairing header (the key routes are
 *     loopback / launch-token / pairing gated), the field clears, and when a
 *     Lyria from an earlier session still holds the port the card says it
 *     keeps its old keys until Restart.
 *  4. The pool switch is a real toggle (aria-pressed) that posts the new
 *     value, off by default.
 *  5. The count line, the field labels and the Add / forget buttons are
 *     12px or larger bold sans, with no small mono.
 *
 * Real component, real React (react-dom/client + act) under jsdom; `fetch`
 * is stubbed and every call recorded.
 *
 * Run: `npx tsx src/components/layout/settings/ProviderCards.lyria.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement',
    'Node', 'Event', 'KeyboardEvent', 'getComputedStyle', 'localStorage',
  ]) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.localStorage.setItem('thedaw.pairingToken', 'phone-pairing-token');

  type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
  const calls: Call[] = [];
  const summary = (over: Record<string, unknown> = {}) => ({
    providers: {
      gemini: { count: 2, handed: 1, source: 'file', configured: true, env: 0, stored: 2, pool: 0, pool_available: 2 },
      openrouter: { count: 0, handed: 0, source: 'none', configured: false, env: 0, stored: 0, pool: 0, pool_available: 1 },
    },
    provider_preference: null,
    share_pool: false,
    reads_key_lists: false,
    mock: true,
    ...over,
  });
  let postReply: { status: number; body: unknown } = { status: 200, body: summary() };
  g.fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const reply = method === 'GET' ? { status: 200, body: summary() } : postReply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { LyriaCheckoutLine, LyriaKeyLists, lyriaKeyCounts } = await import('./ProviderCards.tsx');

  const doc = dom.window.document;
  const host = doc.getElementById('root')!;
  const root = createRoot(host);
  let saved = 0;
  await act(async () => {
    root.render(React.createElement(LyriaKeyLists, { onSaved: () => { saved += 1; } }));
  });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  await settle();

  // ── 1. an older checkout: the card says only the first key is used ──────
  const count = host.querySelector<HTMLElement>('[data-lyria-key-count="gemini"]');
  assert.ok(count, 'the Gemini count line renders');
  assert.match(count!.textContent ?? '', /2 keys · 2 saved here · Lyria uses the first one/);
  assert.ok(host.textContent?.includes('reads one key per provider'), host.textContent ?? '');
  assert.ok(!host.textContent?.includes('a rejected key is skipped'), 'no failover promise for an old checkout');
  assert.equal(lyriaKeyCounts(undefined), 'no keys');

  // ── 5. the count line is 12px bold sans ────────────────────────────────
  const countClass = count!.className;
  assert.ok(countClass.includes('text-xs') && countClass.includes('font-bold'), countClass);
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]|font-mono/.test(countClass), countClass);
  // Every label, button and line of text in the card: 12px or larger, no
  // mono. The key and provider fields keep the Settings input style (a typed
  // value at 12px, not a label), so only the text around them is held here.
  const cardText: HTMLElement[] = Array.from<HTMLElement>(host.querySelectorAll<HTMLElement>('label, button, span, p'));
  assert.ok(cardText.length > 8, `expected the card's labels and buttons, found ${cardText.length}`);
  for (const el of cardText) {
    const cls = el.getAttribute('class') ?? '';
    assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(cls), `text under 12px on <${el.tagName.toLowerCase()}> "${el.textContent}": ${cls}`);
    assert.ok(!cls.includes('font-mono'), `mono on <${el.tagName.toLowerCase()}> "${el.textContent}": ${cls}`);
  }

  const input = doc.getElementById('settings-lyria-gemini-key') as HTMLInputElement;
  assert.ok(input, 'the Gemini key field renders with its id');
  const form = input.closest('form')!;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  const type = async (value: string) => {
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((r) => setTimeout(r, 20));
  };

  // ── 2. a refused key: message shown, value kept, no unhandled rejection ─
  postReply = { status: 400, body: { detail: 'That does not look like an API key.' } };
  await type('tiny');
  await submit();
  const alert = host.querySelector('[role="alert"]');
  assert.equal(alert?.textContent, 'That does not look like an API key.');
  assert.equal(input.value, 'tiny', 'a refused key stays in the field so it can be fixed');
  assert.deepEqual(unhandled, [], `a refused key left an unhandled rejection: ${String(unhandled[0])}`);
  assert.equal(saved, 0);

  // ── 3. a good key: pairing header, field clears, stale Lyria reported ───
  postReply = { status: 200, body: summary({ external_running: true }) };
  await type('AIza-good-gemini-key');
  await submit();
  const post = calls.filter((c) => c.method === 'POST' && c.url === '/api/lyria/keys').at(-1)!;
  assert.deepEqual(post.body, { provider: 'gemini', key: 'AIza-good-gemini-key' });
  assert.equal(post.headers['X-TheDAW-Pair'], 'phone-pairing-token');
  assert.equal(input.value, '');
  assert.equal(host.querySelector('[role="alert"]'), null, 'the old refusal clears');
  assert.ok(
    host.querySelector('[role="status"]')?.textContent?.includes('Press Restart in the Lyria tab'),
    host.textContent ?? '',
  );
  assert.equal(saved, 1);

  // ── 4. the pool switch: off by default, posts the new value ─────────────
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Use the assistant’s key pool too"]');
  assert.ok(toggle, 'the pool switch renders with an accessible name');
  assert.equal(toggle!.getAttribute('aria-pressed'), 'false');
  assert.ok(toggle!.textContent?.includes('(3 keys)'), toggle!.textContent ?? '');
  postReply = { status: 200, body: summary({ share_pool: true }) };
  await act(async () => {
    toggle!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  const poolPost = calls.filter((c) => c.url === '/api/lyria/keys/pool').at(-1)!;
  assert.deepEqual(poolPost.body, { share: true });
  assert.equal(poolPost.headers['X-TheDAW-Pair'], 'phone-pairing-token');
  assert.equal(toggle!.getAttribute('aria-pressed'), 'true');

  await act(async () => root.unmount());

  // ── 6. the checkout line: the recorded commit, and a checkout that got
  //       no keys says why ──────────────────────────────────────────────────
  const extras = {
    missing: [],
    installable: true,
    installing: false,
    install: { status: 'idle' },
    gemini_key: true,
    gemini_key_source: 'file',
    mock: true,
    project_path: 'C:\\lyria',
    repo: 'StarskreamEXE/lyria-3-pro',
    repo_url: 'https://github.com/StarskreamEXE/lyria-3-pro.git',
    head: '192032ebe80397d869de6c9dbf4b8a7b64274db0',
    commit: '192032ebe80397d869de6c9dbf4b8a7b64274db0',
    commit_event: 'install',
    recorded_at: 1_790_000_000,
    ran_version: '0.0.0',
    verify: { ok: true, reason: '', package_name: 'lyria-3-pro', package_version: '0.0.0' },
    git: true,
    node: true,
    npm: true,
    listening: true,
  };
  const lineRoot = createRoot(host);
  await act(async () => {
    lineRoot.render(React.createElement(LyriaCheckoutLine, { extras }));
  });
  const line = host.querySelector<HTMLElement>('[data-lyria-checkout]');
  assert.ok(line, 'the checkout line renders');
  assert.match(line!.textContent ?? '', /Checkout 192032e of StarskreamEXE\/lyria-3-pro · lyria-3-pro 0\.0\.0 · last ran 0\.0\.0/);
  assert.ok(line!.title.includes('192032ebe80397d869de6c9dbf4b8a7b64274db0'), line!.title);
  assert.ok(line!.title.includes('Recorded at the last install'), line!.title);
  assert.equal(host.querySelector('[role="alert"]'), null, 'a checkout that passed has no alert');
  const withheld = "The checkout at C:\\lyria is the package 'not-lyria', not lyria-3-pro, so theDAW hands it no keys.";
  await act(async () => {
    lineRoot.render(
      React.createElement(LyriaCheckoutLine, {
        extras: { ...extras, verify: { ok: false, reason: withheld, package_name: 'not-lyria', package_version: '0.0.0' } },
      }),
    );
  });
  const keysAlert = host.querySelector<HTMLElement>('[role="alert"]');
  assert.ok(keysAlert, 'a checkout that failed the check shows why');
  assert.equal(keysAlert!.textContent, `No keys handed: ${withheld}`);
  for (const el of Array.from<HTMLElement>(host.querySelectorAll<HTMLElement>('p'))) {
    const cls = el.className;
    assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(cls), `text under 12px on "${el.textContent}": ${cls}`);
    assert.ok(!cls.includes('font-mono'), `mono on "${el.textContent}": ${cls}`);
  }
  await act(async () => lineRoot.unmount());
  assert.deepEqual(unhandled, []);
  console.log('ProviderCards.lyria.test.tsx: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
