/**
 * The shared IndexedDB connection (T18 audit MINOR 8, third audit MAJOR 4 and
 * MINOR 7/9).
 *
 * Every call used to open its own connection. Two puts for one entry were
 * then two transactions on two connections, and nothing orders them: the
 * older capture could commit last and win. One shared connection puts every
 * transaction in creation order.
 *
 * Which means the cached connection must be dropped ONLY when it is really
 * gone. Dropping it on any error (an ordinary request failure, a quota error)
 * threw the ordering guarantee away again, and dropping it without checking
 * identity could discard a connection another caller had just opened.
 *
 * Run: npx tsx src/lib/vstStateStorage.connection.test.ts
 */
import assert from 'node:assert/strict';
import { FakeIdb } from '../state/effectChainStore.fakeIdb.ts';

const idb = new FakeIdb();
idb.install();

const { putVstRawState, getVstRawState, deleteVstRawState, listVstRawStateIds } = await import('./vstStateStorage.ts');

/* ── one connection for every operation ───────────────────────────────────── */
{
  await putVstRawState('e1', 'ONE', 'thedaw');
  await putVstRawState('e1', 'TWO', 'thedaw');
  await getVstRawState('e1');
  await listVstRawStateIds();
  await deleteVstRawState('e1');
  assert.equal(idb.opens, 1, `every operation shares one connection, got ${idb.opens} opens`);
  assert.equal(idb.closes, 0, 'and it is not closed between operations');
}

/* ── writes land in the order they were made ──────────────────────────────── */
{
  const first = putVstRawState('e2', 'OLDER', 'thedaw');
  const second = putVstRawState('e2', 'NEWER', 'thedaw');
  await Promise.all([first, second]);
  assert.deepEqual(idb.data.get('e2'), { rawState: 'NEWER', stateHost: 'thedaw' });
  assert.deepEqual(
    idb.ops.filter((o) => o === 'put:e2'),
    ['put:e2', 'put:e2'],
  );
}

/* ── an ordinary request failure KEEPS the connection (the ordering
   guarantee is not thrown away over a quota error) ──────────────────────── */
{
  const opensBefore = idb.opens;
  idb.failPuts = new DOMException('quota', 'QuotaExceededError');
  await assert.rejects(putVstRawState('e3', 'TOO-BIG', 'thedaw'));
  idb.failPuts = null;
  await putVstRawState('e3', 'FITS', 'thedaw');
  assert.equal(idb.opens, opensBefore, 'the healthy connection was reused');
  assert.deepEqual(idb.data.get('e3'), { rawState: 'FITS', stateHost: 'thedaw' });
}

/* ── a connection that is really gone IS dropped: the next call reopens ──── */
{
  const opensBefore = idb.opens;
  idb.throwOnTransaction = new DOMException('closed', 'InvalidStateError');
  await assert.rejects(getVstRawState('e3'));
  idb.throwOnTransaction = null;
  await getVstRawState('e3');
  assert.equal(idb.opens, opensBefore + 1, 'a closed connection is replaced, once');
}

/* ── the browser telling us the connection is gone drops the cache too ───── */
{
  const opensBefore = idb.opens;
  idb.dbHandles[idb.dbHandles.length - 1].onclose?.({} as Event);
  await getVstRawState('e3');
  assert.equal(idb.opens, opensBefore + 1, 'onclose invalidates the cached connection');

  const beforeVersionChange = idb.opens;
  const closesBefore = idb.closes;
  idb.dbHandles[idb.dbHandles.length - 1].onversionchange?.({} as Event);
  assert.equal(idb.closes, closesBefore + 1, 'onversionchange closes our connection');
  await getVstRawState('e3');
  assert.equal(idb.opens, beforeVersionChange + 1, 'and the next call opens a new one');
}

/* ── a failed open is not cached: the next call tries again ───────────────── */
{
  idb.dbHandles[idb.dbHandles.length - 1].onclose?.({} as Event);
  idb.failOpen = new Error('open failed');
  await assert.rejects(getVstRawState('e3'));
  idb.failOpen = null;
  const value = await getVstRawState('e3');
  assert.ok(value, 'the retry after a failed open works');
}

/* ── a blocked open does not leak the connection it gets afterwards
   (MINOR 7): the blocking tab closes, the open succeeds, and nobody is
   holding that handle — so it is closed ─────────────────────────────────── */
{
  idb.dbHandles[idb.dbHandles.length - 1].onclose?.({} as Event);
  const closesBefore = idb.closes;
  idb.blockOpen = true;
  idb.openAfterBlocked = true;
  await assert.rejects(getVstRawState('e3'), /blocked/i);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(idb.closes, closesBefore + 1, 'the untracked connection was closed');
  idb.blockOpen = false;
  idb.openAfterBlocked = false;
}

console.log('vstStateStorage.connection: ok');
