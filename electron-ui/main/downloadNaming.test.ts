// Run with: npx tsx electron-ui/main/downloadNaming.test.ts
//
// Pure logic behind item 4's auto-download fix (no Electron import — this
// runs under plain Node/tsx, unlike main/index.ts which needs the electron
// package installed).
//   - uniqueDownloadPath never overwrites an existing file, and falls back to
//     a timestamp suffix rather than handing back a still-colliding path
//     when every numbered variant is also taken.
//   - AutoDownloadClaims is the "these exact filenames are about to be
//     automatic downloads" claim the renderer's IPC call and watchDownloads'
//     will-download handler share: a name match claims, a non-match (an
//     ordinary user download) does not, an expired claim does not, and the
//     claim set cannot grow without bound.
import assert from 'node:assert/strict';
import path from 'node:path';
import { AutoDownloadClaims, uniqueDownloadPath } from './downloadNaming.ts';

// ── uniqueDownloadPath ────────────────────────────────────────────────────
{
  const dir = 'C:\\Users\\test\\Downloads';
  // Nothing there yet: the plain name.
  assert.equal(uniqueDownloadPath(dir, 'take.wav', () => false), path.join(dir, 'take.wav'));

  // The plain name exists, "(1)" does not: picks "(1)".
  const takenOnce = new Set([path.join(dir, 'take.wav')]);
  assert.equal(uniqueDownloadPath(dir, 'take.wav', (p) => takenOnce.has(p)), path.join(dir, 'take (1).wav'));

  // The plain name AND "(1)" both exist: picks "(2)".
  const takenTwice = new Set([path.join(dir, 'take.wav'), path.join(dir, 'take (1).wav')]);
  assert.equal(uniqueDownloadPath(dir, 'take.wav', (p) => takenTwice.has(p)), path.join(dir, 'take (2).wav'));

  // The extension survives the "(N)" insertion — it goes before the dot, not after.
  assert.equal(uniqueDownloadPath(dir, 'd1_00.wav', (p) => p === path.join(dir, 'd1_00.wav')), path.join(dir, 'd1_00 (1).wav'));

  // A filename with no extension (defensive: the backend always sends one, but
  // the naming logic must not throw on one that doesn't).
  assert.equal(uniqueDownloadPath(dir, 'take', () => false), path.join(dir, 'take'));
  const takenNoExt = new Set([path.join(dir, 'take')]);
  assert.equal(uniqueDownloadPath(dir, 'take', (p) => takenNoExt.has(p)), path.join(dir, 'take (1)'));

  // Every numbered variant is also taken: falls back to a timestamp suffix
  // rather than returning a path that STILL exists (which setSavePath would
  // silently overwrite) — never hangs, and never claims false uniqueness.
  const t0 = Date.now();
  const stuck = uniqueDownloadPath(dir, 'stuck.wav', () => true, () => 1234567890);
  assert.ok(Date.now() - t0 < 2000, 'uniqueDownloadPath must not hang');
  assert.equal(stuck, path.join(dir, 'stuck.1234567890.wav'), 'falls back to a timestamp suffix, not a still-colliding numbered path');
}

// ── AutoDownloadClaims ────────────────────────────────────────────────────
{
  let clock = 0;
  const now = () => clock;
  const claims = new AutoDownloadClaims(5000, now);

  assert.equal(claims.size, 0, 'starts empty: downloads keep the dialog by default');
  assert.equal(claims.claim('a.wav'), false, 'nothing marked yet — the dialog stays');

  // A name match claims; a non-match (an ordinary, unrelated user download)
  // does not — this is the whole point of the fix over a bare count.
  claims.mark(['a.wav', 'b.wav']);
  assert.equal(claims.size, 2);
  assert.equal(claims.claim('unrelated-user-download.pdf'), false, 'a non-matching filename never claims');
  assert.equal(claims.size, 2, 'a non-match does not consume anything');
  assert.equal(claims.claim('a.wav'), true, 'a matching filename claims');
  assert.equal(claims.size, 1);
  assert.equal(claims.claim('a.wav'), false, 'consumed once — a second will-download for the same name is not auto');
  assert.equal(claims.claim('b.wav'), true);
  assert.equal(claims.size, 0);

  // An expired mark does not claim, and is swept out (bounded growth) even
  // though nothing ever consumed it — the leak the count-only design had.
  claims.mark(['c.wav']);
  assert.equal(claims.size, 1);
  clock += 5001; // past the 5s TTL
  assert.equal(claims.claim('c.wav'), false, 'an expired mark does not claim — falls back to the dialog');
  assert.equal(claims.size, 0, 'the expired entry was swept, not left to leak forever');

  // A steady trickle of small batches, most never claimed (e.g. every CREATE
  // this session had autoDownload on but the user closed the app before any
  // will-download fired) does not grow the claim set without bound: only
  // entries younger than the TTL are ever counted.
  clock = 0;
  for (let batch = 0; batch < 50; batch += 1) {
    claims.mark([`batch-${batch}-take.wav`]);
    clock += 200; // 200ms between batches — well under the 5s TTL at first
  }
  // 50 batches * 200ms = 10s of elapsed time against a 5s TTL: only the
  // second half (younger than 5s old) can still be present.
  assert.ok(claims.size <= 26, `claim set stayed bounded by the TTL, not by how many batches ever ran (size=${claims.size})`);

  // Marking the SAME name twice does not grow the set either (it overwrites,
  // refreshing the expiry rather than adding a duplicate entry).
  const fresh = new AutoDownloadClaims(5000, now);
  fresh.mark(['same.wav']);
  fresh.mark(['same.wav']);
  fresh.mark(['same.wav']);
  assert.equal(fresh.size, 1);

  // A non-string / empty entry in the names array is ignored rather than
  // corrupting the claim set (defensive: this crosses an IPC boundary).
  const defensive = new AutoDownloadClaims(5000, now);
  defensive.mark(['ok.wav', '', ...([null, undefined, 42] as unknown as string[])]);
  assert.equal(defensive.size, 1);
  assert.equal(defensive.claim('ok.wav'), true);
}

console.log('downloadNaming: unique path fallback + per-download claim contract passed');
