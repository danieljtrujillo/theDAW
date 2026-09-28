/**
 * The sound banks' presets as a select's option groups, one group per bank
 * and bank select (lib/bankRegistry presetGroups): every user bank, and the
 * bundled bank's variation banks and kits. Every instrument picker lists
 * them from one store (state/soundBankStore), so a bank added anywhere is in
 * every picker at once.
 */
import React, { useEffect } from 'react';
import { presetGroups, type InstrumentRef } from '../../lib/bankRegistry';
import { loadBundledBankPresets } from '../../lib/soundfontEngine';
import { useSoundBankStore } from '../../state/soundBankStore';

let listedOnce = false;

/**
 * The store's banks, listed from the backend the first time any picker
 * mounts, and the bundled bank's presets read once the picker is opened
 * (`warm`), which loads the bundled soundfont.
 */
export function useSoundBanks(): { banks: ReturnType<typeof useSoundBankStore.getState>['banks']; warm: () => void } {
  const banks = useSoundBankStore((s) => s.banks);
  useEffect(() => {
    if (listedOnce) return;
    listedOnce = true;
    void useSoundBankStore.getState().refresh();
  }, []);
  return { banks, warm: () => void loadBundledBankPresets() };
}

/**
 * Option groups for the melodic presets (`drums` false) or the kits.
 * `skipBundledKits` leaves out the bundled kits a picker already lists by
 * program. A kit of a user bank whose program a bundled kit answers to is
 * listed with a note: a kit is chosen by its program alone, so the bundled
 * one plays. `valuePrefix` goes before each value, for a select that lists
 * kits and instruments together and has to tell them apart.
 */
export const BankPresetOptions: React.FC<{ drums: boolean; skipBundledKits?: readonly number[]; valuePrefix?: string }> = ({
  drums,
  skipBundledKits = [],
  valuePrefix = '',
}) => {
  const banks = useSoundBankStore((s) => s.banks);
  const groups = presetGroups(banks, drums, (bankId, program) => bankId === 'gm' && drums && skipBundledKits.includes(program));
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.key} label={g.label}>
          {g.options.map((o) => (
            <option key={o.value} value={`${valuePrefix}${o.value}`} title={o.shadowed ? 'A bundled kit has this program and plays in its place' : undefined}>
              {o.shadowed ? `${o.label} (bundled kit plays)` : o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
};

/** True when a voice is a bank preset (not the bundled bank's bank 0), which the pickers show by its `b:` value. */
export const isBankPreset = (ref: InstrumentRef): boolean => ref.bankId !== 'gm' || ref.bank !== 0;
