/**
 * Quest MIDI row: a program that takes the headset while Settings is open
 * shows up without a Re-scan.
 *
 * Replays the order the app sees it in with the bridge WebSocket closed (MIDI
 * off): Settings → Inputs & outputs mounts and reads Ready; the Node bridge
 * then maps the headset to itself; the row's timer re-reads the status and
 * shows Held with Take over, and the LOG gets one notice. The buttons stay
 * enabled through each poll. Once the bridge WebSocket is open, which pushes
 * status changes itself, the timer fetches nothing. Unmounting stops the timer.
 *
 * Run: npx tsx src/components/layout/settings/QuestMidiRow.poll.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

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
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5173/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'getComputedStyle']) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.WebSocket = FakeSocket;

  // The row's timer, driven by hand: each entry is one setInterval.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const win = dom.window as unknown as Record<string, unknown>;
  win.setInterval = (fn: () => void, ms: number) => {
    const id = nextTimer++;
    timers.set(id, { fn, ms });
    return id;
  };
  win.clearInterval = (id: number) => {
    timers.delete(id);
  };

  const readyStatus = {
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
  const heldStatus = {
    ...readyStatus,
    adb_reverse_ok: false,
    headset_holder: { pid: 4242, name: 'node.exe', port: 8765, thedaw: false, mapped: true },
  };
  let serverStatus: unknown = readyStatus;
  const gets: string[] = [];
  g.fetch = async (url: string, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'GET') gets.push(url);
    return new Response(JSON.stringify(serverStatus), { status: 200 });
  };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { QuestMidiRow } = await import('./QuestMidiRow.tsx');
  const { QUEST_MIDI_POLL_MS, useQuestMidiStatusStore } = await import('../../../state/questMidiStatus.ts');
  const { startQuestMidi, stopQuestMidi } = await import('../../../state/questMidiClient.ts');
  const { useLogStore } = await import('../../../state/logStore.ts');

  const questNotices = () =>
    useLogStore.getState().entries.filter((e) => e.source === 'questmidi' && e.msg.startsWith('QUEST MIDI HELD'));
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const doc = dom.window.document;
  const host = doc.getElementById('root')!;
  const root = createRoot(host);
  const takeOver = () => host.querySelector('button[aria-label^="Take over the Quest headset"]');

  // 1. Settings opens with the bridge socket closed; the row reads Ready.
  await act(async () => {
    root.render(React.createElement(QuestMidiRow));
    await settle();
  });
  assert.deepEqual(gets, ['/api/questmidi/status']);
  assert.ok(host.textContent?.includes('Ready'), host.textContent ?? '');
  assert.equal(timers.size, 1, 'the row keeps one status timer');
  const [timer] = [...timers.values()];
  assert.equal(timer.ms, QUEST_MIDI_POLL_MS);

  // 2. The Node bridge maps the headset to itself; the next tick shows it.
  serverStatus = heldStatus;
  const busySeen: unknown[] = [];
  const unsubscribe = useQuestMidiStatusStore.subscribe((s) => busySeen.push(s.busy));
  await act(async () => {
    timer.fn();
    await settle();
  });
  unsubscribe();
  assert.equal(gets.length, 2, 'the timer re-read the status');
  assert.ok(host.textContent?.includes('Held'), host.textContent ?? '');
  assert.ok(host.textContent?.includes('node.exe (pid 4242) has the headset'), host.textContent ?? '');
  assert.ok(takeOver(), 'Take over is offered');
  assert.equal((takeOver() as HTMLButtonElement).disabled, false);
  assert.ok(
    busySeen.every((b) => b === null),
    `a poll disabled the buttons: ${JSON.stringify(busySeen)}`,
  );
  assert.equal(questNotices().length, 1, 'one LOG notice names the holder');

  // 3. The bridge socket opens; it pushes changes, so the timer fetches nothing.
  startQuestMidi();
  FakeSocket.made[FakeSocket.made.length - 1].open();
  await act(async () => {
    timer.fn();
    await settle();
  });
  assert.equal(gets.length, 2, 'the timer fetched while the socket was open');

  // 4. Closing Settings stops the timer.
  await act(async () => {
    root.unmount();
  });
  assert.equal(timers.size, 0, 'the timer outlived the row');
  stopQuestMidi();
  console.log('QuestMidiRow.poll: a holder that arrives while Settings is open shows up without a Re-scan');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
