// Run with: npx tsx src/state/vstStore.test.ts
//
// The reported symptom: a browser tab (not the desktop shell) calls
// GET /api/vst/scan, the backend answers its by-design 403 "This request must
// come from theDAW's desktop shell.", and the store logged it as an error and
// put "VST SCAN FAILED: ..." in the status bar. Being turned away from a
// desktop-only route is the documented shape of the browser build, not a
// fault, so it must read as "scanned, none here".
import assert from 'node:assert/strict';

const DESKTOP_ONLY = "This request must come from theDAW's desktop shell.";

// Stub fetch BEFORE the store (and the api client under it) is imported.
let nextResponse: Response = new Response('{"plugins":[]}', { status: 200 });
globalThis.fetch = (async () => nextResponse.clone()) as typeof fetch;

const { useVstStore, isDesktopOnlyRefusal, resetDesktopOnlyNotice, vstBrowserEmptyText, PAIR_THIS_DEVICE_TEXT } =
  await import('./vstStore.ts');
const { useStatusBarStore } = await import('./statusBarStore.ts');
const { useLogStore } = await import('./logStore.ts');
const { ApiError } = await import('../lib/apiJson.ts');

const errorLogCount = (): number =>
  useLogStore.getState().entries.filter((e) => e.level === 'error').length;

const reset = (body: string, status: number): void => {
  nextResponse = new Response(body, { status, headers: { 'content-type': 'application/json' } });
  resetDesktopOnlyNotice();
  useVstStore.setState({ plugins: [], scanning: false, scanned: false, error: null, unavailableReason: null });
};

// --- the refusal predicate --------------------------------------------------
{
  assert.equal(isDesktopOnlyRefusal(new ApiError(DESKTOP_ONLY, 403)), true);
  // Any 4xx that says so in its own words, not only 403.
  assert.equal(isDesktopOnlyRefusal(new ApiError('Desktop app only', 404)), true);
  // A real failure is still a real failure.
  assert.equal(isDesktopOnlyRefusal(new ApiError('scan crashed', 500)), false);
  assert.equal(isDesktopOnlyRefusal(new ApiError('bad request', 400)), false);
  assert.equal(isDesktopOnlyRefusal(new Error(DESKTOP_ONLY)), false);
}

// --- the 403 is not an error ------------------------------------------------
{
  reset(JSON.stringify({ detail: DESKTOP_ONLY }), 403);
  const errorsBefore = errorLogCount();

  await useVstStore.getState().scan();

  const s = useVstStore.getState();
  assert.equal(s.scanned, true, 'the scan is answered, not pending');
  assert.deepEqual(s.plugins, []);
  assert.equal(s.error, null, 'a refusal is not an error');
  assert.equal(s.unavailableReason, DESKTOP_ONLY, "the backend's own words are kept");
  assert.equal(useStatusBarStore.getState().text, 'VST: desktop app only');
  assert.equal(errorLogCount(), errorsBefore, 'nothing was logged as an error');
}

// --- the quiet notice is shown once -----------------------------------------
{
  reset(JSON.stringify({ detail: DESKTOP_ONLY }), 403);
  await useVstStore.getState().scan();
  useStatusBarStore.getState().setText('SOMETHING ELSE');
  await useVstStore.getState().scan();
  assert.equal(
    useStatusBarStore.getState().text,
    'SOMETHING ELSE',
    'the second refusal must not re-announce itself',
  );
}

// --- a real failure still fails ---------------------------------------------
{
  reset(JSON.stringify({ detail: 'the host sidecar died' }), 500);
  const errorsBefore = errorLogCount();

  await useVstStore.getState().scan();

  const s = useVstStore.getState();
  assert.equal(s.error, 'the host sidecar died');
  assert.equal(s.unavailableReason, null);
  assert.equal(useStatusBarStore.getState().text, 'VST SCAN FAILED: the host sidecar died');
  assert.equal(errorLogCount(), errorsBefore + 1, 'a real failure is still logged');
}

// --- a working scan is unchanged --------------------------------------------
{
  reset(JSON.stringify({ plugins: [{ name: 'Pro-Q', path: 'p', manufacturer: 'f', version: '1', category: 'effect', file_size_mb: 1, last_modified: 0 }] }), 200);
  await useVstStore.getState().scan();
  const s = useVstStore.getState();
  assert.equal(s.plugins.length, 1);
  assert.equal(s.scanned, true);
  assert.equal(s.error, null);
  assert.equal(s.unavailableReason, null);
}

// --- the MIX effects browser says WHY the list is empty ----------------------
{
  // Scanning wins: the list is not empty yet, it is unknown.
  assert.equal(vstBrowserEmptyText(true, null), 'Scanning…');
  assert.equal(vstBrowserEmptyText(true, DESKTOP_ONLY), 'Scanning…');
  // A refusal is explained, not left as a blank panel.
  assert.equal(
    vstBrowserEmptyText(false, DESKTOP_ONLY),
    `VST hosting is desktop-only. ${DESKTOP_ONLY}`,
  );
  // Nothing refused: the message that was always there.
  assert.equal(vstBrowserEmptyText(false, null), 'No VST3 plugins found. Click Rescan.');
  assert.equal(vstBrowserEmptyText(false, '   '), 'No VST3 plugins found. Click Rescan.');
}

// --- an unpaired device on the LAN is told how to pair ----------------------
//
// The VST routes accept a paired device now (backend/modules/vst/router.py).
// A device on another machine that was never paired gets the pairing gate's
// 403, in the backend's exact words; MIX must say how to pair, not claim VST
// hosting is desktop-only, which is no longer true.
{
  const PAIRING_GATE = "This request must come from theDAW's desktop shell or a paired device.";
  reset(JSON.stringify({ detail: PAIRING_GATE }), 403);
  const errorsBefore = errorLogCount();

  await useVstStore.getState().scan();

  const s = useVstStore.getState();
  assert.equal(s.error, null, 'still a refusal, not a failure');
  assert.equal(s.unavailableReason, PAIRING_GATE);
  assert.equal(useStatusBarStore.getState().text, 'VST: pair this device');
  assert.equal(errorLogCount(), errorsBefore, 'nothing was logged as an error');
  assert.equal(vstBrowserEmptyText(false, s.unavailableReason), PAIR_THIS_DEVICE_TEXT);
  assert.doesNotMatch(PAIR_THIS_DEVICE_TEXT, /desktop-only/);
  assert.match(PAIR_THIS_DEVICE_TEXT, /Mobile Access/, 'it names where the paired link comes from');
}

console.log('vstStore.test.ts: all assertions passed');
