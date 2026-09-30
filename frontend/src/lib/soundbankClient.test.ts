/**
 * soundbankClient: row state, size line and error wording for the sound bank
 * downloads.
 *
 * Run: `npx tsx src/lib/soundbankClient.test.ts`
 */
import assert from 'node:assert/strict';
import type { DownloadJob } from './modelDownloadClient.ts';
import {
  classifySoundbankError,
  soundbankSizeText,
  soundbankState,
  type SoundbankEntry,
} from './soundbankClient.ts';

const entry = (over: Partial<SoundbankEntry> = {}): SoundbankEntry => ({
  id: 'thedaw-orchestra',
  label: 'theDAW Orchestra',
  summary: 's',
  format: 'sf3',
  licence: { name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/', summary: 'x', spdx: 'CC0-1.0' },
  homepage: 'https://github.com/gantasmo/theDAW/releases?q=soundbank-orchestra',
  credit: 'c',
  kind: 'download',
  url: null,
  size_bytes: null,
  sha256: null,
  loadable: true,
  notes: '',
  tags: [],
  installed: [],
  installed_bytes: 0,
  job_id: null,
  ...over,
});

const job = (status: DownloadJob['status'], over: Partial<DownloadJob> = {}): DownloadJob => ({
  id: `job-${status}`,
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
  ...over,
});

// Row state: a link stays a link; the newest job for the bank decides the rest.
{
  assert.equal(soundbankState(entry({ kind: 'link' }), [job('downloading')]), 'link');
  assert.equal(soundbankState(entry(), []), 'available');
  assert.equal(soundbankState(entry(), [job('queued')]), 'downloading');
  assert.equal(soundbankState(entry({ job_id: 'j' }), []), 'downloading', 'a job the list reports as live');
  assert.equal(soundbankState(entry(), [job('error')]), 'failed');
  assert.equal(soundbankState(entry(), [job('error'), job('done')]), 'installed');
  assert.equal(soundbankState(entry({ installed: ['C:/x.sf3'] }), [job('error')]), 'installed', 'a failed re-download keeps the installed bank');
  // Model jobs and other banks' jobs never move a row.
  assert.equal(soundbankState(entry(), [job('downloading', { kind: 'model' })]), 'available');
  assert.equal(soundbankState(entry(), [job('downloading', { name: 'sonatina-sf2' })]), 'available');
}

// Size line.
{
  const fmt = (n: number) => `${n}B`;
  assert.equal(soundbankSizeText(entry({ installed_bytes: 10, size_bytes: 99 }), fmt), '10B on disk');
  assert.equal(soundbankSizeText(entry({ size_bytes: 99 }), fmt), '99B');
  assert.equal(soundbankSizeText(entry({ kind: 'link' }), fmt), 'SFZ, on its own site');
  assert.equal(soundbankSizeText(entry(), fmt), 'size shown when published');
}

// Errors are worded for a download site, never for Hugging Face.
{
  const home = 'https://example.test/page';
  const unpublished = classifySoundbankError(
    "No published release of gantasmo/theDAW with a tag starting 'soundbank-orchestra' carries theDAW-Orchestra.sf3.",
    home,
  );
  assert.equal(unpublished.headline, 'Not published yet');
  assert.deepEqual(unpublished.links, [{ label: 'Open download page', url: home }]);
  assert.equal(classifySoundbankError('theDAW-Orchestra.sf3: SHA-256 does not match the published digest').headline, 'The download arrived damaged');
  assert.equal(classifySoundbankError('[Errno 28] No space left on device').kind, 'disk');
  assert.equal(classifySoundbankError('HTTP Error 404: Not Found', home).headline, 'The file has moved');
  const net = classifySoundbankError('<urlopen error [Errno 11001] getaddrinfo failed>');
  assert.equal(net.kind, 'network');
  assert.ok(!/hugging/i.test(net.headline + net.fix), net.headline);
  assert.equal(classifySoundbankError('HTTP Error 503: Service Unavailable').kind, 'network');
  assert.equal(classifySoundbankError('weird\nsecond line').fix, 'weird');
}

console.log('soundbankClient: ok');

// An installed bank's manifest registers its playback gains under the registry's id.
{
  const { selectionGainDb, clearSoundbankGains } = await import('./soundbankGain.ts');
  const { registerInstalledSoundbankGains } = await import('./soundbankClient.ts');
  const g = globalThis as unknown as { fetch: typeof fetch };
  const seen: string[] = [];
  g.fetch = (async (url: unknown) => {
    seen.push(String(url));
    if (String(url).includes('/sonatina-sf2/')) return new Response('{"detail":"none"}', { status: 404 });
    return new Response(JSON.stringify({ playback_gain: { '1:73': 9.5, '0:40': 0 } }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await registerInstalledSoundbankGains('thedaw-orchestra', 'orchestra', 0), 2);
  assert.equal(seen[0], '/api/models/soundbanks/thedaw-orchestra/manifest');
  assert.equal(selectionGainDb(1, 73), 9.5);
  assert.equal(await registerInstalledSoundbankGains('sonatina-sf2', 'sso', 0), 0);
  clearSoundbankGains();
  console.log('soundbankClient manifest: ok');
}
