/**
 * soundBankStore — the sound banks every picker lists and every synth loads:
 * the bundled General MIDI bank and the user's SF2, SF3 and DLS banks, which
 * the backend stores (backend/modules/soundfonts) at the paths it wrote.
 *
 * One store, read by every picker, so a bank added in one place is listed in
 * every picker at once, and soundfontEngine loads it into every live synth
 * when the list changes. The offsets the backend gave each bank go to
 * lib/bankRegistry, which turns a voice into the bank select a synth and a
 * MIDI file send; the last list is kept in the browser too, so a project
 * opened before the backend answers resolves its voices at the same offsets.
 *
 * A bank the download manager installed (SoundBank `downloadId`) carries
 * playback gains in its manifest: each listed one is registered with
 * lib/soundbankGain at its offset (lib/soundbankClient
 * fetchInstalledSoundbankManifest), and a bank that leaves the list takes its
 * gains with it. A bank the user added from a file with its build manifest
 * beside it (SoundBank `manifest`) has its gains registered the same way, from
 * the copy the backend kept. A sound bank download that finishes refreshes the list
 * (state/downloadStore), so the new bank is in every picker at once.
 */
import { create } from 'zustand';
import { delJson, getJson, postForm, postJson } from '../lib/apiJson';
import {
  BUNDLED_BANK_ID,
  bankFromBackend,
  setKnownBanks,
  type BackendBank,
  type BankPreset,
  type SoundBank,
} from '../lib/bankRegistry';
import { notifyPlacesChanged } from '../lib/placesClient';
import { fetchInstalledSoundbankManifest } from '../lib/soundbankClient';
import { registerSoundbankGains, setBundledKits, unregisterSoundbankGains, type SoundbankGainManifest } from '../lib/soundbankGain';
import { logError, logInfo, logWarn } from './logStore';

/** Where the bundled bank is served from (frontend/public). */
export const BUNDLED_BANK_URL = '/soundfonts/gm.sf3';
/** The file types a sound bank is. */
export const SOUND_BANK_EXTS = ['.sf2', '.sf3', '.dls'] as const;

const CACHE_KEY = 'thedaw.soundBanks.v1';

interface SoundBankState {
  /** The bundled bank first (once its presets are read), then the user's banks in the order added. */
  banks: SoundBank[];
  /** True once the backend's list arrived. */
  listed: boolean;
  /** An add or a remove in flight. */
  busy: boolean;
  /** The last failure, in words to show. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Upload a bank file the user picked. */
  addFile: (file: File) => Promise<SoundBank | null>;
  /** Add a bank from a path on this machine (a Recent pick). */
  addPath: (path: string) => Promise<SoundBank | null>;
  remove: (id: string) => Promise<boolean>;
  /** The bundled bank's presets, read by soundfontEngine from its bytes. */
  setBundledPresets: (name: string, presets: BankPreset[]) => void;
}

const userBanks = (banks: readonly SoundBank[]): SoundBank[] => banks.filter((b) => b.kind === 'user');

function readCache(): SoundBank[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CACHE_KEY) : null;
    if (!raw) return [];
    const list = JSON.parse(raw) as BackendBank[];
    return Array.isArray(list) ? list.map(bankFromBackend).filter((b): b is SoundBank => b !== null) : [];
  } catch {
    return [];
  }
}

function writeCache(banks: readonly SoundBank[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const list: BackendBank[] = userBanks(banks).map((b) => ({
      id: b.id,
      name: b.name,
      format: b.format,
      offset: b.offset,
      span: b.span,
      presets: b.presets.map((p) => ({ bank: p.bank, bank_lsb: p.bankLsb, program: p.program, name: p.name, drum: p.drum })),
      ...(b.downloadId ? { download_id: b.downloadId } : {}),
      ...(b.manifest ? { manifest: true } : {}),
    }));
    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: the next refresh lists them again */
  }
}

/** Put the user’s banks after the bundled one, and hand them (offset, span and presets) to the registry. */
function withUsers(state: readonly SoundBank[], users: readonly SoundBank[]): SoundBank[] {
  const bundled = state.filter((b) => b.kind === 'bundled');
  const next = [...bundled, ...users];
  setKnownBanks(next);
  return next;
}

/** Each downloaded bank whose playback gains are registered, as `downloadId@offset`. */
const gainsRegistered = new Map<string, string>();

/**
 * Register the playback gains of every downloaded bank in `banks` at its
 * offset (once per bank and offset), and drop the gains of a bank no longer
 * listed. A bank with no manifest registers none.
 */
export async function syncDownloadedBankGains(banks: readonly SoundBank[]): Promise<void> {
  const listed = new Set<string>();
  const waits: Promise<void>[] = [];
  for (const b of userBanks(banks)) {
    if (!b.downloadId && !b.manifest) continue;
    listed.add(b.id);
    const sig = `${b.downloadId ?? 'file'}@${b.offset}`;
    if (gainsRegistered.get(b.id) === sig) continue;
    gainsRegistered.set(b.id, sig);
    const { downloadId, id, offset, name } = b;
    const manifest = downloadId
      ? fetchInstalledSoundbankManifest(downloadId)
      : getJson<SoundbankGainManifest>(`/api/soundfonts/${encodeURIComponent(id)}/manifest`);
    // Registered only while the bank is still listed at this offset: one removed, or moved, while
    // its manifest was on its way takes no gains.
    const register = manifest.then((m) => (m && gainsRegistered.get(id) === sig ? registerSoundbankGains(id, m, offset) : 0));
    waits.push(
      register.then(
        (n) => {
          if (n > 0) logInfo('midi', `Sound bank "${name}": playback gains for ${n} presets`);
        },
        (e: unknown) => {
          // Asked again on the next list.
          gainsRegistered.delete(id);
          logWarn('midi', `Sound bank "${name}" plays without its playback gains: ${describe(e)}`);
        },
      ),
    );
  }
  for (const id of [...gainsRegistered.keys()]) {
    if (listed.has(id)) continue;
    gainsRegistered.delete(id);
    unregisterSoundbankGains(id);
  }
  await Promise.all(waits);
}

const cached = readCache();
setKnownBanks(cached);

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useSoundBankStore = create<SoundBankState>((set, get) => ({
  banks: cached,
  listed: false,
  busy: false,
  error: null,

  refresh: async () => {
    try {
      const data = await getJson<{ banks?: BackendBank[] }>('/api/soundfonts');
      const users = (data.banks ?? []).map(bankFromBackend).filter((b): b is SoundBank => b !== null);
      const banks = withUsers(get().banks, users);
      writeCache(banks);
      set({ banks, listed: true, error: null });
      await syncDownloadedBankGains(banks);
    } catch (e) {
      set({ listed: true, error: `Sound banks could not be listed: ${describe(e)}` });
    }
  },

  addFile: async (file) => {
    set({ busy: true, error: null });
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const data = await postForm<{ bank: BackendBank }>('/api/soundfonts/upload', form);
      const bank = bankFromBackend(data.bank);
      await get().refresh();
      notifyPlacesChanged();
      if (bank) logInfo('midi', `Sound bank "${bank.name}" added: ${bank.presets.length} presets from bank select ${bank.offset}`);
      return bank;
    } catch (e) {
      const msg = `Sound bank ${file.name} was not added: ${describe(e)}`;
      set({ error: msg });
      logError('midi', msg);
      return null;
    } finally {
      set({ busy: false });
    }
  },

  addPath: async (path) => {
    set({ busy: true, error: null });
    try {
      const data = await postJson<{ bank: BackendBank }>('/api/soundfonts/add-path', { path });
      const bank = bankFromBackend(data.bank);
      await get().refresh();
      notifyPlacesChanged();
      if (bank) logInfo('midi', `Sound bank "${bank.name}" added from ${path}`);
      return bank;
    } catch (e) {
      const msg = `Sound bank ${path} was not added: ${describe(e)}`;
      set({ error: msg });
      logError('midi', msg);
      return null;
    } finally {
      set({ busy: false });
    }
  },

  remove: async (id) => {
    if (id === BUNDLED_BANK_ID) return false;
    set({ busy: true, error: null });
    try {
      await delJson(`/api/soundfonts/${encodeURIComponent(id)}`);
      const gone = get().banks.find((b) => b.id === id);
      const banks = withUsers(get().banks, userBanks(get().banks).filter((b) => b.id !== id));
      writeCache(banks);
      set({ banks });
      logInfo(
        'midi',
        gone?.downloadId
          ? `Sound bank "${gone.name}" deleted from disk; download it again from Settings, Sound banks`
          : `Sound bank "${gone?.name ?? id}" removed`,
      );
      return true;
    } catch (e) {
      const msg = `Sound bank was not removed: ${describe(e)}`;
      set({ error: msg });
      logError('midi', msg);
      return false;
    } finally {
      set({ busy: false });
    }
  },

  setBundledPresets: (name, presets) => {
    // Its kits play on a drum channel ahead of any user bank's at the same program.
    setBundledKits(presets.filter((p) => p.drum).map((p) => p.program));
    const bundled: SoundBank = {
      id: BUNDLED_BANK_ID,
      name: name || 'General MIDI',
      kind: 'bundled',
      format: 'sf3',
      offset: 0,
      span: 128,
      presets,
      url: BUNDLED_BANK_URL,
    };
    set((s) => {
      const banks = [bundled, ...userBanks(s.banks)];
      setKnownBanks(banks);
      return { banks };
    });
  },
}));

// The gains follow the list: a removed bank's go, and a cached downloaded bank's are
// registered from the first list on, so a render before any picker opens has them.
useSoundBankStore.subscribe((s, prev) => {
  if (s.banks !== prev.banks) void syncDownloadedBankGains(s.banks);
});
if (cached.some((b) => b.downloadId)) void syncDownloadedBankGains(cached);

/** The user's banks the store lists now. */
export const listedUserBanks = (): SoundBank[] => userBanks(useSoundBankStore.getState().banks);
