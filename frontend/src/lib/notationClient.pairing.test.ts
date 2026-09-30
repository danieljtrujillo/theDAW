// Run with: npx tsx src/lib/notationClient.pairing.test.ts
//
// Every notation route that writes a file answers only this machine's own UI,
// the desktop shell or a paired device (backend/modules/notation/router.py).
// A phone opened from the Mobile Access share link is a paired device: it
// proves it with the X-TheDAW-Pair header. Every writer the SCORE tab calls
// sends that header, so a paired phone can import, export, perform, arrange
// and build tabs and chord tracks as this machine's UI does.
import assert from 'node:assert/strict';

const TOKEN = 'paired-phone-token';
const store = new Map<string, string>([['thedaw.pairingToken', TOKEN]]);
Object.assign(globalThis, {
  window: {
    location: { href: 'http://192.168.1.20:5173/', origin: 'http://192.168.1.20:5173', hash: '', pathname: '/', search: '' },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    history: { replaceState: () => undefined },
  },
});

interface Call { url: string; method: string; pair: string | null }
const calls: Call[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  calls.push({ url: String(input), method: init?.method ?? 'GET', pair: headers.get('X-TheDAW-Pair') });
  return new Response(JSON.stringify({ artifact: null, entry_id: 'e1' }), { status: 200 });
}) as typeof fetch;

const client = await import('./notationClient.ts');

await client.convertMidiToMusicXml('e1', 'm1');
await client.rewriteSheetFromMidi('e1', 'a1');
await client.importScoreFile(new File(['X:1'], 'tune.abc'));
await client.openCorpusPiece('bach_bwv66_6_mxl');
await client.exportArtifact('e1', 'a1', 'pdf');
await client.renderScoreAudio('e1', 'a1');
await client.performScore('e1', 'a1');
await client.makeTabs('e1', { source_artifact_id: 'a1' });
await client.makeArrangement('e1', { style: 'lead-sheet', source_artifact_id: 'a1' });
await client.makeChordTrack('e1', { source: 'auto' });

const posts = calls.filter((c) => c.method === 'POST');
assert.deepEqual(
  posts.map((c) => c.url),
  [
    '/api/notation/e1/from-midi/m1',
    '/api/notation/e1/rewrite-from-midi/a1',
    '/api/notation/import',
    '/api/notation/corpus/open',
    '/api/notation/e1/export',
    '/api/notation/e1/export',
    '/api/notation/e1/perform',
    '/api/notation/e1/tabs',
    '/api/notation/e1/arrange',
    '/api/notation/e1/chords',
  ],
);
for (const call of posts) {
  assert.equal(call.pair, TOKEN, `${call.url} sends the pairing header`);
}

console.log('notationClient pairing: every writer sends X-TheDAW-Pair');
