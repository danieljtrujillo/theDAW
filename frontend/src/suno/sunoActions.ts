/**
 * sunoActions — the integration seam between library tracks and the Suno panel.
 *
 * Cross-platform direction is ONE-WAY: only Suno-origin tracks (model === 'suno')
 * can seed a Suno cover/mashup, because only they own a Suno clip id. Sending a
 * Suno track INTO the local Stable Audio init/inpaint/editor is the OTHER
 * direction and is handled by the normal library "send" buttons (there a Suno
 * track is just audio).
 *
 * CHANGED from the old StableDAW:
 *   - Source check is `entry.model === 'suno'` (LibraryEntry has no `provider`).
 *   - The "Suno clip id" for a library entry is stored in its tags as
 *     `sunoid:<id>`; we parse that, falling back to `entry.id`.
 *   - Revealing the panel uses the center-tab nav (`setCenterTab('make')`) +
 *     `generateParamsStore.patch({ model: 'suno' })`. There is no
 *     `stabledaw:open-suno` event and no GlobalGenerateBar anymore.
 */

import { useSunoStore } from './sunoStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useAppUiStore } from '../state/appUiStore';

/** Loose shape — accepts any library-ish entry without importing the full type. */
type SunoSourceEntry = { id: string; model: string; tags?: string[] };

/**
 * Extract the Suno clip id from a library entry. Suno tracks carry their clip
 * id in tags as `sunoid:<id>`; if missing we fall back to the entry id (which
 * for Suno-registered tracks is typically the clip id anyway).
 */
const sunoClipId = (entry: SunoSourceEntry): string => {
  const tag = (entry.tags ?? []).find((t) => t.startsWith('sunoid:'));
  return tag ? tag.slice('sunoid:'.length) : entry.id;
};

/** Switch the workspace to the Make tab and select the Suno model → reveals the panel. */
const openSunoPanel = (): void => {
  useGenerateParamsStore.getState().patch({ model: 'suno' });
  useAppUiStore.getState().setCenterTab('make');
};

export const sunoActions = {
  /** Only Suno-origin tracks can seed a Suno cover/mashup. */
  canUseAsSunoSource: (entry: SunoSourceEntry): boolean => entry.model === 'suno',

  /** Prefill the Cover form with this track's Suno clip id, then reveal the panel. */
  sendToCover: (entry: SunoSourceEntry): void => {
    if (entry.model !== 'suno') return;
    useSunoStore.getState().prefillCover(sunoClipId(entry));
    openSunoPanel();
  },

  /** Prefill the Mashup form's base clip with this track's Suno clip id, then reveal the panel. */
  sendToMashup: (entry: SunoSourceEntry): void => {
    if (entry.model !== 'suno') return;
    useSunoStore.getState().prefillMashup(sunoClipId(entry));
    openSunoPanel();
  },
};
