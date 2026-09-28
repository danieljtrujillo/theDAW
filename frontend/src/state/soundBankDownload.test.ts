/**
 * A sound bank download that finishes reaches the bank registry and its
 * playback gains, in the order the app sees it: the download dock's poll sees
 * the job go from downloading to done (state/downloadStore), the bank store
 * lists the bank the backend registered at its offset (state/soundBankStore,
 * GET /api/soundfonts), and the bank's manifest gains are registered at that
 * offset (lib/soundbankClient registerInstalledSoundbankGains), so a program
 * change to its Flute Staccato (bank 1, program 73) picks the gain up. The
 * bank leaving the list takes its gains with it.
 *
 *   cd frontend && npx tsx src/state/soundBankDownload.test.ts
 */
import assert from 'node:assert/strict';
import type { DownloadJob } from '../lib/modelDownloadClient.ts';
import { selectionGainDb } from '../lib/soundbankGain.ts';
import { bankOffsetOf } from '../lib/bankRegistry.ts';
import { useDownloadStore } from './downloadStore.ts';
import { useSoundBankStore } from './soundBankStore.ts';

const job = (status: DownloadJob['status']): DownloadJob => ({
  id: 'job-orchestra',
  name: 'thedaw-orchestra',
  repo_id: '',
  label: 'theDAW Orchestra',
  status,
  files: [],
  current_file: 0,
  dest_dir: '',
  error_detail: null,
  error_repo_id: null,
  kind: 'soundbank',
});

const orchestra = {
  id: 'dl-thedaw-orchestra-thedaw-orchestra-1a2b3c4d',
  name: 'theDAW Orchestra',
  format: 'sf3',
  offset: 32,
  span: 2,
  presets: [
    { bank: 0, program: 40, name: 'Violins', drum: false },
    { bank: 1, program: 73, name: 'Flute Staccato', drum: false },
  ],
  download_id: 'thedaw-orchestra',
};

let jobStatus: DownloadJob['status'] = 'downloading';
let listed: unknown[] = [];
const asked: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  asked.push(url);
  if (url === '/api/models/downloads') return json({ jobs: [job(jobStatus)] });
  if (url === '/api/magenta/engine/checkpoints') return json({ detail: 'off' }, 404);
  if (url === '/api/soundfonts') return json({ banks: listed });
  if (url === '/api/models/soundbanks/thedaw-orchestra/manifest') return json({ playback_gain: { '1:73': 9.5, '0:40': 1.5 } });
  return json({ detail: `unexpected ${url}` }, 404);
}) as typeof fetch;

const settle = async (until: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !until(); i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), what);
};

// While the download runs, the registry is not asked and no gain is set.
await useDownloadStore.getState().refresh();
assert.ok(!asked.includes('/api/soundfonts'), 'a running download does not list banks');
assert.equal(selectionGainDb(33, 73), 0);

// The download finishes: the backend's hook has listed the bank.
listed = [orchestra];
jobStatus = 'done';
await useDownloadStore.getState().refresh();
await settle(() => useSoundBankStore.getState().banks.some((b) => b.id === orchestra.id), 'the finished download lists the bank');
const bank = useSoundBankStore.getState().banks.find((b) => b.id === orchestra.id);
assert.equal(bank?.downloadId, 'thedaw-orchestra');
assert.equal(bankOffsetOf(orchestra.id), 32, 'the voice resolver knows its offset');
await settle(() => selectionGainDb(33, 73) === 9.5, 'Flute Staccato carries its playback gain at bank select 33');
assert.equal(selectionGainDb(32, 40), 1.5, 'Violins at bank select 32');
assert.equal(selectionGainDb(1, 73), 0, 'bank 1 of the bundled bank has no gain of the orchestra');

// A later poll of the same finished job does not list the banks again.
const lists = asked.filter((u) => u === '/api/soundfonts').length;
await useDownloadStore.getState().refresh();
assert.equal(asked.filter((u) => u === '/api/soundfonts').length, lists, 'a job already done does not refresh the list');
const manifests = asked.filter((u) => u.endsWith('/manifest')).length;
await useSoundBankStore.getState().refresh();
assert.equal(asked.filter((u) => u.endsWith('/manifest')).length, manifests, 'the gains are fetched once per bank and offset');

// The bank leaves the list: its gains go too.
listed = [];
await useSoundBankStore.getState().refresh();
await settle(() => selectionGainDb(33, 73) === 0, 'a bank off the list plays no gain');

console.log('soundBankDownload: ok');
