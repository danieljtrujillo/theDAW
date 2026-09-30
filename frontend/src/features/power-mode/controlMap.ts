export const POWER_MODE_CTRL_PARAM = Object.freeze({
  lp4uxdj: 'grainsMix',
  pz6r4wt: 'reverbMix',
  '7qh4qid': 'grainsDensity',
  '5ajomy7': 'filterCutoff',
  'jc1ft9e-value': 'wetDry',
  'g4m6nz8-styleindex': 'filterType',
  'pgw6scm-activated': 'freeze',
} as const);

export function powerModePatch(data: unknown): Record<string, number> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  if (message.type !== 'updateValue' || typeof message.id !== 'string' ||
    !Object.hasOwn(POWER_MODE_CTRL_PARAM, message.id) ||
    typeof message.value !== 'number' || !Number.isFinite(message.value)) return null;
  const parameter = POWER_MODE_CTRL_PARAM[message.id as keyof typeof POWER_MODE_CTRL_PARAM];
  return { [parameter]: Math.max(0, Math.min(1, message.value)) };
}
