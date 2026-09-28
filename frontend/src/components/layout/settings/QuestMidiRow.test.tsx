/**
 * Quest MIDI: another program serves the headset, and only the user moves it.
 *
 * Replays the order the app sees it in: the bridge WebSocket opens with
 * theDAW holding the headset; mid-session the backend pushes a status frame
 * naming a program that started listening on the headset's port, and the LOG
 * gets one notice; Settings → Inputs & outputs shows Held with a labelled Take
 * over button; the same program then maps the headset to itself, which is not
 * news; a reconnect that finds the same program posts nothing new; nothing has
 * asked the backend to take the headset until the user presses Take over;
 * after it, the row shows Ready and offers Re-attach instead. Last, a holder
 * the backend could not name (pid 0) is shown without a pid.
 *
 * Run: npx tsx src/components/layout/settings/QuestMidiRow.test.tsx
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

class FakeSocket {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.made.push(this);
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  frame(body: unknown): void {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const requests: { url: string; method: string }[] = [];
let nextResponse: unknown = null;

const g = globalThis as unknown as Record<string, unknown>;
g.window = { location: { protocol: 'http:', host: '127.0.0.1:5173', hash: '' }, setTimeout, clearTimeout };
g.WebSocket = FakeSocket;
g.fetch = async (url: string, init?: { method?: string }) => {
  requests.push({ url, method: init?.method ?? 'GET' });
  return new Response(JSON.stringify(nextResponse), { status: 200 });
};

const { startQuestMidi, stopQuestMidi } = await import('../../../state/questMidiClient.ts');
const { useQuestMidiStatusStore } = await import('../../../state/questMidiStatus.ts');
const { useLogStore } = await import('../../../state/logStore.ts');
const { STATUS_REPEAT_MS } = await import('../../../state/statusNoticeStore.ts');
const { QuestMidiRowView } = await import('./QuestMidiRow.tsx');

const HOLDER = { pid: 4242, name: 'node.exe', port: 8765, thedaw: false, mapped: true };
const readyStatus = {
  type: 'status',
  started: true,
  port: 8765,
  device_port: 8765,
  host_port: 8766,
  configured_host_port: 8766,
  adb_path: 'C:/platform-tools/adb.exe',
  adb_reverse_ok: true,
  quest_connected: false,
  headset_holder: null,
  took_over: false,
};
const heldStatus = { ...readyStatus, adb_reverse_ok: false, headset_holder: HOLDER };
const listeningStatus = { ...heldStatus, headset_holder: { ...HOLDER, mapped: false } };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// Moves the clock past the notice store's repeat window, which drops an
// identical line posted within STATUS_REPEAT_MS. Status changes that are
// seconds apart in the app are that far apart here too.
const realNow = Date.now;
let clockOffset = 0;
const later = () => {
  clockOffset += STATUS_REPEAT_MS + 1000;
  Date.now = () => realNow() + clockOffset;
};
const questNotices = () =>
  useLogStore.getState().entries.filter((e) => e.source === 'questmidi' && e.msg.startsWith('QUEST MIDI HELD'));
const renderRow = () => {
  const s = useQuestMidiStatusStore.getState();
  return renderToString(
    <QuestMidiRowView status={s.status} error={s.error} busy={s.busy} onTakeOver={() => {}} onReattach={() => {}} />,
  );
};

// 1. The bridge WebSocket opens; theDAW has the headset.
startQuestMidi();
const sock = FakeSocket.made[0];
assert.ok(sock, 'the bridge opened a socket');
sock.open();
sock.frame(readyStatus);
await tick();
let html = renderRow();
assert.ok(html.includes('Ready'), html);
assert.equal(questNotices().length, 0);

// 2. Mid-session, with the socket still open, the backend pushes a frame: the
// Node bridge started listening on the headset's port.
sock.frame(listeningStatus);
await tick();
const held = useQuestMidiStatusStore.getState().status;
assert.equal(held?.holder?.pid, 4242, 'the pushed status frame reached the store');
assert.equal(questNotices().length, 1, 'one LOG notice names the holder');
assert.equal(questNotices()[0].level, 'warn');
assert.ok(questNotices()[0].msg.includes('node.exe (pid 4242)'), questNotices()[0].msg);
html = renderRow();
assert.ok(html.includes('Held'), html);
assert.ok(html.includes('node.exe (pid 4242) listens on port 8765 here'), html);

// 3. Some seconds later the same program maps the headset to itself: the row
// says so, and it is not announced a second time.
later();
sock.frame(heldStatus);
await tick();
assert.equal(questNotices().length, 1, 'the same program was announced twice');

// Settings shows Held, says who, and offers a labelled Take over.
html = renderRow();
assert.ok(html.includes('Held'), html);
assert.ok(html.includes('node.exe (pid 4242) has the headset'), html);
assert.ok(html.includes('aria-label="Take over the Quest headset from node.exe (pid 4242)"'), html);
assert.ok(html.includes('>Take over<'), html);
assert.ok(!html.includes('Re-attach'), 'no Re-attach while another program holds the headset');

// 4. A reconnect that finds the same program posts nothing new.
sock.close();
stopQuestMidi();
startQuestMidi();
const again = FakeSocket.made[FakeSocket.made.length - 1];
again.open();
again.frame(heldStatus);
await tick();
assert.equal(questNotices().length, 1, 'the same holder is not announced twice');

// 5. Nothing asked the backend to take the headset before the user did.
assert.deepEqual(
  requests.filter((r) => r.method === 'POST'),
  [],
  'the headset was taken without a user action',
);

// 6. The user presses Take over.
nextResponse = { ...heldStatus, type: undefined, headset_holder: null, took_over: true, adb_reverse_ok: true };
await useQuestMidiStatusStore.getState().takeOver();
assert.deepEqual(requests.filter((r) => r.method === 'POST'), [{ url: '/api/questmidi/takeover', method: 'POST' }]);
const taken = useQuestMidiStatusStore.getState().status;
assert.equal(taken?.holder, null);
assert.equal(taken?.tookOver, true);

html = renderRow();
assert.ok(html.includes('Ready'), html);
assert.ok(!html.includes('Take over the Quest headset'), 'no Take over once theDAW has the headset');
assert.ok(html.includes('aria-label="Re-attach the Quest headset over USB"'), html);

// 7. The holder coming back later (it mapped the headset to itself again) is
// news.
later();
again.frame(heldStatus);
await tick();
assert.equal(questNotices().length, 2, 'a holder that returns is announced again');

// 8. A holder the backend sees on the port but cannot name (pid 0).
again.frame({ ...listeningStatus, headset_holder: { pid: 0, name: '', port: 8765, thedaw: false, mapped: false } });
await tick();
assert.equal(questNotices().length, 3, 'a different program is news');
assert.ok(questNotices()[2].msg.includes('QUEST MIDI HELD: another program serves port 8765'), questNotices()[2].msg);
html = renderRow();
assert.ok(html.includes('another program listens on port 8765 here'), html);
assert.ok(!html.includes('pid 0'), html);
assert.ok(html.includes('aria-label="Take over the Quest headset from another program"'), html);

Date.now = realNow;
stopQuestMidi();
console.log('QuestMidiRow: the headset stays with its holder until the user presses Take over');
