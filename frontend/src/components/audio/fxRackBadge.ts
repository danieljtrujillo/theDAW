/**
 * The short pill text and full-sentence label for the FX rack's live VST
 * status badge (see `vstLiveBadge` in FxRack.tsx).
 *
 * That badge used to put a whole explanatory sentence inside the small pill
 * itself — e.g. "LIVE · saved settings could not be loaded — <reason>" — which
 * reads fine as a tooltip but is a wall of text at pill size (review finding:
 * a whole sentence sits inside a small pill in the FX rack). This module owns
 * the split: a short `text` for the pill, and a full-sentence `label` for its
 * `aria-label`/`title`, so shortening the pill never costs assistive tech the
 * explanation.
 *
 * Pure: it takes only the status and a defaults flag, nothing entry-specific
 * (latency, plugin name, host reason), so it is trivial to test standalone.
 */

import type { VstLiveStatus } from '../../state/vstLiveStore';

export interface LiveBadge {
  /** What the pill itself shows. Always short — never a full sentence. */
  text: string;
  /** A full-sentence explanation of what `text` means. */
  label: string;
}

/**
 * `status` is the entry's live session status (`live?.status ?? 'off'`).
 * `usingDefaults` is true only while `status` is `'live'` and the host could
 * not restore the entry's saved state, so the plugin is processing at its
 * factory defaults instead (`stateOrigin === 'state-rejected'`); every other
 * status ignores it.
 */
export function liveBadge(status: VstLiveStatus, usingDefaults: boolean): LiveBadge {
  if (status === 'live') {
    return usingDefaults
      ? {
          text: 'LIVE · DEFAULTS',
          label:
            'Live, but running at its factory defaults — the host could not restore this plugin’s saved settings.',
        }
      : {
          text: 'LIVE',
          label: 'Live: the plugin is processing this signal in real time.',
        };
  }
  if (status === 'starting') {
    return {
      text: 'starting…',
      label: 'Opening the plugin host — the signal passes through untouched until it is ready.',
    };
  }
  if (status === 'error') {
    return {
      text: 'error',
      label: 'The plugin host stopped — the signal passes through untouched while it reconnects.',
    };
  }
  // 'off' and 'unavailable' are the same thing to a listener: the plugin only
  // prints at freeze/bounce.
  return {
    text: 'render-only',
    label: 'This plugin applies at freeze/bounce, not live.',
  };
}
