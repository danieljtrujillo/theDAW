// Run with: npx tsx src/lib/pairingRevoke.test.ts
//
// The "New pairing link" button in Mobile Access, driven through the clicks
// and timer a user produces: arm, confirm, the backend answering (or not), and
// the arm running out. Each click reads the state the previous one left, the
// way React hands the next render's values to the next click.
import assert from 'node:assert/strict';

const { clickNewPairingLink, scheduleDisarm, REVOKE_ARM_MS, REGENERATE_URL } = await import('./pairingRevoke.ts');
const { pairedShareLink } = await import('./shareLink.ts');
type RevokeState = import('./pairingRevoke.ts').RevokeState;

const SHARE_URL = 'https://192.168.1.20:8601/';

/** The panel's state, and the requests the backend saw. */
function panel(answer: () => Promise<Response>) {
  const s = {
    armed: false,
    state: 'idle' as RevokeState,
    token: 'old-token' as string | null,
    posts: [] as Array<{ url: string; method?: string }>,
    stateLog: [] as RevokeState[],
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    s.posts.push({ url, method: init?.method });
    return answer();
  }) as unknown as typeof fetch;
  const click = () =>
    clickNewPairingLink({
      armed: s.armed,
      state: s.state,
      setArmed: (a) => {
        s.armed = a;
      },
      setState: (st) => {
        s.state = st;
        s.stateLog.push(st);
      },
      adoptToken: (t) => {
        s.token = t;
      },
      fetchImpl,
    });
  return { s, click, link: () => pairedShareLink(SHARE_URL, s.token) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// --- arm, then confirm: the token and every link switch ---------------------
{
  const { s, click, link } = panel(async () => json({ token: 'new-token' }));
  assert.equal(link(), `${SHARE_URL}#pair=old-token`);

  await click();
  assert.equal(s.armed, true, 'the first click arms the button');
  assert.equal(s.posts.length, 0, 'and asks nothing of the backend: replacing the token un-pairs every device');
  assert.equal(s.token, 'old-token');

  await click();
  assert.deepEqual(s.posts, [{ url: REGENERATE_URL, method: 'POST' }], 'the second click regenerates once');
  assert.equal(s.armed, false, 'and disarms');
  assert.deepEqual(s.stateLog, ['busy', 'done']);
  assert.equal(s.token, 'new-token');
  assert.equal(link(), `${SHARE_URL}#pair=new-token`, 'the Share URL and its QR code carry the new token');

  // A third click starts over at arming; it never regenerates on one click.
  await click();
  assert.equal(s.armed, true);
  assert.equal(s.posts.length, 1);
}

// --- the backend refuses: the old token and links stay ---------------------
{
  const { s, click, link } = panel(async () => json({ detail: 'refused' }, 403));
  await click();
  await click();
  assert.deepEqual(s.stateLog, ['busy', 'failed']);
  assert.equal(s.token, 'old-token');
  assert.equal(link(), `${SHARE_URL}#pair=old-token`, 'a failed regenerate leaves the working link in place');
}

// --- a 200 with no token is a failure, never an empty token ----------------
{
  const { s, click } = panel(async () => json({}));
  await click();
  await click();
  assert.deepEqual(s.stateLog, ['busy', 'failed']);
  assert.equal(s.token, 'old-token');
}

// --- the backend is unreachable ---------------------------------------------
{
  const { s, click } = panel(async () => {
    throw new TypeError('Failed to fetch');
  });
  await click();
  await click();
  assert.deepEqual(s.stateLog, ['busy', 'failed']);
  assert.equal(s.token, 'old-token');
}

// --- a click while the request is in flight does nothing -------------------
{
  let release: (r: Response) => void = () => {};
  const { s, click } = panel(() => new Promise<Response>((res) => (release = res)));
  await click();
  const inFlight = click();
  assert.equal(s.state, 'busy');
  await click(); // unarmed, busy: ignored
  assert.equal(s.armed, false, 'a click during the request neither arms nor regenerates');
  assert.equal(s.posts.length, 1);
  release(json({ token: 'new-token' }));
  await inFlight;
  assert.equal(s.token, 'new-token');
}

// --- the arm runs out: the next click arms again ---------------------------
{
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextId++;
    timers.set(id, { fn, ms });
    return id;
  };
  const clearTimer = (id: number) => {
    timers.delete(id);
  };
  const { s, click } = panel(async () => json({ token: 'new-token' }));

  // Unarmed: nothing is scheduled.
  scheduleDisarm(s.armed, (a) => (s.armed = a), setTimer, clearTimer);
  assert.equal(timers.size, 0);

  await click();
  const cleanup = scheduleDisarm(s.armed, (a) => (s.armed = a), setTimer, clearTimer);
  assert.equal(timers.size, 1);
  const [[id, timer]] = [...timers];
  assert.equal(timer.ms, REVOKE_ARM_MS);

  timer.fn(); // the user waited too long
  timers.delete(id);
  assert.equal(s.armed, false, 'the arm runs out on its own');
  cleanup();

  await click();
  assert.equal(s.armed, true, 'the click after a timeout arms again');
  assert.equal(s.posts.length, 0, 'and never regenerates on that single click');

  // The effect's cleanup cancels a pending disarm.
  const cancel = scheduleDisarm(s.armed, (a) => (s.armed = a), setTimer, clearTimer);
  assert.equal(timers.size, 1);
  cancel();
  assert.equal(timers.size, 0);
}

console.log('pairingRevoke.test.ts: all assertions passed');
