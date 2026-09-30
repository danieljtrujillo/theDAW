/**
 * Batch-12 T16 fixes for VJView — three pure predicates extracted so they can
 * be tested without mounting the iframe/postMessage machinery:
 *
 *   1. isTrustedVjSource  — a popped-out VJ window used to be silently
 *      dropped as an inbound message source (VJView.tsx:228 accepted only the
 *      in-tab iframe's contentWindow). Control-sync / SET-ack / camera-state
 *      messages from a popped-out VJ never reached SA3. FOLLOW-UP (audit): the
 *      window-identity check alone is not enough — a popped-out window keeps
 *      the same JS `Window` handle even after `window.open`-style navigation
 *      to a DIFFERENT origin, so a same-object-different-origin sender used
 *      to pass. Now also requires `event.origin === vjOrigin` whenever
 *      `vjOrigin` isn't the `'*'` fallback (unparseable VJ URL).
 *   2. formatVjErrorDetail — the `detail` state (VJView.tsx:64) was set on a
 *      load failure (:376) but never rendered, so a real cause (a stack
 *      trace, a spawn error) was thrown away and the user only saw
 *      "The VJ engine didn't start."
 *   3. isVjPollActive — the delinQuest status poll (VJView.tsx:390-393) ran
 *      on a bare `setInterval([], 5000)` forever, including while the VJ tab
 *      was hidden (warm-mounted behind another center tab) or the window was
 *      backgrounded. Matches the same "popped OR (visible && docVisible)"
 *      gate already used by the audio bridge effect (VJView.tsx:408).
 *
 * Run: `npx tsx src/views/VJView.b12.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { formatVjErrorDetail, isTrustedVjSource, isVjPollActive } from './VJView.tsx';

/* ------------------------------ isTrustedVjSource ------------------------------ */
{
  const iframeWindow = { id: 'iframe' } as unknown as Window;
  const poppedWindow = { id: 'popped' } as unknown as Window;
  const other = { id: 'other' } as unknown as Window;
  const VJ_ORIGIN = 'http://localhost:5187';
  const OTHER_ORIGIN = 'https://evil.example.com';

  assert.equal(isTrustedVjSource(null, iframeWindow, poppedWindow, VJ_ORIGIN, VJ_ORIGIN), false, 'a null source is never trusted');
  assert.equal(isTrustedVjSource(iframeWindow, iframeWindow, poppedWindow, VJ_ORIGIN, VJ_ORIGIN), true, 'the in-tab iframe window, right origin, is trusted');
  assert.equal(isTrustedVjSource(poppedWindow, iframeWindow, poppedWindow, VJ_ORIGIN, VJ_ORIGIN), true, 'the popped-out window, right origin, is trusted (THE BUG)');
  assert.equal(isTrustedVjSource(other, iframeWindow, poppedWindow, VJ_ORIGIN, VJ_ORIGIN), false, 'an unrelated window is never trusted');
  assert.equal(isTrustedVjSource(iframeWindow, null, poppedWindow, VJ_ORIGIN, VJ_ORIGIN), false, 'no in-tab iframe registered yet: nothing matches it');
  assert.equal(isTrustedVjSource(poppedWindow, iframeWindow, null, VJ_ORIGIN, VJ_ORIGIN), false, 'no popped window registered: nothing matches it');

  // Audit finding 1 (MAJOR): a trusted window handle that navigated to a
  // different origin must be rejected.
  assert.equal(
    isTrustedVjSource(poppedWindow, iframeWindow, poppedWindow, OTHER_ORIGIN, VJ_ORIGIN),
    false,
    'a trusted popped window sending from the WRONG origin is rejected',
  );
  assert.equal(
    isTrustedVjSource(iframeWindow, iframeWindow, poppedWindow, OTHER_ORIGIN, VJ_ORIGIN),
    false,
    'a trusted iframe window sending from the WRONG origin is rejected',
  );
  // The '*' fallback only applies when the VJ URL itself was unparseable —
  // origin can't be pinned, so identity alone still gates it.
  assert.equal(
    isTrustedVjSource(poppedWindow, iframeWindow, poppedWindow, OTHER_ORIGIN, '*'),
    true,
    "expectedOrigin '*' (unparseable VJ url) skips the origin check",
  );
}

/* ------------------------------ formatVjErrorDetail ------------------------------ */
{
  assert.equal(formatVjErrorDetail(''), null, 'empty detail renders nothing');
  assert.equal(formatVjErrorDetail('   '), null, 'whitespace-only detail renders nothing');
  assert.equal(formatVjErrorDetail('spawn ENOENT'), 'spawn ENOENT', 'a real error is passed through');
  assert.equal(formatVjErrorDetail('  spawn ENOENT  '), 'spawn ENOENT', 'surrounding whitespace is trimmed');
}

/* ------------------------------ isVjPollActive ------------------------------ */
{
  assert.equal(isVjPollActive(true, false, false), true, 'popped out: always active regardless of in-tab visibility');
  assert.equal(isVjPollActive(false, true, true), true, 'in-tab, visible tab, visible document: active');
  assert.equal(isVjPollActive(false, true, false), false, 'in-tab, visible tab, but the document is backgrounded: paused');
  assert.equal(isVjPollActive(false, false, true), false, 'in-tab, document visible, but another center tab is shown: paused');
  assert.equal(isVjPollActive(false, false, false), false, 'in-tab, hidden and backgrounded: paused');
}

console.log('VJView.b12.test.ts: all assertions passed');
