// The "New pairing link" button in Mobile Access (components/layout/Shell.tsx).
//
// POST /api/pairing/token/regenerate replaces the LAN pairing token
// (backend/lib/pairing.py), so every link handed out before stops working and
// every device already paired is un-paired. Hence two clicks: the first arms
// the button for REVOKE_ARM_MS, the second makes the new token. The Share URL,
// its QR code and the companion link all read the adopted token, so they switch
// to it at once. Kept free of React so the whole sequence runs in a test.

export type RevokeState = 'idle' | 'busy' | 'done' | 'failed';

/** How long the first click keeps the button armed. */
export const REVOKE_ARM_MS = 4000;

export const REGENERATE_URL = '/api/pairing/token/regenerate';

export interface RevokeClick {
  /** Whether the button is armed right now (the render's value). */
  armed: boolean;
  /** The request state right now; a click while busy does nothing. */
  state: RevokeState;
  setArmed: (armed: boolean) => void;
  setState: (state: RevokeState) => void;
  /** Takes the new token; the links and QR codes are built from it. */
  adoptToken: (token: string) => void;
  fetchImpl?: typeof fetch;
}

/** One click on the button. Unarmed: arm it and ask nothing of the backend.
 *  Armed: disarm, POST the regenerate route, adopt the token it answers with
 *  ('done'), or leave the old token in place ('failed'). */
export async function clickNewPairingLink(click: RevokeClick): Promise<void> {
  if (click.state === 'busy') return;
  if (!click.armed) {
    click.setArmed(true);
    return;
  }
  click.setArmed(false);
  click.setState('busy');
  const doFetch = click.fetchImpl ?? fetch;
  try {
    const r = await doFetch(REGENERATE_URL, { method: 'POST' });
    const j = r.ok ? ((await r.json()) as { token?: unknown }) : null;
    if (j && typeof j.token === 'string' && j.token) {
      click.adoptToken(j.token);
      click.setState('done');
    } else {
      click.setState('failed');
    }
  } catch {
    click.setState('failed');
  }
}

/** While armed, disarm after REVOKE_ARM_MS. Returns the cleanup that cancels
 *  the pending disarm (a re-render, the second click, the dialog closing). */
export function scheduleDisarm(
  armed: boolean,
  setArmed: (armed: boolean) => void,
  setTimer: (fn: () => void, ms: number) => number = (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle: number) => void = (handle) => window.clearTimeout(handle),
): () => void {
  if (!armed) return () => {};
  const handle = setTimer(() => setArmed(false), REVOKE_ARM_MS);
  return () => clearTimer(handle);
}
