// One-time migration of persisted browser storage to the current key namespace.
// Earlier builds wrote some keys under a legacy prefix; this copies any such
// values to the current keys and drops the stale ones, so no local data
// (saved prompts, API keys, effect chains, settings, media-bucket metadata) is
// lost across the rename. Idempotent — a sentinel guards it so it runs once.

const DONE = 'thedaw.brandMigrated.v1';

// Exact key renames in localStorage.
const RENAMES: Record<string, string> = {
  'stabledaw-prompt-library': 'thedaw-prompt-library',
  'stabledaw-effect-chain': 'thedaw-effect-chain',
  'stabledaw-controller-map-v1': 'thedaw-controller-map-v1',
  'stabledaw-learned-profiles-v1': 'thedaw-learned-profiles-v1',
  'stabledaw-feature-settings': 'thedaw-feature-settings',
  'stabledaw-app-ui': 'thedaw-app-ui',
  'stabledaw-bottom-panel-v4': 'thedaw-bottom-panel-v4',
  'stabledaw-slide-v1': 'thedaw-slide-v1',
  'stabledaw.templates': 'thedaw.templates',
  'stabledaw.shareUrlOverride': 'thedaw.shareUrlOverride',
  'stabledaw.mediaBucket.meta.v1': 'thedaw.mediaBucket.meta.v1',
  'stabledaw_orb_api_keys': 'thedaw_orb_api_keys',
};

export function migrateBrandKeys(): void {
  try {
    if (localStorage.getItem(DONE)) return;

    // Exact renames: copy only when the new key is absent (never clobber newer
    // data), but always drop the stale legacy key.
    for (const [oldKey, newKey] of Object.entries(RENAMES)) {
      const v = localStorage.getItem(oldKey);
      if (v !== null) {
        if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, v);
        localStorage.removeItem(oldKey);
      }
    }

    // Prefix sweeps: legacy "<prefix>.savedPrompts.*" and "<prefix>:*" keys.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('stabledaw.savedPrompts.') || k.startsWith('stabledaw:'))) {
        const nk = 'thedaw' + k.slice('stabledaw'.length);
        const v = localStorage.getItem(k);
        if (v !== null && localStorage.getItem(nk) === null) localStorage.setItem(nk, v);
        localStorage.removeItem(k);
      }
    }

    // sessionStorage (assistant conversation id).
    const sid = sessionStorage.getItem('stabledaw:conversationId');
    if (sid && !sessionStorage.getItem('thedaw:conversationId')) {
      sessionStorage.setItem('thedaw:conversationId', sid);
    }
    sessionStorage.removeItem('stabledaw:conversationId');

    localStorage.setItem(DONE, '1');
  } catch {
    // Storage unavailable (private mode / disabled) — non-fatal.
  }
}
