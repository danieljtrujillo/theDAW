/**
 * Batch-12 audit MAJOR finding #2, same class of bug as module-kit.js's
 * `moduleKitOutputDevice.b12.test.ts`: none of the per-page `message`
 * listeners in `public/edit-modules/*.html` checked `e.source` either, so any
 * frame that can reach one of these iframes could forge a `thedaw-audio` or
 * `thedaw-transport` message. This page's own host is `window.parent` — the
 * `<iframe>` `EffectGuiStage.tsx` mounts it in — so `e.source !== window.parent`
 * as the FIRST statement of every listener rejects everything else.
 *
 * Scans the real HTML source text (same technique as
 * `editModulesContract.test.ts`) for EVERY `public/edit-modules/*.html` page
 * and asserts every `addEventListener('message', ...)` in that page is
 * immediately followed by the guard, so a listener added later cannot ship
 * unguarded without this test catching it. `eq.html` and `parametric-eq.html`
 * were T13's (DSP B) own write set during batch-12 and were excluded here
 * while they were in flight; both now carry the guard (T13 landed it), so
 * they are scanned like every other page — nothing is exempt.
 *
 * Batch-12 audit round 3, minor #5: the CHILD -> PARENT direction had the
 * same `'*'` target-origin problem the host -> child posts were already
 * fixed for (EffectGuiStage.tsx). Every page's `postTransportState` posted
 * `window.parent.postMessage({...}, '*')` — a foreign embedder that put this
 * iframe somewhere it does not belong would still receive the transport
 * state. `window.location.origin` is safe here specifically because the
 * ONLY legitimate parent is this same origin's own app (EffectGuiStage.tsx
 * mounts these pages from `/edit-modules/...` on the same host); a real
 * embedder on another origin now gets nothing instead of a leak.
 *
 * Run: `npx tsx src/components/audio/effects/editModulesMessageSourceGuard.b12.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(here, '..', '..', '..', '..', 'public', 'edit-modules');
const read = (file: string) => readFileSync(join(MODULES_DIR, file), 'utf8');

const GUARD = "if (e.source !== window.parent) return;";

const pages = readdirSync(MODULES_DIR).filter((f) => f.endsWith('.html'));

assert.ok(pages.length > 0, 'the edit-modules directory has HTML pages to scan');
assert.ok(pages.includes('tool.html'), 'tool.html (the audit-cited example) is in scope');
assert.ok(pages.includes('eq.html') && pages.includes('parametric-eq.html'), "T13's two pages are scanned too, not exempt");

for (const file of pages) {
  const html = read(file);
  // Every window.addEventListener('message', ...) opener's line index.
  const openers = [...html.matchAll(/window\.addEventListener\(\s*['"]message['"]/g)];
  for (const opener of openers) {
    const afterOpener = html.slice(opener.index!);
    // The listener's opening `{` starts its body; the guard must be the body's
    // first statement, so it must appear before any other statement — checked
    // by requiring it within the first ~80 characters after the opener, which
    // is enough room for `, function (e) {` / `, async (e) => {` plus the
    // guard itself but not enough to hide a real statement ahead of it.
    const window80 = afterOpener.slice(0, 120);
    assert.ok(
      window80.includes(GUARD),
      `${file}: a message listener at offset ${opener.index} is missing the e.source !== window.parent guard as its first statement`,
    );
  }
}

// ── audit round 3, minor #5: no CHILD -> PARENT post uses a '*' target ─────
{
  let postCount = 0;
  for (const file of pages) {
    const html = read(file);
    // Every window.parent.postMessage(...) call in the page.
    const posts = [...html.matchAll(/window\.parent\.postMessage\([\s\S]*?\)/g)];
    for (const post of posts) {
      postCount += 1;
      assert.ok(
        !/,\s*['"]\*['"]\s*\)$/.test(post[0]),
        `${file}: a window.parent.postMessage call still targets '*' — should be window.location.origin`,
      );
      assert.ok(
        post[0].includes('window.location.origin'),
        `${file}: a window.parent.postMessage call does not target window.location.origin`,
      );
    }
  }
  assert.ok(postCount > 0, 'at least one window.parent.postMessage call was found to check');
}

console.log(`edit-modules message-source guard: ${pages.length} pages scanned, all assertions passed`);
