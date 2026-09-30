/**
 * Batch-12 T16 fix (FE-014): a stack's media `url` (SlidePanel.tsx:267,
 * `assignMedia`) is a `blob:` object URL, and `stacks` is persisted
 * (slideStore.ts partialize). `URL.createObjectURL` results are scoped to the
 * page/session that created them — after a reload the persisted `blob:` URL
 * no longer resolves to anything, so `loadStackMedia` silently posts a dead
 * URL into the VJ.
 *
 * `resolveStaleStackMedia` is the pure decision behind the fix: given the
 * stacks as persisted, the media bucket's live blobs (which DO survive
 * reload — they're re-hydrated from IndexedDB, see mediaBucketStore.ts), and
 * the set of blob URLs actually created THIS session, decide which stacks
 * need a freshly-minted object URL derived from their `entryId`. The
 * component wires this to `URL.createObjectURL` and `updateStack`; the test
 * injects a fake `createObjectUrl` so no real Blob/URL API is required.
 *
 * SlidePanel.tsx has a top-level `import './track-controls.css'` — plain
 * Node has no CSS loader, so this file registers a tiny loader hook that
 * turns any `.css` import into an empty module before dynamically importing
 * SlidePanel.tsx. (Verified against the Node.js `module.register()` /
 * customization-hooks docs before use, per this project's API-verification
 * rule.) The hook must be registered before the import — hence the dynamic
 * `await import()` instead of a static `import` at the top of this file.
 *
 * Also covers two audit follow-ups:
 *   - releaseStackMedia (MINOR #5) — deleting a stack used to leave its
 *     object URL un-revoked and still in liveStackMediaUrls (a leak, and a
 *     landmine: if a later stack ever reused that same URL string the set
 *     would think it's still "live").
 *   - runStackMediaRefresh (MINOR #6) — the stale-media-refresh effect closed
 *     over the `stacks` array from its own render's selector. Under
 *     StrictMode (dev), React invokes an effect's setup twice against the
 *     SAME pre-effect snapshot; the first invocation's `updateStack` call
 *     lands in the store synchronously, but the second invocation's closure
 *     still held the OLD array, saw the same "stale" media again, and
 *     minted a SECOND object URL that immediately became an orphan (the
 *     store only kept the second one; the first was never revoked). Reading
 *     `useSlideStore.getState().stacks` fresh on every invocation instead of
 *     a closed-over value fixes this — modeled here via a `getStacks()`
 *     callback so it's testable without React/StrictMode.
 *
 * Run: `npx tsx src/components/layout/SlidePanel.b12.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { StackBinding, StackMedia } from '../../state/slideStore.ts';
import type { BucketItem } from '../../state/mediaBucketStore.ts';

const cssStubHook = `
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(cssStubHook)}`, import.meta.url);

const { resolveStaleStackMedia, releaseStackMedia, runStackMediaRefresh } = (await import('./SlidePanel.tsx')) as {
  resolveStaleStackMedia: typeof import('./SlidePanel.tsx').resolveStaleStackMedia;
  releaseStackMedia: typeof import('./SlidePanel.tsx').releaseStackMedia;
  runStackMediaRefresh: typeof import('./SlidePanel.tsx').runStackMediaRefresh;
};

const fakeBlob = (tag: string) => ({ __tag: tag } as unknown as Blob);
const bucket: BucketItem[] = [
  { id: 'entry-1', name: 'clip.mp4', blob: fakeBlob('clip.mp4'), mimeType: 'video/mp4', size: 10, addedAt: 1 },
];

const makeCreateUrl = () => {
  let n = 0;
  const calls: Blob[] = [];
  const fn = (blob: Blob) => {
    calls.push(blob);
    n += 1;
    return `blob:fresh-${n}`;
  };
  return { fn, calls };
};

function main(): void {
  /* 1. A stack whose blob: URL was NOT created this session (a dead URL from a
        previous reload) is refreshed from the bucket via its entryId. */
  {
    const stacks: StackBinding[] = [
      { id: 'stack-1', name: 'Bloom', media: { kind: 'video', url: 'blob:stale-abc', label: 'clip.mp4', entryId: 'entry-1' }, targets: [] },
    ];
    const { fn: createObjectUrl, calls } = makeCreateUrl();
    const updates = resolveStaleStackMedia(stacks, bucket, new Set(), createObjectUrl);
    assert.equal(updates.length, 1, 'one stack needed a refresh');
    assert.equal(updates[0].id, 'stack-1');
    assert.equal(updates[0].media.url, 'blob:fresh-1', 'gets a URL created THIS session');
    assert.equal(updates[0].media.entryId, 'entry-1', 'entryId is preserved');
    assert.equal(updates[0].media.label, 'clip.mp4', 'label is preserved');
    assert.equal(calls.length, 1, 'createObjectUrl was called exactly once');
    assert.equal(calls[0], bucket[0].blob, "created from the bucket item's own blob");
  }

  /* 2. A stack whose URL IS in the live set (created this session, e.g. the user
        just picked new media) is left alone — no needless re-creation/leak. */
  {
    const stacks: StackBinding[] = [
      { id: 'stack-2', name: 'Glitch', media: { kind: 'image', url: 'blob:live-1', label: 'still.png', entryId: 'entry-1' }, targets: [] },
    ];
    const { fn: createObjectUrl, calls } = makeCreateUrl();
    const updates = resolveStaleStackMedia(stacks, bucket, new Set(['blob:live-1']), createObjectUrl);
    assert.equal(updates.length, 0, 'a live URL is not touched');
    assert.equal(calls.length, 0, 'no new object URL created');
  }

  /* 3. No media at all: nothing to do. */
  {
    const stacks: StackBinding[] = [{ id: 'stack-3', name: 'Empty', media: null, targets: [] }];
    const updates = resolveStaleStackMedia(stacks, bucket, new Set(), makeCreateUrl().fn);
    assert.equal(updates.length, 0, 'a stack with no media is skipped');
  }

  /* 4. A stale URL whose entryId no longer exists in the bucket (the source
        media was removed/never survived reload): CLEARS the stack's media
        (shows nothing) rather than keeping a dead URL around forever
        (2nd audit follow-up, MINOR #5 — used to silently leave it). */
  {
    const stacks: StackBinding[] = [
      { id: 'stack-4', name: 'Gone', media: { kind: 'video', url: 'blob:stale-gone', label: 'deleted.mp4', entryId: 'entry-missing' }, targets: [] },
    ];
    const { fn: createObjectUrl, calls } = makeCreateUrl();
    const updates = resolveStaleStackMedia(stacks, bucket, new Set(), createObjectUrl);
    assert.equal(updates.length, 1, 'no bucket match: the dead media is cleared (THE BUG: used to leave it)');
    assert.equal(updates[0].id, 'stack-4');
    assert.equal(updates[0].media, null, 'media is cleared to null, not left as a dead blob: URL');
    assert.equal(calls.length, 0, 'no object URL is created for a clear');
  }

  /* 5. Media with no entryId at all (legacy/pre-fix data): also left alone. */
  {
    const stacks: StackBinding[] = [
      { id: 'stack-5', name: 'Legacy', media: { kind: 'video', url: 'blob:stale-legacy', label: 'old.mp4' }, targets: [] },
    ];
    const updates = resolveStaleStackMedia(stacks, bucket, new Set(), makeCreateUrl().fn);
    assert.equal(updates.length, 0, 'no entryId: cannot recover, left as-is');
  }

  /* 6. A non-blob URL (e.g. already a persistent http(s) URL) is never touched. */
  {
    const stacks: StackBinding[] = [
      { id: 'stack-6', name: 'Remote', media: { kind: 'video', url: 'https://example.com/clip.mp4', label: 'clip.mp4', entryId: 'entry-1' }, targets: [] },
    ];
    const updates = resolveStaleStackMedia(stacks, bucket, new Set(), makeCreateUrl().fn);
    assert.equal(updates.length, 0, 'non-blob URLs are left alone');
  }

  /* ------------------------------ releaseStackMedia (audit #5) ------------------------------ */

  /* 7. Deleting a stack with media revokes its URL and drops it from the live set. */
  {
    const liveUrls = new Set<string>(['blob:live-del-1']);
    const revoked: string[] = [];
    releaseStackMedia({ kind: 'video', url: 'blob:live-del-1', label: 'clip.mp4', entryId: 'entry-1' }, liveUrls, (u) => revoked.push(u));
    assert.deepEqual(revoked, ['blob:live-del-1'], 'the media URL was revoked');
    assert.equal(liveUrls.has('blob:live-del-1'), false, 'removed from the live set so it can never be mistaken for still-live');
  }

  /* 8. No media / no url: no-op, never crashes. */
  {
    const liveUrls = new Set<string>();
    const revoked: string[] = [];
    releaseStackMedia(null, liveUrls, (u) => revoked.push(u));
    releaseStackMedia(undefined, liveUrls, (u) => revoked.push(u));
    releaseStackMedia({ kind: 'video', url: '', label: 'x' }, liveUrls, (u) => revoked.push(u));
    assert.equal(revoked.length, 0, 'nothing to revoke');
  }

  /* ------------------------------ runStackMediaRefresh (audit #6) ------------------------------ */

  /* 9. StrictMode double-invoke: the SECOND invocation must see the store update the
        FIRST invocation already applied, not a stale pre-effect snapshot — otherwise it
        re-derives a second, orphaned object URL for the same stack. */
  {
    const store = {
      stacks: [
        { id: 'stack-9', name: 'Bloom', media: { kind: 'video' as const, url: 'blob:stale-strict', label: 'clip.mp4', entryId: 'entry-1' }, targets: [] },
      ] as StackBinding[],
    };
    const liveUrls = new Set<string>();
    const { fn: rawCreateObjectUrl, calls } = makeCreateUrl();
    // Mirrors the component's real callback: every newly-minted URL is
    // registered as live immediately, not just returned.
    const createObjectUrl = (blob: Blob) => {
      const url = rawCreateObjectUrl(blob);
      liveUrls.add(url);
      return url;
    };
    const applied: Array<{ id: string; media: StackMedia | null }> = [];
    const applyUpdate = (id: string, media: StackMedia | null) => {
      applied.push({ id, media });
      // Mirrors zustand's synchronous `set()`: the store reflects the change
      // immediately, before the next (StrictMode) invocation runs.
      store.stacks = store.stacks.map((s) => (s.id === id ? { ...s, media } : s));
    };
    const getStacks = () => store.stacks;

    // Invocation 1 (React's real "setup").
    runStackMediaRefresh(getStacks, bucket, liveUrls, createObjectUrl, applyUpdate);
    // Invocation 2 (StrictMode's synthetic extra "setup", same commit).
    runStackMediaRefresh(getStacks, bucket, liveUrls, createObjectUrl, applyUpdate);

    assert.equal(calls.length, 1, 'only ONE object URL was ever minted across both invocations (THE BUG minted two)');
    assert.equal(applied.length, 1, 'updateStack was only called once');
    assert.equal(store.stacks[0].media?.url, 'blob:fresh-1', 'the store ends up with the single fresh URL');
  }

  console.log('SlidePanel.b12.test.ts: all assertions passed');
}

main();
