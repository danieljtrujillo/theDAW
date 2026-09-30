/**
 * bankRegistry — the sound banks a MIDI voice can come from, and how a preset
 * in one of them becomes the bank select a synth and a MIDI file send.
 *
 * A voice is an InstrumentRef: the bank it lives in (`bankId`), its bank
 * select inside that bank's own file (`bank`) and its program. The bundled
 * General MIDI bank (`BUNDLED_BANK_ID`) is loaded at offset 0, so its bank
 * select is its own: 0 the General MIDI set, 1-26 its variations, 120 and the
 * percussion bank its kits. A user bank (backend/modules/soundfonts) is
 * loaded at the offset the backend gave it, so its bank `b` answers to bank
 * select `offset + b` on every synth (SpessaSynth addSoundBank with a bank
 * offset), live, in a render and in an exported file.
 *
 * The banks the app last heard are held here (each user bank's offset, span
 * and presets), so the pure voice code (lib/clipProgram) resolves a ref
 * without a store, and the articulation map (lib/articulationMap) finds the
 * bank a bank select falls in and the presets that bank holds. A bank the
 * registry does not know (removed, or not listed yet) resolves at offset 0:
 * its preset plays the bundled bank's preset at the same bank select and
 * program.
 *
 * Pure, so node tests load it.
 */

/** The bundled General MIDI bank's id. */
export const BUNDLED_BANK_ID = 'gm';

/** One preset of a bank, as its own file numbers it. */
export interface BankPreset {
  /** Bank select MSB inside the bank's file (0 for a kit). */
  bank: number;
  /** Bank select LSB inside the bank's file. */
  bankLsb: number;
  program: number;
  name: string;
  /** A drum kit: selected by its program on a drum channel. */
  drum: boolean;
}

/** A bank the app can load. */
export interface SoundBank {
  id: string;
  name: string;
  kind: 'bundled' | 'user';
  format: string;
  /** The bank select the bank's bank 0 answers to on a synth. */
  offset: number;
  /** How many bank selects from `offset` the bank's melodic presets use. */
  span: number;
  presets: BankPreset[];
  /** Where the bytes are fetched from. */
  url: string;
  /** Where the bank is stored on this machine (the backend's copy). */
  path?: string;
  /** The file the user added it from. */
  fileName?: string;
  sourcePath?: string;
  size?: number;
  /** The download manager's catalog entry the bank was installed from
   *  (backend/modules/modeldl soundbanks), whose manifest carries its
   *  playback gains (lib/soundbankGain). Absent for a bank the user added. */
  downloadId?: string;
  /** The bank has a build manifest with playback gains (GET /api/soundfonts/{id}/manifest): kept from beside the file it was added from. */
  manifest?: boolean;
}

/** A voice in a bank: the widened form of a bare program. */
export interface InstrumentRef {
  bankId: string;
  /** Bank select MSB inside the bank's own file. */
  bank: number;
  program: number;
}

const dataByte = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(127, Math.round(v))) : fallback;

/** A bank id as a project stores it: the bundled bank when absent or blank. */
export const cleanBankId = (id: unknown): string =>
  typeof id === 'string' && id.trim() ? id.trim() : BUNDLED_BANK_ID;

/* ── the banks the app last heard ───────────────────────────────────────── */

/** A user bank as the registry keeps it: where it is loaded, how wide it is, and what it holds. */
interface KnownBank {
  offset: number;
  span: number;
  presets: readonly BankPreset[];
}

let known = new Map<string, KnownBank>();

/**
 * Replace the known banks (the registry store calls this on every refresh):
 * each user bank's offset, and its span and presets when the caller has them
 * (a listing has; a test may give the offset alone).
 */
export function setKnownBanks(banks: ReadonlyArray<Pick<SoundBank, 'id' | 'offset'> & Partial<Pick<SoundBank, 'span' | 'presets'>>>): void {
  const next = new Map<string, KnownBank>();
  for (const b of banks) {
    if (b.id === BUNDLED_BANK_ID) continue;
    next.set(b.id, { offset: dataByte(b.offset), span: Math.max(1, dataByte(b.span, 1)), presets: b.presets ?? [] });
  }
  known = next;
}

/** The offset a bank is loaded at: 0 for the bundled bank and for a bank the registry does not know. */
export const bankOffsetOf = (bankId: string | undefined): number => known.get(cleanBankId(bankId))?.offset ?? 0;

/** True when the registry knows `bankId` (the bundled bank always). */
export const isKnownBank = (bankId: string | undefined): boolean => {
  const id = cleanBankId(bankId);
  return id === BUNDLED_BANK_ID || known.has(id);
};

/** The presets of a known user bank, as its file numbers them; none for the bundled bank or a bank the registry does not know. */
export const bankPresetsOf = (bankId: string | undefined): readonly BankPreset[] => known.get(cleanBankId(bankId))?.presets ?? [];

/**
 * The bank and its own bank select that bank select `msb` falls in, among the
 * known banks (bankForSelect over the registry): the user bank whose range
 * holds it, else the bundled bank.
 */
export const bankOfSelect = (msb: number): { bankId: string; bank: number } =>
  bankForSelect(msb, [...known.entries()].map(([id, b]) => ({ id, offset: b.offset, span: b.span, kind: 'user' as const })));

/**
 * The bank select MSB a synth and a MIDI file send for bank `bank` of bank
 * `bankId`: its offset plus the bank, at most 127.
 */
export function bankSelectFor(bankId: string | undefined, bank: number | undefined): number {
  return Math.min(127, bankOffsetOf(bankId) + dataByte(bank));
}

/**
 * The bank and its own bank select that bank select `msb` falls in: a user
 * bank whose range holds it, else the bundled bank. `spans` gives each user
 * bank's width (SoundBank `span`).
 */
export function bankForSelect(
  msb: number,
  banks: ReadonlyArray<Pick<SoundBank, 'id' | 'offset' | 'span' | 'kind'>>,
): { bankId: string; bank: number } {
  const m = dataByte(msb);
  for (const b of banks) {
    if (b.kind !== 'user') continue;
    if (m >= b.offset && m < b.offset + Math.max(1, b.span)) return { bankId: b.id, bank: m - b.offset };
  }
  return { bankId: BUNDLED_BANK_ID, bank: m };
}

/* ── refs, as projects and pickers carry them ───────────────────────────── */

/**
 * A voice from whatever a saved project or an older build holds: a bare
 * program (every project before banks), `{program, bank}` (a clip's
 * instrumentProgram and instrumentBank), the file's snake_case keys, or a
 * whole ref. The bank id is the bundled bank's when none is named, so every
 * earlier project opens on the sound it was saved with. Undefined when there
 * is no program.
 */
export function migrateInstrumentRef(raw: unknown): InstrumentRef | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { bankId: BUNDLED_BANK_ID, bank: 0, program: dataByte(raw) } : undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const program = r.program ?? r.instrumentProgram ?? r.instrument_program;
  if (typeof program !== 'number' || !Number.isFinite(program)) return undefined;
  return {
    bankId: cleanBankId(r.bankId ?? r.instrumentBankId ?? r.instrument_bank_id),
    bank: dataByte(r.bank ?? r.instrumentBank ?? r.instrument_bank),
    program: dataByte(program),
  };
}

/** A ref as a picker's option value. */
export const instrumentRefValue = (ref: InstrumentRef): string => `b:${ref.bankId}:${ref.bank}:${ref.program}`;

/** The ref an option value names, or null for any other value. */
export function parseInstrumentRefValue(value: string): InstrumentRef | null {
  const m = /^b:(.+):(\d{1,3}):(\d{1,3})$/.exec(value);
  if (!m) return null;
  return { bankId: cleanBankId(m[1]), bank: dataByte(Number(m[2])), program: dataByte(Number(m[3])) };
}

/* ── picker groups ──────────────────────────────────────────────────────── */

export interface PresetOption {
  value: string;
  label: string;
  ref: InstrumentRef;
  drum: boolean;
  /** A kit whose program a bundled kit already answers to: selected by program alone, the bundled one plays. */
  shadowed?: boolean;
}

export interface PresetGroup {
  key: string;
  label: string;
  bankId: string;
  options: PresetOption[];
}

/**
 * The presets the pickers list, grouped by bank and bank select: every bank
 * of every user bank, and the bundled bank's variation banks and kits (its
 * bank 0 is the General MIDI list the pickers already show). `drums` picks
 * the kits (a drum track's list) or the melodic presets. `skip` leaves out
 * a preset a picker lists already (the bundled kits it names).
 */
export function presetGroups(
  banks: readonly SoundBank[],
  drums: boolean,
  skip: (bankId: string, program: number) => boolean = () => false,
): PresetGroup[] {
  const bundledKits = new Set<number>();
  for (const b of banks) {
    if (b.kind === 'bundled') for (const p of b.presets) if (p.drum) bundledKits.add(p.program);
  }
  const groups: PresetGroup[] = [];
  for (const b of banks) {
    const byBank = new Map<number, BankPreset[]>();
    for (const p of b.presets) {
      if (p.drum !== drums) continue;
      if (b.kind === 'bundled' && !drums && p.bank === 0) continue;
      if (skip(b.id, p.program)) continue;
      const k = drums ? -1 : p.bank;
      const list = byBank.get(k) ?? [];
      list.push(p);
      byBank.set(k, list);
    }
    for (const [bank, presets] of [...byBank.entries()].sort((x, y) => x[0] - y[0])) {
      const where = drums ? 'kits' : `bank ${bank}`;
      groups.push({
        key: `${b.id}:${drums ? 'kits' : bank}`,
        label: `${b.name} · ${where}`,
        bankId: b.id,
        options: presets
          .slice()
          .sort((x, y) => x.program - y.program || x.bank - y.bank)
          // One option per program in a bank (a kit is one per program: its bank select is not sent).
          .filter((p, i, all) => i === 0 || !(all[i - 1].program === p.program && (drums || all[i - 1].bank === p.bank)))
          .map((p) => {
            const ref: InstrumentRef = { bankId: b.id, bank: drums ? 0 : p.bank, program: p.program };
            return {
              value: instrumentRefValue(ref),
              label: `${p.program + 1}. ${p.name}`,
              ref,
              drum: p.drum,
              ...(drums && b.kind === 'user' && bundledKits.has(p.program) ? { shadowed: true } : {}),
            };
          }),
      });
    }
  }
  return groups;
}

/** The name of the preset a ref names, or null when its bank does not list it. */
export function presetName(banks: readonly SoundBank[], ref: InstrumentRef, drum = false): string | null {
  const bank = banks.find((b) => b.id === ref.bankId);
  const p = bank?.presets.find((x) => x.program === ref.program && x.drum === drum && (drum || x.bank === ref.bank));
  return p ? p.name : null;
}

/** A user bank's entry as the backend lists it (backend/modules/soundfonts). */
export interface BackendBank {
  id: string;
  name: string;
  format: string;
  offset: number;
  span: number;
  presets: Array<{ bank: number; bank_lsb?: number; program: number; name: string; drum: boolean }>;
  path?: string;
  file_name?: string;
  source_path?: string;
  size?: number;
  download_id?: string;
  manifest?: boolean;
}

/** A backend entry as a SoundBank, or null when it is malformed. */
export function bankFromBackend(raw: BackendBank): SoundBank | null {
  if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.presets)) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    kind: 'user',
    format: raw.format,
    offset: dataByte(raw.offset),
    span: Math.max(1, dataByte(raw.span, 1)),
    presets: raw.presets.map((p) => ({
      bank: dataByte(p.bank),
      bankLsb: dataByte(p.bank_lsb),
      program: dataByte(p.program),
      name: String(p.name ?? ''),
      drum: p.drum === true,
    })),
    url: `/api/soundfonts/${encodeURIComponent(raw.id)}/file`,
    ...(raw.path ? { path: raw.path } : {}),
    ...(raw.file_name ? { fileName: raw.file_name } : {}),
    ...(raw.source_path ? { sourcePath: raw.source_path } : {}),
    ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
    ...(typeof raw.download_id === 'string' && raw.download_id ? { downloadId: raw.download_id } : {}),
    ...(raw.manifest === true ? { manifest: true } : {}),
  };
}
